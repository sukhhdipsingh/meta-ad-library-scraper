/**
 * Apify wiring. The only file allowed to import the SDK.
 *
 * Everything interesting happens in scrape.js; this file exists to connect it
 * to the platform: proxy, sessions, pay-per-event charging, the key-value
 * records buyers actually read, and a status message that never lies about why
 * a run returned fewer ads than expected.
 */
import { Actor, log } from 'apify';
import { runScrape } from './scrape.js';
import { validateInput } from './validate.js';
import { createSessionManager } from './session.js';
import { persistMediaFor } from './media.js';
import { buildWebhookPayload, deliverWebhook, isDeliverableWebhookUrl } from './webhook.js';
import { isBillable } from './state.js';
import { AdLibraryError, CATEGORY, categorise } from './errors.js';
import { CHARGE_EVENT, CHECKPOINT_STORE, MONITOR_STORE, RUN_STATUS_KEY, SUMMARY_KEY } from './constants.js';

const PUSH_CHUNK = 200;

/** Apify record keys accept a restricted charset, so a free-text id is sanitised. */
function stateKey(monitorId) {
  const raw = String(monitorId ?? '').trim() || 'default';
  return raw.replace(/[^a-zA-Z0-9!\-_.'()]/g, '-').slice(0, 200) || 'default';
}

await Actor.init();

/** Created once the proxy is known, torn down in `finally` whatever happens. */
let sessions = { stats: () => ({}), close: async () => {} };
/** Set by the catch block so `finally` knows to exit with a failure code. */
let failure = null;

try {
  const input = (await Actor.getInput()) ?? {};

  // Before anything is fetched or charged: a typo in a field name must cost an
  // error message, not a surprise bill (see validate.js for the two incidents
  // on a competing actor that this prevents).
  for (const note of validateInput(input).warnings) log.warning(note);

  // Meta blocks a bare IP after ~47 requests for well over 25 minutes, so a
  // proxy-less run is a support ticket waiting to happen. It is allowed —
  // small runs work fine — but never silently.
  const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
  if (!proxyConfiguration) {
    log.warning(
      'No proxy configured. Meta blocks a single IP after roughly 47 requests (~470 ads) '
      + 'and the block outlasts 25 minutes. Runs above a few hundred ads need residential proxies.',
    );
  }
  sessions = createSessionManager({ proxyConfiguration, log });

  const pricePerAdUsd = readEventPrice();
  let chargeWarned = false;
  let chargedTotal = 0;
  let chargeLimitHit = false;

  // Collected during the run so the webhook body does not require re-reading
  // the dataset back out of the platform.
  let webhookEvents = { ads: [], removed: [] };

  const sink = {
    log,
    pricePerAdUsd,
    webhookWanted: isDeliverableWebhookUrl(input.webhookUrl),
    collectForWebhook: (events) => { webhookEvents = events; },

    // --- session plumbing, handed to the source adapter unchanged ---
    acquireSession: () => sessions.acquire(),
    noteRequest: (session) => sessions.noteRequest(session),
    noteFailure: (session, err) => sessions.noteFailure(session, err),
    refreshDocId: (session) => sessions.refreshDocId(session),

    async pushAds(ads, { billable = true } = {}) {
      const rows = input.persistMedia && billable
        ? await persistMediaFor(ads, { store: await Actor.openKeyValueStore(), log })
        : ads;

      for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
        const chunk = rows.slice(i, i + PUSH_CHUNK);
        await Actor.pushData(chunk);
        if (!billable) continue;

        // Removals, unchanged ads and failures are bookkeeping the buyer has
        // already paid for once. Only genuine new/changed results are charged.
        const count = chunk.filter(isBillable).length;
        if (!count) continue;
        try {
          const result = await Actor.charge({ eventName: CHARGE_EVENT, count });
          chargedTotal += result?.chargedCount ?? count;
          if (result?.eventChargeLimitReached) chargeLimitHit = true;
        } catch (err) {
          if (!chargeWarned) {
            chargeWarned = true;
            log.warning(`Charging unavailable (${err.message}) — results are still saved in full.`);
          }
        }
      }
    },
  };

  // Pagination progress. Meta's cursor stays valid across processes, so a run
  // that dies — a crash, a proxy giving out, or an Apify platform migration —
  // can continue at the exact page instead of restarting and re-billing. The
  // record lives in a named store because the default one is wiped per run.
  {
    const store = await Actor.openKeyValueStore(CHECKPOINT_STORE);
    const key = stateKey(input.monitorId ?? 'default');
    sink.loadCheckpoint = async () => (await store.getValue(key)) ?? null;
    sink.saveCheckpoint = async (cp) => { await store.setValue(key, cp); };
    // A migration is the exact scenario competitors lose whole runs to; the
    // checkpoint is already on disk, this just says so out loud.
    Actor.on('migrating', () => {
      log.warning('Platform migration — progress is checkpointed, so the next run resumes at the same page.');
    });
  }

  // Monitor state lives in a named store so it survives between runs; the
  // default store is wiped with every run. One record per monitorId lets several
  // schedules share the actor without diffing each other's ads.
  if (input.monitorMode && input.monitorMode !== 'off') {
    const store = await Actor.openKeyValueStore(MONITOR_STORE);
    const key = stateKey(input.monitorId);
    sink.loadState = async () => (await store.getValue(key)) ?? null;
    sink.saveState = async (state) => { await store.setValue(key, state); };
    log.info(`Monitor mode "${input.monitorMode}" — memory "${key}" in key-value store "${MONITOR_STORE}".`);
  }

  const summary = await runScrape(input, sink);
  summary.adsCharged = chargedTotal || summary.adsCharged;
  summary.sessions = sessions.stats();

  await Actor.setValue(SUMMARY_KEY, summary);
  // Written even when the run ends badly: it is the record that explains why a
  // scheduled run came back short, and it must never be the thing that is missing.
  await Actor.setValue(RUN_STATUS_KEY, summary.queries);

  await Actor.setStatusMessage(statusMessage(summary, chargeLimitHit));
  log.info(`Done. ${statusMessage(summary, chargeLimitHit)}`);

  // Push the delta somewhere, so a scheduled run does not have to be polled.
  // Deliberately after the status message: a dead endpoint must not change the
  // outcome of a run whose data is already saved and already paid for.
  if (input.webhookUrl) {
    await deliverWebhook({
      url: input.webhookUrl,
      payload: buildWebhookPayload({
        summary,
        ads: webhookEvents.ads,
        removed: webhookEvents.removed,
        datasetId: process.env.APIFY_DEFAULT_DATASET_ID ?? null,
        runId: process.env.APIFY_ACTOR_RUN_ID ?? null,
      }),
      post: async (url, body) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
      log,
    });
  }

  // A run where nothing worked should fail loudly; a run where some queries
  // failed but ads came back is a success with a caveat, already in RUN-STATUS.
  if (summary.totalAds === 0 && summary.failures > 0 && summary.queriesOk === 0) {
    const worst = summary.queries.find((q) => q.errorCategory && q.errorCategory !== CATEGORY.NO_RESULTS);
    throw new AdLibraryError(worst?.errorCategory ?? CATEGORY.UNKNOWN, {
      detail: worst?.errorMessage ?? 'every query failed — see the RUN-STATUS record',
    });
  }
} catch (err) {
  const category = err instanceof AdLibraryError ? err.category : categorise(err);
  log.error(`[${category}] ${err.message}`);
  failure = `Failed (${category}): ${err.message}`.slice(0, 1000);
} finally {
  await sessions.close();
  // `Actor.exit()` ends the run as SUCCEEDED. Calling it unconditionally in a
  // finally block swallows the failure above and reports a run that scraped
  // nothing as a success — the exact "silent success" this actor exists to
  // eliminate. So a failure exits through `Actor.fail`, which sets exit code 1.
  if (failure) await Actor.fail(failure);
  else await Actor.exit();
}

/** The per-event price, when the platform exposes it. Used only to turn
 *  `maxCostUsd` into an ad count; absent, the run relies on `maxAds`. */
function readEventPrice() {
  try {
    const info = Actor.getChargingManager().getPricingInfo();
    const price = info?.perEventPrices?.[CHARGE_EVENT];
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * One line that answers "why did I get this many ads?" without opening a log.
 * A short result set with no explanation is what makes a working scraper look
 * broken, so every reason that shortened the run is named here.
 */
function statusMessage(summary, chargeLimitHit) {
  // The verdict leads, because "did I get everything?" is the question a short
  // result set actually raises.
  const parts = [
    `${summary.runStatus}: ${summary.totalAds} ad(s) from ${summary.queriesOk}/${summary.queriesRun} quer(y|ies)`,
  ];

  if (summary.duplicatesDropped) parts.push(`${summary.duplicatesDropped} duplicate(s) dropped (not billed)`);

  if (summary.monitorCounts) {
    const c = summary.monitorCounts;
    parts.push(`monitor: ${c.new} new, ${c.changed} changed, ${c.unchanged} unchanged (free), ${c.removed} removed (free)`);
  }
  if (summary.capped) {
    parts.push(`stopped at ${summary.maxAds} by ${summary.cappedBy} — this is your spend cap, not a failure`);
  }
  if (chargeLimitHit) parts.push('platform charge limit reached');
  if (summary.failures) parts.push(`${summary.failures} quer(y|ies) failed — see RUN-STATUS`);

  return parts.join(' | ').slice(0, 1000);
}

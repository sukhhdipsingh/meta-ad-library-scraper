/**
 * The run: turn an input object into billable records, honestly.
 *
 * This is the only place that knows about budgets, and that is deliberate. The
 * loudest complaint about every scraper in this category is surprise cost, so
 * the rule here is that the actor decides whether it can afford a record
 * *before* it emits it, and every stop reason is written down where the buyer
 * will see it.
 *
 * Three invariants hold throughout:
 *   1. Nothing is billed twice. Dedup happens before the sink is ever called.
 *   2. Nothing is billed that the buyer did not gain. Unchanged ads, removals
 *      and failures are recorded but never charged.
 *   3. Nothing is truncated silently. Every cap sets a flag that reaches the
 *      SUMMARY and the status message.
 *
 * The module imports no Apify SDK, so the whole pipeline runs against the
 * committed fixtures in tests with no network and no platform.
 */
import { ADS_PER_PAGE, DEFAULT_MAX_ADS, DEFAULT_MAX_PAGES_PER_QUERY } from './constants.js';
import { AdLibraryError, CATEGORY, categorise } from './errors.js';
import { makeDeduper } from './dedupe.js';
import { makeMonitor, isBillable } from './state.js';
import { openCheckpoint } from './checkpoint.js';
import { makeFilter } from './filters.js';
import { MAX_EVENTS_PER_KIND } from './webhook.js';
import * as web from './sources/weblibrary.js';

const NOOP_LOG = { debug() {}, info() {}, warning() {}, error() {} };

/** Bounded so a large monitor cannot build an unsendable webhook body. */
const WEBHOOK_COLLECT_LIMIT = MAX_EVENTS_PER_KIND * 4;

/**
 * Expand the three input shapes into a flat list of queries.
 * A malformed entry becomes a recorded failure, never a dead run: one bad
 * page id in a list of fifty should cost the buyer forty-nine good results.
 */
export function buildTargets(input = {}) {
  const queries = [];
  const rejected = [];
  const opts = {
    countries: input.countries,
    activeStatus: input.activeStatus,
    adType: input.adType,
    mediaType: input.mediaType,
  };

  const push = (target, label) => {
    try {
      queries.push(web.buildQuery(target, opts));
    } catch (err) {
      rejected.push({
        queryKey: `invalid:${label}`,
        ok: false,
        ads: 0,
        errorCategory: err instanceof AdLibraryError ? err.category : categorise(err),
        errorMessage: err.message,
      });
    }
  };

  for (const term of asList(input.searchTerms)) push({ searchTerm: term }, term);
  for (const id of asList(input.pageIds)) push({ pageId: id }, id);

  // Searching a brand by name is the standard way to get the wrong advertiser:
  // "multiple unrelated Facebook Pages share the exact same name". The fix the
  // community converged on is to search the name but keep only the ads whose
  // destination matches the real site — "same-name local businesses almost
  // never share a domain". `advertiserDomains` does both halves in one input.
  for (const domain of asList(input.advertiserDomains)) {
    const term = brandTermFromDomain(domain);
    if (!term) {
      rejected.push({
        queryKey: `invalid:${domain}`,
        ok: false,
        ads: 0,
        errorCategory: CATEGORY.INVALID_INPUT,
        errorMessage: `"${domain}" is not a domain. Use the form nike.com.`,
      });
      continue;
    }
    push({ searchTerm: term }, domain);
  }

  for (const raw of asList(input.adLibraryUrls)) {
    const parsed = web.parseAdLibraryUrl(raw);
    if (!parsed) {
      rejected.push({
        queryKey: `invalid:${raw}`,
        ok: false,
        ads: 0,
        errorCategory: CATEGORY.INVALID_INPUT,
        errorMessage: `"${raw}" is not a Facebook Ad Library URL.`,
      });
      continue;
    }
    if (parsed.singleAdId && !parsed.pageId && !parsed.searchTerm) {
      rejected.push({
        queryKey: `invalid:${raw}`,
        ok: false,
        ads: 0,
        errorCategory: CATEGORY.INVALID_INPUT,
        errorMessage:
          `"${raw}" links to a single ad. The Ad Library only exposes search by keyword or by Page, `
          + 'so use a Page URL (view_all_page_id=...) or a keyword search URL instead.',
      });
      continue;
    }
    // Filters written into the URL beat the run-wide defaults: the buyer is
    // pasting a link precisely because it already says what they want.
    push({
      pageId: parsed.pageId,
      searchTerm: parsed.searchTerm,
      countries: parsed.countries,
      activeStatus: parsed.activeStatus,
      adType: parsed.adType,
      mediaType: parsed.mediaType,
    }, raw);
  }

  return { queries: dedupeQueries(queries), rejected };
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  .map((x) => (typeof x === 'string' ? x.trim() : x))
  .filter(Boolean);

/** `https://shop.nike.com/x` -> `nike`. The registrable name is what an
 *  advertiser actually calls itself, so it is the best keyword to search on. */
export function brandTermFromDomain(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  let host;
  try {
    host = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  if (!host.includes('.')) return null;
  const parts = host.split('.').filter(Boolean);
  // Drop the public suffix, including two-part ones like .co.uk / .com.au.
  const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);
  let idx = parts.length - 2;
  if (parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2])) idx = parts.length - 3;
  const name = parts[idx];
  return name && name.length > 1 ? name : null;
}

/** Two identical queries would bill the same ads twice over. */
function dedupeQueries(queries) {
  const seen = new Set();
  return queries.filter((q) => !seen.has(q.queryKey) && seen.add(q.queryKey));
}

/**
 * Track what the run is allowed to spend, in ads.
 *
 * `maxCostUsd` is converted into an ad count using the actual per-event price
 * when the platform tells us one; otherwise the run falls back to `maxAds`
 * alone rather than guessing a price and capping the buyer by accident.
 */
export function makeBudget({ maxAds = DEFAULT_MAX_ADS, maxCostUsd = null, pricePerAdUsd = null } = {}) {
  const byCount = Number.isFinite(maxAds) && maxAds > 0 ? Math.floor(maxAds) : DEFAULT_MAX_ADS;
  const byCost = Number.isFinite(maxCostUsd) && maxCostUsd > 0 && Number.isFinite(pricePerAdUsd) && pricePerAdUsd > 0
    ? Math.floor(maxCostUsd / pricePerAdUsd)
    : null;

  const limit = byCost === null ? byCount : Math.min(byCount, byCost);
  let used = 0;

  return {
    limit,
    reason: byCost !== null && byCost < byCount ? 'maxCostUsd' : 'maxAds',
    get used() { return used; },
    get remaining() { return Math.max(0, limit - used); },
    get exhausted() { return used >= limit; },
    /** How many of `n` may be taken without crossing the ceiling. */
    take(n) {
      const allowed = Math.min(n, limit - used);
      used += Math.max(0, allowed);
      return Math.max(0, allowed);
    },
  };
}

/**
 * Run every query, emit records through the sink, and report what happened.
 *
 * @param {object} input   the actor input
 * @param {object} sink    `{ log, pushAds, acquireSession, noteRequest, noteFailure,
 *                            loadState?, saveState? }`
 * @returns {Promise<object>} the SUMMARY record
 */
export async function runScrape(input = {}, sink = {}) {
  const log = sink.log ?? NOOP_LOG;
  const now = sink.now ?? Date.now();

  const monitorMode = input.monitorMode ?? 'off';
  const monitoring = monitorMode !== 'off';
  const maxPages = clampInt(input.maxPagesPerQuery, DEFAULT_MAX_PAGES_PER_QUERY, 1, 5000);

  const budget = makeBudget({
    maxAds: input.maxAds ?? DEFAULT_MAX_ADS,
    maxCostUsd: input.maxCostUsd ?? null,
    pricePerAdUsd: sink.pricePerAdUsd ?? null,
  });

  const { queries, rejected } = buildTargets(input);
  if (!queries.length && !rejected.length) {
    throw new AdLibraryError(CATEGORY.INVALID_INPUT, {
      detail: 'provide at least one of searchTerms, pageIds, advertiserDomains or adLibraryUrls',
    });
  }

  log.info(
    `Starting: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, `
    + `cap ${budget.limit} ad(s) (${budget.reason})`
    + (sink.pricePerAdUsd ? ` — at most $${(budget.limit * sink.pricePerAdUsd).toFixed(2)}` : '')
    + `. Roughly ${Math.ceil(budget.limit / ADS_PER_PAGE)} request(s) to Meta.`,
  );

  // A run that dies mid-pagination — a crash, a platform migration, a proxy
  // giving out — must not start over and re-bill from the top. Every page
  // boundary is persisted, so a resumed run continues at the exact cursor.
  const checkpoint = openCheckpoint({
    queries,
    previous: input.resumeFromCheckpoint === false ? null : await sink.loadCheckpoint?.(),
    enabled: input.resumeFromCheckpoint !== false && Boolean(sink.saveCheckpoint),
  });
  if (checkpoint.resumed) {
    log.info(
      `Resuming a previous attempt: ${checkpoint.stats().queriesAlreadyDone} quer(y|ies) already finished, `
      + `${checkpoint.carriedOver} ad(s) already collected and paid for — they will not be billed again.`,
    );
  }
  const persist = async () => {
    const snap = checkpoint.snapshot(now);
    if (snap) await sink.saveCheckpoint?.(snap);
  };

  // Built once: a filter that cannot be parsed is reported, never ignored.
  const filter = makeFilter(input, { now });
  for (const bad of filter.rejected) log.warning(`Filter ignored — ${bad}`);
  if (filter.active.length) log.info(`Filters active (applied before billing): ${filter.active.join(', ')}`);

  // The monitor is opened up front so each page can be judged as it arrives,
  // which is what allows shipping page by page instead of at the very end.
  const monitor = monitoring
    ? makeMonitor(await sink.loadState?.() ?? null, {
      now,
      monitorId: input.monitorId ?? 'default',
      emitRemoved: input.emitRemoved !== false,
    })
    : null;

  // A bounded copy of what the run delivered, kept only for the webhook body.
  // Collected while shipping rather than re-read from the dataset, and capped
  // here so a huge monitor cannot build a huge POST.
  const wantsWebhook = Boolean(sink.webhookWanted);
  const deliveredForHook = [];

  // Queries that ran out of page budget rather than out of ads: the silent
  // cause of "why did I get fewer results than the website shows".
  const pagesCapped = [];

  const deduper = makeDeduper();
  const status = [...rejected];
  const byQuery = [];         // per-query outcome, for RUN-STATUS
  let delivered = 0;
  let charged = 0;
  let capped = false;
  let cappedBy = null;

  for (const query of queries) {
    if (checkpoint.isDone(query.queryKey)) {
      // Finished on a previous attempt; nothing left to fetch or to charge.
      status.push({
        queryKey: query.queryKey, browserUrl: query.browserUrl, ok: true, ads: 0,
        resumedComplete: true,
      });
      byQuery.push({ queryKey: query.queryKey, ok: true, ads: [] });
      continue;
    }
    if (budget.exhausted) {
      capped = true;
      cappedBy = budget.reason;
      status.push({
        queryKey: query.queryKey, browserUrl: query.browserUrl, ok: false, ads: 0,
        errorCategory: CATEGORY.NO_RESULTS,
        errorMessage: `Not attempted: the run had already reached its ${budget.reason} cap.`,
      });
      byQuery.push({ queryKey: query.queryKey, ok: false, ads: [] });
      continue;
    }

    const found = [];
    let failure = null;
    let pages = 0;
    let finished = false;

    try {
      const startCursor = checkpoint.cursorFor(query.queryKey);
      for await (const { ads, page, nextCursor, done } of web.paginate(query, sink, { maxPages, startCursor })) {
        pages = page;
        const batch = [];

        for (const raw of ads) {
          const record = web.normalize(raw, { now });
          if (!deduper.keep(record)) continue;
          // Already delivered by the attempt this run is resuming.
          if (checkpoint.hasSeen(record.id)) continue;
          // Filtered ads are dropped BEFORE billing. Telling a buyer to
          // post-process the dataset means charging them for rows they throw
          // away — which is exactly what the incumbents do.
          if (!filter.apply(record)) continue;
          // The per-card breakdown is the bulkiest part of a row. Media from
          // cards is already merged into images/videos, so dropping it loses
          // no creatives — only the card-by-card structure.
          if (input.includeCards === false) record.cards = [];
          batch.push(monitor ? monitor.annotate(record, query.queryKey) : record);
        }

        // `changes-only` withholds untouched ads; every other mode ships them,
        // free of charge, because the buyer asked to see the full picture.
        const wanted = monitorMode === 'changes-only'
          ? batch.filter((a) => a.status === 'new' || a.status === 'changed')
          : batch;

        // Apply the budget here, per page, so the cap can never be exceeded and
        // an ad that is refused is never marked as delivered.
        const billableHere = wanted.filter(isBillable);
        const allowedHere = budget.take(billableHere.length);
        if (allowedHere < billableHere.length) { capped = true; cappedBy = budget.reason; }

        let quota = allowedHere;
        const shippable = wanted.filter((ad) => {
          if (!isBillable(ad)) return true;
          if (quota > 0) { quota--; return true; }
          return false;
        });

        // Ship first, then record progress. Doing it in this order is the whole
        // point: a crash between the two costs a repeated page, never a lost
        // one. The reverse order would advance the cursor past ads the buyer
        // never received — the silent data loss this feature exists to prevent.
        if (shippable.length) await sink.pushAds?.(shippable);
        if (wantsWebhook) {
          for (const ad of shippable) {
            if (deliveredForHook.length < WEBHOOK_COLLECT_LIMIT) deliveredForHook.push(ad);
          }
        }
        for (const ad of shippable) checkpoint.noteAd(ad.id);
        delivered += shippable.length;
        charged += Math.min(allowedHere, shippable.filter(isBillable).length);
        found.push(...shippable);

        if (done) { finished = true; checkpoint.noteQueryDone(query.queryKey); }
        else checkpoint.notePage(query.queryKey, nextCursor, found.length);
        await persist();

        if (budget.exhausted) break;
      }
    } catch (err) {
      failure = err instanceof AdLibraryError ? err : new AdLibraryError(categorise(err), { detail: err.message, cause: err });
      log.warning(`Query ${query.queryKey} failed: ${failure.message}`);
    }

    if (!failure && !finished && pages >= maxPages) pagesCapped.push(query.queryKey);
    if (!failure) monitor?.noteQueryOk(query.queryKey);
    byQuery.push({ queryKey: query.queryKey, ok: !failure, ads: found });
    status.push({
      queryKey: query.queryKey,
      browserUrl: query.browserUrl,
      ok: !failure,
      ads: found.length,
      pages,
      // Says whether this query saw the end of its results, so a short answer
      // is never mistaken for a complete one.
      complete: Boolean(finished) && !failure,
      ...(!failure && !finished && pages >= maxPages
        ? { truncatedBy: 'maxPagesPerQuery' }
        : {}),
      ...(failure
        ? failure.toRecord()
        : found.length === 0
          ? { errorCategory: CATEGORY.NO_RESULTS, errorMessage: 'Meta returned no ads for these filters.' }
          : {}),
    });
  }

  // --- close the monitor: what disappeared, and what to remember ----------
  let removed = [];
  let counts = null;

  if (monitor) {
    const finished = monitor.finish();
    removed = finished.removed;
    counts = finished.counts;
    // Removal notices are bookkeeping the buyer paid for once already.
    if (removed.length) await sink.pushAds?.(removed, { billable: false });
    await sink.saveState?.(finished.nextState);
  }

  const okQueries = status.filter((s) => s.ok).length;
  const failures = status.filter((s) => !s.ok).length;

  // Handed back so main.js can POST it without re-reading the dataset.
  sink.collectForWebhook?.({ ads: deliveredForHook, removed });

  // An explicit verdict on whether this run saw everything it set out to see.
  //
  // This is the single most expensive failure in the category, stated plainly
  // by a buyer: "A cheaper run that quietly stops paginating on high-review
  // places isn't actually cheaper, it's just wrong in a way that doesn't throw
  // an error." A run that succeeded but only covered half the ads must not be
  // indistinguishable from one that covered all of them.
  const completeness = failures > 0
    ? (okQueries > 0 ? 'PARTIAL' : 'FAILED')
    : (capped || pagesCapped.length ? 'PARTIAL' : 'COMPLETE');

  return {
    runStatus: completeness,
    // Why it is not COMPLETE, in the buyer's terms. Empty when it is.
    incompleteBecause: completeness === 'COMPLETE' ? [] : [
      ...(failures > 0 ? [`${failures} quer(y|ies) failed`] : []),
      ...(capped ? [`stopped at the ${cappedBy} cap`] : []),
      ...(pagesCapped.length ? [`${pagesCapped.length} quer(y|ies) hit maxPagesPerQuery`] : []),
    ],
    totalAds: delivered,
    adsCharged: charged,
    duplicatesDropped: deduper.dropped,
    removedReported: removed.length,
    queriesRun: queries.length,
    queriesOk: okQueries,
    failures,
    capped,
    cappedBy: capped ? cappedBy : null,
    maxAds: budget.limit,
    monitorMode,
    monitorCounts: counts,
    checkpoint: checkpoint.stats(),
    monitorId: monitoring ? (input.monitorId ?? 'default') : null,
    filters: filter.report(),
    queries: status,
    finishedAt: new Date(now).toISOString(),
  };
}

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Push the changes somewhere, instead of making people poll for them.
 *
 * Asked for directly, and never answered:
 *   "Do your actors expose the change events as a webhook, or do users poll?"
 *
 * And the shape it should take, from someone describing the system they built
 * by hand because nothing offered it:
 *   "send notifications from that smaller event list" — the events, not the
 *   whole baseline.
 *
 * So the payload is the delta, not the dataset: what launched, what changed,
 * what stopped, plus the run status that says whether the run was complete
 * enough to trust those conclusions.
 *
 * Two rules govern everything here:
 *   1. The webhook can never fail the run. The dataset is already saved and
 *      already paid for; a dead endpoint is a warning, not a failure.
 *   2. The body is bounded. A monitor over a large advertiser can produce
 *      thousands of events, and nobody's endpoint wants a 40 MB POST.
 */

/** Enough to act on, small enough to always send. */
export const MAX_EVENTS_PER_KIND = 200;

/** The fields a notification actually needs. The full record stays in the
 *  dataset; this is the part someone puts in a Slack message. */
function slim(ad) {
  return {
    id: ad.id,
    status: ad.status ?? 'new',
    pageId: ad.pageId ?? null,
    pageName: ad.pageName ?? null,
    title: ad.title ?? null,
    body: typeof ad.body === 'string' ? ad.body.slice(0, 500) : null,
    creativeType: ad.creativeType ?? null,
    linkUrlClean: ad.linkUrlClean ?? ad.linkUrl ?? null,
    linkDomain: ad.linkDomain ?? null,
    startDate: ad.startDate ?? null,
    totalActiveDays: ad.totalActiveDays ?? null,
    adLibraryUrl: ad.adLibraryUrl ?? null,
    ...(ad.changedFields?.length ? { changedFields: ad.changedFields } : {}),
    ...(ad.isScaling ? { isScaling: true, variantDelta: ad.variantDelta } : {}),
  };
}

/** Only https: a webhook body carries the whole delta, so plain http is refused. */
export function isDeliverableWebhookUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    return new URL(url.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build the POST body.
 *
 * @param {object} args `{ summary, ads, removed, datasetId, runId, actorRunUrl }`
 */
export function buildWebhookPayload({ summary, ads = [], removed = [], datasetId = null, runId = null }) {
  const isNew = (a) => a.status === 'new' || !a.status;
  const created = ads.filter(isNew).slice(0, MAX_EVENTS_PER_KIND).map(slim);
  const changed = ads.filter((a) => a.status === 'changed').slice(0, MAX_EVENTS_PER_KIND).map(slim);
  const scaling = ads.filter((a) => a.isScaling).slice(0, MAX_EVENTS_PER_KIND).map(slim);
  const stopped = removed.slice(0, MAX_EVENTS_PER_KIND).map(slim);

  return {
    // A consumer should be able to route on this without parsing anything else.
    event: created.length || changed.length || stopped.length ? 'ads.changed' : 'run.finished',
    monitorId: summary.monitorId ?? null,
    finishedAt: summary.finishedAt,

    // The run's own health, so a partial run is never mistaken for "the
    // competitor stopped advertising".
    run: {
      id: runId,
      datasetId,
      status: summary.failures > 0 ? (summary.queriesOk > 0 ? 'partial' : 'failed') : 'complete',
      queriesRun: summary.queriesRun,
      queriesOk: summary.queriesOk,
      failures: summary.failures,
      capped: summary.capped,
      cappedBy: summary.cappedBy,
      resumed: summary.checkpoint?.resumed ?? false,
      adsReturned: summary.totalAds,
      adsCharged: summary.adsCharged,
    },

    counts: {
      new: summary.monitorCounts?.new ?? created.length,
      changed: summary.monitorCounts?.changed ?? 0,
      unchanged: summary.monitorCounts?.unchanged ?? 0,
      removed: summary.monitorCounts?.removed ?? removed.length,
      scaling: scaling.length,
    },

    // Truncation is stated, never silent.
    truncated: {
      new: Math.max(0, ads.filter(isNew).length - created.length),
      changed: Math.max(0, ads.filter((a) => a.status === 'changed').length - changed.length),
      removed: Math.max(0, removed.length - stopped.length),
    },

    events: { new: created, changed, scaling, removed: stopped },
  };
}

/**
 * POST the delta, and never let it decide whether the run succeeded.
 *
 * @param {object} args `{ url, payload, post, log }` — `post` is injected so
 *   this is testable without a network.
 */
export async function deliverWebhook({ url, payload, post, log = console }) {
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target) return { delivered: false, reason: 'not requested' };

  if (!isDeliverableWebhookUrl(target)) {
    log.warning?.(
      `webhookUrl "${target}" is not an https URL — nothing was sent. A webhook body carries `
      + 'the whole change set, so plain http is refused.',
    );
    return { delivered: false, reason: 'not https' };
  }

  try {
    await post(target, payload);
    const n = payload.events.new.length + payload.events.changed.length + payload.events.removed.length;
    log.info?.(`Webhook delivered to ${target} — ${n} event(s).`);
    return { delivered: true };
  } catch (err) {
    log.warning?.(`Webhook POST to ${target} failed (${err.message}) — the run is unaffected and the results are saved.`);
    return { delivered: false, reason: err.message };
  }
}

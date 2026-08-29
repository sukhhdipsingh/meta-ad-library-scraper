/**
 * Monitor state — what a scheduled run remembers between runs.
 *
 * This is the feature the market actually asked for. Two independent voices in
 * the r/n8n thread on tracking competitor ads said the same thing:
 *
 *   "The API handles pulling, the value is in the diff: store yesterday's JSON,
 *    compare, push only new or changed ads."
 *   "Keep a table of ads keyed by ad id with first_seen and last_seen, write a
 *    row only when the creative, text, or target URL changes."
 *
 * Neither incumbent does this. So a scheduled run here answers "what changed"
 * rather than re-billing the same 400 ads every morning.
 *
 * A third requirement from the same thread governs the removal logic:
 *
 *   "If one scheduled run is partial or fails, missing ads should [not be read
 *    as removed]."
 *
 * Hence `ok` per query: only a query that actually succeeded may retire the ads
 * it used to return. A network blip must never fabricate a wave of removals.
 *
 * The module is deliberately pure — no SDK, no key-value store, no clock. The
 * caller loads the previous state, calls `diffRun`, and persists `nextState`.
 */
import { creativeFingerprint, changedFields } from './fingerprint.js';

export const STATE_VERSION = 1;

/** A monitor that has never run. */
export function emptyState(monitorId = 'default') {
  return { version: STATE_VERSION, monitorId, updatedAt: null, ads: {} };
}

/** Tolerate a null, half-written, or older record instead of crashing a run. */
function readState(prev, monitorId) {
  const base = emptyState(monitorId);
  if (!prev || typeof prev !== 'object') return base;
  return {
    ...base,
    monitorId: prev.monitorId ?? monitorId,
    ads: prev.ads && typeof prev.ads === 'object' ? prev.ads : {},
  };
}

/**
 * Compare one run against the previous state.
 *
 * State footprint is kept deliberately small: a monitor can track tens of
 * thousands of ads and the whole thing has to fit in one key-value record, so
 * only the fingerprint, the query it belongs to, and the two timestamps are
 * kept — never the ad itself.
 *
 * @param {object|null} prevState  what was persisted last run
 * @param {Array<{queryKey: string, ok: boolean, ads: object[]}>} byQuery
 *   every query attempted this run, failures included with `ok:false` and no
 *   ads. Only `ok:true` queries can produce removals.
 * @param {object} opts `{ now, monitorId, emitRemoved }` — `now` is epoch ms
 *   and is always injected so runs are reproducible in tests.
 * @returns {{annotate, removed, nextState, counts}}
 */
export function makeMonitor(prevState, { now = Date.now(), monitorId = 'default', emitRemoved = true } = {}) {
  const prev = readState(prevState, monitorId);
  const nowIso = new Date(now).toISOString();

  const nextAds = {};
  const counts = { new: 0, changed: 0, unchanged: 0, removed: 0 };
  const seenThisRun = new Set();
  const okQueries = new Set();

  return {
    counts,

    /**
     * Judge one ad the moment it arrives, and stamp the monitor fields on it.
     *
     * Deciding per ad rather than per run is what lets the caller ship each
     * page as it is fetched. That in turn is what makes the checkpoint honest:
     * progress is only ever recorded for ads that have actually been delivered.
     */
    annotate(ad, queryKey = '') {
      if (!ad?.id || seenThisRun.has(ad.id)) return ad;
      seenThisRun.add(ad.id);

      const fp = creativeFingerprint(ad);
      const before = prev.ads[ad.id];

      let status = 'unchanged';
      let fields = [];
      if (!before) {
        status = 'new';
      } else if (before.fp !== fp) {
        status = 'changed';
        fields = changedFields(before.snapshot ?? null, ad);
      }
      counts[status]++;

      // firstSeenAt is sticky: it is the launch date the buyer reports on, so
      // it survives every later run untouched.
      const firstSeenAt = before?.firstSeenAt ?? nowIso;

      // How many near-identical copies Meta grouped under this ad, last run and
      // now. The raw number is a weak signal on its own — a cost-cap campaign
      // can carry ten variants where only one spends — but the *movement* is
      // the thing people say every tool misses: "the duplicate tracking over
      // time is the part most people miss, that's where you actually see the
      // scaling signal".
      const variantCount = Number.isFinite(ad.variantCount) ? ad.variantCount : 1;
      const variantCountPrev = Number.isFinite(before?.variantCount) ? before.variantCount : null;
      const variantDelta = variantCountPrev === null ? 0 : variantCount - variantCountPrev;

      nextAds[ad.id] = {
        fp,
        queryKey: queryKey || before?.queryKey || '',
        firstSeenAt,
        lastSeenAt: nowIso,
        variantCount,
        // Kept only for naming changed fields next run; bounded on purpose.
        snapshot: compactSnapshot(ad),
      };

      return {
        ...ad,
        status,
        isNew: status === 'new',
        firstSeenAt,
        lastSeenAt: nowIso,
        changedFields: fields,
        // Whole days this monitor has been watching the ad — the honest version
        // of "days running" when Meta's own start date is missing or wrong.
        daysTracked: Math.max(0, Math.floor((now - Date.parse(firstSeenAt)) / 86_400_000)),
        variantCountPrev,
        variantDelta,
        // Duplicates going up between runs, on an ad that is otherwise the
        // same creative: the advertiser is putting it in more ad sets.
        isScaling: variantDelta > 0,
      };
    },

    /** A query that completed without error may retire the ads it used to hold. */
    noteQueryOk(queryKey) {
      okQueries.add(queryKey);
    },

    /**
     * Close the run: work out what disappeared and produce the state to persist.
     * Only queries that actually succeeded can report removals — a network blip
     * must never look like a competitor pulling their campaigns.
     */
    finish() {
      const removed = [];
      for (const [id, rec] of Object.entries(prev.ads)) {
        if (nextAds[id]) continue;
        if (!okQueries.has(rec.queryKey)) {
          // The query that owned this ad did not succeed, so its absence proves
          // nothing. Keep the record untouched and say nothing.
          nextAds[id] = rec;
          continue;
        }
        counts.removed++;
        if (emitRemoved) {
          removed.push({
            id,
            status: 'removed',
            source: 'web',
            firstSeenAt: rec.firstSeenAt ?? null,
            lastSeenAt: rec.lastSeenAt ?? null,
            removedAt: nowIso,
            pageId: rec.snapshot?.pageId ?? null,
            pageName: rec.snapshot?.pageName ?? null,
            adLibraryUrl: rec.snapshot?.adLibraryUrl ?? null,
          });
        }
      }
      return {
        removed,
        counts,
        nextState: { version: STATE_VERSION, monitorId, updatedAt: nowIso, ads: nextAds },
      };
    },
  };
}

/**
 * Whole-run convenience wrapper over `makeMonitor`, kept for tests and for
 * callers that genuinely have every ad in hand before deciding anything.
 */
export function diffRun(prevState, byQuery, opts = {}) {
  const monitor = makeMonitor(prevState, opts);
  const verdicts = new Map();

  for (const q of byQuery) {
    if (q?.ok) monitor.noteQueryOk(q.queryKey);
    for (const ad of q?.ads ?? []) {
      const judged = monitor.annotate(ad, q?.queryKey ?? '');
      if (judged !== ad) verdicts.set(ad.id, judged);
    }
  }

  const { removed, counts, nextState } = monitor.finish();
  return {
    annotate: (ad) => verdicts.get(ad?.id) ?? ad,
    removed,
    counts,
    nextState,
  };
}

/** Only what a later diff needs to name changed fields and describe a removal. */
function compactSnapshot(ad) {
  return {
    pageId: ad.pageId ?? null,
    pageName: ad.pageName ?? null,
    adLibraryUrl: ad.adLibraryUrl ?? null,
    body: ad.body ?? null,
    title: ad.title ?? null,
    caption: ad.caption ?? null,
    linkUrl: ad.linkUrl ?? null,
    linkDescription: ad.linkDescription ?? null,
    ctaText: ad.ctaText ?? null,
    ctaType: ad.ctaType ?? null,
    creativeBodies: ad.creativeBodies ?? [],
    creativeTitles: ad.creativeTitles ?? [],
    creativeLinkUrls: ad.creativeLinkUrls ?? [],
    images: ad.images ?? [],
    videos: ad.videos ?? [],
  };
}

/** Ads that are billable: what is new or materially changed. `unchanged` and
 *  `removed` are bookkeeping the buyer already paid for once. */
export function isBillable(ad) {
  if (!ad || ad.errorCategory) return false;
  if (!('status' in ad)) return true;           // non-monitor run: everything counts
  return ad.status === 'new' || ad.status === 'changed';
}

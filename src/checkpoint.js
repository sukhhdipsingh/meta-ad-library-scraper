/**
 * Resumable pagination.
 *
 * This is the one thing the market leader says cannot be done. Verbatim, from
 * their own issue tracker:
 *
 *   "due to technical limitations, we can't resume scraping a search url once
 *    it fails in the middle. Only way is to restart from beginning ... This can
 *    also happen if the actor gets migrated during the run which will make all
 *    urls non-resume-able"
 *
 * and, on a separate report of runs silently returning a fraction of the ads:
 *
 *   "This is a known issue that sometimes scraping stops in between before
 *    scraping all available ads. There is no simple solution to this due to
 *    nature of pagination in facebook ads library."
 *
 * Their users report the consequence: 15,600 ads where a week earlier the same
 * query returned 48,500; 9,254 out of ~36,000; runs "randomly limited to 30
 * results". The buyer pays for a partial answer and cannot tell it is partial.
 *
 * It is solvable, because Meta's cursor is an opaque but *durable* token: the
 * page after `end_cursor` can be requested later, from a different IP, in a
 * different process. So every page boundary is written to the key-value store,
 * which survives both a crash and an Apify platform migration. A resumed run
 * picks up at the exact cursor and re-bills nothing, because the ids already
 * collected are remembered too.
 *
 * Pure by design: the caller supplies `load`/`save`, so this is testable with
 * no platform and no network.
 */

export const CHECKPOINT_VERSION = 1;

/** Ids are the bulk of the record. A run far past this is not the target use
 *  case, and an unbounded record would eventually fail to save. */
const MAX_REMEMBERED_IDS = 200_000;

/** A run that has not started. */
export function emptyCheckpoint(fingerprint = '') {
  return {
    version: CHECKPOINT_VERSION,
    fingerprint,
    updatedAt: null,
    queries: {},
    seenIds: [],
  };
}

/**
 * Identifies "the same job". Resuming into a *different* query set would
 * silently mix results, so the checkpoint is only honoured when the inputs
 * that determine what gets fetched are unchanged.
 */
export function inputFingerprint(queries) {
  return queries.map((q) => q.queryKey).sort().join('|');
}

function readCheckpoint(raw, fingerprint) {
  const base = emptyCheckpoint(fingerprint);
  if (!raw || typeof raw !== 'object') return base;
  if (raw.version !== CHECKPOINT_VERSION) return base;
  // A checkpoint from a different query set is not ours to resume.
  if (raw.fingerprint !== fingerprint) return base;
  return {
    ...base,
    updatedAt: raw.updatedAt ?? null,
    queries: raw.queries && typeof raw.queries === 'object' ? raw.queries : {},
    seenIds: Array.isArray(raw.seenIds) ? raw.seenIds : [],
  };
}

/**
 * Open the checkpoint for a run.
 *
 * @param {object} opts
 * @param {object[]} opts.queries      from `buildTargets`
 * @param {object|null} opts.previous  whatever was persisted, or null
 * @param {boolean} [opts.enabled]     when false, every method is a no-op
 * @returns {object} the checkpoint handle
 */
export function openCheckpoint({ queries, previous = null, enabled = true } = {}) {
  const fingerprint = inputFingerprint(queries ?? []);
  const state = enabled ? readCheckpoint(previous, fingerprint) : emptyCheckpoint(fingerprint);
  const seen = new Set(state.seenIds);
  const resumed = enabled && Boolean(state.updatedAt);
  let dirty = false;

  return {
    resumed,
    /** How many ads a resumed run already paid for and collected. */
    get carriedOver() { return seen.size; },

    /** Queries already finished last time need not be fetched at all. */
    isDone(queryKey) {
      return Boolean(state.queries[queryKey]?.done);
    },

    /** Where to pick this query back up, or null to start from the top. */
    cursorFor(queryKey) {
      return state.queries[queryKey]?.cursor ?? null;
    },

    /** Ids already collected — so a resumed run never bills them twice. */
    hasSeen(id) {
      return seen.has(id);
    },

    noteAd(id) {
      if (!id || seen.has(id)) return;
      if (seen.size < MAX_REMEMBERED_IDS) seen.add(id);
      dirty = true;
    },

    /** Record the boundary *after* a page has been safely handled. */
    notePage(queryKey, cursor, adsSoFar) {
      state.queries[queryKey] = { cursor: cursor ?? null, ads: adsSoFar, done: false };
      dirty = true;
    },

    noteQueryDone(queryKey) {
      state.queries[queryKey] = { ...(state.queries[queryKey] ?? {}), cursor: null, done: true };
      dirty = true;
    },

    /** The record to persist, or null when nothing changed. */
    snapshot(now = Date.now()) {
      if (!dirty) return null;
      dirty = false;
      return {
        version: CHECKPOINT_VERSION,
        fingerprint,
        updatedAt: new Date(now).toISOString(),
        queries: state.queries,
        seenIds: [...seen],
      };
    },

    /** Progress for the SUMMARY, so a resumed run is visible, not silent. */
    stats() {
      const done = Object.values(state.queries).filter((q) => q.done).length;
      return {
        resumed,
        resumedFrom: state.updatedAt,
        queriesAlreadyDone: done,
        adsCarriedOver: seen.size,
      };
    },
  };
}

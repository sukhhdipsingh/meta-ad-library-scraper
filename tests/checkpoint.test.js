/**
 * Resumable pagination — the capability the market leader publicly says is
 * impossible ("we can't resume scraping a search url once it fails in the
 * middle. Only way is to restart from beginning").
 *
 * These tests prove the three things a buyer is actually paying for:
 *   - a crashed run continues from the exact page it reached;
 *   - it does not re-bill what the first attempt already delivered;
 *   - it refuses to resume into a different query set, which would silently
 *     mix results.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runScrape } from '../src/scrape.js';
import { openCheckpoint, inputFingerprint, CHECKPOINT_VERSION } from '../src/checkpoint.js';

const fixture = (name) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
);
const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const QUIET = { debug() {}, info() {}, warning() {}, error() {} };

/**
 * A fake Meta that serves an endless stream of distinct pages, and can be told
 * to die at a given page — the way a real run dies to a migration or a proxy.
 */
function endlessMeta({ failAtPage = Infinity, pageSize = 10 } = {}) {
  let served = 0;
  const base = fixture('keyword_us');
  return {
    get served() { return served; },
    async postForm(_url, body) {
      served++;
      if (served > failAtPage) throw new Error('the platform migrated this run');

      // Honour the cursor the way Meta does: `cursor-N` means "give me page
      // N+1". Without this the fake would replay page 1 on a resumed run and
      // prove nothing.
      const cursor = JSON.parse(body.variables).cursor;
      const pageNo = cursor ? Number(String(cursor).replace('cursor-', '')) + 1 : 1;

      const page = structuredClone(base);
      const conn = page.data.ad_library_main.search_results_connection;
      conn.page_info = { has_next_page: true, end_cursor: `cursor-${pageNo}` };
      conn.edges = conn.edges.slice(0, pageSize).map((edge, i) => {
        const clone = structuredClone(edge);
        for (const ad of clone.node.collated_results) ad.ad_archive_id = `ad-${pageNo}-${i}`;
        return clone;
      });
      return page;
    },
  };
}

function sinkFor(meta, store, extra = {}) {
  const pushed = [];
  const session = { id: 's', lsd: 'l', docId: 'd', requestCount: 0, http: meta };
  return {
    log: QUIET,
    now: NOW,
    acquireSession: async () => session,
    noteRequest() {},
    noteFailure: async () => false,
    async pushAds(ads, { billable = true } = {}) { if (billable) pushed.push(...ads); },
    loadCheckpoint: async () => store.value,
    saveCheckpoint: async (v) => { store.value = v; },
    get pushed() { return pushed; },
    ...extra,
  };
}

// --- unit ------------------------------------------------------------------

test('a checkpoint from a different query set is refused, not silently merged', () => {
  const previous = {
    version: CHECKPOINT_VERSION,
    fingerprint: inputFingerprint([{ queryKey: 'term:nike:US:active' }]),
    updatedAt: '2026-08-26T00:00:00.000Z',
    queries: { 'term:nike:US:active': { cursor: 'abc', done: false } },
    seenIds: ['1', '2'],
  };
  const cp = openCheckpoint({ queries: [{ queryKey: 'term:adidas:US:active' }], previous });

  assert.equal(cp.resumed, false, 'a different job must start clean');
  assert.equal(cp.cursorFor('term:adidas:US:active'), null);
  assert.equal(cp.carriedOver, 0);
});

test('a checkpoint written by an older version is ignored', () => {
  const cp = openCheckpoint({
    queries: [{ queryKey: 'k' }],
    previous: { version: 0, fingerprint: 'k', updatedAt: 'x', queries: { k: { cursor: 'c' } }, seenIds: ['1'] },
  });
  assert.equal(cp.resumed, false);
  assert.equal(cp.cursorFor('k'), null);
});

test('a corrupt or half-written record does not crash the run', () => {
  for (const junk of [null, undefined, 'nope', 42, {}, { version: CHECKPOINT_VERSION }]) {
    assert.doesNotThrow(() => openCheckpoint({ queries: [{ queryKey: 'k' }], previous: junk }));
  }
});

// --- the real thing --------------------------------------------------------

test('a run killed mid-pagination resumes at the exact page it reached', async () => {
  const store = { value: null };

  // First attempt: dies after 3 pages, like a platform migration.
  const first = endlessMeta({ failAtPage: 3 });
  const s1 = sinkFor(first, store);
  const r1 = await runScrape({ searchTerms: ['nike'], maxAds: 1000, maxPagesPerQuery: 50 }, s1);

  assert.equal(r1.totalAds, 30, 'three pages were delivered before the crash');
  assert.equal(r1.failures, 1, 'and the crash is reported, not hidden');
  assert.ok(store.value, 'progress was persisted');
  assert.equal(store.value.queries['term:nike:US+ALL:active'] ?? store.value.queries[Object.keys(store.value.queries)[0]].cursor, 'cursor-3');

  // Second attempt: same input, fresh process.
  const second = endlessMeta({ failAtPage: 2 });
  const s2 = sinkFor(second, store);
  const r2 = await runScrape({ searchTerms: ['nike'], maxAds: 1000, maxPagesPerQuery: 50 }, s2);

  assert.equal(r2.checkpoint.resumed, true, 'the second run knew it was a resume');
  assert.equal(r2.checkpoint.adsCarriedOver >= 30, true, 'it remembered what was already collected');
  // The ids differ per page, so anything it returns is genuinely new work.
  assert.equal(r2.totalAds, 20, 'only the two new pages were charged');
  assert.equal(r2.adsCharged, 20, 'nothing from the first attempt was billed twice');
});

test('resuming starts the request at the saved cursor, not at the top', async () => {
  const store = {
    value: {
      version: CHECKPOINT_VERSION,
      fingerprint: null,   // filled in below
      updatedAt: '2026-08-27T00:00:00.000Z',
      queries: {},
      seenIds: [],
    },
  };

  // Discover the real query key by running once against an immediately-terminal page.
  const probeStore = { value: null };
  const probe = endlessMeta({ failAtPage: 1 });
  await runScrape({ searchTerms: ['nike'], maxAds: 10, maxPagesPerQuery: 1 }, sinkFor(probe, probeStore));
  const queryKey = Object.keys(probeStore.value.queries)[0];

  store.value.fingerprint = queryKey;
  store.value.queries[queryKey] = { cursor: 'RESUME-HERE', ads: 10, done: false };

  const cursors = [];
  const meta = {
    async postForm(_url, body) {
      cursors.push(JSON.parse(body.variables).cursor);
      const page = structuredClone(fixture('keyword_us'));
      page.data.ad_library_main.search_results_connection.page_info = { has_next_page: false, end_cursor: null };
      return page;
    },
  };
  await runScrape({ searchTerms: ['nike'], maxAds: 100 }, sinkFor(meta, store));

  assert.equal(cursors[0], 'RESUME-HERE', 'the first request continued where the last attempt stopped');
});

test('a query that finished last time is not fetched again at all', async () => {
  const store = { value: null };

  const first = endlessMeta({ failAtPage: 1 });
  // A terminal page ends the query cleanly.
  first.postForm = async () => {
    const page = structuredClone(fixture('keyword_us'));
    page.data.ad_library_main.search_results_connection.page_info = { has_next_page: false, end_cursor: null };
    return page;
  };
  const r1 = await runScrape({ searchTerms: ['nike'], maxAds: 100 }, sinkFor(first, store));
  assert.equal(r1.totalAds, 10);

  let calls = 0;
  const second = { async postForm() { calls++; throw new Error('should never be called'); } };
  const r2 = await runScrape({ searchTerms: ['nike'], maxAds: 100 }, sinkFor(second, store));

  assert.equal(calls, 0, 'a completed query costs zero requests on resume');
  assert.equal(r2.totalAds, 0);
  assert.equal(r2.adsCharged, 0, 'and zero dollars');
  assert.equal(r2.failures, 0, 'it is a success, not a failure');
});

test('resumeFromCheckpoint:false forces a clean run', async () => {
  const store = { value: null };
  await runScrape({ searchTerms: ['nike'], maxAds: 100, maxPagesPerQuery: 2 },
    sinkFor(endlessMeta(), store));
  assert.ok(store.value, 'the first run saved progress');

  const meta = endlessMeta();
  const r = await runScrape(
    { searchTerms: ['nike'], maxAds: 100, maxPagesPerQuery: 2, resumeFromCheckpoint: false },
    sinkFor(meta, store),
  );
  assert.equal(r.checkpoint.resumed, false);
  assert.equal(r.totalAds, 20, 'it re-fetched from the top, as asked');
});

test('the checkpoint records progress page by page, not only at the end', async () => {
  const saves = [];
  const store = { value: null };
  const meta = endlessMeta({ failAtPage: 4 });
  const sink = sinkFor(meta, store, {
    saveCheckpoint: async (v) => { store.value = v; saves.push(structuredClone(v)); },
  });

  await runScrape({ searchTerms: ['nike'], maxAds: 1000, maxPagesPerQuery: 20 }, sink);

  assert.ok(saves.length >= 4, `expected a save per page, got ${saves.length}`);
  const cursors = saves.map((s) => Object.values(s.queries)[0]?.cursor);
  assert.deepEqual(cursors.slice(0, 4), ['cursor-1', 'cursor-2', 'cursor-3', 'cursor-4'],
    'each save advanced by exactly one page');
});

// --- the correctness property the whole feature rests on -------------------

test('a crashed run never marks an ad as done that the buyer did not receive', async () => {
  // The subtle failure mode: if progress were recorded before delivery, the
  // cursor would advance past ads that were collected but never shipped, and
  // the resumed run would skip them. That is silent data loss dressed up as a
  // feature. Here: everything the checkpoint remembers was actually pushed.
  const store = { value: null };
  const meta = endlessMeta({ failAtPage: 3 });
  const pushed = [];
  const sink = sinkFor(meta, store, {
    async pushAds(ads, { billable = true } = {}) { if (billable) pushed.push(...ads); },
  });

  await runScrape({ searchTerms: ['nike'], maxAds: 1000, maxPagesPerQuery: 50 }, sink);

  const deliveredIds = new Set(pushed.map((a) => a.id));
  const rememberedIds = store.value.seenIds;
  assert.ok(rememberedIds.length > 0, 'something was remembered');
  for (const id of rememberedIds) {
    assert.ok(deliveredIds.has(id), `checkpoint remembers ${id} but it was never delivered`);
  }
  assert.equal(rememberedIds.length, deliveredIds.size, 'remembered set == delivered set');
});

test('a budget-capped ad is not marked delivered, so a later run can still get it', async () => {
  // maxAds stops the run mid-page. The ads it refused must remain fetchable:
  // the buyer did not receive them and did not pay for them.
  const store = { value: null };
  const pushed = [];
  const sink = sinkFor(endlessMeta(), store, {
    async pushAds(ads, { billable = true } = {}) { if (billable) pushed.push(...ads); },
  });

  const r = await runScrape({ searchTerms: ['nike'], maxAds: 4, maxPagesPerQuery: 50 }, sink);

  assert.equal(r.totalAds, 4);
  assert.equal(r.capped, true);
  assert.equal(pushed.length, 4);
  assert.equal(store.value.seenIds.length, 4,
    'only the four delivered ads were remembered — the six refused ones stay available');
});

test('shipping happens page by page, not all at the end', async () => {
  // This is what makes the checkpoint meaningful: if delivery only happened at
  // the end, a crash would lose every page.
  const store = { value: null };
  const pushCalls = [];
  const sink = sinkFor(endlessMeta({ failAtPage: 4 }), store, {
    async pushAds(ads, { billable = true } = {}) { if (billable) pushCalls.push(ads.length); },
  });

  await runScrape({ searchTerms: ['nike'], maxAds: 1000, maxPagesPerQuery: 20 }, sink);

  // Four pages are served before the fake dies on the fifth request.
  assert.deepEqual(pushCalls, [10, 10, 10, 10], 'each page was delivered as it arrived');
});

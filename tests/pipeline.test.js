/**
 * End-to-end pipeline tests against the real payloads captured from Meta on
 * 2026-08-27. No network, no Apify SDK — a fake session replays the fixtures.
 *
 * These are the tests that would catch a regression a buyer would actually
 * feel: wrong billing, silent truncation, false "removed" reports, or a
 * pagination loop that never ends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runScrape, buildTargets, makeBudget } from '../src/scrape.js';
import { CATEGORY } from '../src/errors.js';

const fixture = (name) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
);

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const QUIET = { debug() {}, info() {}, warning() {}, error() {} };

/**
 * A sink that replays fixture pages instead of calling Meta.
 * `pages` is a list of raw GraphQL payloads, served in order; the session's
 * `postForm` hands back the next one each time it is called.
 */
function fakeSink(pages, extra = {}) {
  const pushed = [];
  const freeRows = [];
  let served = 0;

  const session = {
    id: 'test-session',
    lsd: 'lsd',
    docId: 'doc',
    requestCount: 0,
    http: {
      async postForm() {
        // Once the fixtures run out, answer with an empty terminal page so a
        // runaway loop shows up as a hang-free test failure, not a hang.
        if (served >= pages.length) {
          return { data: { ad_library_main: { search_results_connection: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } };
        }
        return pages[served++];
      },
    },
  };

  return {
    log: QUIET,
    now: NOW,
    acquireSession: async () => session,
    noteRequest: () => { session.requestCount++; },
    noteFailure: async () => false,
    async pushAds(ads, { billable = true } = {}) {
      if (billable) pushed.push(...ads);
      else freeRows.push(...ads);
    },
    get pushed() { return pushed; },
    get freeRows() { return freeRows; },
    get served() { return served; },
    ...extra,
  };
}

// --- input handling -------------------------------------------------------

test('buildTargets accepts all three input shapes and dedupes identical queries', () => {
  const { queries, rejected } = buildTargets({
    searchTerms: ['nike', 'nike'],
    pageIds: ['15087023444'],
    adLibraryUrls: ['https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&search_type=page&view_all_page_id=183869772601'],
    countries: ['US'],
  });
  assert.equal(rejected.length, 0);
  assert.equal(queries.length, 3, 'the duplicated search term collapses to one query');
  assert.ok(queries.some((q) => q.pageId === '183869772601'), 'the URL contributed its page id');
});

test('a bad page id is rejected as a named failure, not a dead run', () => {
  const { queries, rejected } = buildTargets({ pageIds: ['not-a-number'], searchTerms: ['nike'] });
  assert.equal(queries.length, 1, 'the good query survives');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].errorCategory, CATEGORY.INVALID_INPUT);
});

test('a non-Ad-Library URL is rejected with an explanation', () => {
  const { rejected } = buildTargets({ adLibraryUrls: ['https://example.com/whatever'] });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].errorMessage, /not a Facebook Ad Library URL/);
});

test('an invalid country code is a country_not_supported failure', () => {
  const { rejected } = buildTargets({ searchTerms: ['nike'], countries: ['USA'] });
  assert.equal(rejected[0].errorCategory, CATEGORY.COUNTRY_NOT_SUPPORTED);
});

// --- budgets --------------------------------------------------------------

test('maxCostUsd converts to an ad count and wins when it is the tighter cap', () => {
  const budget = makeBudget({ maxAds: 10_000, maxCostUsd: 3, pricePerAdUsd: 0.0006 });
  assert.equal(budget.limit, 5000);
  assert.equal(budget.reason, 'maxCostUsd');
});

test('maxCostUsd is ignored when the platform exposes no price, rather than guessing', () => {
  const budget = makeBudget({ maxAds: 100, maxCostUsd: 3, pricePerAdUsd: null });
  assert.equal(budget.limit, 100);
  assert.equal(budget.reason, 'maxAds');
});

// --- the run --------------------------------------------------------------

test('a plain run normalises the real payload and charges every unique ad', async () => {
  const sink = fakeSink([fixture('keyword_us')]);
  const summary = await runScrape({ searchTerms: ['nike'], countries: ['US'], maxAds: 100 }, sink);

  assert.equal(summary.totalAds, 10);
  assert.equal(summary.adsCharged, 10);
  assert.equal(summary.duplicatesDropped, 0);
  assert.equal(summary.failures, 0);
  assert.equal(summary.capped, false);

  const ad = sink.pushed[0];
  assert.match(ad.id, /^\d+$/);
  assert.equal(ad.source, 'web');
  assert.ok(ad.adLibraryUrl.includes(ad.id));
  assert.equal(typeof ad.body, 'string', 'body is a string, not Meta\'s {text} object');
  assert.ok(ad.pageName, 'advertiser name is populated');
  assert.equal(ad.scrapedAt, new Date(NOW).toISOString());
});

test('creatives are never empty across the fixture — the incumbent bug', async () => {
  // Meta hides most media inside snapshot.cards[]; reading only snapshot.images
  // is what produces the "empty adCreativeImages" complaint filed against the
  // official actor. Every ad in this fixture has at least one creative.
  const sink = fakeSink([fixture('keyword_us')]);
  await runScrape({ searchTerms: ['nike'], maxAds: 100 }, sink);

  const withMedia = sink.pushed.filter((a) => a.mediaCount > 0);
  assert.equal(withMedia.length, sink.pushed.length, 'every ad carries at least one image or video');

  const withCopy = sink.pushed.filter((a) => a.creativeBodies.length > 0);
  assert.equal(withCopy.length, sink.pushed.length, 'every ad carries at least one body');
});

test('political ads carry parsed spend and impressions', async () => {
  const sink = fakeSink([fixture('political_us')]);
  await runScrape({ searchTerms: ['senate'], adType: 'political', maxAds: 100 }, sink);

  const priced = sink.pushed.filter((a) => a.spend);
  assert.ok(priced.length >= 5, `expected several priced ads, got ${priced.length}`);
  for (const ad of priced) {
    assert.equal(ad.isPolitical, true);
    assert.equal(typeof ad.spend.lower, 'number');
    assert.ok(ad.spend.upper >= ad.spend.lower);
    assert.equal(ad.spend.currency, 'USD');
    assert.ok(ad.spend.raw, 'the original localised string is always kept');
  }
});

test('the same ad returned by two queries is billed once', async () => {
  // Serving the same page twice is exactly what happens when two search terms
  // surface the same advertiser.
  const sink = fakeSink([fixture('keyword_us'), fixture('keyword_us')]);
  const summary = await runScrape({ searchTerms: ['nike', 'sneakers'], maxAds: 100 }, sink);

  assert.equal(summary.totalAds, 10, 'the second query added nothing new');
  assert.equal(summary.duplicatesDropped, 10);
  assert.equal(summary.adsCharged, 10, 'duplicates are never charged');
});

test('maxAds truncates loudly, never silently', async () => {
  const sink = fakeSink([fixture('keyword_us')]);
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 4 }, sink);

  assert.equal(summary.totalAds, 4);
  assert.equal(summary.adsCharged, 4);
  assert.equal(summary.capped, true);
  assert.equal(summary.cappedBy, 'maxAds');
});

test('an empty result set is an answer, not a failure', async () => {
  const sink = fakeSink([fixture('no_results')]);
  const summary = await runScrape({ searchTerms: ['zzqqxxjjvv'], maxAds: 100 }, sink);

  assert.equal(summary.totalAds, 0);
  assert.equal(summary.queriesOk, 1, 'the query itself succeeded');
  assert.equal(summary.queries[0].errorCategory, CATEGORY.NO_RESULTS);
});

test('pagination stops when a cursor repeats instead of looping forever', async () => {
  // Both pages claim has_next_page with the same end_cursor.
  const page = fixture('keyword_us');
  const sink = fakeSink([page, page, page, page]);
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 1000 }, sink);

  assert.equal(summary.totalAds, 10);
  assert.ok(sink.served <= 2, `loop guard stopped after ${sink.served} request(s)`);
});

test('maxPagesPerQuery bounds a query that would paginate forever', async () => {
  // Distinct cursors on every page defeat the repeat guard, so the page cap is
  // the only thing standing between the buyer and an unbounded bill.
  let n = 0;
  const endless = () => {
    const page = structuredClone(fixture('keyword_us'));
    const conn = page.data.ad_library_main.search_results_connection;
    conn.page_info.end_cursor = `cursor-${n++}`;
    for (const edge of conn.edges) {
      for (const ad of edge.node.collated_results) ad.ad_archive_id = `${ad.ad_archive_id}-${n}`;
    }
    return page;
  };
  const sink = fakeSink(Array.from({ length: 20 }, endless));
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 10_000, maxPagesPerQuery: 3 }, sink);

  assert.equal(sink.served, 3, 'exactly three pages were requested');
  assert.equal(summary.totalAds, 30);
});

// --- monitor mode ---------------------------------------------------------

test('first monitor run marks everything new; the second charges nothing', async () => {
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  const first = fakeSink([fixture('keyword_us')], state);
  const r1 = await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, first);
  assert.equal(r1.monitorCounts.new, 10);
  assert.equal(r1.adsCharged, 10);
  assert.ok(saved, 'state was persisted');

  const second = fakeSink([fixture('keyword_us')], state);
  const r2 = await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, second);
  assert.equal(r2.monitorCounts.unchanged, 10);
  assert.equal(r2.monitorCounts.new, 0);
  assert.equal(r2.adsCharged, 0, 'unchanged ads are free — the core promise');
  assert.equal(r2.totalAds, 10, 'annotate mode still returns them');
});

test('changes-only returns nothing when nothing changed', async () => {
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  await runScrape({ searchTerms: ['nike'], monitorMode: 'changes-only', maxAds: 100 }, fakeSink([fixture('keyword_us')], state));
  const second = fakeSink([fixture('keyword_us')], state);
  const r2 = await runScrape({ searchTerms: ['nike'], monitorMode: 'changes-only', maxAds: 100 }, second);

  assert.equal(r2.totalAds, 0);
  assert.equal(r2.adsCharged, 0);
  assert.equal(second.pushed.length, 0);
});

test('an edited ad is reported as changed, with the field named', async () => {
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, fakeSink([fixture('keyword_us')], state));

  const edited = structuredClone(fixture('keyword_us'));
  edited.data.ad_library_main.search_results_connection.edges[0].node.collated_results[0].snapshot.body = { text: 'A totally new offer' };

  const second = fakeSink([edited], state);
  const r2 = await runScrape({ searchTerms: ['nike'], monitorMode: 'changes-only', maxAds: 100 }, second);

  assert.equal(r2.monitorCounts.changed, 1);
  assert.equal(r2.adsCharged, 1, 'only the changed ad is billed');
  assert.equal(second.pushed[0].status, 'changed');
  assert.ok(second.pushed[0].changedFields.includes('body'));
});

test('re-signed CDN URLs do not fake a change', async () => {
  // The signature parameters differ on every response. If the fingerprint saw
  // them, every ad would be "changed" on every run and the buyer would be
  // billed the full set daily — the exact failure this design exists to avoid.
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, fakeSink([fixture('keyword_us')], state));

  const resigned = structuredClone(fixture('keyword_us'));
  let touched = 0;
  for (const edge of resigned.data.ad_library_main.search_results_connection.edges) {
    for (const ad of edge.node.collated_results) {
      for (const card of ad.snapshot.cards ?? []) {
        if (typeof card.original_image_url === 'string' && card.original_image_url) {
          card.original_image_url = card.original_image_url.replace(/oh=[^&]*/, 'oh=00_DIFFERENT');
          touched++;
        }
      }
    }
  }
  assert.ok(touched > 0, 'the fixture really does carry signed URLs');

  const second = fakeSink([resigned], state);
  const r2 = await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, second);
  assert.equal(r2.monitorCounts.changed, 0, 're-signing is not a content change');
  assert.equal(r2.adsCharged, 0);
});

test('a failed query never reports its ads as removed', async () => {
  // The reliability rule from the research: a partial run must not look like a
  // competitor pulling their campaigns.
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, fakeSink([fixture('keyword_us')], state));

  const failing = fakeSink([], state);
  failing.acquireSession = async () => { throw new Error('network went away'); };

  const r2 = await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, failing);
  assert.equal(r2.monitorCounts.removed, 0, 'nothing was declared removed');
  assert.equal(failing.freeRows.length, 0);
  assert.equal(r2.failures, 1, 'the failure is reported instead');
});

test('an ad that really disappeared is reported removed, and for free', async () => {
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, fakeSink([fixture('keyword_us')], state));

  const shrunk = structuredClone(fixture('keyword_us'));
  const conn = shrunk.data.ad_library_main.search_results_connection;
  conn.edges = conn.edges.slice(0, 6);
  conn.page_info.has_next_page = false;
  conn.page_info.end_cursor = null;

  const second = fakeSink([shrunk], state);
  const r2 = await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, second);

  assert.equal(r2.monitorCounts.removed, 4);
  assert.equal(second.freeRows.length, 4);
  assert.equal(second.freeRows[0].status, 'removed');
  assert.equal(r2.adsCharged, 0, 'removals are never billed');
});

test('firstSeenAt is sticky across runs', async () => {
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  const first = fakeSink([fixture('keyword_us')], state);
  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, first);
  const originalFirstSeen = first.pushed[0].firstSeenAt;

  const later = fakeSink([fixture('keyword_us')], { ...state, now: NOW + 86_400_000 });
  later.now = NOW + 86_400_000;
  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, later);

  assert.equal(later.pushed[0].firstSeenAt, originalFirstSeen, 'the launch date never moves');
  assert.notEqual(later.pushed[0].lastSeenAt, originalFirstSeen, 'but lastSeenAt advances');
});

// --- self-healing against Meta redeploys ----------------------------------

test('a stale query id is re-resolved once and the page retried', async () => {
  // Meta rotating the persisted-query id is the documented reason competing
  // scrapers "break every few weeks". Here it costs one bundle read, not a run.
  // Terminal page, so the count below measures the retry and nothing else.
  const good = structuredClone(fixture('keyword_us'));
  good.data.ad_library_main.search_results_connection.page_info = { has_next_page: false, end_cursor: null };
  let calls = 0;
  let refreshed = 0;

  const session = {
    id: 's', lsd: 'lsd', docId: 'stale-id', requestCount: 0,
    http: {
      async postForm() {
        calls++;
        // First call answers with a payload we cannot read; after the refresh
        // the same call succeeds.
        return refreshed ? good : { data: {} };
      },
    },
  };

  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 100 }, {
    log: QUIET,
    now: NOW,
    acquireSession: async () => session,
    noteRequest() {},
    noteFailure: async () => false,
    refreshDocId: async () => { refreshed++; return true; },
    pushAds: async () => {},
  });

  assert.equal(refreshed, 1, 'the bundle was re-read exactly once');
  assert.equal(calls, 2, 'the failed page was retried, not abandoned');
  assert.equal(summary.totalAds, 10, 'the run recovered fully');
  assert.equal(summary.failures, 0);
});

test('when the id was not actually stale, the failure is still reported honestly', async () => {
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 100 }, {
    log: QUIET,
    now: NOW,
    acquireSession: async () => ({ id: 's', lsd: 'l', docId: 'd', http: { postForm: async () => ({ data: {} }) } }),
    noteRequest() {},
    noteFailure: async () => false,
    refreshDocId: async () => false,   // re-read, id unchanged
    pushAds: async () => {},
  });

  assert.equal(summary.queries[0].errorCategory, CATEGORY.SCHEMA_CHANGED);
  assert.equal(summary.totalAds, 0);
});

// --- the scaling signal: duplicate movement between runs -------------------

test('a creative appearing in more ad sets is reported as scaling', async () => {
  // "the duplicate tracking over time is the part most people miss, that's
  // where you actually see the scaling signal". The raw count is weak; the
  // delta between runs is the signal.
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  const day1 = structuredClone(fixture('keyword_us'));
  day1.data.ad_library_main.search_results_connection.edges[0].node.collated_results[0].collation_count = 2;
  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, fakeSink([day1], state));

  const day2 = structuredClone(day1);
  day2.data.ad_library_main.search_results_connection.edges[0].node.collated_results[0].collation_count = 9;

  const second = fakeSink([day2], state);
  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, second);

  const tracked = second.pushed.find((a) => a.variantCountPrev === 2);
  assert.ok(tracked, 'the ad carried its previous variant count forward');
  assert.equal(tracked.variantCount, 9);
  assert.equal(tracked.variantDelta, 7);
  assert.equal(tracked.isScaling, true);
  assert.equal(tracked.status, 'unchanged', 'the creative itself did not change — only its spread');
});

test('a steady creative is not reported as scaling', async () => {
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, fakeSink([fixture('keyword_us')], state));
  const second = fakeSink([fixture('keyword_us')], state);
  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, second);

  assert.ok(second.pushed.every((a) => a.isScaling === false), 'nothing moved, nothing flagged');
  assert.ok(second.pushed.every((a) => a.variantDelta === 0));
});

test('daysTracked counts how long this monitor has watched the ad', async () => {
  let saved = null;
  const state = { loadState: async () => saved, saveState: async (s) => { saved = s; } };

  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, fakeSink([fixture('keyword_us')], state));

  const later = fakeSink([fixture('keyword_us')], state);
  later.now = NOW + 5 * 86_400_000;
  await runScrape({ searchTerms: ['nike'], monitorMode: 'annotate', maxAds: 100 }, later);

  assert.equal(later.pushed[0].daysTracked, 5);
});

// --- the completeness verdict ---------------------------------------------

test('a run that saw everything reports COMPLETE', async () => {
  const page = structuredClone(fixture('keyword_us'));
  page.data.ad_library_main.search_results_connection.page_info = { has_next_page: false, end_cursor: null };
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 100 }, fakeSink([page]));

  assert.equal(summary.runStatus, 'COMPLETE');
  assert.deepEqual(summary.incompleteBecause, []);
  assert.equal(summary.queries[0].complete, true);
});

test('hitting the page budget reports PARTIAL and names the cause', async () => {
  // "A cheaper run that quietly stops paginating isn't actually cheaper, it's
  // just wrong in a way that doesn't throw an error."
  let n = 0;
  const endless = () => {
    const p = structuredClone(fixture('keyword_us'));
    const conn = p.data.ad_library_main.search_results_connection;
    conn.page_info = { has_next_page: true, end_cursor: `c-${n++}` };
    for (const e of conn.edges) for (const a of e.node.collated_results) a.ad_archive_id = `${a.ad_archive_id}-${n}`;
    return p;
  };
  const summary = await runScrape(
    { searchTerms: ['nike'], maxAds: 10_000, maxPagesPerQuery: 2 },
    fakeSink(Array.from({ length: 10 }, endless)),
  );

  assert.equal(summary.runStatus, 'PARTIAL');
  assert.ok(summary.incompleteBecause.some((r) => /maxPagesPerQuery/.test(r)));
  assert.equal(summary.queries[0].complete, false);
  assert.equal(summary.queries[0].truncatedBy, 'maxPagesPerQuery');
});

test('the spend cap also makes the run PARTIAL, and says so', async () => {
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 4 }, fakeSink([fixture('keyword_us')]));
  assert.equal(summary.runStatus, 'PARTIAL');
  assert.ok(summary.incompleteBecause.some((r) => /maxAds cap/.test(r)));
});

test('every query failing reports FAILED, not PARTIAL', async () => {
  const sink = fakeSink([]);
  sink.acquireSession = async () => { throw new Error('network gone'); };
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 100 }, sink);

  assert.equal(summary.runStatus, 'FAILED');
  assert.equal(summary.queriesOk, 0);
});

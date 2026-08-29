/**
 * Filters, and the promise attached to them: a filtered ad is never billed.
 *
 * The official actor closed a request for exactly this with "please filter out
 * the dataset using third-party tools" — which means paying for every row you
 * then discard. These tests pin the opposite behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeFilter, parseDateInput } from '../src/filters.js';
import { runScrape } from '../src/scrape.js';
import { extractPage, normalizeAd } from '../src/normalize.js';

const fixture = (name) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
);
const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const QUIET = { debug() {}, info() {}, warning() {}, error() {} };

const realAds = (name = 'keyword_us') =>
  extractPage(fixture(name)).ads.map((r) => normalizeAd(r, { now: NOW }));

function sinkOnce(page) {
  const pushed = [];
  let served = 0;
  return {
    log: QUIET,
    now: NOW,
    acquireSession: async () => ({
      id: 's', lsd: 'l', docId: 'd',
      http: {
        async postForm() {
          if (served++) {
            return { data: { ad_library_main: { search_results_connection: { edges: [], page_info: { has_next_page: false } } } } };
          }
          const p = structuredClone(page);
          p.data.ad_library_main.search_results_connection.page_info = { has_next_page: false, end_cursor: null };
          return p;
        },
      },
    }),
    noteRequest() {}, noteFailure: async () => false,
    async pushAds(ads, { billable = true } = {}) { if (billable) pushed.push(...ads); },
    get pushed() { return pushed; },
  };
}

// --- date parsing ----------------------------------------------------------

test('dates accept ISO and the relative form people actually type', () => {
  assert.equal(parseDateInput('2026-01-15'), Date.UTC(2026, 0, 15) / 1000);
  assert.equal(parseDateInput('30 days', NOW), Math.floor(NOW / 1000) - 30 * 86400);
  assert.equal(parseDateInput('6 months', NOW), Math.floor(NOW / 1000) - 180 * 86400);
  assert.equal(parseDateInput(''), null);
  assert.equal(parseDateInput('not a date'), null);
});

test('an unparseable date is reported, never silently dropped', () => {
  const f = makeFilter({ startedAfter: 'whenever' }, { now: NOW });
  assert.equal(f.active.length, 0, 'the broken filter is not applied');
  assert.equal(f.rejected.length, 1);
  assert.match(f.rejected[0], /startedAfter/);
});

// --- the filters themselves, on real ads -----------------------------------

test('minDaysRunning keeps only long-running ads — the signal everyone sorts by', () => {
  const ads = realAds();
  const f = makeFilter({ minDaysRunning: 60 }, { now: NOW });
  const kept = ads.filter((a) => f.apply(a));

  assert.ok(kept.length < ads.length, 'the filter actually removed something');
  for (const a of kept) assert.ok(a.totalActiveDays >= 60, `${a.id} ran ${a.totalActiveDays} days`);
  assert.equal(f.report().removedByFilter.minDaysRunning, ads.length - kept.length);
});

test('publisherPlatforms matches case-insensitively', () => {
  const ads = realAds();
  const kept = ads.filter((a) => makeFilter({ publisherPlatforms: ['instagram'] }).apply(a));
  assert.ok(kept.length > 0, 'the fixture has Instagram ads');
  for (const a of kept) assert.ok(a.platforms.map((p) => p.toLowerCase()).includes('instagram'));
});

test('requireMedia drops ads with no creative at all', () => {
  const withoutMedia = normalizeAd({ ad_archive_id: '1', page_id: '2', is_active: true });
  const f = makeFilter({ requireMedia: true });
  assert.equal(f.apply(withoutMedia), false);
  assert.ok(realAds().filter((a) => f.apply(a)).length > 0);
});

test('excludeDisplayFormats removes the format known for empty creatives', () => {
  const ads = realAds();
  const formats = new Set(ads.map((a) => a.displayFormat).filter(Boolean));
  const victim = [...formats][0];
  const kept = ads.filter((a) => makeFilter({ excludeDisplayFormats: [victim] }).apply(a));
  assert.ok(kept.every((a) => a.displayFormat !== victim));
  assert.ok(kept.length < ads.length);
});

test('bodyContains and bodyExcludes search all the copy, not just the top-level body', () => {
  const ads = realAds();
  const word = ads.find((a) => a.creativeBodies.length)?.creativeBodies[0].split(/\s+/)[0];
  assert.ok(word, 'the fixture has ad copy');

  const kept = ads.filter((a) => makeFilter({ bodyContains: [word] }).apply(a));
  assert.ok(kept.length > 0, `no ad matched "${word}"`);

  const excluded = ads.filter((a) => makeFilter({ bodyExcludes: [word] }).apply(a));
  assert.equal(kept.length + excluded.length, ads.length, 'contains and excludes partition the set');
});

test('linkDomains matches subdomains too', () => {
  const f = makeFilter({ linkDomains: ['nike.com'] });
  assert.equal(f.apply({ linkDomain: 'nike.com', platforms: [] }), true);
  assert.equal(f.apply({ linkDomain: 'shop.nike.com', platforms: [] }), true);
  assert.equal(f.apply({ linkDomain: 'notnike.com', platforms: [] }), false);
  assert.equal(f.apply({ linkDomain: null, platforms: [] }), false);
});

test('minVariantCount isolates creatives being scaled across ad sets', () => {
  const ads = realAds('political_us').concat(realAds());
  const kept = ads.filter((a) => makeFilter({ minVariantCount: 2 }).apply(a));
  assert.ok(kept.length > 0, 'the fixtures contain collated ads');
  for (const a of kept) assert.ok(a.variantCount >= 2);
});

test('a filter never throws on a malformed record', () => {
  const f = makeFilter({
    minDaysRunning: 10, publisherPlatforms: ['facebook'], linkDomains: ['x.com'],
    bodyContains: ['a'], requireMedia: true, minVariantCount: 2,
  });
  for (const junk of [{}, { platforms: null }, { platforms: 'nope' }, null]) {
    assert.doesNotThrow(() => f.apply(junk ?? {}));
  }
});

// --- the billing promise ---------------------------------------------------

test('filtered ads are never charged, and the SUMMARY says how many went', async () => {
  const sink = sinkOnce(fixture('keyword_us'));
  const summary = await runScrape(
    { searchTerms: ['nike'], maxAds: 100, minDaysRunning: 60 },
    sink,
  );

  const total = extractPage(fixture('keyword_us')).ads.length;
  assert.ok(summary.totalAds < total, 'the filter removed ads');
  assert.equal(summary.adsCharged, summary.totalAds, 'only surviving ads were charged');
  assert.equal(sink.pushed.length, summary.totalAds);

  assert.ok(summary.filters.filtersActive.includes('minDaysRunning'));
  assert.equal(
    summary.filters.removedByFilter.minDaysRunning,
    total - summary.totalAds,
    'the SUMMARY accounts for every removed ad',
  );
});

test('with no filters configured the report is empty and nothing is removed', async () => {
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 100 }, sinkOnce(fixture('keyword_us')));
  assert.deepEqual(summary.filters.filtersActive, []);
  assert.equal(summary.filters.totalRemoved, 0);
  assert.equal(summary.totalAds, 10);
});

// --- finding the right advertiser, not the same-named one -----------------

test('advertiserDomains searches the brand name and keeps only its own ads', async () => {
  // "multiple unrelated Facebook Pages share the exact same name" — searching
  // by name alone returns impostors. The domain decides which one is real.
  const { buildTargets, brandTermFromDomain } = await import('../src/scrape.js');

  assert.equal(brandTermFromDomain('nike.com'), 'nike');
  assert.equal(brandTermFromDomain('https://shop.marksandspencer.co.uk/x'), 'marksandspencer');
  assert.equal(brandTermFromDomain('not-a-domain'), null);

  const { queries, rejected } = buildTargets({ advertiserDomains: ['nike.com'] });
  assert.equal(rejected.length, 0);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].searchTerm, 'nike', 'it searches the brand name');

  // ...and the filter half keeps only ads that actually point at the site.
  const f = makeFilter({ advertiserDomains: ['nike.com'] });
  assert.equal(f.apply({ linkDomain: 'nike.com', platforms: [] }), true);
  assert.equal(f.apply({ linkDomain: 'shop.nike.com', platforms: [] }), true);
  assert.equal(f.apply({ linkDomain: 'nike-fanclub.de', platforms: [] }), false,
    'the same-named impostor is dropped');
});

test('a malformed advertiser domain is a named rejection, not a silent miss', async () => {
  const { buildTargets } = await import('../src/scrape.js');
  const { rejected } = buildTargets({ advertiserDomains: ['nonsense'] });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].errorMessage, /is not a domain/);
});

test('maxAdsPerPage collapses a keyword search down to N ads per advertiser', () => {
  // The filter counts what it has already let through, so one instance is
  // shared across the whole run — building a fresh one per ad would reset it.
  const ads = realAds('page_id_nike');   // every ad from one advertiser
  const single = makeFilter({ maxAdsPerPage: 1 });
  const kept = ads.filter((a) => single.apply(a));
  assert.equal(kept.length, 1, 'one ad per advertiser, as asked');

  // Two advertisers, two survivors.
  const mixed = [
    { pageId: 'a', platforms: [] }, { pageId: 'a', platforms: [] },
    { pageId: 'b', platforms: [] }, { pageId: 'b', platforms: [] },
  ];
  const f = makeFilter({ maxAdsPerPage: 1 });
  assert.deepEqual(mixed.filter((r) => f.apply(r)).map((r) => r.pageId), ['a', 'b']);
});

test('maxAdsPerPage cuts the bill, not just the spreadsheet', async () => {
  const sink = sinkOnce(fixture('page_id_nike'));
  const summary = await runScrape({ searchTerms: ['nike'], maxAds: 100, maxAdsPerPage: 2 }, sink);

  assert.equal(summary.totalAds, 2, 'only two ads survived');
  assert.equal(summary.adsCharged, 2, 'and only two were charged');
  assert.ok(summary.filters.removedByFilter.maxAdsPerPage >= 1);
});

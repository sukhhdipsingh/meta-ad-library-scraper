/**
 * Contract tests: the early-warning system for Meta changing their payload.
 *
 * The single most common complaint about Ad Library scrapers is that they
 * "break every few weeks when Facebook changes their frontend". Breaking is
 * partly unavoidable. Breaking *silently* — shipping rows full of nulls that
 * nobody notices until a customer complains — is not.
 *
 * So these tests assert two different things:
 *
 *   1. Against the committed fixtures: the output contract holds. Every
 *      documented key exists, with the documented type. If someone refactors
 *      normalize.js and drops a column, this fails by name.
 *   2. Against deliberately mutated payloads: when Meta moves a field, the code
 *      fails loudly with `schema_changed` and says which field, rather than
 *      quietly returning empty results.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractPage, normalizeAd, REQUIRED_RAW_FIELDS } from '../src/normalize.js';
import { runScrape } from '../src/scrape.js';
import { CATEGORY } from '../src/errors.js';

const fixture = (name) => JSON.parse(
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
);
const POPULATED = ['keyword_us', 'page_id_nike', 'eu_dsa_de', 'political_us', 'inactive', 'all_countries'];
const QUIET = { debug() {}, info() {}, warning() {}, error() {} };

const rawAds = (name) => extractPage(fixture(name)).ads;

/** The public output contract from docs/CONTRACT.md §1, as a type map.
 *  'string?' means "string or null" — never undefined, never missing. */
const SHAPE = {
  id: 'string', adId: 'string?', source: 'string', adLibraryUrl: 'string?',
  pageId: 'string?', pageName: 'string?', pageUrl: 'string?',
  pageProfilePictureUrl: 'string?', pageLikeCount: 'number?',
  pageCategories: 'array', pageIsDeleted: 'boolean', byline: 'string?',
  isActive: 'boolean', startDate: 'string?', endDate: 'string?',
  startDateEpoch: 'number?', endDateEpoch: 'number?', totalActiveDays: 'number?',
  title: 'string?', body: 'string?', caption: 'string?', linkUrl: 'string?',
  linkDescription: 'string?', ctaText: 'string?', ctaType: 'string?',
  displayFormat: 'string?', creativeBodies: 'array', creativeTitles: 'array',
  creativeLinkUrls: 'array', images: 'array', videos: 'array', cards: 'array',
  mediaCount: 'number', platforms: 'array', languages: 'array', countries: 'array',
  variantCount: 'number', collationId: 'string?', linkDomain: 'string?',
  linkUrlClean: 'string?', utm: 'object', creativeType: 'string',
  containsInjectionRisk: 'boolean',
  transparencyAvailable: 'boolean',
  isPolitical: 'boolean', categories: 'array', spend: 'object?',
  impressions: 'object?', impressionsIndex: 'number', reachEstimate: 'number?',
  euTotalReach: 'number?', demographics: 'array', scrapedAt: 'string',
};

function checkType(value, spec, where) {
  const optional = spec.endsWith('?');
  const base = optional ? spec.slice(0, -1) : spec;
  assert.notEqual(value, undefined, `${where} must exist (undefined breaks CSV/spreadsheet exports)`);
  if (value === null) {
    assert.ok(optional, `${where} is null but the contract says it is always ${base}`);
    return;
  }
  if (base === 'array') assert.ok(Array.isArray(value), `${where} must be an array`);
  else if (base === 'object') assert.equal(typeof value, 'object', `${where} must be an object`);
  else assert.equal(typeof value, base, `${where} must be a ${base}`);
}

test('every fixture ad matches the published output contract exactly', () => {
  let checked = 0;
  for (const name of POPULATED) {
    for (const raw of rawAds(name)) {
      const record = normalizeAd(raw, { now: Date.parse('2026-08-27T12:00:00Z') });
      for (const [key, spec] of Object.entries(SHAPE)) {
        checkType(record[key], spec, `${name}: ${key}`);
      }
      // No stray keys either: an undocumented column today is a column someone
      // depends on tomorrow.
      for (const key of Object.keys(record)) {
        assert.ok(key in SHAPE, `${name}: "${key}" is not in the documented contract`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 50, `expected to check the whole corpus, checked ${checked}`);
});

test('arrays are never null, so exports keep their columns', () => {
  for (const name of POPULATED) {
    for (const raw of rawAds(name)) {
      const r = normalizeAd(raw);
      for (const key of ['pageCategories', 'creativeBodies', 'creativeTitles', 'creativeLinkUrls',
        'images', 'videos', 'cards', 'platforms', 'languages', 'countries', 'categories', 'demographics']) {
        assert.ok(Array.isArray(r[key]), `${name}: ${key} must be an array, got ${r[key]}`);
      }
    }
  }
});

test('the fields the whole pipeline keys on are present in every real ad', () => {
  for (const name of POPULATED) {
    for (const raw of rawAds(name)) {
      for (const field of REQUIRED_RAW_FIELDS) {
        assert.ok(field in raw, `${name}: Meta stopped sending "${field}" — dedup and billing key on it`);
      }
    }
  }
});

// --- drift detection ------------------------------------------------------

test('a moved connection is reported as schema_changed, naming the path', async () => {
  const broken = { data: { ad_library_main: { renamed_connection: {} } } };
  const summary = await runScrape({ searchTerms: ['nike'] }, {
    log: QUIET,
    acquireSession: async () => ({ http: { postForm: async () => broken } }),
    noteRequest() {},
    noteFailure: async () => false,
    pushAds: async () => {},
  });

  assert.equal(summary.queries[0].errorCategory, CATEGORY.SCHEMA_CHANGED);
  assert.match(summary.queries[0].errorMessage, /search_results_connection\.edges/,
    'the message must name the missing path so the fix is one module wide');
});

test('a completely foreign payload fails as schema_changed, not as a crash', async () => {
  const summary = await runScrape({ searchTerms: ['nike'] }, {
    log: QUIET,
    acquireSession: async () => ({ http: { postForm: async () => ({ hello: 'world' }) } }),
    noteRequest() {},
    noteFailure: async () => false,
    pushAds: async () => {},
  });
  assert.equal(summary.queries[0].errorCategory, CATEGORY.SCHEMA_CHANGED);
  assert.equal(summary.totalAds, 0);
});

test('an ad stripped of its snapshot still yields a contract-shaped row', () => {
  // Meta occasionally returns a gated or withheld ad with almost nothing in it.
  // That must degrade to nulls, not throw and lose the other 9 ads on the page.
  const record = normalizeAd({ ad_archive_id: '123', page_id: '456', is_active: true });
  for (const [key, spec] of Object.entries(SHAPE)) checkType(record[key], spec, `stripped: ${key}`);
  assert.equal(record.id, '123');
  assert.equal(record.body, null);
  assert.equal(record.mediaCount, 0);
});

test('normalizeAd never throws, whatever it is handed', () => {
  for (const junk of [null, undefined, {}, { snapshot: null }, { snapshot: 'nope' },
    { ad_archive_id: 1, snapshot: { cards: 'not-an-array', body: 42 } }]) {
    assert.doesNotThrow(() => normalizeAd(junk), `threw on ${JSON.stringify(junk)}`);
  }
});

// --- the promise that sells the actor -------------------------------------

test('media extraction beats the naive snapshot.images approach on real data', () => {
  // This is the measured claim in the README. If a refactor ever makes it
  // false, the README becomes a lie — so it is a test, not a comment.
  let naive = 0;
  let actual = 0;
  for (const name of POPULATED) {
    for (const raw of rawAds(name)) {
      naive += (raw.snapshot?.images?.length ?? 0) + (raw.snapshot?.videos?.length ?? 0);
      actual += normalizeAd(raw).mediaCount;
    }
  }
  assert.ok(actual > naive * 3,
    `expected the card-aware extractor to find far more media; naive=${naive} actual=${actual}`);
});

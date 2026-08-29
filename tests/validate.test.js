/**
 * Input validation — the cheapest bug fix in this whole category.
 *
 * Two users of a competing actor were billed $17 and $15 because they wrote
 * `maxAds` where that actor's field was `resultsLimit`. It accepted the unknown
 * key silently and ran uncapped. These tests make that failure mode impossible
 * here, and make the error message point at the fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateInput, KNOWN_INPUT_KEYS } from '../src/validate.js';
import { CATEGORY } from '../src/errors.js';

const rejects = (input) => {
  try {
    validateInput(input);
    return null;
  } catch (err) {
    assert.equal(err.category, CATEGORY.INVALID_INPUT, `wrong category for ${JSON.stringify(input)}`);
    return err.message;
  }
};

test('a valid input passes', () => {
  assert.doesNotThrow(() => validateInput({
    searchTerms: ['nike'], countries: ['US'], activeStatus: 'active',
    adType: 'all', mediaType: 'all', maxAds: 500, monitorMode: 'off',
  }));
});

test('an unknown field is refused before anything is charged', () => {
  const msg = rejects({ searchTerms: ['nike'], resultsLimitt: 10 });
  assert.ok(msg, 'an unknown key must be rejected');
  assert.match(msg, /Unknown input field "resultsLimitt"/);
  assert.match(msg, /nothing was charged/i, 'the message must reassure about billing');
});

test("a competitor's field name is named, with the local equivalent", () => {
  // This is the exact typo that cost two people real money elsewhere.
  for (const [foreign, ours] of [['resultsLimit', 'maxAds'], ['limitPerSource', 'maxAds'],
    ['urls', 'adLibraryUrls'], ['searchQueries', 'searchTerms'], ['country', 'countries']]) {
    const msg = rejects({ searchTerms: ['nike'], [foreign]: 'x' });
    assert.ok(msg, `${foreign} should be rejected`);
    assert.match(msg, new RegExp(`Did you mean "${ours}"`), `no pointer from ${foreign} to ${ours}`);
  }
});

test('a near-miss typo suggests the right field', () => {
  const msg = rejects({ searchTerms: ['nike'], maxAd: 10 });
  assert.match(msg, /Did you mean "maxAds"/);
});

test('a field belonging to another actor is called out as such', () => {
  const msg = rejects({ searchTerms: ['nike'], scrapeAdDetails: true });
  assert.match(msg, /belongs to a different Ad Library actor/);
});

test('an empty input says what to provide', () => {
  const msg = rejects({});
  assert.match(msg, /searchTerms, pageIds, advertiserDomains or adLibraryUrls/);
});

test('an enum outside its range is refused, listing the valid values', () => {
  assert.match(rejects({ searchTerms: ['x'], activeStatus: 'ACTIVE' }), /must be one of active, inactive, all/);
  assert.match(rejects({ searchTerms: ['x'], adType: 'politics' }), /must be one of all, political/);
  assert.match(rejects({ searchTerms: ['x'], monitorMode: 'diff' }), /off, annotate or changes-only/);
});

test('a non-numeric or negative cap is refused rather than treated as unlimited', () => {
  for (const bad of ['lots', -1, 0, 1.5, {}]) {
    assert.ok(rejects({ searchTerms: ['x'], maxAds: bad }), `maxAds=${JSON.stringify(bad)} must be refused`);
  }
});

test('a scalar where a list belongs is refused with an example', () => {
  assert.match(rejects({ searchTerms: 'nike' }), /must be a list, e\.g\. \["nike"\]/);
});

test('the input is warned about, not refused, when the default cap applies', () => {
  const { warnings } = validateInput({ searchTerms: ['nike'] });
  assert.ok(warnings.some((w) => /default cap of 1000/.test(w)));
});

test('changes-only without a monitorId warns about the shared memory', () => {
  const { warnings } = validateInput({ searchTerms: ['nike'], maxAds: 10, monitorMode: 'changes-only' });
  assert.ok(warnings.some((w) => /monitorId/.test(w)));
});

test('every field in the published input schema is accepted', async () => {
  // Guards against the schema and the validator drifting apart, which would
  // reject a field the UI offers.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const schema = JSON.parse(readFileSync(
    fileURLToPath(new URL('../.actor/input_schema.json', import.meta.url)), 'utf8'));

  for (const key of Object.keys(schema.properties)) {
    assert.ok(KNOWN_INPUT_KEYS.has(key), `input_schema.json offers "${key}" but the validator rejects it`);
  }
});

// --- the published schema must satisfy Apify's own build-time rules --------

test('input_schema.json passes the checks Apify runs at build time', async () => {
  // A build failed on exactly this: "Field schema.properties.mediaType.description
  // is required". Catching it here costs a second; catching it on the platform
  // costs a failed build.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const schema = JSON.parse(readFileSync(
    fileURLToPath(new URL('../.actor/input_schema.json', import.meta.url)), 'utf8'));

  assert.equal(schema.schemaVersion, 1);
  assert.ok(schema.title, 'the schema needs a title');
  assert.equal(schema.type, 'object');

  for (const [key, field] of Object.entries(schema.properties)) {
    assert.ok(field.title, `${key}: title is required`);
    assert.ok(field.description, `${key}: description is required`);
    assert.ok(field.type, `${key}: type is required`);
    // An editor is mandatory for string and array fields.
    if (field.type === 'array' || field.type === 'string') {
      assert.ok(field.editor, `${key}: an ${field.type} field needs an editor`);
    }
    if (field.enum) {
      assert.ok(Array.isArray(field.enumTitles), `${key}: enum needs enumTitles`);
      assert.equal(field.enum.length, field.enumTitles.length, `${key}: enum/enumTitles length mismatch`);
    }
  }
});

test('actor.json points at files that exist', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../.actor/', import.meta.url));
  const actor = JSON.parse(readFileSync(`${dir}actor.json`, 'utf8'));

  for (const key of ['input', 'readme', 'changelog', 'dockerfile']) {
    if (!actor[key]) continue;
    assert.ok(existsSync(new URL(actor[key], `file://${dir}`)), `actor.json ${key} -> ${actor[key]} is missing`);
  }
  assert.ok(existsSync(new URL(actor.storages.dataset, `file://${dir}`)), 'dataset schema is missing');
});

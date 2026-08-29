/**
 * Meta declining to answer is not Meta changing its schema.
 *
 * The bug this file guards against cost a whole production run: the Ad Library
 * answered HTTP 200 with a refusal in the body, the code saw no `data` and
 * reported `schema_changed` — a category nothing retries — so a failure that a
 * fresh exit IP would have fixed killed the run instead. These tests pin the
 * three readings apart: refusal (rotate), rotated query id (re-read the
 * bundle), genuinely unrecognised body (schema_changed, and say what arrived).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { readMetaError, classifyMetaError, CATEGORY } from '../src/errors.js';
import { fetchPage, buildQuery } from '../src/sources/weblibrary.js';
import { runScrape } from '../src/scrape.js';

const QUIET = { debug() {}, info() {}, warning() {}, error() {} };

const sessionServing = (payload) => ({
  id: 's', lsd: 'lsd', docId: 'doc', requestCount: 0,
  http: { postForm: async () => payload },
});

const query = () => buildQuery({ searchTerm: 'nike' }, {});

describe('reading the refusal Meta put in an HTTP 200', () => {
  test('the flat shape, which is what the soft block uses', () => {
    assert.deepEqual(
      readMetaError({ __ar: 1, error: 1357054, errorSummary: "Your Request Couldn't be Processed" }),
      { code: 1357054, message: "Your Request Couldn't be Processed" },
    );
  });

  test('the GraphQL errors array, which the top-level read used to miss', () => {
    assert.deepEqual(
      readMetaError({ errors: [{ code: 1675004, summary: 'Rate limit exceeded' }] }),
      { code: 1675004, message: 'Rate limit exceeded' },
    );
  });

  test('the nested object shape', () => {
    assert.deepEqual(
      readMetaError({ error: { code: 1357001, message: 'You must log in to continue' } }),
      { code: 1357001, message: 'You must log in to continue' },
    );
  });

  test('a body with no refusal in it reads as no refusal', () => {
    assert.equal(readMetaError({ hello: 'world' }), null);
    assert.equal(readMetaError({ data: { ad_library_main: {} } }), null);
    assert.equal(readMetaError(null), null);
  });
});

describe('what each refusal means', () => {
  test('a rotated persisted query asks for a bundle re-read, not a proxy rotation', () => {
    assert.equal(
      classifyMetaError({ code: null, message: 'Query with id 24922295957467452 does not exist' }),
      CATEGORY.DOC_ID_STALE,
    );
  });

  test('a login wall is a blocked exit IP', () => {
    assert.equal(
      classifyMetaError({ code: 1357001, message: 'You must log in to continue' }),
      CATEGORY.BLOCKED,
    );
  });

  test('an unrecognised refusal is treated as transient, so the run rotates instead of dying', () => {
    assert.equal(
      classifyMetaError({ code: 999999, message: 'Sorry, something went wrong' }),
      CATEGORY.RATE_LIMITED,
    );
  });
});

describe('fetchPage turns the refusal into a recoverable failure', () => {
  test('a data-less body carrying a refusal is never schema_changed', async () => {
    await assert.rejects(
      () => fetchPage(query(), null, {
        session: sessionServing({ errors: [{ code: 1675004, summary: 'Please try again later' }] }),
      }),
      (err) => {
        assert.equal(err.category, CATEGORY.RATE_LIMITED);
        assert.match(err.message, /1675004/);
        assert.match(err.message, /Please try again later/, 'Meta\'s own words reach the log');
        return true;
      },
    );
  });

  test('a data-less body with no refusal is schema_changed, and names what did arrive', async () => {
    await assert.rejects(
      () => fetchPage(query(), null, { session: sessionServing({ hello: 'world', extensions: {} }) }),
      (err) => {
        assert.equal(err.category, CATEGORY.SCHEMA_CHANGED);
        assert.match(err.message, /hello, extensions/, 'the shape is in the message, not just "expected data"');
        return true;
      },
    );
  });
});

describe('the run recovers instead of failing', () => {
  test('a refused page is retried on a fresh session and the query completes', async () => {
    const good = {
      data: { ad_library_main: { search_results_connection: {
        edges: [{ node: { collated_results: [{
          ad_archive_id: '1', page_id: '9', page_name: 'Nike', is_active: true,
          snapshot: { body: { text: 'hi' }, images: [], cards: [], videos: [] },
        }] } }],
        page_info: { has_next_page: false, end_cursor: null },
      } } },
    };
    let call = 0;
    const rotated = [];
    const summary = await runScrape({ searchTerms: ['nike'], maxAds: 10 }, {
      log: QUIET,
      acquireSession: async () => ({
        id: `s${call}`, lsd: 'l', docId: 'd',
        http: { postForm: async () => (++call === 1 ? { errors: [{ code: 1675004, summary: 'slow down' }] } : good) },
      }),
      noteRequest() {},
      noteFailure: async (_s, err) => { rotated.push(err.category); return true; },
      pushAds: async () => {},
    });

    assert.deepEqual(rotated, [CATEGORY.RATE_LIMITED], 'the refusal rotated the exit IP');
    assert.equal(summary.failures, 0, 'and the run recovered rather than reporting a failure');
    assert.equal(summary.totalAds, 1);
  });

  test('a rotated query id triggers the bundle re-read, not a proxy rotation', async () => {
    let refreshed = 0;
    let call = 0;
    const good = {
      data: { ad_library_main: { search_results_connection: {
        edges: [], page_info: { has_next_page: false, end_cursor: null },
      } } },
    };
    await runScrape({ searchTerms: ['nike'], maxAds: 10 }, {
      log: QUIET,
      acquireSession: async () => ({
        id: 's', lsd: 'l', docId: 'd',
        http: {
          postForm: async () => (++call === 1
            ? { errors: [{ message: 'Query with id 123 does not exist' }] }
            : good),
        },
      }),
      noteRequest() {},
      noteFailure: async () => false,
      refreshDocId: async () => { refreshed += 1; return true; },
      pushAds: async () => {},
    });

    assert.equal(refreshed, 1, 'the stale id was re-read from the live bundle');
    assert.equal(call, 2, 'and the page was retried with the new id');
  });
});

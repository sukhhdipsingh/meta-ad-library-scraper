import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractBundleUrls, extractChallengePath, extractDocId, extractLsd } from '../src/docid.js';
import { OPERATION_NAME } from '../src/constants.js';

const BUNDLE = readFileSync(fileURLToPath(new URL('./fixtures/bundle_docid.js', import.meta.url)), 'utf8');

describe('extractDocId', () => {
  test('reads the AdLibrarySearchPaginationQuery id from the real bundle excerpt', () => {
    assert.equal(extractDocId(BUNDLE, OPERATION_NAME), '24922295957467452');
  });

  test('does not return the other relay operation present in the same file', () => {
    const docId = extractDocId(BUNDLE, OPERATION_NAME);
    assert.notEqual(docId, '9798656056887768');
    // and the other module is still readable when asked for by name
    assert.equal(extractDocId(BUNDLE, 'SomeOtherModule'), '9798656056887768');
  });

  test('tolerates whichever variable the minifier picked for the export', () => {
    for (const v of ['a', 'e', 'i', 't', 'nn']) {
      const src = `__d("Op_facebookRelayOperation",[],(function(t,n,r,o,${v},i){${v}.exports="12345"}),null);`;
      assert.equal(extractDocId(src, 'Op'), '12345', `failed for ${v}.exports`);
    }
  });

  test('accepts single-quoted module names', () => {
    const src = `__d('Op_facebookRelayOperation',[],(function(t,n,r,o,a,i){a.exports='777'}),null);`;
    assert.equal(extractDocId(src, 'Op'), '777');
  });

  test('returns null for an operation the bundle does not define', () => {
    assert.equal(extractDocId(BUNDLE, 'NotThereQuery'), null);
  });

  test('does not steal the next module id when this module has no export', () => {
    const src = '__d("Op_facebookRelayOperation",[],(function(){}),null);'
      + `${'/* filler */'.repeat(60)}\n`
      + '__d("Other_facebookRelayOperation",[],(function(t,n,r,o,a,i){a.exports="999"}),null);';
    assert.equal(extractDocId(src, 'Op'), null);
  });

  test('never throws on junk input', () => {
    assert.equal(extractDocId(null, OPERATION_NAME), null);
    assert.equal(extractDocId('', OPERATION_NAME), null);
    assert.equal(extractDocId('whatever', ''), null);
  });

  test('operation names are treated as literals, not patterns', () => {
    assert.equal(extractDocId(BUNDLE, '.*'), null);
  });
});

describe('extractBundleUrls', () => {
  test('collects fbcdn .js urls, unescapes them and deduplicates', () => {
    const html = `
      <script src="https://static.xx.fbcdn.net/rsrc.php/v3/y1/r/entry.js?_nc_x=AAA"></script>
      <script src="https://static.xx.fbcdn.net/rsrc.php/v3/y1/r/entry.js?_nc_x=AAA"></script>
      {"src":"https:\\/\\/static.xx.fbcdn.net\\/rsrc.php\\/v3\\/y9\\/r\\/inline.js"}
      <link href="https://static.xx.fbcdn.net/rsrc.php/v3/y2/r/style.css">
      <script src="https://example.com/not-facebook.js"></script>
    `;
    const urls = extractBundleUrls(html);
    assert.deepEqual(urls, [
      'https://static.xx.fbcdn.net/rsrc.php/v3/y1/r/entry.js?_nc_x=AAA',
      'https://static.xx.fbcdn.net/rsrc.php/v3/y9/r/inline.js',
    ]);
  });

  test('ranks an AdLibrary-named bundle first, then script tags, then inline json', () => {
    const html = `
      {"u":"https:\\/\\/static.xx.fbcdn.net\\/rsrc.php\\/v3\\/inline-only.js"}
      <script src="https://static.xx.fbcdn.net/rsrc.php/v3/entry.js"></script>
      {"u":"https:\\/\\/static.xx.fbcdn.net\\/rsrc.php\\/v3\\/AdLibrarySearch.js"}
    `;
    assert.deepEqual(extractBundleUrls(html), [
      'https://static.xx.fbcdn.net/rsrc.php/v3/AdLibrarySearch.js',
      'https://static.xx.fbcdn.net/rsrc.php/v3/entry.js',
      'https://static.xx.fbcdn.net/rsrc.php/v3/inline-only.js',
    ]);
  });

  test('returns [] when there is nothing to find', () => {
    assert.deepEqual(extractBundleUrls('<html></html>'), []);
    assert.deepEqual(extractBundleUrls(null), []);
  });
});

describe('extractLsd', () => {
  test('reads the relay-injected token', () => {
    const html = 'x["LSD",[],{"token":"AVqB_9-xYz"},321]y';
    assert.equal(extractLsd(html), 'AVqB_9-xYz');
  });

  test('falls back to the hidden input form', () => {
    assert.equal(extractLsd('<input type="hidden" name="lsd" value="AVfallback" />'), 'AVfallback');
  });

  test('returns null before the challenge is solved', () => {
    assert.equal(extractLsd('<html>no token here</html>'), null);
    assert.equal(extractLsd(null), null);
  });
});

describe('extractChallengePath', () => {
  test('finds the rd_verify path with its challenge number', () => {
    const html = 'blah "/__rd_verify_Q_6hBQ_pnb7x2azH69vWBrxri3nuLOmh83dnAbrpt_iSBQ?challenge=3" blah';
    assert.equal(
      extractChallengePath(html),
      '/__rd_verify_Q_6hBQ_pnb7x2azH69vWBrxri3nuLOmh83dnAbrpt_iSBQ?challenge=3',
    );
  });

  test('handles the json-escaped form', () => {
    assert.equal(extractChallengePath('{"u":"\\/__rd_verify_abc-1?challenge=12"}'), '/__rd_verify_abc-1?challenge=12');
  });

  test('returns null when no challenge is served', () => {
    assert.equal(extractChallengePath('<html>ok</html>'), null);
    assert.equal(extractChallengePath(null), null);
  });
});

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSessionManager } from '../src/session.js';
import { AdLibraryError, CATEGORY } from '../src/errors.js';
import { FALLBACK_DOC_ID, SESSION_MAX_REQUESTS, GRAPHQL_URL } from '../src/constants.js';

const BUNDLE = readFileSync(fileURLToPath(new URL('./fixtures/bundle_docid.js', import.meta.url)), 'utf8');

const BUNDLE_URL = 'https://static.xx.fbcdn.net/rsrc.php/v3/y1/r/AdLibraryEntry.js';
const CHALLENGE_PATH = '/__rd_verify_Q_6hBQ_pnb7x2azH69vWBrxri3nuLOmh83dnAbrpt_iSBQ?challenge=3';

const htmlWithChallenge = () =>
  `<html><script src="${BUNDLE_URL}"></script><a href="${CHALLENGE_PATH}">verify</a></html>`;

const htmlWithLsd = (token) =>
  `<html><script src="${BUNDLE_URL}"></script><script>require("LSD",[],{"token":"${token}"},99);</script></html>`;

/**
 * A stand-in for Meta: serves the challenge until `rd_challenge` comes back in
 * the cookie header, then serves the shell that carries the lsd token.
 */
function makeFakeMeta({ bundle = BUNDLE, serveChallenge = true, serveLsd = true, graphql = null, challengeStatus = 403 } = {}) {
  const calls = [];
  let lsdCounter = 0;
  const tokens = [];

  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    calls.push({ url: u, method, cookie: headers.cookie ?? '', headers, body: init.body });

    if (u.includes('__rd_verify_')) {
      const h = new Headers();
      h.append('set-cookie', 'rd_challenge=solved-abc; Path=/; HttpOnly');
      h.append('set-cookie', 'datr=xyz; Path=/');
      return new Response('{"ok":1}', { status: 200, headers: h });
    }

    if (u === GRAPHQL_URL) {
      const { status = 200, body = '{"data":{}}' } = graphql ?? {};
      return new Response(body, { status });
    }

    if (u.endsWith('.js')) {
      return new Response(bundle, { status: 200 });
    }

    // the Ad Library shell. The challenge page ships with HTTP 403 by default,
    // because that is what Meta does (measured 2026-08-27); `challengeStatus`
    // exists so one test can prove the older 200 variant still bootstraps.
    const hasChallengeCookie = (headers.cookie ?? '').includes('rd_challenge');
    if (serveChallenge && !hasChallengeCookie) {
      return new Response(htmlWithChallenge(), { status: challengeStatus });
    }
    if (!serveLsd) return new Response('<html>blocked</html>', { status: 200 });
    const token = `AVlsd_${(lsdCounter += 1)}`;
    tokens.push(token);
    return new Response(htmlWithLsd(token), { status: 200 });
  };

  return { fetchImpl, calls, tokens };
}

function makeProxy() {
  const sessionIds = [];
  return {
    sessionIds,
    async newUrl(sessionId) {
      sessionIds.push(sessionId);
      return `http://user-session-${sessionId}:pw@proxy.apify.com:8000`;
    },
  };
}

function makeLog() {
  const warnings = [];
  return { warnings, debug() {}, info() {}, error() {}, warning: (m) => warnings.push(String(m)) };
}

const manager = (over = {}) => createSessionManager({
  fetchImpl: over.fetchImpl,
  proxyConfiguration: over.proxyConfiguration,
  log: over.log ?? makeLog(),
  docIdOverride: over.docIdOverride,
  maxRotations: over.maxRotations,
  docIdStore: over.docIdStore,
  bundleScanBudgetBytes: over.bundleScanBudgetBytes,
  // no proxy agent in tests, and no point sleeping between retries
  httpOptions: { retries: 0, ...over.httpOptions },
});

describe('bootstrap: challenge -> lsd -> doc_id', () => {
  test('runs the measured three-step handshake in order', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl, proxyConfiguration: makeProxy() });

    const session = await sm.acquire();

    const shape = meta.calls.map((c) => `${c.method} ${c.url.includes('__rd_verify_') ? 'challenge' : (c.url.endsWith('.js') ? 'bundle' : 'shell')}`);
    // No bundle here on purpose: the operation bundle was measured at 6.3 MB
    // and residential proxy traffic is billed per GB, so it is only fetched
    // when a request actually fails (see the doc_id refresh tests).
    assert.deepEqual(shape, ['GET shell', 'POST challenge', 'GET shell']);
    assert.equal(session.lsd, meta.tokens.at(-1));
    assert.equal(session.requestCount, 0);
    await sm.close();
  });

  test('a 403 whose body carries the challenge is solved, not reported as blocked', async () => {
    // Measured 2026-08-27 (evening): Meta moved the challenge page from HTTP
    // 200 to HTTP 403. Treating that status as a block killed every run while
    // the challenge inside the body was perfectly solvable. This is the
    // regression test for that outage.
    const meta = makeFakeMeta({ challengeStatus: 403 });
    const sm = manager({ fetchImpl: meta.fetchImpl });
    const session = await sm.acquire();
    assert.ok(session.lsd, 'the handshake must complete despite the 403');
    await sm.close();
  });

  test('a challenge served with HTTP 200 (the older variant) still bootstraps', async () => {
    const meta = makeFakeMeta({ challengeStatus: 200 });
    const sm = manager({ fetchImpl: meta.fetchImpl });
    const session = await sm.acquire();
    assert.ok(session.lsd);
    await sm.close();
  });

  test('replays the rd_challenge cookie on the second GET', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl });
    await sm.acquire();

    const shellGets = meta.calls.filter((c) => c.method === 'GET' && !c.url.endsWith('.js'));
    assert.equal(shellGets.length, 2);
    assert.ok(!shellGets[0].cookie.includes('rd_challenge'), 'first GET must be cold');
    assert.match(shellGets[1].cookie, /rd_challenge=solved-abc/);
    // the second set-cookie from the challenge response is kept too
    assert.match(shellGets[1].cookie, /datr=xyz/);
    await sm.close();
  });

  test('forces en_US via cookie and accept-language on every request', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl });
    await sm.acquire();

    for (const call of meta.calls) {
      assert.match(call.cookie, /locale=en_US/, `missing locale cookie on ${call.url}`);
      assert.equal(call.headers['accept-language'], 'en-US,en;q=0.9');
      assert.match(call.headers['user-agent'], /Chrome\/\d+/);
    }
    await sm.close();
  });

  test('starts on the pinned doc_id without downloading anything', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl });
    const session = await sm.acquire();

    assert.equal(session.docId, FALLBACK_DOC_ID);
    assert.equal(meta.calls.filter((c) => c.url.endsWith('.js')).length, 0,
      'the happy path must cost zero bundle bytes');
    await sm.close();
  });
});

describe('doc_id refresh: paid for only when Meta actually moves it', () => {
  test('re-reads the id from the live bundle and reports the change', async () => {
    const log = makeLog();
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl, log, docIdOverride: 'an-old-id' });
    const session = await sm.acquire();

    const changed = await sm.refreshDocId(session);

    assert.equal(changed, true, 'the id differed, so a retry is worth it');
    assert.equal(session.docId, '24922295957467452', 'sessions already handed out see the new id');
    assert.ok(log.warnings.some((w) => w.includes(CATEGORY.DOC_ID_STALE)), log.warnings.join('|'));
    await sm.close();
  });

  test('reports no change when the id is the same, so nothing is retried pointlessly', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl, docIdOverride: '24922295957467452' });
    const session = await sm.acquire();

    assert.equal(await sm.refreshDocId(session), false);
    await sm.close();
  });

  test('the 6.3 MB bundle is never downloaded twice in one run', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl, docIdOverride: 'an-old-id' });
    const session = await sm.acquire();

    await sm.refreshDocId(session);
    const afterFirst = meta.calls.filter((c) => c.url.endsWith('.js')).length;
    assert.equal(await sm.refreshDocId(session), false, 'a second refresh is refused');
    assert.equal(meta.calls.filter((c) => c.url.endsWith('.js')).length, afterFirst,
      'and costs no further bytes');
    await sm.close();
  });

  test('a bundle without the operation leaves the current id in place, with a warning', async () => {
    const log = makeLog();
    const meta = makeFakeMeta({ bundle: '/* a bundle without the operation */' });
    const sm = manager({ fetchImpl: meta.fetchImpl, log, docIdOverride: 'keep-me' });
    const session = await sm.acquire();

    assert.equal(await sm.refreshDocId(session), false);
    assert.equal(session.docId, 'keep-me');
    assert.ok(log.warnings.some((w) => w.includes(CATEGORY.DOC_ID_STALE)), log.warnings.join('|'));
    await sm.close();
  });
});

describe('bootstrap: remaining behaviour', () => {

  test('docIdOverride skips the bundle download entirely', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl, docIdOverride: '111222333' });
    const session = await sm.acquire();
    assert.equal(session.docId, '111222333');
    assert.equal(meta.calls.filter((c) => c.url.endsWith('.js')).length, 0);
    await sm.close();
  });

  test('no lsd and no challenge is a BLOCKED failure, not a crash', async () => {
    const meta = makeFakeMeta({ serveChallenge: false, serveLsd: false });
    const sm = manager({ fetchImpl: meta.fetchImpl });
    await assert.rejects(() => sm.acquire(), (err) => {
      assert.ok(err instanceof AdLibraryError);
      assert.equal(err.category, CATEGORY.BLOCKED);
      return true;
    });
  });
});

describe('rotation', () => {
  test('a new session means a NEW sessionId passed to newUrl (new id = new IP)', async () => {
    const meta = makeFakeMeta();
    const proxy = makeProxy();
    const sm = manager({ fetchImpl: meta.fetchImpl, proxyConfiguration: proxy });

    const first = await sm.acquire();
    const second = await sm.rotate();

    assert.equal(proxy.sessionIds.length, 2);
    assert.notEqual(proxy.sessionIds[0], proxy.sessionIds[1]);
    assert.notEqual(first.id, second.id);
    assert.equal(second.requestCount, 0);
    await sm.close();
  });

  test('retires the session after SESSION_MAX_REQUESTS', async () => {
    const meta = makeFakeMeta();
    const proxy = makeProxy();
    const sm = manager({ fetchImpl: meta.fetchImpl, proxyConfiguration: proxy });

    const first = await sm.acquire();
    for (let i = 1; i < SESSION_MAX_REQUESTS; i += 1) {
      sm.noteRequest(first);
      assert.equal((await sm.acquire()).id, first.id, `rotated too early at request ${i}`);
    }
    sm.noteRequest(first);
    assert.equal(first.requestCount, SESSION_MAX_REQUESTS);

    const next = await sm.acquire();
    assert.notEqual(next.id, first.id);
    assert.equal(proxy.sessionIds.length, 2);
    await sm.close();
  });

  test('a soft block retires the session immediately, well before the budget', async () => {
    const meta = makeFakeMeta();
    const proxy = makeProxy();
    const sm = manager({ fetchImpl: meta.fetchImpl, proxyConfiguration: proxy });

    const first = await sm.acquire();
    sm.noteRequest(first);
    const rotated = await sm.noteFailure(first, new AdLibraryError(CATEGORY.RATE_LIMITED, { retryable: true }));
    assert.equal(rotated, true);

    const next = await sm.acquire();
    assert.notEqual(next.id, first.id);
    assert.equal(proxy.sessionIds.length, 2);
    await sm.close();
  });

  test('an ordinary failure does not burn a session', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl });
    const first = await sm.acquire();
    assert.equal(await sm.noteFailure(first, new AdLibraryError(CATEGORY.NETWORK)), false);
    assert.equal((await sm.acquire()).id, first.id);
    await sm.close();
  });

  test('past maxRotations it gives up with RATE_LIMITED', async () => {
    const meta = makeFakeMeta();
    const proxy = makeProxy();
    const sm = manager({ fetchImpl: meta.fetchImpl, proxyConfiguration: proxy, maxRotations: 2 });

    await sm.acquire();
    await sm.rotate();
    await sm.rotate();

    await assert.rejects(() => sm.rotate(), (err) => {
      assert.ok(err instanceof AdLibraryError);
      assert.equal(err.category, CATEGORY.RATE_LIMITED);
      assert.match(err.message, /rotations/);
      return true;
    });
    assert.equal(sm.stats().rotations, 2);
    assert.equal(proxy.sessionIds.length, 3);
  });
});

describe('the session http client', () => {
  const jsonResponse = async (body) => {
    const meta = makeFakeMeta({ graphql: { body } });
    const sm = manager({ fetchImpl: meta.fetchImpl });
    const session = await sm.acquire();
    return { session, sm };
  };

  test('strips the for(;;); guard before parsing', async () => {
    const { session, sm } = await jsonResponse('for (;;);{"data":{"ok":true}}');
    const json = await session.http.postForm(GRAPHQL_URL, { doc_id: session.docId });
    assert.deepEqual(json, { data: { ok: true } });
    await sm.close();
  });

  test('uses only the first line of a multi-line response', async () => {
    const { session, sm } = await jsonResponse('for (;;);{"data":{"page":1}}\n{"data":{"page":2}}\n');
    const json = await session.http.postForm(GRAPHQL_URL, {});
    assert.deepEqual(json, { data: { page: 1 } });
    await sm.close();
  });

  test('detects the soft block hidden inside an HTTP 200', async () => {
    const { session, sm } = await jsonResponse('for (;;);{"__ar":1,"error":1357054,"errorSummary":"Your Request Couldn\'t be Processed"}');
    await assert.rejects(() => session.http.postForm(GRAPHQL_URL, {}), (err) => {
      assert.ok(err instanceof AdLibraryError);
      assert.equal(err.category, CATEGORY.RATE_LIMITED);
      assert.equal(err.status, 200, 'the block really is a 200');
      assert.equal(err.retryable, true);
      return true;
    });
    await sm.close();
  });

  test('an unrelated error code is not treated as a block', async () => {
    const { session, sm } = await jsonResponse('for (;;);{"error":404}');
    const json = await session.http.postForm(GRAPHQL_URL, {});
    assert.equal(json.error, 404);
    await sm.close();
  });

  test('sends the form body urlencoded, dropping null params', async () => {
    const meta = makeFakeMeta({ graphql: { body: '{"data":{}}' } });
    const sm = manager({ fetchImpl: meta.fetchImpl });
    const session = await sm.acquire();
    await session.http.postForm(GRAPHQL_URL, { av: 0, __aaid: 0, __ccg: 'EXCELLENT', lsd: session.lsd, nothing: null });

    const call = meta.calls.at(-1);
    assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
    const sent = new URLSearchParams(call.body);
    // omitting __aaid or __ccg makes Meta reject the request outright
    assert.equal(sent.get('__aaid'), '0');
    assert.equal(sent.get('__ccg'), 'EXCELLENT');
    assert.equal(sent.get('lsd'), session.lsd);
    assert.equal(sent.has('nothing'), false);
    await sm.close();
  });

  test('a 404 is reported as page_not_found and never retried', async () => {
    const meta = makeFakeMeta({ graphql: { status: 404, body: 'nope' } });
    const sm = manager({ fetchImpl: meta.fetchImpl, httpOptions: { retries: 3, backoffBaseMs: 1 } });
    const session = await sm.acquire();
    const before = meta.calls.length;

    await assert.rejects(() => session.http.postForm(GRAPHQL_URL, {}), (err) => {
      assert.equal(err.category, CATEGORY.PAGE_NOT_FOUND);
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(meta.calls.length - before, 1, 'a 404 must not be retried');
    await sm.close();
  });

  test('retries a 503 with backoff, then succeeds', async () => {
    let attempts = 0;
    const slept = [];
    const fetchImpl = async (url, init) => {
      if (String(url) === GRAPHQL_URL) {
        attempts += 1;
        if (attempts < 3) return new Response('busy', { status: 503 });
        return new Response('for (;;);{"data":{"ok":1}}', { status: 200 });
      }
      return makeFakeMeta().fetchImpl(url, init);
    };
    const sm = manager({
      fetchImpl,
      httpOptions: { retries: 3, backoffBaseMs: 10, sleepImpl: async (ms) => { slept.push(ms); } },
    });
    const session = await sm.acquire();
    const json = await session.http.postForm(GRAPHQL_URL, {});

    assert.deepEqual(json, { data: { ok: 1 } });
    assert.equal(attempts, 3);
    assert.equal(slept.length, 2);
    assert.ok(slept[1] > slept[0], `backoff must grow: ${slept}`);
    await sm.close();
  });

  test('a network failure surfaces as the network category', async () => {
    const base = makeFakeMeta();
    const fetchImpl = async (url, init) => {
      if (String(url) === GRAPHQL_URL) throw new TypeError('fetch failed');
      return base.fetchImpl(url, init);
    };
    const sm = manager({ fetchImpl, httpOptions: { retries: 1, backoffBaseMs: 1 } });
    const session = await sm.acquire();
    await assert.rejects(() => session.http.postForm(GRAPHQL_URL, {}), (err) => {
      assert.ok(err instanceof AdLibraryError);
      assert.equal(err.category, CATEGORY.NETWORK);
      assert.equal(err.retryable, true);
      return true;
    });
    await sm.close();
  });
});

describe('a refused exit IP is diagnosed as blocked, not as a network fault', () => {
  test('403 on the shell says "blocked", so the fix (rotate the proxy) is obvious', async () => {
    // Measured: once Meta has had enough of an IP it stops answering the page
    // at all. Calling that a network error sends the reader hunting for a DNS
    // problem that does not exist.
    const sm = createSessionManager({
      fetchImpl: async () => new Response('<html>denied</html>', { status: 403 }),
      httpOptions: { retries: 0 },
      log: { debug() {}, info() {}, warning() {}, error() {} },
    });

    await assert.rejects(() => sm.acquire(), (err) => {
      assert.equal(err.category, CATEGORY.BLOCKED);
      assert.match(err.message, /proxy exit IP is blocked/);
      return true;
    });
    await sm.close();
  });

  test('a 503 is still an ordinary network fault', async () => {
    const sm = createSessionManager({
      fetchImpl: async () => new Response('nope', { status: 503 }),
      httpOptions: { retries: 0 },
      log: { debug() {}, info() {}, warning() {}, error() {} },
    });
    await assert.rejects(() => sm.acquire(), (err) => {
      assert.equal(err.category, CATEGORY.NETWORK);
      return true;
    });
    await sm.close();
  });
});

describe('the bootstrap must look like a browser navigation', () => {
  test('the shell GET carries the Sec-Fetch set and client hints', async () => {
    // Measured on the platform: a request carrying only a user-agent is
    // answered with 403 before the challenge is ever issued. These headers are
    // what make Meta treat it as a navigation from a real tab.
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl });
    await sm.acquire();

    const shellGets = meta.calls.filter((c) => c.method === 'GET' && !c.url.endsWith('.js'));
    assert.ok(shellGets.length >= 1);

    for (const call of shellGets) {
      assert.match(call.headers.accept ?? '', /text\/html/, 'accept must ask for a document');
      assert.equal(call.headers['sec-fetch-dest'], 'document');
      assert.equal(call.headers['sec-fetch-mode'], 'navigate');
      assert.equal(call.headers['upgrade-insecure-requests'], '1');
      assert.match(call.headers['sec-ch-ua'] ?? '', /Chrom/, 'client hints must be present');
      assert.equal(call.headers['sec-ch-ua-mobile'], '?0');
    }
    await sm.close();
  });

  test('the second GET declares same-origin, because the challenge came from facebook.com', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl });
    await sm.acquire();

    const shellGets = meta.calls.filter((c) => c.method === 'GET' && !c.url.endsWith('.js'));
    assert.equal(shellGets[0].headers['sec-fetch-site'], 'none', 'the first hit is a cold navigation');
    assert.equal(shellGets[1].headers['sec-fetch-site'], 'same-origin');
    assert.ok(shellGets[1].headers.referer, 'and carries a referer');
    await sm.close();
  });
});

describe('the doc_id re-read must look like a browser, or Meta answers 400', () => {
  test('the shell GET carries the full navigation headers, and the bundle GET does not', async () => {
    const meta = makeFakeMeta();
    const sm = manager({ fetchImpl: meta.fetchImpl, docIdOverride: 'an-old-id' });
    const session = await sm.acquire();
    const before = meta.calls.length;

    await sm.refreshDocId(session);

    const after = meta.calls.slice(before);
    const shellGet = after.find((c) => c.url.includes('/ads/library') && c.method === 'GET');
    assert.ok(shellGet, 'the refresh re-reads the shell');
    // Measured 2026-08-27: a GET with only a user-agent is answered HTTP 400.
    // Sending these is the difference between a working self-repair and a
    // warning in the log every run.
    assert.equal(shellGet.headers['sec-fetch-mode'], 'navigate');
    assert.equal(shellGet.headers['sec-fetch-dest'], 'document');
    assert.equal(shellGet.headers['upgrade-insecure-requests'], '1');

    const bundleGet = after.find((c) => c.url.endsWith('.js'));
    assert.ok(bundleGet, 'and then pulls the bundle');
    assert.equal(bundleGet.headers['sec-fetch-dest'], 'script',
      'a document-shaped request for a .js file is exactly what a bot filter looks for');

    await sm.close();
  });
});

/**
 * The bundle hunt used to stop after four candidates. Measured 2026-08-29, the
 * operation lives in the fifth — so the self-repair could never fire, and the
 * actor would have needed a code change on the day Meta rotated the id. These
 * tests pin the two properties that make it automatic instead: the hunt is
 * bounded by bytes rather than by an arbitrary count, and the answer outlives
 * the run that paid for it.
 */
describe('finding a rotated query id without a code change', () => {
  /** Serves `count` decoy bundles before the one that carries the operation. */
  function metaWithBundleAt(position, { bundleBytes = 1000 } = {}) {
    const urls = Array.from({ length: 10 }, (_, i) => `https://static.xx.fbcdn.net/rsrc.php/v4/y${i}/decoy${i}.js`);
    const shell = `<html>${urls.map((u) => `<script src="${u}"></script>`).join('')}` +
      `<script>require("LSD",[],{"token":"AVlsd_1"},99);</script></html>`;
    const filler = 'x'.repeat(bundleBytes);
    const served = [];
    const fetchImpl = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('__rd_verify_')) return new Response('{"ok":1}', { status: 200 });
      if (u.endsWith('.js')) {
        served.push(u);
        const isTarget = u === urls[position];
        return new Response(
          isTarget ? BUNDLE : `/* ${filler} */`,
          { status: 200 },
        );
      }
      return new Response(shell, { status: 200 });
    };
    return { fetchImpl, served, urls };
  }

  test('the fifth bundle is reached — the old four-candidate cap never got there', async () => {
    const meta = metaWithBundleAt(4);
    const sm = manager({ fetchImpl: meta.fetchImpl, docIdOverride: 'an-old-id' });
    const session = await sm.acquire();

    assert.equal(await sm.refreshDocId(session), true, 'the id was found and it had moved');
    assert.equal(session.docId, '24922295957467452');
    assert.equal(meta.served.length, 5, 'and it stopped as soon as it found it');
    await sm.close();
  });

  test('the hunt stops on its byte budget, not on a candidate count', async () => {
    // Every decoy is 1 KB, so a 3 KB budget buys three of them and no more.
    const meta = metaWithBundleAt(9, { bundleBytes: 1000 });
    const log = makeLog();
    const sm = manager({ fetchImpl: meta.fetchImpl, log, docIdOverride: 'keep-me', bundleScanBudgetBytes: 3000 });
    const session = await sm.acquire();

    assert.equal(await sm.refreshDocId(session), false);
    assert.equal(session.docId, 'keep-me', 'a hunt that ran out of budget must not invent an id');
    assert.ok(meta.served.length <= 5, `stopped early, served ${meta.served.length}`);
    assert.ok(log.warnings.some((w) => /Stopped hunting/.test(w)), log.warnings.join('|'));
    await sm.close();
  });

  test('a resolved id is written once and reused by the next run for free', async () => {
    const saved = [];
    const store = { load: async () => null, save: async (id) => { saved.push(id); } };
    const meta = metaWithBundleAt(0);
    const sm = manager({ fetchImpl: meta.fetchImpl, docIdOverride: 'an-old-id', docIdStore: store });
    const session = await sm.acquire();
    await sm.refreshDocId(session);
    assert.deepEqual(saved, ['24922295957467452'], 'the run that paid for the scan recorded the answer');
    await sm.close();

    // The next run: it starts on the remembered id and downloads nothing.
    const next = makeFakeMeta();
    const sm2 = manager({ fetchImpl: next.fetchImpl, docIdStore: { load: async () => '24922295957467452', save: async () => {} } });
    const session2 = await sm2.acquire();
    assert.equal(session2.docId, '24922295957467452');
    assert.equal(next.calls.filter((c) => c.url.endsWith('.js')).length, 0, 'and paid nothing for it');
    await sm2.close();
  });

  test('a store that throws is not allowed to break the run', async () => {
    const meta = makeFakeMeta();
    const sm = manager({
      fetchImpl: meta.fetchImpl,
      docIdStore: { load: async () => { throw new Error('store down'); }, save: async () => { throw new Error('store down'); } },
    });
    const session = await sm.acquire();
    assert.equal(session.docId, FALLBACK_DOC_ID, 'it falls back rather than failing');
    await sm.close();
  });
});

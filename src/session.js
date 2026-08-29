/**
 * Session lifecycle: challenge -> lsd -> doc_id -> rotate.
 *
 * Why this module exists: a cold POST to Meta's GraphQL endpoint always fails.
 * A usable session is the product of a three-step handshake (GET the shell,
 * POST the anti-bot challenge to mint `rd_challenge`, GET the shell again to
 * read the `lsd` token), and it is worth ~25 requests before the exit IP is at
 * risk of a block that outlasts 25 minutes. Encapsulating that here keeps the
 * source adapters free of anti-bot concerns: they ask for a session and use it.
 *
 * `proxyConfiguration` is an injected dependency with exactly one method,
 * `newUrl(sessionId)`. The Apify SDK object satisfies it, and so does a stub —
 * which is why this file never imports `apify` (see CONTRACT.md §4).
 */

import { createHttpClient } from './http.js';
import { extractBundleUrls, extractChallengePath, extractDocId, extractLsd } from './docid.js';
import { AdLibraryError, CATEGORY } from './errors.js';
import {
  AD_LIBRARY_URL,
  FALLBACK_DOC_ID,
  FORCED_LOCALE,
  NAVIGATION_HEADERS,
  OPERATION_NAME,
  SESSION_MAX_REQUESTS,
} from './constants.js';

const NOOP_LOG = { debug() {}, info() {}, warning() {}, error() {} };

/** The shell we bootstrap against. Any valid query works; this one is cheap
 *  and always serves the challenge. */
const BOOTSTRAP_URL = `${AD_LIBRARY_URL}?active_status=active&ad_type=all&country=US`;
const FB_ORIGIN = 'https://www.facebook.com';

/** What a browser sends when it pulls a JS bundle off the CDN. The navigation
 *  headers would be wrong here — a `sec-fetch-dest: document` request for a
 *  `.js` file is exactly the mismatch a bot filter looks for. */
const BUNDLE_HEADERS = {
  accept: '*/*',
  'sec-fetch-dest': 'script',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-site': 'cross-site',
  referer: `${FB_ORIGIN}/`,
};

/**
 * @param {object} options
 * @param {{ newUrl(sessionId: string): Promise<string|undefined> }} [options.proxyConfiguration]
 * @param {object} [options.log]
 * @param {string} [options.docIdOverride] skip bundle resolution entirely
 * @param {number} [options.maxRotations] rotations allowed before giving up
 * @param {Function} [options.fetchImpl] injectable for tests
 * @param {object} [options.httpOptions] forwarded to `createHttpClient`
 */
export function createSessionManager({
  proxyConfiguration = null,
  log = NOOP_LOG,
  docIdOverride = null,
  maxRotations = 10,
  fetchImpl = globalThis.fetch,
  httpOptions = {},
} = {}) {
  let current = null;
  let rotations = 0;
  let created = 0;
  /** Resolved once and reused: the doc_id belongs to Meta's deploy, not to our
   *  proxy session, so re-downloading a bundle on every rotation is waste. */
  let cachedDocId = docIdOverride ?? null;
  /** The 6.3 MB bundle is worth downloading once per run, never twice.
   *  `docIdOverride` only seeds the starting value — it does not disable the
   *  self-repair, because a pinned id can go stale like any other. */
  let docIdRefreshed = false;

  const nextSessionId = () => `meta_${Date.now().toString(36)}_${(created += 1)}`;

  /**
   * Re-read the doc_id from Meta's live JavaScript, and say whether it moved.
   *
   * This is deliberately NOT part of the bootstrap. The bundle that carries the
   * operation was measured at 6.3 MB, and residential proxy traffic is billed
   * per gigabyte: paying that on every run would cost more than the ads it
   * fetches. So the known id is used first, and this only runs when a request
   * actually fails in a way that suggests the id went stale — which is the one
   * moment the download is worth its price.
   *
   * @returns {Promise<boolean>} true when a different id was found
   */
  async function refreshDocId(session) {
    const before = cachedDocId;
    let html;
    try {
      // The same navigation headers the bootstrap uses. Measured: the Ad
      // Library answers a GET carrying only a user-agent with HTTP 400, so
      // sending them is what makes this re-read work at all — without them the
      // self-repair failed on every run and the actor silently stayed on the
      // stale id it was trying to replace.
      html = await session.http.getText(BOOTSTRAP_URL, {
        headers: { ...NAVIGATION_HEADERS, 'sec-fetch-site': 'same-origin', referer: BOOTSTRAP_URL },
      });
    } catch (err) {
      log.warning?.(`Could not re-read the Ad Library shell to refresh the doc_id: ${err.message}`);
      return false;
    }

    // Candidates are ranked by how likely they are to hold the operation, so
    // only a couple are ever downloaded.
    for (const url of extractBundleUrls(html).slice(0, 4)) {
      try {
        const found = extractDocId(await session.http.getText(url, { headers: BUNDLE_HEADERS }), OPERATION_NAME);
        if (!found) continue;
        cachedDocId = found;
        if (found !== before) {
          log.warning?.(
            `[${CATEGORY.DOC_ID_STALE}] Meta rotated the Ad Library query id: `
            + `${before} -> ${found}. Continuing with the new one.`,
          );
          return true;
        }
        log.info?.(`Re-read the doc_id from the live bundle; it is unchanged (${found}).`);
        return false;
      } catch (err) {
        log.debug?.(`Bundle ${url} unusable while refreshing doc_id: ${err.message}`);
      }
    }

    log.warning?.(
      `[${CATEGORY.DOC_ID_STALE}] Could not read ${OPERATION_NAME} out of any live bundle; `
      + `staying on ${cachedDocId}.`,
    );
    return false;
  }

  async function bootstrap() {
    const id = nextSessionId();
    // A new sessionId is what makes Apify hand out a different exit IP; reusing
    // one would rotate cookies while staying on the blocked address.
    const proxyUrl = (await proxyConfiguration?.newUrl(id)) ?? null;

    const http = createHttpClient({ proxyUrl, log, fetchImpl, ...httpOptions });
    // Meta localises spend/impression strings by exit IP; en_US keeps the
    // public output schema stable no matter where the proxy lands.
    http.setCookie('locale', FORCED_LOCALE);

    // Meta answers the cold GET with the anti-bot challenge page under HTTP
    // 403 (measured 2026-08-27; earlier the same page came as 200). A 403
    // whose body carries the challenge is step one of the handshake, not a
    // block — only a 403 without it means the exit IP is actually unwelcome.
    let html = await http.getText(BOOTSTRAP_URL, {
      headers: NAVIGATION_HEADERS,
      allowStatus: (status, body) => status === 403 && body.includes('/__rd_verify_'),
    });

    const challengePath = extractChallengePath(html);
    if (challengePath) {
      // Sets the `rd_challenge` cookie; the jar replays it on the next GET.
      await http.postForm(`${FB_ORIGIN}${challengePath}`, {}, {
        raw: true,
        headers: { origin: FB_ORIGIN, referer: BOOTSTRAP_URL },
      });
      // Same-origin now: the challenge answer came from facebook.com.
      html = await http.getText(BOOTSTRAP_URL, {
        headers: { ...NAVIGATION_HEADERS, 'sec-fetch-site': 'same-origin', referer: BOOTSTRAP_URL },
      });
    }

    const lsd = extractLsd(html);
    if (!lsd) {
      await http.close();
      throw new AdLibraryError(CATEGORY.BLOCKED, {
        detail: challengePath
          ? 'the challenge was answered but the shell still has no lsd token'
          : 'no challenge and no lsd token in the Ad Library shell',
      });
    }

    // The known-good id is used as-is. `refreshDocId` re-reads it from the live
    // bundle only if a request later suggests Meta rotated it, because that
    // download is 6.3 MB of billed proxy traffic.
    cachedDocId ??= FALLBACK_DOC_ID;

    log.info?.(`Session ${id} ready (lsd acquired, doc_id ${cachedDocId}${proxyUrl ? ', proxied' : ''})`);
    // `docId` is a getter so a mid-run refresh reaches sessions already handed out.
    const session = { id, http, lsd, requestCount: 0, blocked: false };
    Object.defineProperty(session, 'docId', { get: () => cachedDocId, enumerable: true });
    return session;
  }

  async function retire(session) {
    if (!session) return;
    session.blocked = true;
    await session.http.close();
    if (current === session) current = null;
  }

  const isSpent = (session) =>
    !session || session.blocked || session.requestCount >= SESSION_MAX_REQUESTS;

  async function newSession() {
    if (created > 0) {
      if (rotations >= maxRotations) {
        throw new AdLibraryError(CATEGORY.RATE_LIMITED, {
          detail: `gave up after ${rotations} proxy session rotations`,
        });
      }
      rotations += 1;
    }
    current = await bootstrap();
    return current;
  }

  return {
    /** A session ready to issue GraphQL requests, rotating if the current one
     *  is spent or blocked. */
    async acquire() {
      if (!isSpent(current)) return current;
      const spent = current;
      if (spent) {
        log.info?.(
          `Retiring session ${spent.id} after ${spent.requestCount} requests` +
          `${spent.blocked ? ' (blocked)' : ''}`,
        );
        await retire(spent);
      }
      return newSession();
    },

    /** Force a fresh session (and therefore a fresh exit IP). */
    async rotate() {
      await retire(current);
      return newSession();
    },

    /**
     * Re-read the query id from Meta's live JavaScript after a request failed
     * in a way that looks like a frontend redeploy. Returns true when the id
     * actually changed, i.e. when retrying is worth it. Runs at most once per
     * run: if the id was already re-read, a second failure is a real bug, not
     * drift, and paying for the bundle again would not help.
     */
    async refreshDocId(session = current) {
      if (docIdRefreshed || !session) return false;
      docIdRefreshed = true;
      return refreshDocId(session);
    },

    /** Count a request against the session's budget. */
    noteRequest(session = current) {
      if (session) session.requestCount += 1;
      return session?.requestCount ?? 0;
    },

    /** Report a failed request. A rate limit retires the session at once: the
     *  block is bound to the exit IP, so only a new sessionId can recover. */
    async noteFailure(session, err) {
      if (err?.category === CATEGORY.RATE_LIMITED || err?.category === CATEGORY.BLOCKED) {
        log.warning?.(`Session ${session?.id} hit ${err.category}; rotating proxy session`);
        await retire(session);
        return true;
      }
      return false;
    },

    /** Diagnostics for RUN-STATUS. */
    stats() {
      return {
        sessionsCreated: created,
        rotations,
        maxRotations,
        docId: cachedDocId,
        currentSessionId: current?.id ?? null,
        currentRequestCount: current?.requestCount ?? 0,
      };
    },

    async close() {
      await retire(current);
    },
  };
}

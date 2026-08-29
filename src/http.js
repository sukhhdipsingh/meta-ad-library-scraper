/**
 * The one place that talks to the network.
 *
 * Why this module exists: three of Meta's behaviours are impossible to handle
 * correctly with a bare `fetch` call, and getting any of them wrong silently
 * corrupts a run rather than failing it.
 *
 *  1. Responses are prefixed with `for (;;);` — `JSON.parse` on the raw body
 *     throws, which reads like a schema change when it is not.
 *  2. A rate-limit block arrives as **HTTP 200**, not 429. Any retry policy
 *     written against status codes never sees it.
 *  3. Every request needs the cookies the previous one set, per proxy session.
 *
 * The client is deliberately per-session: one jar, one proxy exit IP, one
 * lifetime. `session.js` throws the whole thing away when it rotates.
 */

import { ProxyAgent } from 'undici';
import { AdLibraryError, CATEGORY, readMetaError } from './errors.js';
import { JSON_HIJACK_PREFIX, SOFT_BLOCK_ERROR_CODES, USER_AGENT, ACCEPT_LANGUAGE } from './constants.js';

/** Statuses worth trying again. 404 is deliberately absent: a missing page
 *  stays missing, and retrying it just burns proxy traffic. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const NOOP_LOG = { debug() {}, info() {}, warning() {}, error() {} };

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSetCookie(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers?.get?.('set-cookie');
  return single ? [single] : [];
}

/**
 * @param {object} [options]
 * @param {string} [options.proxyUrl] proxy to route every request through
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries] attempts after the first one
 * @param {object} [options.log]
 * @param {Function} [options.fetchImpl] injectable for tests
 * @param {Function} [options.sleepImpl] injectable for tests
 * @param {number} [options.backoffBaseMs]
 */
export function createHttpClient({
  proxyUrl = null,
  timeoutMs = 30_000,
  retries = 3,
  log = NOOP_LOG,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
  backoffBaseMs = 500,
} = {}) {
  /** @type {Map<string, string>} name -> value */
  const jar = new Map();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null;

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  function absorbCookies(headers) {
    for (const raw of parseSetCookie(headers)) {
      const pair = String(raw).split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  function baseHeaders(extra) {
    const headers = {
      'user-agent': USER_AGENT,
      'accept-language': ACCEPT_LANGUAGE,
      ...extra,
    };
    const cookie = cookieHeader();
    if (cookie) headers.cookie = cookie;
    return headers;
  }

  async function once(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
      absorbCookies(res.headers);
      const body = await res.text();
      return { status: res.status, body, headers: res.headers, url: res.url || url };
    } catch (err) {
      if (err instanceof AdLibraryError) throw err;
      throw new AdLibraryError(CATEGORY.NETWORK, {
        detail: err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms: ${url}` : String(err?.message ?? err),
        cause: err,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A rate-limit block outlives any backoff we could afford (measured: still
   * blocked after 25 minutes) and it is bound to the exit IP, not the cookies.
   * Retrying it here would only spend the budget; it is propagated instead so
   * the session manager can rotate to a different IP.
   */
  const shouldRetry = (err) => err?.retryable === true && err?.category !== CATEGORY.RATE_LIMITED;

  async function withRetry(label, run) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await run();
      } catch (err) {
        lastError = err;
        if (attempt === retries || !shouldRetry(err)) throw err;
        const backoff = backoffBaseMs * 2 ** attempt;
        const delay = backoff + Math.floor(Math.random() * backoff);
        log.warning?.(`${label} failed (${err.category ?? 'unknown'}), retry ${attempt + 1}/${retries} in ${delay}ms`);
        await sleepImpl(delay);
      }
    }
    throw lastError;
  }

  /**
   * Meta refuses a disliked exit IP with 403 (and occasionally 401) on the very
   * first GET, before any GraphQL call. Reporting that as a network error sends
   * the reader hunting for a DNS problem that does not exist, so the two are
   * separated: 403/401 means "this IP is not welcome", which the session manager
   * can fix by rotating, and a plain 429 keeps its own meaning.
   */
  function assertStatus(status, url) {
    if (status >= 200 && status < 400) return;
    const category = status === 404 ? CATEGORY.PAGE_NOT_FOUND
      : status === 429 ? CATEGORY.RATE_LIMITED
        : (status === 403 || status === 401) ? CATEGORY.BLOCKED
          : CATEGORY.NETWORK;
    throw new AdLibraryError(category, {
      detail: `HTTP ${status} for ${url}`,
      status,
      // A blocked IP is not recoverable by waiting; it is recoverable by
      // rotating, which is the session manager's job, not the retry loop's.
      retryable: RETRYABLE_STATUS.has(status) && category === CATEGORY.NETWORK,
    });
  }

  /**
   * Meta answers with `for (;;);{...}` and sometimes appends further JSON lines
   * for multi-part Relay responses. Only the first line is the payload, and the
   * guard prefix has to go before parsing.
   */
  function parseFacebookJson(body, url) {
    const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? '';
    const stripped = firstLine.replace(JSON_HIJACK_PREFIX, '').trim();
    try {
      return JSON.parse(stripped);
    } catch (err) {
      const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(stripped);
      throw new AdLibraryError(looksLikeHtml ? CATEGORY.BLOCKED : CATEGORY.SCHEMA_CHANGED, {
        detail: `unparseable body from ${url}: ${stripped.slice(0, 120)}`,
        cause: err,
      });
    }
  }

  /**
   * HTTP 200 + `{"error":1357054}` is the soft block. Never a 429.
   *
   * The code is read through `readMetaError`, so the same block is recognised
   * whether Meta puts it at the top level or inside the GraphQL `errors` array
   * — it uses both, and reading only the top level let a block through
   * disguised as an unreadable response.
   *
   * Only the known block codes are fatal here. Anything else stays in the body
   * for the caller to judge: the transport layer does not get to decide that a
   * response it does not understand is a failure.
   */
  function assertNotSoftBlocked(json, url) {
    const metaError = readMetaError(json);
    if (metaError?.code === null || !SOFT_BLOCK_ERROR_CODES.has(metaError?.code)) return;
    throw new AdLibraryError(CATEGORY.RATE_LIMITED, {
      detail: `soft block ${metaError.code}${metaError.message ? ` (${metaError.message})` : ''} from ${url}`,
      status: 200,
      retryable: true,
    });
  }

  return {
    jar,
    cookieHeader,

    /** Seed a cookie the server never sets for us (e.g. the forced locale). */
    setCookie(name, value) {
      jar.set(name, value);
    },

    /**
     * @param {string} url
     * @param {{headers?: object, allowStatus?: (status: number, body: string) => boolean}} [opts]
     *   `allowStatus` lets a caller accept a response the status code alone
     *   would condemn. Meta serves its anti-bot challenge page with HTTP 403
     *   (measured 2026-08-27, evening — the morning it was still 200), so for
     *   the bootstrap GET the body, not the status, is what tells a solvable
     *   challenge apart from a genuine block.
     * @returns {Promise<string>} the response body
     */
    async getText(url, opts = {}) {
      return withRetry(`GET ${url}`, async () => {
        const res = await once(url, { method: 'GET', headers: baseHeaders(opts.headers), redirect: 'follow' });
        if (!opts.allowStatus?.(res.status, res.body)) assertStatus(res.status, url);
        return res.body;
      });
    },

    /**
     * @param {string} url
     * @param {Record<string, string|number|boolean>} bodyParams urlencoded form body
     * @param {{headers?: object, raw?: boolean}} [opts] `raw` skips JSON parsing
     *   (the challenge endpoint answers with something that is not JSON).
     * @returns {Promise<any|string>} parsed JSON, or the body when `raw`
     */
    async postForm(url, bodyParams = {}, opts = {}) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(bodyParams)) {
        if (value === undefined || value === null) continue;
        form.set(key, String(value));
      }
      const body = form.toString();

      return withRetry(`POST ${url}`, async () => {
        const res = await once(url, {
          method: 'POST',
          headers: baseHeaders({
            'content-type': 'application/x-www-form-urlencoded',
            accept: '*/*',
            ...opts.headers,
          }),
          body,
          redirect: 'follow',
        });
        assertStatus(res.status, url);
        if (opts.raw) return res.body;
        const json = parseFacebookJson(res.body, url);
        assertNotSoftBlocked(json, url);
        return json;
      });
    },

    /** Release the proxy agent's sockets. Rotation creates one client per
     *  session, so leaking agents would leak file descriptors. */
    async close() {
      if (dispatcher) await dispatcher.close().catch(() => {});
    },
  };
}

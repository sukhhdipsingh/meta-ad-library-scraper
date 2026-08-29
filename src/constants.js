/**
 * Every fact about Meta's Ad Library that the rest of the code depends on,
 * in one place. All of it was measured against the live endpoint on
 * 2026-08-27 (see PLANmetaadlibraryactor.md §1); nothing here is guesswork.
 *
 * When Meta changes something, this file is the first place to look.
 */

/** The Relay persisted-query id for the Ad Library search, as of 2026-08-27.
 *  Only a fallback: `docid.js` re-resolves it from the live JS bundle, because
 *  Meta rotates it whenever the frontend is redeployed. */
export const FALLBACK_DOC_ID = '24922295957467452';

/** Relay operation name — used both as a request header and to locate the
 *  doc_id module inside the bundle. */
export const OPERATION_NAME = 'AdLibrarySearchPaginationQuery';

export const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
export const AD_LIBRARY_URL = 'https://www.facebook.com/ads/library/';

/** A single ad's permalink in the public Ad Library. */
export const adPermalink = (id) => `${AD_LIBRARY_URL}?id=${encodeURIComponent(id)}`;

/** Measured: the server ignores `first` and always returns 10 edges per page.
 *  Cost and progress estimates must use this, not the requested page size. */
export const ADS_PER_PAGE = 10;

/** Measured: ~47 requests from one IP triggers a block that outlasts 25 minutes.
 *  A session is retired well before that, with a 2x safety margin. */
export const SESSION_MAX_REQUESTS = 25;

/** Meta signals the soft block as HTTP 200 with this code in the body — never
 *  as a 429. Any status-code-based retry would miss it entirely. */
export const SOFT_BLOCK_ERROR_CODES = new Set([1357054, 1357004, 1357001]);

/** Facebook prefixes JSON responses with this anti-hijacking guard. */
export const JSON_HIJACK_PREFIX = /^\s*for\s*\(\s*;\s*;\s*\)\s*;/;

/** Desktop Chrome on macOS. The Ad Library serves a different (JS-only) shell
 *  to unrecognised agents, so this is load-bearing, not cosmetic. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Meta localises spend and impression strings by IP. Forcing en_US keeps the
 *  public output schema stable no matter where the proxy exits. */
export const FORCED_LOCALE = 'en_US';
export const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/**
 * What a real Chrome tab sends when a person types the Ad Library URL.
 *
 * These are load-bearing, not decoration. Measured 2026-08-27: the cold GET is
 * answered with the challenge page (HTTP 403) whatever the headers say, but the
 * GET that follows the solved challenge is answered 400 when it carries only a
 * user-agent, and 200 with the full navigation set. Meta reads `Sec-Fetch-*`
 * and the client hints to decide whether this is a browser navigation, so
 * dropping them is the difference between an lsd token and a failed run.
 *
 * `accept-encoding` is deliberately absent — undici negotiates and decompresses
 * on its own, and overriding it yields a body we cannot read.
 */
export const NAVIGATION_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'cache-control': 'max-age=0',
};

/** Accepted values for the GraphQL variables, verified live. */
export const ACTIVE_STATUS = { active: 'ACTIVE', inactive: 'INACTIVE', all: 'ALL' };
export const AD_TYPE = { all: 'ALL', political: 'POLITICAL_AND_ISSUE_ADS' };
export const SEARCH_TYPE = { keyword: 'KEYWORD_UNORDERED', page: 'PAGE' };
export const MEDIA_TYPE = { all: 'ALL', image: 'IMAGE', video: 'VIDEO', meme: 'MEME' };

/** Charged once per unique, billable ad. */
export const CHARGE_EVENT = 'ad-result';

/** Key-value record names. Documented in the README because buyers read them. */
export const SUMMARY_KEY = 'SUMMARY';
export const RUN_STATUS_KEY = 'RUN-STATUS';
export const MONITOR_STORE = 'meta-ad-monitor';
/** Pagination progress, so a killed run resumes instead of restarting. */
export const CHECKPOINT_STORE = 'meta-ad-checkpoint';
/** The query id a previous run resolved from the live bundle. Persisting it is
 *  what makes the self-repair permanent: Meta's rotation is paid for once, by
 *  whichever run hits it first, and never again by any later run. */
export const DOC_ID_STORE = 'meta-ad-docid';
export const DOC_ID_KEY = 'CURRENT';

/** How many bundle bytes one run may spend hunting for a rotated query id.
 *  Measured 2026-08-29: the operation lives in the 5th ranked candidate and is
 *  reached after 7.4 MB, so the old cap of "the first 4 bundles" could never
 *  find it. A byte budget is the honest limit — the count never was. */
export const DOC_ID_SCAN_BUDGET_BYTES = 24_000_000;

/** A run that paginates forever costs the buyer money for nothing. */
export const DEFAULT_MAX_PAGES_PER_QUERY = 200;
export const DEFAULT_MAX_ADS = 1000;

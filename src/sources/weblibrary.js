/**
 * The public Ad Library, read through the same GraphQL call the website makes.
 *
 * This is the primary source and the only one that sees ordinary commercial
 * ads. Meta's official Graph API is deliberately narrower (political ads
 * everywhere, all ads only for the EU), so for the "what is my competitor
 * running" question — the one people actually buy this for — this adapter is
 * the product.
 *
 * Everything the request needs was measured against the live endpoint on
 * 2026-08-27 and is recorded in constants.js. Two facts drive the shape of the
 * code here:
 *
 *   - The server ignores `first` and always returns 10 edges. Progress and cost
 *     are counted in pages of ADS_PER_PAGE, never in the requested size.
 *   - Pagination is strictly sequential: each cursor is only obtainable from the
 *     previous response. Concurrency therefore belongs between queries, never
 *     inside one. `paginate` is an async generator so the caller can stop the
 *     moment a budget is exhausted, rather than fetching a page it cannot bill.
 */
import {
  ACTIVE_STATUS, AD_TYPE, ADS_PER_PAGE, GRAPHQL_URL, MEDIA_TYPE,
  OPERATION_NAME, SEARCH_TYPE, AD_LIBRARY_URL,
} from '../constants.js';
import { AdLibraryError, CATEGORY, classifyMetaError, readMetaError } from '../errors.js';
import { extractPage, normalizeAd } from '../normalize.js';

export const name = 'web';

/** A stable, human-readable id for a query — used as the RUN-STATUS key and as
 *  the monitor's ownership marker, so it must not depend on run order. */
export function queryKeyOf(target) {
  if (target.pageId) return `page:${target.pageId}:${target.countries.join('+')}:${target.activeStatus}`;
  return `term:${target.searchTerm}:${target.countries.join('+')}:${target.activeStatus}`;
}

const ALPHA2 = /^[A-Z]{2}$/;

/** Countries are validated here rather than at the edge so a bad code produces
 *  a named category instead of an empty result the buyer has to explain. */
function normaliseCountries(countries) {
  const list = (Array.isArray(countries) ? countries : [countries])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => c.trim().toUpperCase());
  if (!list.length) return ['ALL'];
  for (const c of list) {
    if (c !== 'ALL' && !ALPHA2.test(c)) {
      throw new AdLibraryError(CATEGORY.COUNTRY_NOT_SUPPORTED, { detail: `"${c}"` });
    }
  }
  return list;
}

/**
 * Read an Ad Library URL the way the website does, so a buyer can paste a link
 * straight from the browser and get exactly what they were looking at.
 * Returns null when the URL is not an Ad Library URL.
 */
export function parseAdLibraryUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$/i.test(url.hostname) || !url.pathname.startsWith('/ads/library')) return null;

  const q = url.searchParams;
  const pageId = q.get('view_all_page_id') || q.get('page_ids');
  const country = q.get('country');
  const status = (q.get('active_status') || 'active').toLowerCase();
  const type = (q.get('ad_type') || 'all').toLowerCase();
  const media = (q.get('media_type') || 'all').toLowerCase();

  return {
    pageId: pageId || null,
    searchTerm: pageId ? null : (q.get('q') || null),
    countries: country ? normaliseCountries(country.split(',')) : ['ALL'],
    activeStatus: status in ACTIVE_STATUS ? status : 'active',
    adType: type === 'political_and_issue_ads' ? 'political' : (type in AD_TYPE ? type : 'all'),
    mediaType: media in MEDIA_TYPE ? media : 'all',
    // A single ad permalink (?id=...) is a legitimate thing to paste.
    singleAdId: q.get('id') || null,
  };
}

/**
 * Turn one user-facing target into everything the request layer needs.
 * `target` is `{ pageId }` or `{ searchTerm }` plus the run-wide options.
 */
export function buildQuery(target, options = {}) {
  const countries = normaliseCountries(target.countries ?? options.countries ?? ['ALL']);
  const activeStatus = target.activeStatus ?? options.activeStatus ?? 'active';
  const adType = target.adType ?? options.adType ?? 'all';
  const mediaType = target.mediaType ?? options.mediaType ?? 'all';

  const pageId = target.pageId ? String(target.pageId).trim() : null;
  const searchTerm = pageId ? null : String(target.searchTerm ?? '').trim();

  if (!pageId && !searchTerm) {
    throw new AdLibraryError(CATEGORY.INVALID_INPUT, {
      detail: 'a query needs either a pageId or a searchTerm',
    });
  }
  if (pageId && !/^\d+$/.test(pageId)) {
    throw new AdLibraryError(CATEGORY.INVALID_INPUT, {
      detail: `pageId "${pageId}" is not numeric — copy view_all_page_id from the Ad Library URL`,
    });
  }

  const resolved = { pageId, searchTerm, countries, activeStatus, adType, mediaType };
  return {
    ...resolved,
    queryKey: queryKeyOf(resolved),
    /** The browser URL that shows the same thing — printed in RUN-STATUS so a
     *  buyer can check any query by eye. */
    browserUrl: `${AD_LIBRARY_URL}?active_status=${activeStatus}&ad_type=${adType}`
      + `&country=${countries[0]}`
      + (pageId ? `&search_type=page&view_all_page_id=${pageId}` : `&q=${encodeURIComponent(searchTerm)}`),
  };
}

/** The GraphQL variables. All 25 names were read out of Meta's own bundle;
 *  omitting one that the operation declares makes the request fail. */
function variablesFor(query, cursor) {
  const isPage = Boolean(query.pageId);
  return {
    activeStatus: ACTIVE_STATUS[query.activeStatus] ?? ACTIVE_STATUS.active,
    adType: AD_TYPE[query.adType] ?? AD_TYPE.all,
    bylines: [],
    collationToken: null,
    contentLanguages: [],
    countries: query.countries,
    cursor: cursor ?? null,
    excludedIDs: [],
    first: ADS_PER_PAGE,
    isTargetedCountry: false,
    location: null,
    mediaType: MEDIA_TYPE[query.mediaType] ?? MEDIA_TYPE.all,
    multiCountryFilterMode: null,
    pageIDs: isPage ? [query.pageId] : [],
    potentialReachInput: [],
    publisherPlatforms: [],
    queryString: isPage ? '' : query.searchTerm,
    regions: [],
    searchType: isPage ? SEARCH_TYPE.page : SEARCH_TYPE.keyword,
    sessionID: query.sessionUuid ?? '00000000-0000-4000-8000-000000000000',
    sortData: null,
    source: null,
    startDate: null,
    v: 'ab12cd',
    viewAllPageID: isPage ? query.pageId : '0',
  };
}

/** The top-level keys of a response we could not read, for the log. Keys only:
 *  a response body can be megabytes, and the shape is the diagnostic. */
function describeShape(payload) {
  if (payload === null || typeof payload !== 'object') return typeof payload;
  const keys = Object.keys(payload);
  return keys.length ? keys.slice(0, 12).join(', ') : 'an empty object';
}

/**
 * One page of results.
 *
 * @param {object} query    from `buildQuery`
 * @param {string|null} cursor
 * @param {{session: object}} ctx
 * @returns {Promise<{ads: object[], hasNext: boolean, endCursor: string|null}>}
 */
export async function fetchPage(query, cursor, { session }) {
  const payload = await session.http.postForm(GRAPHQL_URL, {
    av: '0',
    __aaid: '0',
    __user: '0',
    __a: '1',
    __req: '1',
    dpr: '1',
    // Both of these are required: without them Meta answers with a generic
    // "couldn't be processed" error rather than data.
    __ccg: 'EXCELLENT',
    lsd: session.lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: OPERATION_NAME,
    variables: JSON.stringify(variablesFor(query, cursor)),
    server_timestamps: 'true',
    doc_id: session.docId,
  }, {
    headers: {
      'x-fb-lsd': session.lsd,
      'x-fb-friendly-name': OPERATION_NAME,
      origin: 'https://www.facebook.com',
      referer: query.browserUrl,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  });

  const { ads, pageInfo, missing } = extractPage(payload);
  if (missing) {
    // A body with no `data` at all is almost never a schema change: it is Meta
    // declining to answer this exit IP, and it says so in the body. Reporting
    // that as `schema_changed` was the bug that made a run fail outright — the
    // category is not retryable, so the run died on a refusal that rotating the
    // proxy session would have fixed. Read the refusal and let it rotate.
    const refusal = readMetaError(payload);
    if (refusal) {
      throw new AdLibraryError(classifyMetaError(refusal), {
        detail: `Meta declined the query${refusal.code !== null ? ` (code ${refusal.code})` : ''}`
          + `${refusal.message ? `: ${refusal.message}` : ''}`,
        status: 200,
      });
    }
    // No refusal in the body either: Meta really did move something. Name the
    // top-level keys, because "expected data" alone has never been enough to
    // tell anyone which module to fix.
    throw new AdLibraryError(CATEGORY.SCHEMA_CHANGED, {
      detail: `expected "${missing}" in the response`
        + ` (body has: ${describeShape(payload)})`,
    });
  }
  return { ads, hasNext: pageInfo.hasNext, endCursor: pageInfo.endCursor };
}

/**
 * Walk a query's pages until it runs out, the page budget is spent, or the
 * caller stops pulling.
 *
 * Two guards matter here. Meta will happily hand back the same cursor forever
 * on some queries, so a repeat means stop — otherwise the run bills the buyer
 * for an infinite loop. And `hasNext` can stay true while a page returns
 * nothing, which is also a terminal condition.
 *
 * @yields {{ads: object[], page: number}}
 */
export async function* paginate(query, ctx, { maxPages = 200, onPage = null, startCursor = null } = {}) {
  const seenCursors = new Set();
  // A resumed run starts at the cursor the previous attempt reached, not at
  // the top. Meta's cursor is opaque but durable: it stays valid across
  // processes and exit IPs, which is what makes resuming possible at all.
  let cursor = startCursor;

  for (let page = 1; page <= maxPages; page++) {
    const session = await ctx.acquireSession();
    let result;
    try {
      result = await fetchPage(query, cursor, { session });
      ctx.noteRequest(session);
    } catch (err) {
      // A response we cannot read is the symptom of Meta having redeployed the
      // frontend and rotated the persisted-query id. Re-reading it costs a
      // large bundle download, so it happens here — once, on evidence — rather
      // than on every run. This is what stops "it broke again this week".
      const looksStale = err?.category === CATEGORY.SCHEMA_CHANGED
        || err?.category === CATEGORY.DOC_ID_STALE;
      if (looksStale && await ctx.refreshDocId?.(session)) {
        result = await fetchPage(query, cursor, { session });
        ctx.noteRequest(session);
      } else {
        const rotated = await ctx.noteFailure(session, err);
        if (!rotated) throw err;
        // The block belongs to the exit IP, not to the cursor: retry the same
        // page on a fresh session rather than losing the query's progress.
        const retrySession = await ctx.acquireSession();
        result = await fetchPage(query, cursor, { session: retrySession });
        ctx.noteRequest(retrySession);
      }
    }

    const exhausted = !result.hasNext || !result.endCursor || !result.ads.length
      || seenCursors.has(result.endCursor);

    // The cursor is reported *with* the page, so the caller can only record a
    // boundary it has actually finished handling. Recording it earlier would
    // let a crash skip a page that was never delivered.
    if (result.ads.length) {
      yield { ads: result.ads, page, nextCursor: exhausted ? null : result.endCursor, done: exhausted };
    }
    onPage?.({ page, count: result.ads.length });

    if (exhausted) return;
    seenCursors.add(result.endCursor);
    cursor = result.endCursor;
  }
  // Ran out of page budget rather than out of ads: the caller decides whether
  // that is a cap worth reporting.
}

/** Raw ad -> public record. Thin on purpose: the mapping lives in normalize.js
 *  so both sources produce byte-identical rows. */
export function normalize(raw, ctx = {}) {
  return normalizeAd(raw, { ...ctx, source: name });
}

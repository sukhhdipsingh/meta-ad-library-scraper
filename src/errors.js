/**
 * Readable failure categories.
 *
 * Why this module exists: the loudest complaint about every Ad Library scraper
 * on the market is that a failed run leaves you reading raw logs to guess what
 * happened ("debugging failed runs through the logs can be tedious"). Every
 * failure this actor records carries a category and a sentence written for the
 * person who is paying, not for the person who wrote the code.
 *
 * The category strings are part of the public output contract: they appear in
 * the RUN-STATUS record and are safe to branch on. Never rename one.
 */

export const CATEGORY = {
  RATE_LIMITED: 'rate_limited',
  SCHEMA_CHANGED: 'schema_changed',
  DOC_ID_STALE: 'doc_id_stale',
  PAGE_NOT_FOUND: 'page_not_found',
  COUNTRY_NOT_SUPPORTED: 'country_not_supported',
  NO_RESULTS: 'no_results',
  BLOCKED: 'blocked',
  NETWORK: 'network',
  INVALID_INPUT: 'invalid_input',
  UNKNOWN: 'unknown',
};

/** What each category means, in the buyer's language. `detail` is appended
 *  when the failure knows something specific (a field name, a country code). */
const EXPLAIN = {
  [CATEGORY.RATE_LIMITED]:
    'Meta is rate-limiting this IP. The run rotated proxy sessions and still hit the limit — ' +
    'use residential proxies, or lower maxAds.',
  [CATEGORY.SCHEMA_CHANGED]:
    'Meta changed the Ad Library response shape, so some fields could not be read. ' +
    'The rest of the run is unaffected; please report this so the one affected module can be fixed.',
  [CATEGORY.DOC_ID_STALE]:
    'Meta redeployed the Ad Library frontend and the stored query id no longer resolves. ' +
    'The actor re-reads it from the live bundle automatically; this run fell back and may be incomplete.',
  [CATEGORY.PAGE_NOT_FOUND]:
    'That Facebook Page id does not exist, is not public, or has never run ads.',
  [CATEGORY.COUNTRY_NOT_SUPPORTED]:
    'The Ad Library rejected that country code. Use ISO-3166 alpha-2 (US, DE, IT) or ALL.',
  [CATEGORY.NO_RESULTS]:
    'The request succeeded and Meta returned no ads for these filters. This is an answer, not an error.',
  [CATEGORY.BLOCKED]:
    'Could not establish a session with the Ad Library — the anti-bot challenge did not resolve. ' +
    'This usually means the proxy exit IP is blocked; a different proxy group normally fixes it.',
  [CATEGORY.NETWORK]:
    'Network error talking to Meta after all retries (timeout, DNS, or connection reset).',
  [CATEGORY.INVALID_INPUT]:
    'The input could not be turned into an Ad Library query.',
  [CATEGORY.UNKNOWN]:
    'Unrecognised failure. The raw message is kept so it can be diagnosed.',
};

/**
 * A failure that already knows how to explain itself.
 * `category` is always one of CATEGORY; `detail` is optional extra context.
 */
export class AdLibraryError extends Error {
  constructor(category, { detail = '', cause = null, status = 0, retryable = false } = {}) {
    const explain = EXPLAIN[category] ?? EXPLAIN[CATEGORY.UNKNOWN];
    // When the detail is already a complete, self-explanatory sentence, it
    // stands alone. Prefixing it with the generic blurb only pads the message
    // the buyer has to read to find out what to change.
    const selfContained = /[.!?]\s*$/.test(detail) && detail.length > 40;
    super(!detail ? explain : selfContained ? detail : `${explain} (${detail})`);
    this.name = 'AdLibraryError';
    this.category = CATEGORY[category?.toUpperCase?.()] ? category : (Object.values(CATEGORY).includes(category) ? category : CATEGORY.UNKNOWN);
    this.detail = detail;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }

  /** The shape that ends up in RUN-STATUS and in failed dataset rows. */
  toRecord() {
    return {
      errorCategory: this.category,
      errorMessage: this.message,
      ...(this.detail ? { errorDetail: this.detail } : {}),
    };
  }
}

/** Human explanation for a category, without needing an Error instance. */
export function explain(category) {
  return EXPLAIN[category] ?? EXPLAIN[CATEGORY.UNKNOWN];
}

/**
 * Best-effort classification of anything thrown or returned that is not
 * already an AdLibraryError. Never throws.
 */
export function categorise(err) {
  if (err instanceof AdLibraryError) return err.category;
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  if (err?.name === 'AbortError' || msg.includes('timeout') || msg.includes('econnreset')
    || msg.includes('enotfound') || msg.includes('socket') || msg.includes('fetch failed')) {
    return CATEGORY.NETWORK;
  }
  if (msg.includes('rate') || msg.includes('1357054')) return CATEGORY.RATE_LIMITED;
  if (msg.includes('challenge') || msg.includes('lsd')) return CATEGORY.BLOCKED;
  return CATEGORY.UNKNOWN;
}

/**
 * Read Meta's refusal envelope out of an HTTP 200 body.
 *
 * Why this exists: Meta almost never refuses with a status code. It answers
 * 200 and puts the reason in the body, in one of several shapes that have all
 * been observed on the Ad Library endpoint:
 *
 *   {"error":1357054,"errorSummary":"Your Request Couldn't be Processed"}
 *   {"errors":[{"code":1675004,"summary":"...","description":"..."}]}
 *   {"error":{"code":1357001,"message":"..."}}
 *
 * Only the first usable entry is returned: a refusal has one reason, and the
 * rest of the array is Relay bookkeeping. Never throws.
 *
 * @param {any} payload parsed response body
 * @returns {{code: number|null, message: string|null}|null}
 */
export function readMetaError(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const sources = [];
  if (typeof payload.error === 'number') sources.push(payload);
  else if (payload.error && typeof payload.error === 'object') sources.push(payload.error);
  if (Array.isArray(payload.errors)) {
    for (const e of payload.errors) if (e && typeof e === 'object') sources.push(e);
  }

  for (const src of sources) {
    const rawCode = src.code ?? src.error ?? src.api_error_code ?? src.error_code;
    const code = Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;
    const message = String(
      src.errorSummary ?? src.summary ?? src.message ?? src.errorDescription ?? src.description ?? '',
    ).replace(/\s+/g, ' ').trim();
    if (code !== null || message) return { code, message: message || null };
  }
  return null;
}

/**
 * What to do about a refusal Meta explained in the body.
 *
 * Deliberately generic. A table of known codes is a maintenance treadmill —
 * Meta adds one and the actor breaks again — so an unrecognised refusal is
 * treated as transient and rotates the exit IP rather than failing the run.
 * That is the recoverable reading, and it is right far more often than not:
 * a data-less answer to a well-formed query is an anti-bot decision, not a
 * schema change. Only a body with no refusal in it at all is a schema change,
 * and that judgement is made by the caller, not here.
 */
export function classifyMetaError(metaError) {
  const message = String(metaError?.message ?? '').toLowerCase();
  // Meta names a rotated persisted query explicitly ("Query with id ... does
  // not exist"). That one is worth telling apart from a refusal, because it is
  // the failure the bundle re-read actually repairs — misfiling it as a block
  // would rotate proxies forever against a problem no IP change can fix.
  if (/persisted query|query with (?:id|hash)|doc_?id|unknown query|not exist/.test(message)) {
    return CATEGORY.DOC_ID_STALE;
  }
  if (/log in|login|checkpoint|not authori[sz]ed|no permission|restricted/.test(message)) {
    return CATEGORY.BLOCKED;
  }
  return CATEGORY.RATE_LIMITED;
}

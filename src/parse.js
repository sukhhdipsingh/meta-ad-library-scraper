/**
 * Turning Meta's human-facing strings into machine-facing numbers.
 *
 * Why this module exists: the Ad Library localises every transparency figure by
 * exit IP. The same ad is `"$300,000 - $350,000"` from a US proxy and
 * `"300.000 US$ - 350.000 US$"` from an Italian one — the separators swap
 * meaning between the two. Buyers still expect one numeric column they can sort.
 * So: parse best-effort, never throw, and always keep `raw` so a wrong guess is
 * auditable and recoverable downstream.
 *
 * Every export here is total. Dirty input yields `null` or `[]`, never an
 * exception — a single malformed ad must not take a 1000-ad run down with it.
 */

const SECONDS_PER_DAY = 86400;

/** Thousand/million/billion words seen across Meta's locales. Matched as whole
 *  tokens only, so a currency suffix ("US$", "kr") is never read as a
 *  multiplier. */
const MULTIPLIERS = new Map([
  ['k', 1e3], ['mila', 1e3], ['tsd', 1e3], ['thousand', 1e3],
  ['m', 1e6], ['mln', 1e6], ['mio', 1e6], ['mn', 1e6],
  ['milioni', 1e6], ['million', 1e6], ['millions', 1e6], ['millones', 1e6],
  ['b', 1e9], ['bn', 1e9], ['mld', 1e9], ['mrd', 1e9],
  ['billion', 1e9], ['miliardi', 1e9],
]);

/** Longest/most specific patterns first: `US$` must win over a bare `$`. */
const CURRENCIES = [
  [/US\s?\$|\bUSD\b/i, 'USD'],
  [/R\s?\$|\bBRL\b/i, 'BRL'],
  [/(?:CA|C)\s?\$|\bCAD\b/i, 'CAD'],
  [/(?:AU|A)\s?\$|\bAUD\b/i, 'AUD'],
  [/MX\s?\$|\bMXN\b/i, 'MXN'],
  [/€|\bEUR\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/₹|\bINR\b/i, 'INR'],
  [/¥|\bJPY\b/i, 'JPY'],
  [/\bCHF\b/i, 'CHF'],
  [/\bSEK\b/i, 'SEK'],
  [/\bNOK\b/i, 'NOK'],
  [/\bDKK\b/i, 'DKK'],
  [/\bPLN\b/i, 'PLN'],
  [/\bTRY\b/i, 'TRY'],
  [/\bZAR\b/i, 'ZAR'],
  [/\$/, 'USD'],
];

/** Spaces (incl. NBSP / narrow NBSP) are a thousands separator in fr/ru/pl. */
const GROUPING_SPACES = /[\s\u00a0\u202f\u2009]/g;

/** A number, its optional grouping separators, and an optional unit word. */
const AMOUNT = /(\d[\d.,\s\u00a0\u202f\u2009]*\d|\d)\s*([a-z]{1,8}\.?)?/i;

/** Any dash between two amounts is a range; amounts never contain dashes. */
const RANGE_SPLIT = /\s*[-–—]\s*|\s+(?:to|a|bis|até)\s+/i;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * `"300.000"` is 300000 in Italian and 300.0 in English. Resolve it without
 * knowing the locale:
 *  - both separators present -> the rightmost one is the decimal point;
 *  - one separator, repeated -> grouping;
 *  - one separator, exactly 3 digits after it -> grouping. Meta reports whole
 *    money buckets, so `1.000` is a thousand, never one-point-zero.
 */
function toNumber(text) {
  let t = String(text).replace(GROUPING_SPACES, '');
  if (t === '') return null;

  const hasDot = t.includes('.');
  const hasComma = t.includes(',');

  if (hasDot && hasComma) {
    const decimal = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    t = t.split(grouping).join('');
    t = t.split(decimal).join('.');
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = t.split(sep);
    const tail = parts[parts.length - 1];
    t = parts.length > 2 || tail.length === 3 ? parts.join('') : parts.join('.');
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** One side of a range: `{ value, cmp }` where cmp is '<', '>' or null. */
function parseAmount(part) {
  if (!isNonEmptyString(part)) return null;
  const cmp = /[<≤]/.test(part) ? '<' : /[>≥]/.test(part) ? '>' : null;
  const m = AMOUNT.exec(part);
  if (!m) return null;
  const base = toNumber(m[1]);
  if (base === null) return null;
  const unit = (m[2] ?? '').toLowerCase().replace(/\.$/, '');
  const mult = MULTIPLIERS.get(unit) ?? 1;
  return { value: base * mult, cmp };
}

/**
 * `"100K - 200K"` -> `{ lower: 100000, upper: 200000 }`.
 * `"<$100"`       -> `{ lower: 0,      upper: 100 }`   (an open lower bound is 0)
 * `">1 mln"`      -> `{ lower: 1e6,    upper: null }`  (no upper bound exists)
 * A bare value is both bounds.
 */
function parseRange(raw) {
  if (!isNonEmptyString(raw)) return null;

  const parts = raw.split(RANGE_SPLIT).filter((p) => /\d/.test(p));
  if (parts.length >= 2) {
    const lo = parseAmount(parts[0]);
    const hi = parseAmount(parts[parts.length - 1]);
    if (lo && hi) return { lower: lo.value, upper: hi.value };
  }

  const one = parseAmount(raw);
  if (!one) return { lower: null, upper: null };
  if (one.cmp === '<') return { lower: 0, upper: one.value };
  if (one.cmp === '>') return { lower: one.value, upper: null };
  return { lower: one.value, upper: one.value };
}

function detectCurrency(raw) {
  for (const [pattern, code] of CURRENCIES) if (pattern.test(raw)) return code;
  return null;
}

/**
 * Localised spend string -> `{ lower, upper, currency, raw }`, or null when
 * Meta sent nothing. `raw` survives even when the numbers do not.
 * @param {string|number|null|undefined} raw
 * @returns {{lower: number|null, upper: number|null, currency: string|null, raw: string}|null}
 */
export function parseSpend(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { lower: raw, upper: raw, currency: null, raw: String(raw) };
  }
  if (!isNonEmptyString(raw)) return null;

  const range = parseRange(raw) ?? { lower: null, upper: null };
  return {
    lower: range.lower,
    upper: range.upper,
    currency: detectCurrency(raw),
    raw,
  };
}

/**
 * Localised impressions string -> `{ lower, upper, raw }`, or null when absent.
 * Prefer `impressionsIndex` for sorting; these bounds are a best effort.
 * @param {string|number|null|undefined} raw
 * @returns {{lower: number|null, upper: number|null, raw: string}|null}
 */
export function parseImpressions(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { lower: raw, upper: raw, raw: String(raw) };
  }
  if (!isNonEmptyString(raw)) return null;

  const range = parseRange(raw) ?? { lower: null, upper: null };
  return { lower: range.lower, upper: range.upper, raw };
}

/**
 * Reach is a single number in the output schema, but Meta may send a bucket
 * (`"100.000 - 500.000"`) or an open bound (`">1 mln"`). The lower bound is the
 * only value guaranteed to be true of the ad, so that is what is reported.
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parseReach(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (!isNonEmptyString(raw)) return null;
  const range = parseRange(raw);
  const value = range?.lower ?? range?.upper ?? null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Year 3000. Meta sends epochs in SECONDS; anything past this bound is a
 *  millisecond value passed by mistake, and 0 always means "Meta had no date",
 *  so both are rejected instead of producing a year-58000 or 1970 column. */
const MAX_EPOCH_SECONDS = 32503680000;

function toEpochSeconds(sec) {
  const n = typeof sec === 'number' ? sec : (isNonEmptyString(sec) ? Number(sec) : NaN);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_EPOCH_SECONDS) return null;
  return Math.trunc(n);
}

/**
 * Epoch seconds -> `"YYYY-MM-DD"` in UTC, or null.
 * @param {number|string|null|undefined} sec
 * @returns {string|null}
 */
export function epochToIsoDate(sec) {
  const n = toEpochSeconds(sec);
  if (n === null) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

/**
 * Epoch seconds -> full ISO 8601 timestamp in UTC, or null.
 * @param {number|string|null|undefined} sec
 * @returns {string|null}
 */
export function epochToIso(sec) {
  const n = toEpochSeconds(sec);
  if (n === null) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * Whole days an ad has been running. A still-running ad has no end date, so
 * `nowEpoch` stands in for it. Counted between UTC calendar days, which keeps
 * the number consistent with the `startDate`/`endDate` columns next to it
 * rather than drifting by one on DST-shifted timestamps.
 * @returns {number|null} >= 0, or null when the start (or both ends) is unknown
 */
export function activeDays(startEpoch, endEpoch, nowEpoch) {
  const start = toEpochSeconds(startEpoch);
  if (start === null) return null;
  const end = toEpochSeconds(endEpoch) ?? toEpochSeconds(nowEpoch);
  if (end === null) return null;

  const startDay = Math.floor(start / SECONDS_PER_DAY);
  const endDay = Math.floor(end / SECONDS_PER_DAY);
  return Math.max(0, endDay - startDay);
}

/**
 * Anything -> a clean `string[]`: trimmed, de-duplicated, empties dropped,
 * nested arrays flattened. Array columns in the output are never null, so this
 * always returns an array.
 * @returns {string[]}
 */
export function toStringArray(v) {
  const out = [];
  const seen = new Set();

  const push = (item) => {
    if (Array.isArray(item)) {
      for (const el of item) push(el);
      return;
    }
    if (item === null || item === undefined) return;
    let s;
    if (typeof item === 'string') s = item;
    else if (typeof item === 'number') s = Number.isFinite(item) ? String(item) : '';
    else if (typeof item === 'boolean') s = String(item);
    else return; // objects carry no meaningful string form
    s = s.trim();
    if (s === '' || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  push(v);
  return out;
}

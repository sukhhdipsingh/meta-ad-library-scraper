/**
 * Refuse an input we do not understand, before spending the buyer's money.
 *
 * This module exists because of two real, documented incidents on a competing
 * actor. Both users wrote `maxAds` when that actor's field was called
 * `resultsLimit`. It accepted the unknown key in silence, treated the run as
 * uncapped, and scraped everything:
 *
 *   "It ignored MaxADS and instead of returning six results, it continued
 *    scraping without signaling for an hour. I spent $17 for nothing."
 *
 *   "I was charged for 3000+ ads being scraped when in reality the brand has
 *    less than 200 active ads ... the price reached all the way up to $15 for
 *    a single scrape."
 *
 * A typo in a config field should cost a clear error message, not fifteen
 * dollars. So: unknown keys are rejected, near-misses are named, and values
 * that cannot mean what they say are rejected too — all before the first
 * request to Meta.
 */
import { AdLibraryError, CATEGORY } from './errors.js';
import { ACTIVE_STATUS, AD_TYPE, MEDIA_TYPE } from './constants.js';

/** Every key the actor understands. Anything else is a mistake worth catching. */
export const KNOWN_INPUT_KEYS = new Set([
  'searchTerms', 'pageIds', 'adLibraryUrls', 'advertiserDomains',
  'countries', 'activeStatus', 'adType', 'mediaType',
  'maxAds', 'maxCostUsd', 'maxPagesPerQuery',
  'monitorMode', 'monitorId', 'emitRemoved',
  'persistMedia', 'includeCards',
  // filters, applied before billing
  'publisherPlatforms', 'minDaysRunning', 'maxDaysRunning',
  'startedAfter', 'startedBefore',
  'excludeDisplayFormats', 'requireMedia', 'minVariantCount',
  'bodyContains', 'bodyExcludes', 'linkDomains', 'maxAdsPerPage',
  'resumeFromCheckpoint', 'webhookUrl',
  'proxyConfiguration',
  // Accepted and ignored: the platform and the console add these.
  'debug', 'customData',
]);

/** Field names competing actors use, so a copied config fails with a pointer
 *  rather than a shrug. */
const ALIASES = new Map([
  ['resultsLimit', 'maxAds'],
  ['limitPerSource', 'maxAds'],
  ['count', 'maxAds'],
  ['maxResults', 'maxAds'],
  ['limit', 'maxAds'],
  ['urls', 'adLibraryUrls'],
  ['startUrls', 'adLibraryUrls'],
  ['searchQueries', 'searchTerms'],
  ['searchQuery', 'searchTerms'],
  ['keywords', 'searchTerms'],
  ['query', 'searchTerms'],
  ['pageId', 'pageIds'],
  ['country', 'countries'],
  ['countryCode', 'countries'],
  ['onlyAdsNewerThan', null],
  ['onlyAdsOlderThan', null],
  ['onlyTotal', null],
  ['scrapeAdDetails', null],
  ['scrapePageAds', null],
]);

/** Levenshtein distance, bounded — only used to suggest a near-miss key. */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
      last = tmp;
    }
  }
  return prev[b.length];
}

function suggestionFor(key) {
  if (ALIASES.has(key)) {
    const target = ALIASES.get(key);
    return target
      ? `Did you mean "${target}"? (Another Ad Library actor calls it "${key}".)`
      : `"${key}" belongs to a different Ad Library actor and has no equivalent here.`;
  }
  let best = null;
  let bestScore = 3;
  for (const known of KNOWN_INPUT_KEYS) {
    const d = distance(key, known);
    if (d < bestScore) { bestScore = d; best = known; }
  }
  return best ? `Did you mean "${best}"?` : null;
}

const isIntLike = (v) => Number.isFinite(Number(v)) && Number(v) === Math.floor(Number(v));

/**
 * Check the input and throw on anything that would silently cost money.
 *
 * @param {object} input
 * @returns {{warnings: string[]}} non-fatal notes worth logging
 * @throws {AdLibraryError} CATEGORY.INVALID_INPUT
 */
export function validateInput(input = {}) {
  const warnings = [];
  const problems = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdLibraryError(CATEGORY.INVALID_INPUT, { detail: 'the input must be a JSON object' });
  }

  for (const key of Object.keys(input)) {
    if (KNOWN_INPUT_KEYS.has(key)) continue;
    const hint = suggestionFor(key);
    problems.push(`Unknown input field "${key}".${hint ? ` ${hint}` : ''}`);
  }

  const hasTarget = ['searchTerms', 'pageIds', 'adLibraryUrls', 'advertiserDomains']
    .some((k) => (Array.isArray(input[k]) ? input[k].length : Boolean(input[k])));
  if (!hasTarget && !problems.length) {
    problems.push('Nothing to scrape: provide at least one of searchTerms, pageIds, advertiserDomains or adLibraryUrls.');
  }

  for (const [key, valid] of [['activeStatus', ACTIVE_STATUS], ['adType', AD_TYPE], ['mediaType', MEDIA_TYPE]]) {
    const v = input[key];
    if (v === undefined || v === null || v === '') continue;
    if (!(v in valid)) {
      problems.push(`"${key}" must be one of ${Object.keys(valid).join(', ')} — got "${v}".`);
    }
  }

  if (input.monitorMode !== undefined && input.monitorMode !== null
    && !['off', 'annotate', 'changes-only'].includes(input.monitorMode)) {
    problems.push(`"monitorMode" must be off, annotate or changes-only — got "${input.monitorMode}".`);
  }

  for (const key of ['maxAds', 'maxCostUsd', 'maxPagesPerQuery',
    'minDaysRunning', 'maxDaysRunning', 'minVariantCount', 'maxAdsPerPage']) {
    const v = input[key];
    if (v === undefined || v === null || v === '') continue;
    if (!isIntLike(v) || Number(v) <= 0) {
      problems.push(`"${key}" must be a positive whole number — got ${JSON.stringify(v)}.`);
    }
  }

  for (const key of ['searchTerms', 'pageIds', 'adLibraryUrls', 'advertiserDomains', 'countries',
    'publisherPlatforms', 'excludeDisplayFormats', 'bodyContains', 'bodyExcludes', 'linkDomains']) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      problems.push(`"${key}" must be a list, e.g. ["nike"] — got ${JSON.stringify(v)}.`);
    }
  }

  // An uncapped run is not refused — but the buyer is told what it implies.
  if (input.maxAds === undefined && !problems.length) {
    warnings.push('No maxAds set; the default cap of 1000 ads applies. Raise it deliberately for bigger runs.');
  }
  if (input.monitorMode === 'changes-only' && !input.monitorId) {
    warnings.push('changes-only with no monitorId uses the shared "default" memory. Give each schedule its own monitorId.');
  }

  if (problems.length) {
    throw new AdLibraryError(CATEGORY.INVALID_INPUT, {
      detail: `${problems.join(' ')} Nothing was scraped and nothing was charged.`,
    });
  }
  return { warnings };
}

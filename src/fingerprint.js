/**
 * Deciding whether an ad's creative actually changed.
 *
 * Why this module exists: monitor mode charges for `changed` rows, so a false
 * positive is money taken for nothing. Meta's CDN URLs carry per-request
 * signature parameters (`oh=`, `oe=`, `_nc_ohc=`) that are different on every
 * single response — hashing a raw URL would report every ad as changed on every
 * run. Only the path basename of a media URL is stable, so that is all this
 * module hashes.
 *
 * It knows the *output* record shape (docs/CONTRACT.md §1) and nothing about
 * Meta's payload; normalization happens before it is called.
 */

import { createHash } from 'node:crypto';

/** Scalar creative fields, in the public schema's names. */
const SCALAR_FIELDS = [
  'body', 'caption', 'ctaText', 'ctaType', 'linkDescription', 'linkUrl', 'title',
];

/** Array-of-string creative fields. Order is not meaningful: Meta reorders DCO
 *  variants between responses for the same unchanged ad. */
const LIST_FIELDS = ['creativeBodies', 'creativeLinkUrls', 'creativeTitles'];

/** Media collections and the URL-bearing keys inside each entry. */
const MEDIA_FIELDS = [
  ['images', ['originalUrl', 'resizedUrl', 'watermarkedUrl']],
  ['videos', ['hdUrl', 'sdUrl', 'previewImageUrl']],
];

/** Every field the fingerprint covers, alphabetical — the vocabulary of
 *  `changedFields`. */
const ALL_FIELDS = [...SCALAR_FIELDS, ...LIST_FIELDS, ...MEDIA_FIELDS.map(([k]) => k)].sort();

/**
 * The stable identity of a Meta CDN asset: the last path segment, with the
 * query string (and therefore the expiring signature) removed.
 * @param {unknown} url
 * @returns {string|null} e.g. "653801683_1340354351422541_..._n.jpg"
 */
export function stableMediaId(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  const basename = segments[segments.length - 1];
  return basename ? basename : null;
}

function scalar(record, field) {
  const v = record?.[field];
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function list(record, field) {
  const v = record?.[field];
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s !== '') seen.add(s);
  }
  return [...seen].sort();
}

function mediaIds(record, field, urlKeys) {
  const v = record?.[field];
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of urlKeys) {
      const id = stableMediaId(entry[key]);
      if (id) seen.add(id);
    }
  }
  return [...seen].sort();
}

/** The canonical, order-independent view of a record's creative. */
function creativeShape(record) {
  const shape = {};
  for (const field of SCALAR_FIELDS) shape[field] = scalar(record, field);
  for (const field of LIST_FIELDS) shape[field] = list(record, field);
  for (const [field, keys] of MEDIA_FIELDS) shape[field] = mediaIds(record, field, keys);
  return shape;
}

/**
 * A sha1 over the creative content only. Identical content yields an identical
 * hash regardless of array order or CDN signature parameters.
 * @param {object|null|undefined} record - a record in the docs/CONTRACT.md §1 shape
 * @returns {string} 40-char hex digest
 */
export function creativeFingerprint(record) {
  const shape = creativeShape(record);
  // Serialised through the fixed ALL_FIELDS order, so object key insertion
  // order in the caller's record can never move the hash.
  const payload = ALL_FIELDS.map((field) => [field, shape[field]]);
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Which creative fields materially differ between two runs of the same ad.
 * Uses exactly the fields the fingerprint covers, so the list is never empty
 * when the fingerprint moved (and never populated when it did not).
 * @returns {string[]} public field names, alphabetical; `[]` when nothing changed
 */
export function changedFields(prevRecord, nextRecord) {
  const prev = creativeShape(prevRecord);
  const next = creativeShape(nextRecord);
  const changed = [];
  for (const field of ALL_FIELDS) {
    const a = prev[field];
    const b = next[field];
    const same = Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((v, i) => v === b[i])
      : a === b;
    if (!same) changed.push(field);
  }
  return changed;
}

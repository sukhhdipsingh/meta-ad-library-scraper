/**
 * Making ad creatives outlive Meta's CDN links.
 *
 * Meta signs every image and video URL with parameters that expire within
 * days. Everyone who scrapes the Ad Library discovers this the week after,
 * when their swipe file turns into a wall of broken images — and no competing
 * actor does anything about it.
 *
 * With `persistMedia` on, each asset is downloaded into the run's key-value
 * store and the URL is rewritten to a permanent one. The original is always
 * kept alongside as `sourceUrl`, so nothing is lost and nothing is guessed.
 *
 * Failure here is never fatal: a creative that will not download leaves the
 * record exactly as it was, with the reason in the log. The buyer already paid
 * for the ad data; a dead CDN link must not take the row away.
 */
import { stableMediaId } from './fingerprint.js';

/** Meta's assets are small, but a 1000-ad run has thousands of them, so the
 *  fetch is bounded on every axis: size, time, and concurrency. */
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 8;

const EXT_BY_TYPE = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/gif', 'gif'],
  ['image/webp', 'webp'], ['video/mp4', 'mp4'], ['video/webm', 'webm'],
]);

/** A key-value store key: restricted charset, and stable across runs so the
 *  same creative downloaded twice lands on the same key. */
export function mediaKey(url, fallbackIndex = 0) {
  const base = stableMediaId(url) ?? `asset-${fallbackIndex}`;
  return `media/${base}`.replace(/[^a-zA-Z0-9!\-_.'()/]/g, '-').slice(0, 250);
}

function extensionFor(contentType, url) {
  const clean = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_TYPE.has(clean)) return EXT_BY_TYPE.get(clean);
  const fromUrl = stableMediaId(url)?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return fromUrl ? fromUrl.toLowerCase() : 'bin';
}

/** Every URL-bearing slot in one record, as `{get, set}` accessors. */
function mediaSlots(record) {
  const slots = [];
  const visit = (obj, keys) => {
    for (const key of keys) {
      if (typeof obj?.[key] === 'string' && obj[key]) {
        slots.push({ get: () => obj[key], set: (v) => { obj[key] = v; } });
      }
    }
  };
  for (const img of record.images ?? []) visit(img, ['originalUrl', 'resizedUrl', 'watermarkedUrl']);
  for (const vid of record.videos ?? []) visit(vid, ['hdUrl', 'sdUrl', 'previewImageUrl']);
  for (const card of record.cards ?? []) {
    for (const img of card.images ?? []) visit(img, ['originalUrl', 'resizedUrl', 'watermarkedUrl']);
    for (const vid of card.videos ?? []) visit(vid, ['hdUrl', 'sdUrl', 'previewImageUrl']);
  }
  return slots;
}

/**
 * Download every creative in `records` into `store`, rewriting URLs in place.
 *
 * @param {object[]} records  normalised ads (mutated on a deep copy, not in place)
 * @param {{store: object, log?: object, fetchImpl?: Function}} ctx
 * @returns {Promise<object[]>} records with permanent URLs and a `mediaPersisted` flag
 */
export async function persistMediaFor(records, { store, log = console, fetchImpl = globalThis.fetch } = {}) {
  if (!store || !Array.isArray(records) || !records.length) return records;

  // Deep copy so a failure part-way through cannot leave callers holding
  // half-rewritten records.
  const out = records.map((r) => structuredClone(r));

  // One URL can appear in several ads and in several slots of the same ad;
  // download it once and reuse the result everywhere.
  const jobs = new Map();
  for (const record of out) {
    for (const slot of mediaSlots(record)) {
      const url = slot.get();
      if (!/^https?:\/\//i.test(url)) continue;
      if (!jobs.has(url)) jobs.set(url, []);
      jobs.get(url).push(slot);
    }
  }
  if (!jobs.size) return out;

  const urls = [...jobs.keys()];
  const resolved = new Map();
  let failed = 0;

  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        resolved.set(url, await download(url, store, fetchImpl));
      } catch (err) {
        failed++;
        log.debug?.(`persistMedia: keeping the original URL for ${url} (${err.message})`);
      }
    }
  });
  await Promise.all(workers);

  for (const record of out) {
    let rewritten = 0;
    for (const slot of mediaSlots(record)) {
      const permanent = resolved.get(slot.get());
      if (!permanent) continue;
      slot.set(permanent);
      rewritten++;
    }
    record.mediaPersisted = rewritten > 0;
  }

  const ok = resolved.size;
  log.info?.(
    `persistMedia: stored ${ok}/${urls.length} creative(s) in the key-value store`
    + (failed ? `; ${failed} kept their original (expiring) Meta URL` : ''),
  );
  return out;
}

async function download(url, store, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new Error(`${declared} bytes exceeds the ${MAX_BYTES}-byte cap`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error(`${buffer.byteLength} bytes exceeds the cap`);

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const key = `${mediaKey(url)}.${extensionFor(contentType, url)}`;
    await store.setValue(key, buffer, { contentType });
    return store.getPublicUrl ? store.getPublicUrl(key) : key;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The expensive bug this file exists to prevent: Meta re-signs every CDN URL on
 * every response, so a fingerprint that hashes raw URLs marks every ad
 * `changed` on every run — and monitor mode charges for `changed`. The real
 * fixture cases below take genuine signed URLs, re-sign them the way Meta would,
 * and assert the hash does not move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stableMediaId, creativeFingerprint, changedFields } from '../src/fingerprint.js';
import { makeDeduper } from '../src/dedupe.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const adsOf = (payload) =>
  payload.data.ad_library_main.search_results_connection.edges
    .flatMap((edge) => edge.node.collated_results ?? []);

/** Minimal stand-in for normalize.js: fixture snapshot -> the record shape the
 *  fingerprint is contracted against (docs/CONTRACT.md §1). */
function toRecord(ad) {
  const s = ad.snapshot ?? {};
  return {
    id: ad.ad_archive_id,
    body: s.body?.text ?? null,
    title: s.title ?? null,
    caption: s.caption ?? null,
    linkUrl: s.link_url ?? null,
    linkDescription: s.link_description ?? null,
    ctaText: s.cta_text ?? null,
    ctaType: s.cta_type ?? null,
    creativeBodies: [s.body?.text, ...(s.cards ?? []).map((c) => c.body)].filter(Boolean),
    creativeTitles: [s.title, ...(s.cards ?? []).map((c) => c.title)].filter(Boolean),
    creativeLinkUrls: [s.link_url, ...(s.cards ?? []).map((c) => c.link_url)].filter(Boolean),
    images: (s.images ?? []).map((i) => ({
      originalUrl: i.original_image_url ?? null,
      resizedUrl: i.resized_image_url ?? null,
      watermarkedUrl: i.watermarked_resized_image_url || null,
    })),
    videos: (s.videos ?? []).map((v) => ({
      hdUrl: v.video_hd_url ?? null,
      sdUrl: v.video_sd_url ?? null,
      previewImageUrl: v.video_preview_image_url ?? null,
    })),
  };
}

/** What Meta does between two responses for the *same* unchanged ad. */
function resign(url) {
  if (typeof url !== 'string') return url;
  return url
    .replace(/oh=[^&]*/, 'oh=00_AQ_ROTATED_SIGNATURE_VALUE')
    .replace(/oe=[^&]*/, 'oe=6BFFFFFF')
    .replace(/_nc_ohc=[^&]*/, '_nc_ohc=ROTATEDohcQ7kNvwROTATED')
    .replace(/_nc_gid=[^&]*/, '_nc_gid=ZZZZZZZZZZZZZZZZZZZZZZ');
}

const resignRecord = (record) => ({
  ...record,
  images: record.images.map((i) => ({
    originalUrl: resign(i.originalUrl),
    resizedUrl: resign(i.resizedUrl),
    watermarkedUrl: resign(i.watermarkedUrl),
  })),
  videos: record.videos.map((v) => ({
    hdUrl: resign(v.hdUrl),
    sdUrl: resign(v.sdUrl),
    previewImageUrl: resign(v.previewImageUrl),
  })),
});

// --- stableMediaId ----------------------------------------------------------

test('stableMediaId: basename of the path, query string discarded', () => {
  const url = 'https://scontent.fflr4-2.fna.fbcdn.net/v/t39.35426-6/'
    + '653801683_1340354351422541_1234567890123456789_n.jpg'
    + '?stp=dst-jpg&_nc_cat=107&_nc_ohc=abc123&oh=00_AQF&oe=6A96';
  assert.equal(stableMediaId(url), '653801683_1340354351422541_1234567890123456789_n.jpg');
});

test('stableMediaId: two signings of the same asset give the same id', () => {
  const [ad] = adsOf(fixture('keyword_us')).filter((a) => a.snapshot.images?.length);
  const url = ad.snapshot.images[0].original_image_url;
  assert.ok(url.includes('oh='), 'fixture URL should carry a signature');
  assert.notEqual(resign(url), url, 're-signing should actually change the URL');
  assert.equal(stableMediaId(url), stableMediaId(resign(url)));
  assert.match(stableMediaId(url), /^\d+_\d+_\d+_n\.jpg$/);
});

test('stableMediaId: non-URLs are null, never a throw', () => {
  for (const bad of [null, undefined, '', '   ', 'not a url', '/only/a/path.jpg', 42, {}, []]) {
    assert.equal(stableMediaId(bad), null, `input ${JSON.stringify(bad)}`);
  }
  assert.equal(stableMediaId('https://example.com/'), null);
});

test('stableMediaId: video path basename', () => {
  const ad = adsOf(fixture('political_us')).find((a) => a.snapshot.videos?.length);
  const id = stableMediaId(ad.snapshot.videos[0].video_hd_url);
  assert.ok(id?.endsWith('.mp4'), `expected an .mp4 basename, got ${id}`);
  assert.ok(!id.includes('?'));
});

// --- creativeFingerprint ----------------------------------------------------

test('creativeFingerprint: sha1 hex, deterministic across calls', () => {
  const record = { body: 'hello', images: [], videos: [] };
  const a = creativeFingerprint(record);
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.equal(a, creativeFingerprint({ ...record }));
});

test('creativeFingerprint: array order is not content', () => {
  const a = {
    creativeBodies: ['one', 'two', 'three'],
    creativeTitles: ['A', 'B'],
    creativeLinkUrls: ['https://x.test/1', 'https://x.test/2'],
    images: [{ originalUrl: 'https://cdn.test/a.jpg' }, { originalUrl: 'https://cdn.test/b.jpg' }],
    videos: [],
  };
  const b = {
    creativeBodies: ['three', 'one', 'two'],
    creativeTitles: ['B', 'A'],
    creativeLinkUrls: ['https://x.test/2', 'https://x.test/1'],
    images: [{ originalUrl: 'https://cdn.test/b.jpg' }, { originalUrl: 'https://cdn.test/a.jpg' }],
    videos: [],
  };
  assert.equal(creativeFingerprint(a), creativeFingerprint(b));
});

test('creativeFingerprint: key insertion order is not content', () => {
  const a = { body: 'x', title: 'y', linkUrl: 'https://z.test/' };
  const b = { linkUrl: 'https://z.test/', title: 'y', body: 'x' };
  assert.equal(creativeFingerprint(a), creativeFingerprint(b));
});

test('creativeFingerprint: real ad survives Meta re-signing every media URL', () => {
  const [ad] = adsOf(fixture('keyword_us')).filter((a) => a.snapshot.images?.length);
  const record = toRecord(ad);
  const refetched = resignRecord(record);

  assert.notDeepEqual(refetched.images, record.images, 'the raw URLs must differ');
  assert.equal(creativeFingerprint(record), creativeFingerprint(refetched));
  assert.deepEqual(changedFields(record, refetched), []);
});

test('creativeFingerprint: real video ad survives re-signing too', () => {
  const ad = adsOf(fixture('political_us')).find((a) => a.snapshot.videos?.length);
  const record = toRecord(ad);
  assert.ok(record.videos.length > 0);
  assert.equal(creativeFingerprint(record), creativeFingerprint(resignRecord(record)));
});

test('creativeFingerprint: every fixture ad is stable under re-signing', () => {
  for (const name of ['keyword_us', 'political_us', 'page_id_nike', 'eu_dsa_de', 'inactive']) {
    for (const ad of adsOf(fixture(name))) {
      const record = toRecord(ad);
      assert.equal(
        creativeFingerprint(record),
        creativeFingerprint(resignRecord(record)),
        `${name} / ad ${ad.ad_archive_id} moved on re-signing`,
      );
    }
  }
});

test('creativeFingerprint: distinct real ads get distinct hashes', () => {
  const ads = adsOf(fixture('keyword_us'));
  const hashes = new Set(ads.map((ad) => creativeFingerprint(toRecord(ad))));
  assert.equal(hashes.size, new Set(ads.map((a) => a.ad_archive_id)).size);
});

test('creativeFingerprint: a genuinely new image moves the hash', () => {
  const [ad] = adsOf(fixture('keyword_us')).filter((a) => a.snapshot.images?.length);
  const record = toRecord(ad);
  const swapped = {
    ...record,
    images: [{ ...record.images[0], originalUrl: 'https://scontent.test/v/t39/999_888_777_n.jpg' }],
  };
  assert.notEqual(creativeFingerprint(record), creativeFingerprint(swapped));
  assert.deepEqual(changedFields(record, swapped), ['images']);
});

test('creativeFingerprint: fields outside the creative do not move the hash', () => {
  const [ad] = adsOf(fixture('keyword_us')).filter((a) => a.snapshot.images?.length);
  const record = toRecord(ad);
  const later = { ...record, isActive: false, endDate: '2027-01-01', scrapedAt: 'later' };
  assert.equal(creativeFingerprint(record), creativeFingerprint(later));
});

test('creativeFingerprint: null and undefined records do not throw', () => {
  assert.equal(creativeFingerprint(null), creativeFingerprint(undefined));
  assert.equal(creativeFingerprint(null), creativeFingerprint({}));
  assert.match(creativeFingerprint(null), /^[0-9a-f]{40}$/);
});

// --- changedFields ----------------------------------------------------------

test('changedFields: public field names, alphabetical', () => {
  const prev = { body: 'old', linkUrl: 'https://a.test/', title: 'same' };
  const next = { body: 'new', linkUrl: 'https://b.test/', title: 'same' };
  assert.deepEqual(changedFields(prev, next), ['body', 'linkUrl']);
});

test('changedFields: identical records report nothing', () => {
  const rec = { body: 'x', creativeBodies: ['a', 'b'], images: [], videos: [] };
  assert.deepEqual(changedFields(rec, { ...rec, creativeBodies: ['b', 'a'] }), []);
});

test('changedFields: null-vs-empty-string is not a change', () => {
  assert.deepEqual(changedFields({ body: null, caption: undefined }, { body: '', caption: '  ' }), []);
});

test('changedFields: a removed list entry counts', () => {
  const prev = { creativeBodies: ['a', 'b'], creativeTitles: ['t'] };
  const next = { creativeBodies: ['a'], creativeTitles: ['t'] };
  assert.deepEqual(changedFields(prev, next), ['creativeBodies']);
});

test('changedFields: missing records are treated as empty, never a throw', () => {
  assert.deepEqual(changedFields(null, null), []);
  assert.deepEqual(changedFields(undefined, { body: 'x' }), ['body']);
  assert.deepEqual(changedFields({ body: 'x' }, null), ['body']);
});

test('changedFields: agrees with the fingerprint on real data', () => {
  const ads = adsOf(fixture('page_id_nike'));
  for (const a of ads) {
    for (const b of ads) {
      const same = creativeFingerprint(toRecord(a)) === creativeFingerprint(toRecord(b));
      const diff = changedFields(toRecord(a), toRecord(b));
      assert.equal(same, diff.length === 0,
        `${a.ad_archive_id} vs ${b.ad_archive_id}: hash-equal=${same} changed=${diff}`);
    }
  }
});

// --- dedupe -----------------------------------------------------------------

test('makeDeduper: keeps the first sighting, drops the rest', () => {
  const d = makeDeduper();
  assert.equal(d.keep({ id: '123' }), true);
  assert.equal(d.keep({ id: '123' }), false);
  assert.equal(d.keep({ id: '456' }), true);
  assert.equal(d.size, 2);
  assert.equal(d.dropped, 1);
});

test('makeDeduper: an unusable id is dropped, never billed', () => {
  const d = makeDeduper();
  for (const record of [{}, { id: null }, { id: '' }, { id: '   ' }, { id: {} }, { id: NaN }, null, undefined]) {
    assert.equal(d.keep(record), false, `record ${JSON.stringify(record)}`);
  }
  assert.equal(d.size, 0);
  assert.equal(d.dropped, 8);
});

test('makeDeduper: numeric and string ids are the same ad', () => {
  const d = makeDeduper();
  assert.equal(d.keep({ id: 1249043200627555 }), true);
  assert.equal(d.keep({ id: '1249043200627555' }), false);
  assert.equal(d.size, 1);
});

test('makeDeduper: counters are independent per deduper', () => {
  const a = makeDeduper();
  const b = makeDeduper();
  a.keep({ id: 'x' });
  a.keep({ id: 'x' });
  assert.equal(b.size, 0);
  assert.equal(b.dropped, 0);
  assert.equal(b.keep({ id: 'x' }), true);
});

test('makeDeduper: real fixture pages, replayed twice, bill each ad once', () => {
  const ads = [...adsOf(fixture('keyword_us')), ...adsOf(fixture('political_us'))]
    .map((ad) => ({ id: ad.ad_archive_id }));
  const unique = new Set(ads.map((a) => a.id)).size;

  const d = makeDeduper();
  const kept = [...ads, ...ads].filter((ad) => d.keep(ad));

  assert.equal(kept.length, unique);
  assert.equal(d.size, unique);
  assert.equal(d.dropped, ads.length * 2 - unique);
});

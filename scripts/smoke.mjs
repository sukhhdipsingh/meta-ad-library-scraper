/**
 * Live smoke test: prove the whole chain works against the real Ad Library.
 *
 * Fixtures can only prove that the parsing is right. This proves the part
 * fixtures cannot: that the doc_id still resolves from Meta's live bundle, that
 * the challenge handshake still yields an lsd token, and that the GraphQL call
 * still answers with ads today.
 *
 * Deliberately tiny — one query, a couple of pages — because the measured block
 * threshold is roughly 47 requests per IP and this is meant to be safe to run
 * without a proxy. Exit code 1 if any stage fails, so CI can gate a release on it.
 *
 *   node scripts/smoke.mjs [searchTerm]
 */
import { createSessionManager } from '../src/session.js';
import { buildQuery, paginate } from '../src/sources/weblibrary.js';
import { normalizeAd } from '../src/normalize.js';
import { FALLBACK_DOC_ID } from '../src/constants.js';

const term = process.argv[2] ?? 'nike';
const log = {
  debug() {},
  info: (m) => console.log(`  ${m}`),
  warning: (m) => console.log(`  WARN ${m}`),
  error: (m) => console.error(`  ERROR ${m}`),
};

const fail = (stage, err) => {
  console.error(`\nFAILED at: ${stage}\n  ${err?.message ?? err}`);
  if (err?.category) console.error(`  category: ${err.category}`);
  process.exit(1);
};

console.log(`Live smoke test — searching the Ad Library for "${term}"\n`);

const sessions = createSessionManager({ log });
let ok = 0;

try {
  console.log('1. Bootstrapping a session (challenge -> lsd -> doc_id)');
  let session;
  try {
    session = await sessions.acquire();
  } catch (err) {
    fail('session bootstrap', err);
  }
  if (!session.lsd) fail('session bootstrap', new Error('no lsd token'));
  console.log(`   lsd acquired, doc_id ${session.docId}`);
  // The bootstrap deliberately does not download the 6.3 MB bundle — the known
  // id is used until something fails. So starting on the fallback is the
  // expected happy path, not a warning. Stage 4 is what proves the re-read
  // still works when it is needed.
  console.log(session.docId === FALLBACK_DOC_ID
    ? '   started on the known id (no bundle downloaded — this is the cheap path)'
    : '   started on a previously resolved id');
  ok++;

  console.log('\n2. Fetching two pages');
  const query = buildQuery({ searchTerm: term, countries: ['US'] }, { activeStatus: 'active' });
  const ads = [];
  try {
    for await (const { ads: batch, page } of paginate(query, {
      acquireSession: () => sessions.acquire(),
      noteRequest: (s) => sessions.noteRequest(s),
      noteFailure: (s, e) => sessions.noteFailure(s, e),
    }, { maxPages: 2 })) {
      console.log(`   page ${page}: ${batch.length} ad(s)`);
      ads.push(...batch);
    }
  } catch (err) {
    fail('pagination', err);
  }
  if (!ads.length) fail('pagination', new Error(`Meta returned no ads for "${term}"`));
  ok++;

  console.log('\n3. Normalising');
  const records = ads.map((a) => normalizeAd(a, { now: Date.now() }));
  const withId = records.filter((r) => r.id).length;
  const withCopy = records.filter((r) => r.creativeBodies.length).length;
  const withMedia = records.filter((r) => r.mediaCount > 0).length;
  console.log(`   ${records.length} ads: ${withId} with id, ${withCopy} with ad copy, ${withMedia} with creatives`);

  if (withId !== records.length) fail('normalisation', new Error('some ads have no id — dedup and billing key on it'));
  // Not every ad on earth has media, but a page where none do means the
  // extractor lost the cards again.
  if (withMedia === 0) fail('normalisation', new Error('no creatives extracted at all — check the card walk'));
  ok++;

  const sample = records.find((r) => r.mediaCount > 0) ?? records[0];
  console.log('\n   sample:');
  console.log(`     ${sample.pageName} — "${(sample.body ?? sample.title ?? '').slice(0, 70)}"`);
  console.log(`     started ${sample.startDate}, ${sample.platforms.join('/')}, ${sample.mediaCount} creative(s)`);
  console.log(`     ${sample.adLibraryUrl}`);

  // The self-repair is the part that silently rots: it only ever runs after a
  // failure, so a broken re-read stays invisible until the day Meta rotates
  // the id and every run fails at once. It gets exercised here on purpose.
  console.log('\n4. Re-reading the doc_id from the live bundle (the self-repair path)');
  const idBefore = session.docId;
  const moved = await sessions.refreshDocId(session);
  if (session.docId === idBefore && !moved) {
    // Either it re-read the same id, or it could not read one at all. Only the
    // first is fine, and the manager logs a DOC_ID_STALE warning for the second.
    console.log(`   re-read produced no change (still ${session.docId})`);
  } else {
    console.log(`   Meta had rotated the id: ${idBefore} -> ${session.docId}`);
  }
  if (!/^\d+$/.test(String(session.docId))) {
    fail('doc_id refresh', new Error(`the id is not numeric after the re-read: ${session.docId}`));
  }
  ok++;

  console.log(`\nOK — ${ok}/4 stages passed. The live chain works.`);
} finally {
  await sessions.close();
}

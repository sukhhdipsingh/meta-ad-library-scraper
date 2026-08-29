/**
 * Uniqueness on `ad_archive_id`.
 *
 * Why this module exists: one edge in Meta's response can carry several ads
 * (`node.collated_results`), and the same ad reappears across pages and across
 * queries in a multi-target run. Billing happens per unique ad (docs/CONTRACT.md
 * §2), so anything that gets past this deduper is something the buyer pays for.
 * A record with no usable id is therefore dropped, not guessed at.
 *
 * Knows nothing about billing itself — it only answers "have I seen this one?".
 */

/** Meta sends ids as numeric strings; a number is accepted and normalised. */
function idOf(record) {
  const raw = record?.id;
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s === '' ? null : s;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/**
 * @returns {{ keep(record: object): boolean, dropped: number, size: number }}
 *   `keep` is true only the first time a valid id is seen. `dropped` counts
 *   duplicates plus id-less records; `size` counts the unique ads kept.
 */
export function makeDeduper() {
  const seen = new Set();
  let dropped = 0;

  return {
    keep(record) {
      const id = idOf(record);
      if (id === null || seen.has(id)) {
        dropped += 1;
        return false;
      }
      seen.add(id);
      return true;
    },
    get dropped() {
      return dropped;
    },
    get size() {
      return seen.size;
    },
  };
}

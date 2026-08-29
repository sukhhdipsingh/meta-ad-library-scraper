/**
 * Post-fetch filters, applied BEFORE billing.
 *
 * Two things make this module worth having.
 *
 * First, the filters themselves are ones buyers keep asking for and the
 * incumbents decline to add. A request to exclude the ad format that returns
 * empty creatives was closed on the official actor with: *"Scraping is correct,
 * please filter out the dataset using third-party tools"*. Long-running ads are
 * the single most-used signal in every workflow thread — *"look for static
 * carousels active for 90+ days"*, *"Find the long running ads (more than 45
 * days)"* — and neither leader lets you filter on it.
 *
 * Second, and more important: filtering happens **before** the charge. An ad
 * that a filter removes is never billed. Telling someone to post-process the
 * dataset means they pay for every row they throw away.
 *
 * Everything here is pure and total: a filter that cannot be understood is
 * reported, never silently ignored, because a filter that quietly does nothing
 * is worse than no filter at all.
 */

const lower = (v) => String(v ?? '').toLowerCase();

/** Epoch seconds for a `YYYY-MM-DD` string, or null. Also accepts a relative
 *  `"30 days"` / `"6 months"` the way buyers write it in scheduling UIs. */
export function parseDateInput(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }

  const rel = s.match(/^(\d+)\s*(day|week|month|year)s?(\s+ago)?$/i);
  if (rel) {
    const n = Number(rel[1]);
    const days = { day: 1, week: 7, month: 30, year: 365 }[rel[2].toLowerCase()];
    return Math.floor(now / 1000) - n * days * 86400;
  }

  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Build a predicate from the run's filter inputs.
 *
 * @returns {{ apply: (record) => boolean, active: string[], rejected: string[], counts: object }}
 */
export function makeFilter(input = {}, { now = Date.now() } = {}) {
  const active = [];
  const rejected = [];
  const counts = {};
  const tests = [];

  const add = (name, fn) => { tests.push({ name, fn }); active.push(name); counts[name] = 0; };
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : [])
    .map((x) => lower(x).trim()).filter(Boolean);

  // --- platform ---------------------------------------------------------
  const platforms = list(input.publisherPlatforms);
  if (platforms.length) {
    add('publisherPlatforms', (r) => r.platforms.some((p) => platforms.includes(lower(p))));
  }

  // --- lifecycle: the signal every workflow thread is built on ----------
  if (Number.isFinite(Number(input.minDaysRunning)) && Number(input.minDaysRunning) > 0) {
    const min = Number(input.minDaysRunning);
    add('minDaysRunning', (r) => Number.isFinite(r.totalActiveDays) && r.totalActiveDays >= min);
  }
  if (Number.isFinite(Number(input.maxDaysRunning)) && Number(input.maxDaysRunning) > 0) {
    const max = Number(input.maxDaysRunning);
    add('maxDaysRunning', (r) => Number.isFinite(r.totalActiveDays) && r.totalActiveDays <= max);
  }

  for (const [key, cmp] of [['startedAfter', 'after'], ['startedBefore', 'before']]) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    const epoch = parseDateInput(input[key], now);
    if (epoch === null) {
      rejected.push(`${key}: "${input[key]}" is not a date (use YYYY-MM-DD or "30 days")`);
      continue;
    }
    add(key, (r) => Number.isFinite(r.startDateEpoch)
      && (cmp === 'after' ? r.startDateEpoch >= epoch : r.startDateEpoch <= epoch));
  }

  // --- creative quality -------------------------------------------------
  const excludeFormats = list(input.excludeDisplayFormats);
  if (excludeFormats.length) {
    add('excludeDisplayFormats', (r) => !excludeFormats.includes(lower(r.displayFormat)));
  }
  if (input.requireMedia === true) {
    add('requireMedia', (r) => r.mediaCount > 0);
  }
  if (Number.isFinite(Number(input.minVariantCount)) && Number(input.minVariantCount) > 1) {
    const min = Number(input.minVariantCount);
    add('minVariantCount', (r) => (r.variantCount ?? 1) >= min);
  }

  // --- text and destination --------------------------------------------
  const haystack = (r) => lower([r.body, r.title, r.caption, r.linkDescription,
    ...(r.creativeBodies ?? []), ...(r.creativeTitles ?? [])].filter(Boolean).join('  '));

  const contains = list(input.bodyContains);
  if (contains.length) {
    // Any-of: a buyer listing three words wants ads mentioning any of them.
    add('bodyContains', (r) => { const h = haystack(r); return contains.some((t) => h.includes(t)); });
  }
  const excludes = list(input.bodyExcludes);
  if (excludes.length) {
    add('bodyExcludes', (r) => { const h = haystack(r); return !excludes.some((t) => h.includes(t)); });
  }

  // `advertiserDomains` is the other half of the same-name fix in scrape.js:
  // the search finds candidates, this keeps only the ones whose destination is
  // the real site. Both inputs feed one predicate.
  const domains = [...new Set([...list(input.linkDomains), ...list(input.advertiserDomains)
    .map((d) => d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0])])];
  if (domains.length) {
    // Suffix match so "nike.com" also accepts "shop.nike.com".
    add('linkDomains', (r) => {
      const d = lower(r.linkDomain);
      return Boolean(d) && domains.some((want) => d === want || d.endsWith(`.${want}`));
    });
  }

  // Keep at most N ads per advertiser. A keyword search routinely returns a
  // thousand rows that are really the same handful of advertisers over and
  // over — "often you get 1,000+ results with multiple ads per page... this
  // would drop the results down significantly". Because it runs before
  // billing, it cuts the bill by the same proportion.
  //
  // Stateful, unlike the predicates above: it counts what it has already let
  // through, so it must come last.
  const perPage = Number(input.maxAdsPerPage);
  const perPageSeen = new Map();
  if (Number.isFinite(perPage) && perPage > 0) {
    add('maxAdsPerPage', (r) => {
      const key = r.pageId ?? r.pageName ?? '';
      const n = perPageSeen.get(key) ?? 0;
      if (n >= perPage) return false;
      perPageSeen.set(key, n + 1);
      return true;
    });
  }

  return {
    active,
    rejected,
    counts,
    /** True when the record survives every filter. Records the first filter
     *  that rejected it, so the SUMMARY can explain a thin result set. */
    apply(record) {
      for (const { name, fn } of tests) {
        let ok;
        try { ok = fn(record); } catch { ok = false; }
        if (!ok) { counts[name]++; return false; }
      }
      return true;
    },
    /** How many ads each filter removed — the answer to "why so few results?" */
    report() {
      const removed = Object.entries(counts).filter(([, n]) => n > 0);
      return {
        filtersActive: active,
        removedByFilter: Object.fromEntries(removed),
        totalRemoved: removed.reduce((sum, [, n]) => sum + n, 0),
      };
    },
  };
}

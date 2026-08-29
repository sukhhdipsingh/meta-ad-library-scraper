# Internal contract — read before touching any module

This is the agreement every module in `src/` is written against. Changing
anything here is a breaking change for buyers, so it changes by decision, not
by accident.

## 1. The output record

One dataset row = one unique Meta ad. Keys are `camelCase` and **never renamed
after launch**. A field that has no value is `null` (scalars) or `[]` (arrays) —
never `undefined`, never a missing key. Consumers write spreadsheet formulas
against these columns; a disappearing column breaks them.

```jsonc
{
  // --- identity ---
  "id":            "1249043200627555",   // ad_archive_id — the dedup key
  "adId":          null,                  // ad_id when Meta exposes it
  "source":        "web",                 // "web" | "graph_api"
  "adLibraryUrl":  "https://www.facebook.com/ads/library/?id=1249043200627555",

  // --- advertiser ---
  "pageId":                "15087023444",
  "pageName":              "Nike",
  "pageUrl":               "https://facebook.com/nike",
  "pageProfilePictureUrl": null,
  "pageLikeCount":         null,
  "pageCategories":        [],
  "pageIsDeleted":         false,
  "byline":                null,          // the "Paid for by" line on political ads

  // --- lifecycle ---
  "isActive":        true,
  "startDate":       "2026-03-17",        // ISO date (UTC), derived from the epoch
  "endDate":         "2026-08-27",
  "startDateEpoch":  1773730800,          // seconds, exactly as Meta sends it
  "endDateEpoch":    1787814000,
  "totalActiveDays": 163,                 // whole UTC days between the two dates
                                          // above; null when the start is unknown

  // --- creative: the part people actually buy ---
  "title":            "Nike",
  "body":             "Celebra tu cumpleaños con Nike…",
  "caption":          "play.google.com",
  "linkUrl":          "https://www.nike.com/…",
  "linkDescription":  "Unlock the latest from Nike & Jordan.",
  "ctaText":          "Shop now",
  "ctaType":          "SHOP_NOW",
  "displayFormat":    "DCO",
  "creativeBodies":   ["…"],              // every distinct body, cards included
  "creativeTitles":   ["…"],
  "creativeLinkUrls": ["…"],
  "images":           [{ "originalUrl": "…", "resizedUrl": "…", "watermarkedUrl": null }],
  "videos":           [{ "hdUrl": "…", "sdUrl": "…", "previewImageUrl": "…" }],
  "cards":            [ /* carousel cards, same field names as the top level */ ],
  "mediaCount":       3,

  // --- distribution ---
  "platforms": ["FACEBOOK", "INSTAGRAM"], // publisher_platform
  "languages": [],
  "countries": [],                        // targeted_or_reached_countries
  "variantCount":  3,                     // collation_count: copies Meta grouped
  "collationId":   null,
  "linkDomain":    "nike.com",            // registrable host of linkUrl
  "linkUrlClean":  "https://nike.com/t",  // destination minus tracking params
  "utm":           {},                    // {source, medium, campaign, content, term}
  "creativeType":  "carousel",            // video|carousel|image|catalog|text
  "containsInjectionRisk": false,         // ad copy that targets an LLM

  // --- honesty about coverage ---
  "transparencyAvailable": false,         // did Meta publish funding data here?

  // --- transparency (political + EU only; null elsewhere, by Meta's design) ---
  "isPolitical":     false,
  "categories":      ["UNKNOWN"],
  "spend":           null,                // { lower, upper, currency, raw }
  "impressions":     null,                // { lower, upper, raw }
  "impressionsIndex": -1,                 // integer bucket, locale-independent
  "reachEstimate":   null,
  "euTotalReach":    null,
  "demographics":    [],

  // --- provenance ---
  "scrapedAt": "2026-08-27T17:35:00.000Z"
}
```

### Monitor-mode additions

Present **only** when `monitorMode !== "off"`:

```jsonc
{
  "status":        "new",        // "new" | "changed" | "unchanged" | "removed"
  "isNew":         true,
  "firstSeenAt":   "2026-08-20T…",   // sticky: set once, never overwritten
  "lastSeenAt":    "2026-08-27T…",
  "changedFields": ["body", "linkUrl"],  // [] unless status === "changed"
  "daysTracked":      12,                // days this monitor has watched it
  "variantCountPrev": 2,                 // null on the first sighting
  "variantDelta":     7,
  "isScaling":        true               // duplicates rising between runs
}
```

## 2. Billing rules — these are promises made in the README

Charged: `new`, `changed`, and every ad in a non-monitor run.
**Not charged**: duplicates, `unchanged`, `removed`, and any row carrying an
`errorCategory`.

Charging happens **after** dedup and **after** the diff, never before.

## 3. Non-obvious traps, each one measured

**Meta CDN URLs expire.** `oh=`, `oe=` and `_nc_ohc=` are signature parameters
that change on every request. Hashing a raw URL produces a false `changed` on
every single run. `fingerprint.js` must use only the **path basename**
(`653801683_1340354351422541_…_n.jpg`), which is stable.

**`first` is ignored.** Meta returns 10 edges per page regardless. Cost
estimates and progress must divide by `ADS_PER_PAGE`, not by the requested size.

**Soft blocks arrive as HTTP 200.** Body is `{"error":1357054,…}`, possibly
behind a `for (;;);` prefix. Status-code retry logic will not see it.

**One edge can hold several ads.** `node.collated_results` is an array; Meta
groups near-identical ads. Flatten it, then dedup on `ad_archive_id`.

**Pagination is strictly sequential.** Each cursor depends on the previous
response, so concurrency belongs *between* queries, never inside one.

**Spend and impressions are localised strings.** With an Italian exit IP the
value arrives as `"300.000 US$ - 350.000 US$"`. Always keep `raw`; parse
`lower`/`upper` best-effort; prefer `impressionsIndex` for sorting.

## 4. Module boundaries

Nothing under `src/` except `main.js` may import the Apify SDK. That rule is
what makes the whole pipeline testable against the committed fixtures with no
network and no platform.

| module | owns | must not |
|---|---|---|
| `constants.js` | measured facts | contain logic |
| `errors.js` | the category taxonomy | know about HTTP or Meta |
| `parse.js` | localised strings → numbers, epochs → ISO | fetch anything |
| `fingerprint.js` | change detection hashing | know about Meta's payload shape |
| `normalize.js` | Meta payload → the record above | fetch, or charge |
| `dedupe.js` | uniqueness on `id` | know about billing |
| `state.js` | monitor diff, pure, clock injected | touch the SDK or the store |
| `docid.js` | doc_id from a JS bundle string | fetch |
| `session.js` | challenge → lsd → session lifecycle | know the output schema |
| `sources/*.js` | one upstream each, same interface | know about the dataset |
| `scrape.js` | orchestration, budgets, RUN-STATUS | import `apify` |
| `main.js` | SDK wiring, PPE, key-value records | contain business logic |

## 5. Source adapter interface

Every file in `src/sources/` exports exactly this:

```js
export const name = 'web';                    // matches record.source
export function buildQuery(target, options)   // -> opaque request descriptor
export async function fetchPage(query, ctx)   // -> { ads: raw[], nextCursor, hasNext }
export function normalize(raw, context)       // -> the record in §1
```

`ctx` carries `{ session, http, log }` and nothing else. An adapter that needs
something new gets it through `ctx`, so the others keep working untouched.

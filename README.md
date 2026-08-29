# Facebook Ad Library Scraper — Meta Ad Library API

**Track what your competitors are advertising on Facebook and Instagram.**

This is a Meta Ad Library API that needs no Meta API token, no app review and no
login. It reads Meta's public Ad Library and returns clean JSON: ad copy, every
creative image and video, CTA, destination URL, run dates, platforms, and — where
Meta publishes it — spend and impressions.

Then the two things no other Ad Library scraper does:

- **It resumes.** If a run is cut short, it continues from the exact page it
  reached — it does not restart and re-bill you from the top.
- **It tells you what changed.** Run it on a schedule and you get new ads, edited
  creatives and stopped ads. You are billed for new and changed ads only.

**$0.60 per 1,000 ads.** No monthly rental, no minimum.

Here is a real row, exactly as it lands in your dataset:

```json
{
  "id": "1249043200627555",
  "pageName": "Nike",
  "title": "Nike: Shoes, Apparel & Stories",
  "body": "Celebrate your birthday with Nike and unlock member-only products.",
  "creativeType": "carousel",
  "ctaText": "Shop now",
  "linkUrlClean": "https://www.nike.com/t/air-max",
  "linkDomain": "nike.com",
  "isActive": true,
  "startDate": "2026-03-17",
  "totalActiveDays": 163,
  "variantCount": 3,
  "images": [{ "originalUrl": "https://scontent.../n.jpg", "resizedUrl": "…", "watermarkedUrl": null }],
  "videos": [],
  "platforms": ["FACEBOOK", "INSTAGRAM"],
  "adLibraryUrl": "https://www.facebook.com/ads/library/?id=1249043200627555"
}
```

---

## Why this one

| | This actor | Official Apify actor | Community leader |
|---|---|---|---|
| Price per 1,000 ads | **$0.60** | $5.80 | $0.75 |
| Resumes an interrupted run | **Yes** | No | No — "only way is to restart from beginning" |
| Results appear during the run | **Yes, page by page** | No — "only at the very end" | Partial |
| Change tracking (new / changed / removed) | **Yes** | No | No |
| Billed for unchanged ads on a re-run | **No** | Yes | Yes |
| Carousel creatives extracted | **Yes — all of them** | Partial | Partial |
| Permanent media URLs | **Optional, built in** | No — points you to another tool | No |
| Rejects a mistyped input before billing | **Yes** | No | No |
| Variant count **and its movement** (scaling signal) | **Yes** | No | No |
| Creative type classified (video/carousel/catalog) | **Yes** | No | No |
| UTM parameters split out of the destination URL | **Yes** | No | No |
| Flags ad copy carrying prompt-injection | **Yes** | No | No |
| Find an advertiser by **website**, not name | **Yes** | No | No |
| Cap ads per advertiser (kills duplicate spam) | **Yes** | No | No |
| Filters that cut the bill (not just the output) | **Yes — 13 of them** | No | No |
| Pushes changes to a webhook | **Yes** | No | No |
| Says whether the run was complete | **Yes — `runStatus`** | No | No |
| Spend cap you set before the run | **Yes** | No | No |
| Named error categories instead of raw logs | **Yes** | No | No |

### Partial results: the problem this category has not solved

The most common complaint about Ad Library scrapers is not that they fail — it is
that they **succeed while returning a fraction of the ads**, and you cannot tell.
Reported against the leading actor: 15,600 ads where the same query returned
48,500 a week earlier; 9,254 out of ~36,000; runs "randomly limited to 30 results".

The cause is architectural, and its author says so plainly: *"we can't resume
scraping a search url once it fails in the middle. Only way is to restart from
beginning... This can also happen if the actor gets migrated during the run."*

Meta's pagination cursor is opaque but **durable** — it stays valid across
processes and IP addresses. So this actor delivers each page as it arrives and
*then* records the boundary. A crash, a dead proxy, or an Apify platform
migration costs you one page, not the run. The `SUMMARY` record says whether a
run resumed and how much it carried over.

The ordering matters and is deliberate: progress is only ever recorded for ads
that have actually been delivered. Recording it first would advance the cursor
past ads you never received — silent data loss wearing the costume of a feature.

It has a second benefit. The official actor's own documentation warns that
*"results will appear only at the very end of the run. The rest of the time it
will display 0 results."* Here the dataset fills up as the run goes, so you can
watch it work and stop it early if it is not what you wanted.

### The carousel problem, measured

Meta hides most ad creatives. Across **60 real ads** captured from the live Ad
Library, the obvious fields (`snapshot.images` and `snapshot.videos`) held
**22 creatives**. Reading the carousel cards and extras as well finds **214** —
**9.7× more**. A scraper that reads only the obvious field loses about **90% of
the creatives** and returns empty image arrays.

This actor reads all three places Meta stores media, de-duplicates them, and
ships them in `images[]` and `videos[]`. That ratio is asserted by a test
against the committed fixtures, so it cannot silently stop being true.

### The same-name problem, solved

Search a brand by name and you get impostors. From a thread on exactly this:
*"multiple unrelated Facebook Pages share the exact same name (e.g., local
businesses in other countries or different industries)"* — one person found their
target name shared by seven different Pages worldwide.

The fix the community converged on is *"match on page_id instead of page name,
and check the page's domain against the brand's real site... same-name local
businesses almost never share a domain"* — but you had to build it yourself.
Here it is one input:

```json
{ "advertiserDomains": ["nike.com"] }
```

That searches the brand name **and** keeps only ads whose destination is that
domain, subdomains included. No impostors, and you are not billed for them.

### One ad per advertiser

A keyword search returns the same few advertisers hundreds of times. The request
— *"filter 1 ad per page... often you get 1,000+ results with multiple ads per
page. This would drop the results down significantly"* — sat unanswered for two
years. `maxAdsPerPage: 1` does it, and because it runs before billing it cuts the
cost in the same proportion.

### Filters that reduce the bill, not just the spreadsheet

Ask the official actor to skip the ad format that returns empty creatives and the
answer is: *"Scraping is correct, please filter out the dataset using third-party
tools."* That means paying for every row you then delete.

Here filters run **before billing**. An ad a filter removes is never charged, and
the `SUMMARY` says exactly how many each filter took, so a thin result set is
never a mystery:

```json
{
  "pageIds": ["15087023444"],
  "minDaysRunning": 60,
  "requireMedia": true,
  "excludeDisplayFormats": ["DCO"],
  "publisherPlatforms": ["INSTAGRAM"]
}
```

| Filter | Keeps |
|---|---|
| `minDaysRunning` / `maxDaysRunning` | Ads live for at least / at most N days |
| `startedAfter` / `startedBefore` | `YYYY-MM-DD` or a relative `"30 days"` |
| `publisherPlatforms` | FACEBOOK, INSTAGRAM, MESSENGER, AUDIENCE_NETWORK, THREADS |
| `requireMedia` | Only ads that actually carry a creative |
| `excludeDisplayFormats` | Drops formats such as `DCO` |
| `minVariantCount` | Only creatives being duplicated across ad sets |
| `bodyContains` / `bodyExcludes` | Searches every body, headline and card |
| `linkDomains` | Ads pointing at a domain (subdomains included) |
| `maxAdsPerPage` | At most N ads per advertiser |

---

## Billing: five promises

1. **You never pay for duplicates.** De-duplicated on Meta's own `ad_archive_id`
   before anything is charged.
2. **You never pay for unchanged ads.** In monitor mode only `new` and `changed`
   ads are billable. `unchanged` and `removed` records are free.
3. **You never pay past your cap.** `maxAds` (default 1,000) and the optional
   `maxCostUsd` stop the run **cleanly** — it finishes as Succeeded and says why
   in the status message. A spend cap is not an error.
4. **You know the cost before it starts.** The estimated maximum is written to the
   log on the first line, and `adsCharged` is in the `SUMMARY` record at the end.
5. **A typo cannot cost you money.** Unknown input fields are refused *before* the
   first request, naming the field you probably meant. Elsewhere in this category,
   writing `maxAds` where the field was called `resultsLimit` was silently accepted
   as "no limit" — two users reported $17 and $15 bills for that mistake.

---

## Meta Ad Library API: the official one vs this one

If you came here after hitting a wall with Meta's official `ads_archive`
endpoint, this is why.

| | Official Graph API (`ads_archive`) | This actor |
|---|---|---|
| Covers ordinary commercial ads | **No** — political/issue ads only, plus EU-targeted ads | **Yes** |
| Access requirements | App review **and** identity verification | None |
| Country parameter | `ad_reached_countries` is **mandatory** — no global query | Optional, `ALL` supported |
| Keyword search | 100-character limit, no translation | Full keyword search |
| Creative images | Low-resolution thumbnails reported by users | Full-resolution, from every place Meta stores them |
| Historical ads outside EU/UK | Gone once the ad stops | Gone too — but monitor mode keeps *your* record |
| Rate limits | Documented, error 613 | Handled with proxy session rotation |

The short version, and it is the single most common misunderstanding in this
space: **Meta's official API is an archive of political advertising, not a
competitor-research tool.** The endpoint is even named `ads_archive`. For a US
e-commerce competitor it returns nothing you can use, which is why this actor
reads the public Ad Library instead.

---

## What a run costs

| You want | Ads | Cost |
|---|---|---|
| One competitor's active ads | ~200 | **$0.12** |
| A brand's full history (active + inactive) | ~1,000 | **$0.60** |
| A keyword across two countries | ~2,000 | **$1.20** |
| Daily monitoring of one competitor, after day one | ~5–20 changed | **under $0.02/day** |

Apify gives every account **$5/month in free credits**, so the first ~8,000 ads
cost you nothing. The default `maxAds` of 1,000 keeps any single run at $0.60
until you deliberately raise it.

---

## Quick start

Track one competitor's ads:

```json
{
  "pageIds": ["15087023444"],
  "countries": ["US"],
  "activeStatus": "active",
  "maxAds": 500
}
```

Search a whole market by keyword:

```json
{
  "searchTerms": ["protein powder", "creatine"],
  "countries": ["US", "GB"],
  "maxAds": 2000
}
```

Or paste an Ad Library URL straight from your browser — the filters in it are read
and applied:

```json
{
  "adLibraryUrls": [
    "https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&search_type=page&view_all_page_id=183869772601"
  ]
}
```

### Daily competitor monitoring (the reason this exists)

```json
{
  "pageIds": ["15087023444"],
  "monitorMode": "changes-only",
  "monitorId": "nike-daily",
  "emitRemoved": true,
  "maxAds": 1000
}
```

Schedule that daily. Day one bills the full set. Every day after, you are billed
only for ads that are genuinely new or whose creative, copy, or destination URL
changed — typically a handful. Use a different `monitorId` per schedule so two
schedules never diff against each other.

### Get pushed the changes instead of polling

Set `webhookUrl` and the run POSTs its delta to your endpoint when it finishes —
what launched, what changed, what started scaling, what stopped:

```json
{
  "event": "ads.changed",
  "monitorId": "nike-daily",
  "run": { "status": "complete", "adsReturned": 14, "adsCharged": 6, "resumed": false },
  "counts": { "new": 4, "changed": 2, "unchanged": 8, "removed": 1, "scaling": 3 },
  "events": {
    "new":     [{ "id": "…", "pageName": "Nike", "creativeType": "video", "linkDomain": "nike.com" }],
    "changed": [{ "id": "…", "changedFields": ["body", "linkUrl"] }],
    "scaling": [{ "id": "…", "variantDelta": 6 }],
    "removed": [{ "id": "…", "status": "removed" }]
  }
}
```

The `run` block is there on purpose: it tells your automation whether the run
was complete enough to trust the removals. A partial run must not be read as
"the competitor stopped advertising".

HTTPS only, and a dead endpoint is logged as a warning — it never fails the run
or costs you the data you already paid for.

---

## Output

One row per unique ad:

```json
{
  "id": "1249043200627555",
  "source": "web",
  "adLibraryUrl": "https://www.facebook.com/ads/library/?id=1249043200627555",

  "pageId": "15087023444",
  "pageName": "Nike",
  "pageUrl": "https://facebook.com/nike",
  "pageLikeCount": 39553410,
  "pageCategories": ["Sportswear"],

  "isActive": true,
  "startDate": "2026-03-17",
  "endDate": "2026-08-27",
  "totalActiveDays": 163,

  "title": "Nike: Shoes, Apparel & Stories",
  "body": "Celebrate your birthday with Nike and unlock member-only products.",
  "caption": "nike.com",
  "linkUrl": "https://www.nike.com/t/...",
  "ctaText": "Shop now",
  "ctaType": "SHOP_NOW",
  "displayFormat": "DPA",
  "creativeBodies": ["..."],
  "creativeTitles": ["..."],
  "creativeLinkUrls": ["..."],
  "images": [{ "originalUrl": "...", "resizedUrl": "...", "watermarkedUrl": null }],
  "videos": [{ "hdUrl": "...", "sdUrl": "...", "previewImageUrl": "..." }],
  "mediaCount": 6,

  "platforms": ["FACEBOOK", "INSTAGRAM", "AUDIENCE_NETWORK", "MESSENGER"],
  "countries": [],

  "variantCount": 3,
  "linkDomain": "nike.com",
  "linkUrlClean": "https://www.nike.com/t/...",
  "utm": { "source": "facebook", "medium": "paid", "campaign": "bday" },
  "creativeType": "carousel",
  "containsInjectionRisk": false,

  "transparencyAvailable": false,
  "isPolitical": false,
  "categories": ["UNKNOWN"],
  "spend": null,
  "impressions": null,
  "impressionsIndex": -1,
  "reachEstimate": null,

  "scrapedAt": "2026-08-27T17:35:00.000Z"
}
```

Three of those fields are worth calling out:

- **`variantCount`** — how many near-identical copies of this creative Meta
  grouped together. Advertisers duplicate a winner across ad sets, so a rising
  variant count is the closest public signal that a creative is being scaled.
- **`linkDomain`** — the destination host. Use it to tell two identically-named
  Facebook Pages apart, which is the standard fix for Ad Library false positives.
- **`transparencyAvailable`** — whether Meta published funding data for *this* ad.
  It makes an empty `spend` unambiguous: Meta does not publish it, the scraper did
  not fail.
- **`creativeType`** — `video`, `carousel`, `image`, `catalog` or `text`, worked out
  from the creative itself rather than copied from Meta's assembly-level
  `display_format`. Asked for verbatim as the layer people would rather buy than
  build: *"building an AI prompt to reliably categorize ad types is more annoying
  than it sounds."*
- **`linkUrlClean` + `utm`** — the destination with tracking parameters stripped,
  and the UTMs as their own fields. A changed landing URL is how you spot a
  competitor shifting messaging, but only once click ids stop making every variant
  look different.
- **`containsInjectionRisk`** — ad copy is written by third parties and can carry
  prompt injection. This flags it; it never rewrites the text.

### The scaling signal

In monitor mode each ad also carries `variantCountPrev`, `variantDelta`,
`isScaling` and `daysTracked`.

A raw duplicate count is a weak signal — a cost-cap campaign can carry ten
variants where only one spends. The **movement between runs** is the signal, and
it is the one people say every tool misses: *"the duplicate tracking over time is
the part most people miss, that's where you actually see the scaling signal."*
When an unchanged creative starts appearing in more ad sets, `isScaling` goes
true.

In monitor mode each row also carries `status`, `isNew`, `firstSeenAt`,
`lastSeenAt`, and `changedFields`.

### Field reference

| Field | Type | Always present |
|---|---|---|
| `id`, `source`, `adLibraryUrl`, `scrapedAt` | string | Yes |
| `pageId`, `pageName`, `pageUrl`, `byline` | string \| null | Key present |
| `isActive`, `pageIsDeleted`, `isPolitical` | boolean | Yes |
| `startDate`, `endDate` | `YYYY-MM-DD` \| null | Key present |
| `totalActiveDays` | number \| null | Key present |
| `title`, `body`, `caption`, `ctaText`, `ctaType` | string \| null | Key present |
| `linkUrl`, `linkUrlClean`, `linkDomain` | string \| null | Key present |
| `utm` | object | Yes (`{}` when none) |
| `creativeType` | `video`/`carousel`/`image`/`catalog`/`text` | Yes |
| `creativeBodies`, `creativeTitles`, `creativeLinkUrls` | string[] | Yes (may be `[]`) |
| `images`, `videos`, `cards` | object[] | Yes (may be `[]`) |
| `mediaCount`, `variantCount`, `impressionsIndex` | number | Yes |
| `platforms`, `countries`, `categories` | string[] | Yes (may be `[]`) |
| `spend`, `impressions` | object \| null | Key present — **null for most ads** |
| `transparencyAvailable`, `containsInjectionRisk` | boolean | Yes |
| `status`, `isNew`, `firstSeenAt`, `lastSeenAt`, `changedFields` | — | Monitor mode only |
| `daysTracked`, `variantCountPrev`, `variantDelta`, `isScaling` | — | Monitor mode only |

Array fields are never `null` and scalar fields are never missing, so
spreadsheet and CSV exports keep their columns. This is asserted by a test
against the committed fixtures.

### Key-value records

- **`SUMMARY`** — totals, ads charged, duplicates dropped, whether a cap was hit.
- **`RUN-STATUS`** — one entry per query with `ok`, the ad count, and an
  `errorCategory` when it failed. This is what makes scheduled runs trustworthy:
  if a query fails, its ads are **not** reported as removed, because a network
  blip is not evidence that a competitor stopped advertising.

---

## FAQ

### Why is `spend` null for most ads?

Because Meta does not publish it for most ads. This is the single most
misunderstood thing about the Ad Library, and no other actor explains it, so:

| Ad type | Available everywhere? | Spend, impressions, funding entity |
|---|---|---|
| Political & issue ads | Yes, ~240 countries | **Yes** |
| Any ad targeting the EU | EU only | **Yes** (EU DSA transparency rules) |
| Ordinary commercial ads outside the EU | Yes | **No** — Meta never publishes it |

So for a US e-commerce competitor you get the creative, the copy, the destination
and the run dates — but not what they spent. Nobody can sell you that number,
because Meta does not publish it. Anyone claiming otherwise is estimating.

### Do I need a Meta API token?

No. This actor does not ask for one and does not need one.

Meta's official Graph API `ads_archive` endpoint only covers political and issue
ads plus EU-targeted ads — the same narrow subset shown above — and it requires an
app review plus identity verification to get at. For ordinary commercial ads it
returns nothing useful, which is why this actor reads the public Ad Library
instead.

### Can I get targeting, budget, CPM, CTR or ROAS?

No, and neither can anyone else. Meta does not publish them. Any tool that shows
you a competitor's exact ad-set structure, budget or ROAS is modelling a guess.
This actor returns what the Ad Library actually contains and labels the rest
`null` rather than inventing a number.

The same caution applies to **how long an ad has been running**. `totalActiveDays`
is the metric everyone sorts by, and it is a *proxy*, not a performance measure:
budget, audience size, bid caps and frequency caps all change how much an ad was
actually shown. A 100-day ad is not automatically twice as good as a 50-day one.

### Does the Ad Library keep old ads?

Only partly, and this catches people out. For ads **targeting the EU or UK**, Meta
must retain them under transparency rules. **Outside the EU/UK, a commercial ad
disappears from the Ad Library once it stops running** — permanently.

So historical analysis of a US-only advertiser is built on what is visible today,
not on a complete archive. This is a limit of the source, not of the scraper, and
it is the reason to start monitoring a competitor *before* you need the history:
`monitorMode` keeps your own record of ads that Meta will later drop.

### I'm feeding this into an LLM. Anything to watch for?

Yes. **Treat scraped ad copy as untrusted input.** Ad text, link descriptions and
video metadata are written by third parties and can contain prompt injection. If
you pipe `body` or `creativeBodies` straight into a generation prompt, isolate
them in a field your model treats as data rather than instructions.

### Why do I need a proxy?

Meta blocks a single IP after roughly **47 requests** — about 470 ads — and in
our measurements that block lasted **hours**, not minutes. It also escalates:
first as a silent HTTP 200 with an error code buried in the body (not a normal
rate-limit response, which is why naive scrapers appear to "go quiet" rather
than fail), and then as an outright 403 on the page itself.

This actor detects it, rotates to a fresh proxy session, and carries on. Residential
proxies are the default and are what make runs above a few hundred ads work.

### The image URLs stopped working. Why?

Meta's CDN links are signed and expire within days. That is Meta's behaviour, not a
bug. Turn on **`persistMedia`** and every image and video is downloaded into the
run's key-value store and the URLs are rewritten to permanent ones.

For the same reason, change detection ignores those signature parameters — otherwise
every ad would look "changed" on every run.

### What if my run gets interrupted?

It continues where it stopped. Every page boundary is written to a key-value
store, so a crash, a dead proxy or an Apify platform migration costs one page
rather than the whole run — and the ads already collected are not billed twice.
Set `resumeFromCheckpoint: false` to force a clean run from the top.

### Will this break when Meta changes their site?

Ad Library scrapers are famously brittle because they hard-code an internal query
id that Meta rotates on every frontend deploy. This actor **re-reads that id from
Meta's live JavaScript bundle at runtime**, and keeps the last known value only as a
fallback. Contract tests also fail by name when a field disappears from the payload,
so a break is diagnosed in minutes rather than guessed at.

If something does break, open an issue on the actor page — it gets fixed, and the
fix is posted in the thread.

### How do I export Facebook Ad Library data to CSV or Google Sheets?

Meta has no export button — the question gets asked repeatedly and answered
rarely. Run this actor and the dataset exports to **CSV, JSON, Excel or Google
Sheets** from the Apify console or the API, with stable column names. Every array
field is always an array and every scalar field is always present, so a
spreadsheet keeps its columns run after run.

### Why can't I find my competitor's ads in the Ad Library?

Four causes, in the order they usually apply:

1. **You searched the name, and got a different Page.** Identically-named Pages
   are common. Use `advertiserDomains` with their website, or `pageIds`.
2. **A filter is narrowing it.** Country and active-status filters live in the
   Ad Library URL; paste the URL here and they are honoured exactly.
3. **The ads stopped.** Outside the EU/UK, Meta removes inactive commercial ads
   permanently.
4. **Meta is not showing everything.** The Ad Library does not always return
   every ad an advertiser runs. That is the source, not the scraper — which is
   why every run here ends with an explicit `runStatus`.

### How do I download all the images and videos from an ad?

Turn on `persistMedia`. Every creative is downloaded into the run's key-value
store and the URLs are rewritten to permanent ones. Without it you get Meta's
CDN links, which are signed and expire within days — the reason so many swipe
files turn into broken images a week later.

### Can I monitor a competitor and get alerted when they launch a new ad?

Yes, and it is what this actor is built for. Set `monitorMode: "changes-only"`,
schedule it daily, and add a `webhookUrl` to have the changes pushed to you.
You are billed only for ads that are genuinely new or changed — typically a
handful per day rather than the whole set.

### Why do I get fewer ads than the Ad Library website shows?

Three reasons, all visible in `SUMMARY`: duplicates were removed (Meta returns the
same ad across queries), a filter excluded them, or `maxAds` capped the run. The
status message always says when a cap was the cause.

### Is this legal?

It reads Meta's **public ad transparency library** — the archive Meta publishes
deliberately, no login, no account, no personal data. It does not touch private
profiles, follower lists, or anything behind authentication. Ad creatives remain
the property of their advertisers; check your own obligations before republishing
them, and note that results may contain publicly shared personal data subject to
GDPR.

---

## Input reference

| Field | Type | Default | What it does |
|---|---|---|---|
| `searchTerms` | string[] | — | Keyword search. One query per term. |
| `pageIds` | string[] | — | Every ad from specific Facebook Pages. |
| `adLibraryUrls` | string[] | — | Ad Library URLs; filters inside them are honoured. |
| `countries` | string[] | `["ALL"]` | ISO-3166 alpha-2, or `ALL`. |
| `activeStatus` | enum | `active` | `active` / `inactive` / `all`. |
| `adType` | enum | `all` | `all` / `political`. |
| `mediaType` | enum | `all` | `all` / `image` / `video` / `meme`. |
| `maxAds` | integer | `1000` | Hard cap on billable ads. |
| `maxCostUsd` | integer | — | Optional dollar ceiling. |
| `maxPagesPerQuery` | integer | `200` | Runaway-pagination guard. |
| `monitorMode` | enum | `off` | `off` / `annotate` / `changes-only`. |
| `monitorId` | string | `default` | Names the memory this schedule diffs against. |
| `emitRemoved` | boolean | `true` | Free records for ads that stopped. |
| `persistMedia` | boolean | `false` | Download media, rewrite URLs to permanent ones. |
| `includeCards` | boolean | `true` | Keep the per-card carousel breakdown. |
| `resumeFromCheckpoint` | boolean | `true` | Continue an interrupted run instead of restarting. |
| `publisherPlatforms` | string[] | — | Keep ads on these platforms. |
| `minDaysRunning` / `maxDaysRunning` | integer | — | Bound how long an ad has been live. |
| `startedAfter` / `startedBefore` | string | — | `YYYY-MM-DD` or `"30 days"`. |
| `requireMedia` | boolean | `false` | Drop ads with no creative. |
| `excludeDisplayFormats` | string[] | — | Drop formats such as `DCO`. |
| `minVariantCount` | integer | — | Only creatives being scaled. |
| `bodyContains` / `bodyExcludes` | string[] | — | Search the ad copy. |
| `linkDomains` | string[] | — | Filter by destination domain. |
| `advertiserDomains` | string[] | — | Find a brand by website, skipping same-named Pages. |
| `webhookUrl` | string | — | HTTPS endpoint that receives the change set on finish. |
| `maxAdsPerPage` | integer | — | Keep at most N ads per advertiser. |
| `proxyConfiguration` | object | Residential | Strongly recommended. |

At least one of `searchTerms`, `pageIds`, `advertiserDomains` or `adLibraryUrls`
is required.

---

## What this actor does not do

Stated up front, because finding out later is worse:

- **No spend, targeting, budget, CPM, CTR or ROAS** for ordinary commercial ads.
  Meta does not publish them. Anyone showing you those numbers is modelling a guess.
- **No ads that already stopped**, outside the EU/UK. Meta deletes them from the
  Ad Library permanently. Start monitoring *before* you need the history.
- **No engagement counts** (likes, comments, shares). Not in the Ad Library.
- **No single-ad lookup by share link.** The public library only exposes search
  by keyword or by Page.
- **Coverage is Meta's, not ours.** The Ad Library does not always return every
  ad an advertiser is running; that is a documented limitation of the source.
  What this actor guarantees is that it tells you when *its own* run was
  incomplete — see `runStatus`.

## Did I get everything? — `runStatus`

Every run ends with an explicit verdict, because a short result set that looks
successful is the most expensive failure in this category:

| `runStatus` | Meaning |
|---|---|
| `COMPLETE` | Every query reached the end of its results. |
| `PARTIAL` | Something stopped it early — a cap, a page budget, or a failed query. `incompleteBecause` names which. |
| `FAILED` | No query succeeded. |

Per query, `RUN-STATUS` also carries `complete: true/false` and `truncatedBy`.

---

## Error categories

Every failure carries a category you can branch on, not a log line you have to read:

| Category | Meaning |
|---|---|
| `rate_limited` | Meta is throttling this IP; sessions were rotated and still hit it. |
| `blocked` | The session challenge did not resolve — usually a blocked proxy exit. |
| `schema_changed` | Meta moved a field. The message names which one. |
| `doc_id_stale` | Meta redeployed the frontend; the query id was re-resolved. |
| `page_not_found` | That Page id does not exist or has never run ads. |
| `country_not_supported` | The country code was rejected. |
| `no_results` | Success, zero ads. An answer, not an error. |
| `network` | Timeout or connection failure after all retries. |

---

## Common uses

- **Competitor ad monitoring** — daily diff of a rival's active creatives.
- **Creative swipe files** — bulk-download ad images and videos by keyword.
- **Ad-spend lead generation** — find businesses actively running ads right now.
- **Agency pitch audits** — pull a prospect's live ads before the call.
- **EU DSA / political ad transparency research** — spend, reach and funding data.
- **Creative trend analysis** — which hooks, formats and CTAs a market is running.

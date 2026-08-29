# Store metadata — paste into Apify Console → Publication → Display information

These are DISTINCT from the store name and description. Apify uses them as the
HTML `<title>` and `<meta name="description">`, which is what Google shows.

## SEO name (target 40–50 characters)

```
Facebook Ad Library Scraper & Meta Ads API
```
42 characters. Carries both head terms: "Facebook Ad Library Scraper" (the #1
query, where apify.com already holds positions 1 and 2) and "Meta Ads API".

## SEO description (target 145–155 characters)

```
Scrape Facebook & Instagram ads from Meta's Ad Library. Ad copy, creatives, CTAs, landing URLs. Tracks what changed. No API token. $0.60 per 1,000 ads.
```
150 characters. Leads with the action, names the platform twice, states the
price — the missing field buyers complained about having to click through for.

## Why the slug is `meta-ad-library-scraper` and must never change

- The actor page becomes `apify.com/<user>/meta-ad-library-scraper`.
- The API subpage becomes `.../meta-ad-library-scraper/api` — a near-exact match
  for **"meta ad library api"**, the one target query where **no Apify actor
  appears on page one** (it is held by transparency.meta.com and three
  commercial tools that rank purely by naming themselves after the query).
- Apify actor `/api` subpages were measured ranking on their own at positions 1
  and 3 for "facebook ads scraper api".
- Changing a slug creates no redirect and resets ranking to zero.

## Target queries, and who holds them today

| Query | Current page 1 | Our angle |
|---|---|---|
| `facebook ad library scraper` | apify.com ×2 (curious_coder, apify) | Head term in title; compete on the comparison table, not on the name |
| `meta ad library api` | **No Apify actor** — transparency.meta.com, then 3 commercial tools | Slug + `/api` subpage + the "official API vs this" section |
| `facebook ads scraper api` | apify.com ×4, incl. two `/api` subpages | Free ranking from existing on the platform |
| `scrape facebook ads` | No Apify at all | Weak intent; not a priority |

## Rules observed in the ranked results

- No ranked result uses "free", "no code", or a benefit claim in the title.
- The winning shape is **primary keyword + secondary keyword**, joined by an
  em-dash or parentheses.
- Google AI Overview cites **use-case sentences**, not feature lists — so the
  description and the README opening both lead with what the buyer is doing.

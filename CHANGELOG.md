# Changelog

## 1.0.1 — 2026-08-27

- **Fix: Meta now serves its anti-bot challenge page with HTTP 403** (it used
  to be HTTP 200). The bootstrap treated that status as a hard block and every
  run failed as `blocked`. The challenge inside the body is still solvable —
  the session handshake now recognises it, solves it, and proceeds. Verified
  end to end against the live Ad Library.

## 1.0.0 — 2026-08-27

First release.

- Reads the public Meta Ad Library through the same GraphQL call the website
  makes. No login, no Meta API token, no headless browser.
- **Resumable pagination.** A run cut short by a crash, a dead proxy or an Apify
  platform migration continues from the exact page it reached, and does not
  re-bill what it already delivered.
- **Change tracking.** Scheduled runs report ads that are new, changed, stopped,
  or spreading into more ad sets (`isScaling`). Only new and changed ads are billed.
- **Creatives from everywhere Meta hides them** — top level, carousel cards and
  extras. Measured at 9.7× more media than reading `snapshot.images` alone.
- **13 filters applied before billing**, so a filtered ad is never charged.
- **`advertiserDomains`** finds a brand by website instead of by name, which
  skips identically-named Pages.
- **Explicit `runStatus`** (`COMPLETE` / `PARTIAL` / `FAILED`) with the reason,
  so a truncated run can never pass for a full one.
- **Webhook** delivery of the change set, with a run-status block.
- **Input validation** that refuses unknown fields before spending anything.
- **`persistMedia`** downloads creatives into the key-value store, because
  Meta's CDN links expire within days.
- Self-healing against Meta rotating its internal query id.

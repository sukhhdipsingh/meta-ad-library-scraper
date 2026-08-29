# Changelog

## 1.0.2 — 2026-08-29

- **Fix: a run died on a refusal it should have retried.** Meta declines a
  request it dislikes with HTTP 200 and the reason in the body. The actor read
  the missing `data` field, called it `schema_changed` — a category nothing
  retries — and failed the whole run. It is now read as what it is: the refusal
  is parsed out of every shape Meta uses for it (top level, nested, and inside
  the GraphQL `errors` array), and an unrecognised one rotates the proxy session
  and retries instead of ending the run. A body with no refusal in it at all is
  still `schema_changed`, and now names the keys that did arrive.
- **Fix: the self-repair for a rotated query id had never worked.** Two faults,
  both silent. The re-read of the Ad Library shell was sent without the browser
  navigation headers, so Meta answered HTTP 400 every time. And the bundle hunt
  gave up after four candidates when the operation lives in the fifth — the id
  is reached 7.4 MB in, so the cap could not have found it on any run. The
  re-read now sends the same headers as the bootstrap, and the hunt is bounded
  by a byte budget instead of a candidate count.
- **A resolved query id now outlives the run that paid for it.** It is written
  to the `meta-ad-docid` key-value store, so when Meta rotates, the first run
  to notice pays for the bundle download once and every later run starts on the
  right id for free. Previously each run would have re-paid.
- **A stale query id is told apart from a block.** Meta names it ("Query with
  id … does not exist"), which asks for a bundle re-read; rotating proxies
  against it would never have helped.
- Deployment is now `scripts/push.mjs`, committed alongside the actor instead
  of improvised, and the live smoke test exercises the self-repair path — the
  part that only runs after a failure, and so rots unseen.

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

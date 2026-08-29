/**
 * Pure string extraction from Meta's HTML shell and JS bundles.
 *
 * Why this module exists: the Ad Library's `doc_id` is a Relay persisted-query
 * id that Meta rotates on every frontend redeploy. A hardcoded one is the
 * single most common reason competing scrapers break "every few weeks". So the
 * actor re-reads it at runtime from the live bundle, and the reading is pure
 * text work — no network, no state — which makes it testable against a
 * committed bundle excerpt.
 *
 * Nothing here fetches. `session.js` does the fetching and hands strings in.
 */

/** Escape a literal for safe interpolation into a RegExp. */
function escapeRe(literal) {
  return String(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the persisted-query id for one Relay operation inside a JS bundle.
 *
 * The module always looks like:
 *   __d("<op>_facebookRelayOperation",[],(function(t,n,r,o,a,i){a.exports="123"}),null);
 * but the minifier renames the module argument on every build (`a.exports`,
 * `e.exports`, `i.exports`, ...), so the export variable must not be pinned.
 * The name is anchored instead, which is what keeps a bundle containing several
 * relay operations from yielding the wrong id.
 *
 * @param {string} bundleSource raw JS bundle text
 * @param {string} operationName e.g. 'AdLibrarySearchPaginationQuery'
 * @returns {string|null} the numeric doc_id, or null when absent
 */
export function extractDocId(bundleSource, operationName) {
  if (typeof bundleSource !== 'string' || !bundleSource || !operationName) return null;

  const op = escapeRe(operationName);
  // The `{0,400}` bound stops the lazy scan from running past the end of this
  // module and stealing the next operation's id if this one has no export.
  const re = new RegExp(
    `__d\\(\\s*["']${op}_facebookRelayOperation["'][\\s\\S]{0,400}?\\.exports\\s*=\\s*["'](\\d+)["']`,
  );
  const m = re.exec(bundleSource);
  return m ? m[1] : null;
}

const RE_JS_URL = /https?:\/\/[\w.-]*fbcdn\.net\/[^\s"'`<>()]*\.js(?:\?[^\s"'`<>()]*)?/g;
const RE_SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** Undo the two escapings Meta's HTML uses around URLs (JSON `\/`, HTML `&amp;`). */
function unescapeHtmlUrls(html) {
  return html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

/**
 * Every Facebook CDN JS bundle URL referenced by the Ad Library HTML shell.
 *
 * Ordered by how likely each one is to hold the search operation: a bundle
 * whose name mentions the Ad Library first, then the ones actually loaded via
 * `<script src>` (the real entry bundles), then anything else that only appears
 * inside inline JSON. Within a tier, order of appearance is preserved.
 *
 * @param {string} html
 * @returns {string[]} deduplicated URLs
 */
export function extractBundleUrls(html) {
  if (typeof html !== 'string' || !html) return [];
  const text = unescapeHtmlUrls(html);

  const scriptSrcs = new Set();
  for (const m of text.matchAll(RE_SCRIPT_SRC)) {
    if (/\.js(\?|$)/i.test(m[1])) scriptSrcs.add(m[1]);
  }

  const seen = new Set();
  const ranked = [];
  let index = 0;
  for (const m of text.matchAll(RE_JS_URL)) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const tier = /adlibrary/i.test(url) ? 0 : (scriptSrcs.has(url) ? 1 : 2);
    ranked.push({ url, tier, index: index++ });
  }

  ranked.sort((a, b) => (a.tier - b.tier) || (a.index - b.index));
  return ranked.map((r) => r.url);
}

/**
 * The `lsd` CSRF token the GraphQL POST must echo in both the body and the
 * `x-fb-lsd` header. It only appears once the challenge cookie is set.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function extractLsd(html) {
  if (typeof html !== 'string' || !html) return null;
  const relay = /"LSD",\[\],\{"token":"([^"]+)"/.exec(html);
  if (relay) return relay[1];
  // Older shells render the token as a plain hidden input instead.
  const input = /name="lsd"\s+value="([^"]+)"/.exec(html);
  return input ? input[1] : null;
}

/**
 * The anti-bot challenge path Meta serves on a cold GET. POSTing to it is what
 * mints the `rd_challenge` cookie; without that cookie the shell never contains
 * an lsd token and every GraphQL POST is rejected.
 *
 * @param {string} html
 * @returns {string|null} a site-relative path, e.g. `/__rd_verify_ab-C_9?challenge=3`
 */
export function extractChallengePath(html) {
  if (typeof html !== 'string' || !html) return null;
  const m = /\/__rd_verify_[A-Za-z0-9_-]+\?challenge=\d+/.exec(unescapeHtmlUrls(html));
  return m ? m[0] : null;
}

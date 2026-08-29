/**
 * Meta's raw GraphQL payload -> the public record documented in docs/CONTRACT.md.
 *
 * This module is where most of the product's value is decided, because Meta's
 * payload is far messier than it looks:
 *
 *   - `snapshot.body` is an OBJECT (`{text}`), not a string. Reading it as a
 *     string is how a scraper ends up shipping empty ad copy.
 *   - Media live in three different places. Measured across the committed
 *     fixtures (60 real ads): 15 ads carry top-level `snapshot.images`, but
 *     `snapshot.cards[]` carries 174 images and 25 videos. An extractor that
 *     only reads `snapshot.images` silently loses ~92% of the creatives —
 *     which is exactly the "empty adCreativeImages / adCreativeBodies"
 *     complaint filed against the incumbent actor.
 *   - One edge can hold several ads (`collated_results`), so flattening has to
 *     happen before dedup and before billing.
 *
 * Everything here is pure: no network, no SDK, no clock except the `now` that
 * the caller injects, so the whole thing is testable against fixtures.
 */
import {
  parseSpend, parseImpressions, parseReach,
  epochToIsoDate, epochToIso, activeDays, toStringArray,
} from './parse.js';
import { adPermalink } from './constants.js';

/** Meta wraps ad copy as `{text: "..."}`; older payloads sometimes inline a
 *  plain string. Accept both, return a trimmed string or null. */
function textOf(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text.trim() || null;
  return null;
}

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * What kind of ad this is, in the vocabulary media buyers actually use.
 *
 * Asked for verbatim, as the thing people would pay not to build: *"already
 * classifies by format (static, video, catalog) without you needing to build
 * that classification layer yourself... building an AI prompt to reliably
 * categorize ad types from raw scraped HTML is more annoying than it sounds."*
 *
 * Meta's own `display_format` is not that classification — DCO and DPA describe
 * how the ad was *assembled*, not what the viewer sees. So the shape of the
 * creative decides, and the format code only breaks ties.
 */
function classifyCreative({ videos, images, cards, displayFormat }) {
  const fmt = String(displayFormat ?? '').toUpperCase();

  // Catalog-driven ads are worth their own label: their creative is generated
  // per product, so a marketer treats them differently from a made creative.
  if (fmt === 'DPA' || fmt === 'DCO') return 'catalog';
  if (videos.length > 0) return 'video';
  if (cards.length > 1 || fmt === 'CAROUSEL') return 'carousel';
  if (images.length > 0) return 'image';
  if (fmt) return fmt.toLowerCase();
  return 'text';
}

/** Tracking parameters carry no meaning for comparison and change on every
 *  variant, so they are split out rather than left to pollute the URL. */
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function splitUrl(rawUrl) {
  const s = clean(rawUrl);
  if (!s || !/^https?:\/\//i.test(s)) return { clean: s, utm: {} };
  let url;
  try { url = new URL(s); } catch { return { clean: s, utm: {} }; }

  const utm = {};
  for (const key of UTM_KEYS) {
    const v = url.searchParams.get(key);
    if (v) utm[key.replace('utm_', '')] = v;
    url.searchParams.delete(key);
  }
  // Meta's own click ids are noise for anyone comparing destinations.
  for (const key of ['fbclid', 'gclid', 'msclkid', 'ttclid', '_ga']) url.searchParams.delete(key);
  return { clean: url.toString().replace(/\?$/, ''), utm };
}

/**
 * Flag ad copy that looks like it is trying to talk to a language model.
 *
 * Raised twice in the research and answered neither time: *"Treat scraped ad
 * content as untrusted input, because it is. The ad copy, the transcript, even
 * the video metadata can carry prompt injection."* The text is never altered —
 * silently rewriting an advertiser's copy would corrupt the dataset — it is
 * only marked, so a pipeline can quarantine it before it reaches a model.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/i,
  /\bsystem\s*(?:prompt|message)\s*[:>]/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /<\s*\/?\s*(?:system|assistant|instructions?)\s*>/i,
  /\bprompt\s+injection\b/i,
  /reveal\s+(?:your|the)\s+(?:system\s+)?prompt/i,
];

function looksLikeInjection(texts) {
  const joined = texts.filter(Boolean).join('\n');
  if (!joined) return false;
  return INJECTION_PATTERNS.some((re) => re.test(joined));
}

/** Registrable host of a destination URL, lowercased, without `www.`.
 *  Meta sometimes puts a bare domain in `caption`, so that is accepted too. */
function hostOf(value) {
  const s = clean(value);
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      .hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Any object that can carry creative media: the snapshot itself, or a card. */
function mediaFrom(node) {
  const images = [];
  const videos = [];
  if (!node || typeof node !== 'object') return { images, videos };

  const original = clean(node.original_image_url);
  const resized = clean(node.resized_image_url);
  if (original || resized) {
    images.push({
      originalUrl: original,
      resizedUrl: resized,
      watermarkedUrl: clean(node.watermarked_resized_image_url),
    });
  }

  const hd = clean(node.video_hd_url);
  const sd = clean(node.video_sd_url);
  if (hd || sd) {
    videos.push({
      hdUrl: hd,
      sdUrl: sd,
      previewImageUrl: clean(node.video_preview_image_url),
    });
  }
  return { images, videos };
}

/** Two media entries are the same asset when they point at the same URLs. */
function dedupeMedia(list, keys) {
  const seen = new Set();
  return list.filter((m) => {
    const k = keys.map((x) => m[x] ?? '').join('|');
    if (!k.replace(/\|/g, '') || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A carousel card, flattened into the same vocabulary as the top level. */
function normalizeCard(card) {
  const { images, videos } = mediaFrom(card);
  return {
    title: clean(card.title),
    body: textOf(card.body),
    caption: clean(card.caption),
    linkUrl: clean(card.link_url),
    linkDescription: clean(card.link_description),
    ctaText: clean(card.cta_text),
    ctaType: clean(card.cta_type),
    images,
    videos,
  };
}

/**
 * One raw `collated_results` entry -> one public record.
 *
 * @param {object} raw    an element of `node.collated_results`
 * @param {object} [ctx]  `{ source, now }` — `now` is epoch ms, injected so
 *                        `scrapedAt` and `totalActiveDays` stay reproducible.
 */
export function normalizeAd(raw, ctx = {}) {
  const { source = 'web', now = Date.now() } = ctx;
  const snapshot = (raw && typeof raw.snapshot === 'object' && raw.snapshot) || {};

  const cards = Array.isArray(snapshot.cards) ? snapshot.cards.map(normalizeCard) : [];

  // Collect media from every place Meta hides it, then dedupe. Order matters
  // only for readability: top-level first, then cards, then the extras.
  const top = mediaFrom(snapshot);
  const extraImages = (Array.isArray(snapshot.extra_images) ? snapshot.extra_images : [])
    .flatMap((i) => mediaFrom(i).images);
  const extraVideos = (Array.isArray(snapshot.extra_videos) ? snapshot.extra_videos : [])
    .flatMap((v) => mediaFrom(v).videos);
  const listImages = (Array.isArray(snapshot.images) ? snapshot.images : [])
    .flatMap((i) => mediaFrom(i).images);
  const listVideos = (Array.isArray(snapshot.videos) ? snapshot.videos : [])
    .flatMap((v) => mediaFrom(v).videos);

  const images = dedupeMedia(
    [...top.images, ...listImages, ...cards.flatMap((c) => c.images), ...extraImages],
    ['originalUrl', 'resizedUrl'],
  );
  const videos = dedupeMedia(
    [...top.videos, ...listVideos, ...cards.flatMap((c) => c.videos), ...extraVideos],
    ['hdUrl', 'sdUrl'],
  );

  const body = textOf(snapshot.body);
  const title = clean(snapshot.title);
  const linkUrl = clean(snapshot.link_url);
  const destination = splitUrl(linkUrl);

  const creativeBodies = toStringArray([body, ...cards.map((c) => c.body)]);
  const creativeTitles = toStringArray([title, ...cards.map((c) => c.title)]);
  const creativeLinkUrls = toStringArray([
    linkUrl,
    ...cards.map((c) => c.linkUrl),
    ...toStringArray(snapshot.extra_links),
  ]);

  const startEpoch = Number.isFinite(raw?.start_date) ? raw.start_date : null;
  const endEpoch = Number.isFinite(raw?.end_date) ? raw.end_date : null;
  const categories = toStringArray(raw?.categories);
  const id = clean(raw?.ad_archive_id) ?? (raw?.ad_archive_id != null ? String(raw.ad_archive_id) : null);

  return {
    // identity
    id,
    adId: raw?.ad_id != null ? String(raw.ad_id) : null,
    source,
    adLibraryUrl: id ? adPermalink(id) : null,

    // advertiser
    pageId: raw?.page_id != null ? String(raw.page_id) : (snapshot.page_id != null ? String(snapshot.page_id) : null),
    pageName: clean(raw?.page_name) ?? clean(snapshot.page_name),
    pageUrl: clean(snapshot.page_profile_uri),
    pageProfilePictureUrl: clean(snapshot.page_profile_picture_url),
    pageLikeCount: Number.isFinite(snapshot.page_like_count) ? snapshot.page_like_count : null,
    pageCategories: toStringArray(snapshot.page_categories),
    pageIsDeleted: Boolean(raw?.page_is_deleted ?? snapshot.page_is_deleted ?? false),
    byline: clean(snapshot.byline),

    // lifecycle
    isActive: Boolean(raw?.is_active),
    startDate: epochToIsoDate(startEpoch),
    endDate: epochToIsoDate(endEpoch),
    startDateEpoch: startEpoch,
    endDateEpoch: endEpoch,
    totalActiveDays: activeDays(startEpoch, endEpoch, Math.floor(now / 1000)),

    // creative
    title,
    body,
    caption: clean(snapshot.caption),
    linkUrl,
    linkDescription: clean(snapshot.link_description),
    ctaText: clean(snapshot.cta_text),
    ctaType: clean(snapshot.cta_type),
    displayFormat: clean(snapshot.display_format),
    creativeBodies,
    creativeTitles,
    creativeLinkUrls,
    images,
    videos,
    cards,
    mediaCount: images.length + videos.length,

    // distribution
    platforms: toStringArray(raw?.publisher_platform),
    languages: toStringArray(snapshot.country_iso_code ? [] : []),
    countries: toStringArray(raw?.targeted_or_reached_countries),

    // How many near-identical copies of this creative Meta grouped together.
    // Advertisers duplicate a winner across ad sets, so this is the closest
    // public signal that a creative is being scaled — repeatedly asked for
    // ("X ads use this creative and text") and exposed by nobody.
    variantCount: Number.isFinite(raw?.collation_count) && raw.collation_count > 0
      ? raw.collation_count
      : 1,
    collationId: raw?.collation_id != null ? String(raw.collation_id) : null,

    // The destination host, for grouping and for telling two same-named Pages
    // apart — the standard fix for Ad Library false positives.
    linkDomain: hostOf(linkUrl) ?? hostOf(clean(snapshot.caption)),
    // Destination without tracking noise, plus the tracking itself as fields.
    // A changed landing URL is how you spot a competitor shifting messaging —
    // but only once the click ids stop making every variant look different.
    linkUrlClean: destination.clean,
    utm: destination.utm,

    // What a media buyer would call this ad, derived rather than copied from
    // Meta's assembly-level `display_format`.
    creativeType: classifyCreative({ videos, images, cards, displayFormat: snapshot.display_format }),

    // Ad copy is third-party text. Marked, never rewritten.
    containsInjectionRisk: looksLikeInjection([body, title, ...creativeBodies, ...creativeTitles]),

    // Says plainly whether Meta published funding data for THIS ad, so an
    // empty `spend` reads as "Meta does not publish it" rather than "the
    // scraper failed". Meta only discloses it for political/issue ads and for
    // ads targeting the EU.
    transparencyAvailable: Boolean(raw?.spend || raw?.impressions_with_index?.impressions_text),

    // transparency — populated by Meta for political and EU ads only
    isPolitical: categories.some((c) => c.toUpperCase().includes('POLITICAL')),
    categories,
    spend: parseSpend(raw?.spend, clean(raw?.currency)),
    impressions: parseImpressions(raw?.impressions_with_index?.impressions_text),
    impressionsIndex: Number.isFinite(raw?.impressions_with_index?.impressions_index)
      ? raw.impressions_with_index.impressions_index
      : -1,
    reachEstimate: parseReach(raw?.reach_estimate),
    euTotalReach: Number.isFinite(raw?.eu_total_reach) ? raw.eu_total_reach : null,
    demographics: Array.isArray(raw?.demographic_distribution) ? raw.demographic_distribution : [],

    // provenance
    scrapedAt: epochToIso(Math.floor(now / 1000)),
  };
}

/**
 * A whole GraphQL response -> `{ ads, pageInfo }`.
 *
 * Returns rather than throws on a shape it does not recognise: the caller
 * decides whether an unreadable page is a `schema_changed` failure or simply
 * the end of a result set. `missing` names what was not found, so the error
 * message can say which field moved instead of "something broke".
 */
export function extractPage(payload) {
  const conn = payload?.data?.ad_library_main?.search_results_connection;
  if (!conn || !Array.isArray(conn.edges)) {
    return {
      ads: [],
      pageInfo: { hasNext: false, endCursor: null },
      missing: !payload?.data ? 'data' : 'data.ad_library_main.search_results_connection.edges',
    };
  }
  const ads = conn.edges.flatMap((e) => {
    const results = e?.node?.collated_results;
    return Array.isArray(results) ? results : [];
  });
  return {
    ads,
    pageInfo: {
      hasNext: Boolean(conn.page_info?.has_next_page),
      endCursor: clean(conn.page_info?.end_cursor),
    },
    missing: null,
  };
}

/** The fields a usable ad must have. Used by the schema-drift contract test so
 *  a Meta change fails loudly, naming the field, instead of shipping nulls. */
export const REQUIRED_RAW_FIELDS = ['ad_archive_id', 'page_id', 'is_active', 'snapshot'];

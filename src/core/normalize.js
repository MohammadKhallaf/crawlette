/**
 * URL normalization and domain classification.
 *
 * Faithful port of crawl4ai's `normalize_url_for_deep_crawl` / `is_external_url`
 * / `get_base_domain` (crawl4ai/utils.py:2317, :2531, :2480), with one
 * deliberate security divergence noted at `isExternalUrl`.
 */

/** Tracking params crawl4ai strips during deep-crawl normalization (utils.py:2352). */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'ref', 'ref_src',
]);

/** Compound public suffixes, from crawl4ai's get_base_domain (utils.py:2480). */
const COMPOUND_TLDS = new Set([
  'co', 'com', 'org', 'gov', 'edu', 'net', 'mil', 'int',
  'ac', 'ad', 'ae', 'af', 'ag',
]);

/** Schemes crawl4ai treats as inherently external (utils.py:2531). */
const NON_HTTP_SCHEMES = ['mailto:', 'tel:', 'ftp:', 'file:', 'data:', 'javascript:'];

/** SOCIAL_MEDIA_DOMAINS, verbatim from crawl4ai/config.py:75. */
export const SOCIAL_MEDIA_DOMAINS = [
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com',
  'pinterest.com', 'tiktok.com', 'snapchat.com', 'reddit.com',
];

/**
 * Resolve `href` against `baseUrl` and canonicalize it.
 *
 * Mirrors crawl4ai: strips the fragment, keeps the query minus tracking
 * params, lowercases the host, and maps an empty path to "/". Trailing
 * slashes are significant and preserved -- "/a" and "/a/" stay distinct,
 * because servers may return different responses for each.
 *
 * @returns {string|null} normalized absolute URL, or null if unresolvable.
 */
export function normalizeUrl(href, baseUrl, { keepFragment = false, sortQuery = false } = {}) {
  if (!href) return null;

  let u;
  try {
    u = new URL(href.trim(), baseUrl);
  } catch {
    return null; // malformed href, or a relative href with no usable base
  }

  u.hostname = u.hostname.toLowerCase();

  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }
  // crawl4ai's deep-crawl normalizer preserves parameter order; the scraper's
  // variant sorts. Sorting yields better dedup, so it's offered but off by
  // default to match deep-crawl behaviour.
  if (sortQuery) u.searchParams.sort();

  if (!keepFragment) u.hash = '';
  if (u.pathname === '') u.pathname = '/';

  return u.toString();
}

/**
 * Registrable domain for `hostname`: strips "www." and honours the small
 * compound-TLD list crawl4ai uses (so "bbc.co.uk" survives intact).
 */
export function getBaseDomain(urlOrHost) {
  let host = urlOrHost;
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return '';
    }
  }
  host = host.toLowerCase().split(':')[0].replace(/^www\./, '');

  const parts = host.split('.');
  if (parts.length > 2 && COMPOUND_TLDS.has(parts[parts.length - 2])) {
    return parts.slice(-3).join('.');
  }
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
}

/**
 * True if `url` leaves `baseDomain`.
 *
 * DIVERGENCE FROM crawl4ai (deliberate): upstream tests
 * `not url_domain.endswith(base)`, a bare suffix match that classifies
 * "evilexample.com" as *internal* to "example.com" -- so a crawl scoped to one
 * site can be walked onto an attacker-controlled lookalike domain. We require
 * either an exact match or a dot-delimited suffix, which keeps genuine
 * subdomains internal while rejecting lookalikes.
 */
export function isExternalUrl(url, baseDomain) {
  const lower = String(url).toLowerCase().trimStart();
  if (NON_HTTP_SCHEMES.some((s) => lower.startsWith(s))) return true;

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false; // relative URL -> same site
  }
  if (!host) return false;

  const domain = getBaseDomain(host);
  const base = getBaseDomain(baseDomain);
  if (!base) return true;

  return !(domain === base || domain.endsWith(`.${base}`));
}

/** True if `url` belongs to one of the well-known social platforms. */
export function isSocialMediaUrl(url, domains = SOCIAL_MEDIA_DOMAINS) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

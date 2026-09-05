/**
 * Sitemap seeding.
 *
 * Many sites render their listing pages client-side, so a normal crawl of
 * "/speakers" or "/products" discovers nothing: the links do not exist in the
 * fetched HTML. Sitemaps are served as static XML and list every URL directly,
 * which makes them both faster and far more complete than following links.
 *
 * Handles plain urlsets, sitemap indexes (recursively), and plain-text sitemaps.
 */

const MAX_INDEX_DEPTH = 3;

/** Pull <loc> values out of sitemap XML. */
function parseLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

/** True when the document is a sitemap index rather than a list of pages. */
const isIndex = (xml) => /<sitemapindex/i.test(xml);

/**
 * Fetch a sitemap and return every page URL it lists.
 *
 * @param {string} url            sitemap URL (.xml, .xml.gz not supported)
 * @param {object} [options]
 * @param {number} [options.limit]   stop after this many URLs
 * @param {RegExp} [options.match]   keep only URLs matching this pattern
 * @returns {Promise<string[]>} de-duplicated page URLs
 */
export async function fetchSitemap(url, options = {}) {
  const { limit = Infinity, match = null, _depth = 0 } = options;

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Sitemap fetch failed: HTTP ${response.status}`);

  const body = await response.text();
  const seen = new Set();

  const keep = (candidate) => {
    if (!/^https?:\/\//i.test(candidate)) return;
    if (match && !match.test(candidate)) return;
    seen.add(candidate);
  };

  if (isIndex(body)) {
    // A sitemap index points at further sitemaps; recurse, but not forever.
    if (_depth >= MAX_INDEX_DEPTH) return [];
    for (const child of parseLocs(body)) {
      if (seen.size >= limit) break;
      try {
        const nested = await fetchSitemap(child, { ...options, _depth: _depth + 1 });
        for (const u of nested) {
          keep(u);
          if (seen.size >= limit) break;
        }
      } catch { /* one bad child sitemap should not sink the crawl */ }
    }
  } else if (/<urlset|<loc>/i.test(body)) {
    for (const u of parseLocs(body)) {
      keep(u);
      if (seen.size >= limit) break;
    }
  } else {
    // Plain-text sitemap: one URL per line.
    for (const line of body.split('\n')) {
      keep(line.trim());
      if (seen.size >= limit) break;
    }
  }

  return [...seen].slice(0, limit === Infinity ? undefined : limit);
}

/** Heuristic: does this URL look like a sitemap rather than a page? */
export const looksLikeSitemap = (url) => /\.xml(\?|$)|sitemap/i.test(url);

/** Conventional sitemap locations to try for a site. */
export function guessSitemapUrls(pageUrl) {
  try {
    const { origin } = new URL(pageUrl);
    return [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/robots.txt`];
  } catch {
    return [];
  }
}

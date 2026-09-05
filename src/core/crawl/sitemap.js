/**
 * Sitemap seeding.
 *
 * Many sites render their listing pages client-side, so a normal crawl of
 * "/speakers" or "/products" discovers nothing: the links do not exist in the
 * fetched HTML. Sitemaps are served as static XML and list every URL directly,
 * which makes them both faster and far more complete than following links.
 *
 * Handles plain urlsets, sitemap indexes (recursively), and plain-text sitemaps.
 *
 * SECURITY: a sitemap index is attacker-controlled content. Its child <loc>
 * entries are followed with the user's cookies, so an index that pointed at
 * arbitrary hosts could steer credentialed requests at internal services
 * (http://localhost:8080/admin, an intranet host) -- server-side request
 * forgery driven from a document the crawl target controls. Children are
 * therefore restricted to the parent sitemap's own origin, which is also what
 * the sitemaps.org spec requires: a sitemap may only list URLs on its own host
 * unless cross-submission has been verified. Credentials can then only ever
 * reach the origin the user typed themselves.
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
      if (!isSameOriginSitemap(child, url)) continue; // see SECURITY note above
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

/**
 * True when `child` is an http(s) URL on the same origin as `parent`.
 *
 * Guards the recursive fetch in `fetchSitemap`: without it, a hostile sitemap
 * index could name any host -- including `file:`, `http://localhost`, or an
 * intranet address -- and have it fetched with the user's ambient credentials.
 */
export function isSameOriginSitemap(child, parent) {
  try {
    const c = new URL(child);
    if (c.protocol !== 'http:' && c.protocol !== 'https:') return false;
    return c.origin === new URL(parent).origin;
  } catch {
    return false;
  }
}

/**
 * Find a site's sitemap without the user having to know where it lives.
 *
 * Tries, in order: the `Sitemap:` directives in robots.txt (the advertised
 * location, and often the only correct one -- a Nuxt or Next site may publish
 * at a path nobody would guess), then the two conventional filenames.
 *
 * @returns {Promise<string|null>} first sitemap that responds, or null
 */
export async function discoverSitemap(pageUrl) {
  let origin;
  try {
    ({ origin } = new URL(pageUrl));
  } catch {
    return null;
  }

  const candidates = [];

  try {
    const robots = await fetch(`${origin}/robots.txt`, { credentials: 'include' });
    if (robots.ok) {
      const body = await robots.text();
      for (const m of body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
        // Only trust same-origin advertisements, for the reason in the
        // SECURITY note above: robots.txt is remote content too.
        if (isSameOriginSitemap(m[1], `${origin}/`)) candidates.push(m[1]);
      }
    }
  } catch { /* robots.txt is optional */ }

  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { credentials: 'include' });
      if (!response.ok) continue;
      const body = await response.text();
      if (/<urlset|<sitemapindex|<loc>/i.test(body)) return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Derive a sensible URL filter from the page the user started on.
 *
 * Starting at "/speakers" almost always means "the speaker pages", so the
 * first path segment becomes the filter and a site-wide sitemap is narrowed to
 * the section actually wanted.
 */
export function deriveMatchFromUrl(pageUrl) {
  try {
    const segments = new URL(pageUrl).pathname.split('/').filter(Boolean);
    return segments.length ? `/${segments[0]}/` : null;
  } catch {
    return null;
  }
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

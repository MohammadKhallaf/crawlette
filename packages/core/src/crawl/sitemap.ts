/**
 * Sitemap seeding.
 *
 * Many sites render their listing pages client-side, so a normal crawl of
 * "/speakers" or "/products" discovers nothing: the links do not exist in the
 * fetched HTML. Sitemaps are served as static XML and list every URL directly,
 * which makes them both faster and far more complete than following links.
 *
 * Handles plain urlsets, sitemap indexes (recursively), and plain-text sitemaps.
 * Parsed with `fast-xml-parser` rather than a hand-rolled `<loc>` regex, which
 * silently kept HTML entities un-decoded (a URL containing `&amp;` stayed
 * literally "&amp;" instead of "&") and had no real answer for CDATA sections.
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

import { XMLParser } from 'fast-xml-parser';

const MAX_INDEX_DEPTH = 3;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  // Sitemaps may list exactly one URL, which fast-xml-parser would otherwise
  // hand back as a bare object instead of a one-element array.
  isArray: (name) => ['url', 'sitemap'].includes(name),
});

interface SitemapEntry {
  loc?: string;
}
interface ParsedUrlset {
  urlset?: { url?: SitemapEntry[] };
  sitemapindex?: { sitemap?: SitemapEntry[] };
}

/** Pull <loc> values out of parsed sitemap XML, tolerating a malformed document. */
function parseLocs(xml: string): { locs: string[]; isIndex: boolean } {
  let parsed: ParsedUrlset;
  try {
    parsed = xmlParser.parse(xml) as ParsedUrlset;
  } catch {
    return { locs: [], isIndex: false };
  }

  if (parsed.sitemapindex) {
    const locs = (parsed.sitemapindex.sitemap ?? [])
      .map((s) => s.loc).filter((l): l is string => Boolean(l));
    return { locs, isIndex: true };
  }
  if (parsed.urlset) {
    const locs = (parsed.urlset.url ?? [])
      .map((u) => u.loc).filter((l): l is string => Boolean(l));
    return { locs, isIndex: false };
  }
  return { locs: [], isIndex: false };
}

export interface FetchSitemapOptions {
  /** Stop after this many URLs. */
  limit?: number;
  /** Keep only URLs matching this pattern. */
  match?: RegExp | null;
  /** @internal recursion depth guard for sitemap indexes */
  _depth?: number;
}

/**
 * Fetch a sitemap and return every page URL it lists.
 *
 * @param url  sitemap URL (.xml, .xml.gz not supported)
 * @returns de-duplicated page URLs
 */
export async function fetchSitemap(url: string, options: FetchSitemapOptions = {}): Promise<string[]> {
  const { limit = Infinity, match = null, _depth = 0 } = options;

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Sitemap fetch failed: HTTP ${response.status}`);

  const body = await response.text();
  const seen = new Set<string>();

  const keep = (candidate: string): void => {
    if (!/^https?:\/\//i.test(candidate)) return;
    if (match && !match.test(candidate)) return;
    seen.add(candidate);
  };

  const trimmed = body.trim();
  if (trimmed.startsWith('<')) {
    const { locs, isIndex } = parseLocs(body);

    if (isIndex) {
      // A sitemap index points at further sitemaps; recurse, but not forever.
      if (_depth >= MAX_INDEX_DEPTH) return [];
      for (const child of locs) {
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
    } else {
      for (const u of locs) {
        keep(u);
        if (seen.size >= limit) break;
      }
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
export function isSameOriginSitemap(child: string, parent: string): boolean {
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
 * @returns first sitemap that responds, or null
 */
export async function discoverSitemap(pageUrl: string): Promise<string | null> {
  let origin: string;
  try {
    ({ origin } = new URL(pageUrl));
  } catch {
    return null;
  }

  const candidates: string[] = [];

  try {
    const robots = await fetch(`${origin}/robots.txt`, { credentials: 'include' });
    if (robots.ok) {
      const body = await robots.text();
      for (const m of body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
        const candidate = m[1];
        // Only trust same-origin advertisements, for the reason in the
        // SECURITY note above: robots.txt is remote content too.
        if (candidate && isSameOriginSitemap(candidate, `${origin}/`)) candidates.push(candidate);
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
export function deriveMatchFromUrl(pageUrl: string): string | null {
  try {
    const segments = new URL(pageUrl).pathname.split('/').filter(Boolean);
    return segments.length ? `/${segments[0]}/` : null;
  } catch {
    return null;
  }
}

/** Heuristic: does this URL look like a sitemap rather than a page? */
export const looksLikeSitemap = (url: string): boolean => /\.xml(\?|$)|sitemap/i.test(url);

/** Conventional sitemap locations to try for a site. */
export function guessSitemapUrls(pageUrl: string): string[] {
  try {
    const { origin } = new URL(pageUrl);
    return [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/robots.txt`];
  } catch {
    return [];
  }
}

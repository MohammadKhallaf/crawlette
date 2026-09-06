/**
 * URL filters for constraining a crawl.
 *
 * Port of crawl4ai/deep_crawling/filters.py. Only the offline filters are
 * ported -- upstream's SEOFilter and ContentRelevanceFilter each perform a
 * network HEAD fetch per candidate URL, which would multiply a crawl's request
 * count; relevance is better handled by the BM25 content filter after fetching.
 */

import picomatch from 'picomatch';
import { getBaseDomain, isSocialMediaUrl } from '../normalize.ts';

/** Filter interface: `apply(url) -> boolean`. */
export class URLFilter {
  // eslint-disable-next-line class-methods-use-this
  apply(_url: string): boolean { return true; }
}

export interface URLPatternFilterOptions {
  reverse?: boolean;
}

/**
 * Glob or regex matching against the URL.
 *
 * Supports `*.ext` suffixes, `prefix/*` prefixes, `**` wildcards, `{a,b}`
 * alternation, and raw regex (anything anchored with ^ or $, or using \d).
 *
 * Glob compilation is delegated to `picomatch` (with `contains: true`, so a
 * pattern matches anywhere in the URL rather than requiring the URL's path
 * segments to align one-to-one with the pattern's -- the semantic this filter
 * has always had, verified to match a hand-rolled compiler byte-for-byte
 * across suffix, prefix, `**` and `{a,b}` cases before the swap).
 */
export class URLPatternFilter extends URLFilter {
  reverse: boolean;

  patterns: RegExp[];

  constructor(patterns: string | string[] = [], { reverse = false }: URLPatternFilterOptions = {}) {
    super();
    this.reverse = reverse;
    const list = Array.isArray(patterns) ? patterns : [patterns];
    this.patterns = list.map(URLPatternFilter.compile);
  }

  static compile(pattern: string): RegExp {
    if (pattern.startsWith('^') || pattern.endsWith('$') || pattern.includes('\\d')) {
      return new RegExp(pattern);
    }
    return picomatch.makeRe(pattern, { contains: true });
  }

  override apply(url: string): boolean {
    const matched = this.patterns.some((re) => re.test(url));
    return this.reverse ? !matched : matched;
  }
}

export interface DomainFilterOptions {
  allowed?: string[] | null;
  blocked?: string[];
  blockSocialMedia?: boolean;
}

/** Allow/block by registrable domain; subdomain-aware in both directions. */
export class DomainFilter extends URLFilter {
  allowed: string[] | null;

  blocked: string[];

  blockSocialMedia: boolean;

  constructor({ allowed = null, blocked = [], blockSocialMedia = false }: DomainFilterOptions = {}) {
    super();
    this.allowed = allowed ? allowed.map((d) => d.toLowerCase()) : null;
    this.blocked = blocked.map((d) => d.toLowerCase());
    this.blockSocialMedia = blockSocialMedia;
  }

  static matches(domain: string, target: string): boolean {
    return domain === target || domain.endsWith(`.${target}`);
  }

  override apply(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    const domain = getBaseDomain(host);
    const hits = (list: string[]): boolean => list.some(
      (d) => DomainFilter.matches(domain, d) || DomainFilter.matches(host, d),
    );

    if (this.blockSocialMedia && isSocialMediaUrl(url)) return false;
    if (hits(this.blocked)) return false;
    if (!this.allowed) return true;
    return hits(this.allowed);
  }
}

/** Extensions that are never worth fetching as pages. */
const BINARY_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tiff',
  'mp4', 'webm', 'avi', 'mov', 'mkv', 'mp3', 'wav', 'ogg', 'flac', 'm4a',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'exe', 'dmg', 'iso', 'deb', 'rpm',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'css', 'js', 'map',
]);

export interface ContentTypeFilterOptions {
  allowed?: string[] | null;
  blockBinary?: boolean;
}

/**
 * Filter by file extension.
 *
 * Extensionless URLs always pass, matching upstream. Unlike upstream, the
 * extension is read from the parsed pathname, so a query string cannot corrupt
 * it (upstream reads "html?x=1" from "/a.html?x=1" and then fails to match it).
 */
export class ContentTypeFilter extends URLFilter {
  allowed: string[] | null;

  blockBinary: boolean;

  constructor({ allowed = null, blockBinary = true }: ContentTypeFilterOptions = {}) {
    super();
    this.allowed = allowed ? allowed.map((e) => e.replace(/^\./, '').toLowerCase()) : null;
    this.blockBinary = blockBinary;
  }

  static extension(url: string): string {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return '';
    }
    const last = path.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
  }

  override apply(url: string): boolean {
    const ext = ContentTypeFilter.extension(url);
    if (!ext) return true;
    if (this.blockBinary && BINARY_EXTENSIONS.has(ext)) return false;
    if (!this.allowed) return true;
    return this.allowed.includes(ext);
  }
}

export interface PathDepthFilterOptions {
  maxDepth?: number;
}

/** Cap how deep a URL's path may go. */
export class PathDepthFilter extends URLFilter {
  maxDepth: number;

  constructor({ maxDepth = Infinity }: PathDepthFilterOptions = {}) {
    super();
    this.maxDepth = maxDepth;
  }

  override apply(url: string): boolean {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).length <= this.maxDepth;
    } catch {
      return false;
    }
  }
}

/**
 * Conjunction of filters, short-circuiting on the first rejection.
 *
 * Synchronous by design: upstream is async only to accommodate its
 * network-fetching filters, which are not ported.
 */
export class FilterChain {
  filters: URLFilter[];

  constructor(filters: URLFilter[] = []) { this.filters = filters; }

  add(filter: URLFilter): this { this.filters.push(filter); return this; }

  apply(url: string): boolean { return this.filters.every((f) => f.apply(url)); }
}

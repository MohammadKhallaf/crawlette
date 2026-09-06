/**
 * DOM cleaning, link extraction and media extraction.
 *
 * Port of crawl4ai's LXMLWebScrapingStrategy._scrap
 * (crawl4ai/content_scraping_strategy.py:615). Operates on a live Document, so
 * the lxml-specific `.tail` juggling upstream needs is unnecessary here --
 * removing a DOM element already leaves sibling text nodes intact.
 */

import {
  normalizeUrl, getBaseDomain, isExternalUrl, isSocialMediaUrl, SOCIAL_MEDIA_DOMAINS,
} from './normalize.ts';

/** Attributes crawl4ai keeps when stripping the rest (config.py:51). */
const IMPORTANT_ATTRS = new Set([
  'src', 'href', 'alt', 'title', 'width', 'height', 'class', 'id', 'rowspan', 'colspan',
]);

/** Always removed, regardless of config (content_scraping_strategy.py:793-815). */
const ALWAYS_STRIP = ['script', 'style', 'link', 'meta', 'noscript'];

/** Inline tags reduced to spans when `onlyText` is set (config.py:52). */
const ONLY_TEXT_ELIGIBLE = new Set([
  'b', 'i', 'u', 'span', 'del', 'ins', 'sub', 'sup', 'strong', 'em', 'code',
  'kbd', 'var', 's', 'q', 'abbr', 'cite', 'dfn', 'time', 'small', 'mark',
]);

/** Substrings that disqualify an image outright (content_scraping_strategy.py:410). */
const IMAGE_NOISE = ['button', 'icon', 'logo'];

const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];

/** IMAGE_SCORE_THRESHOLD (config.py:95); an image must score strictly above it. */
export const IMAGE_SCORE_THRESHOLD = 2;

export interface Link {
  href: string;
  text: string;
  title: string;
  baseDomain: string;
}

export interface ImageMedia {
  src: string;
  alt: string;
  desc: string;
  score: number;
  type: 'image';
  groupId: number;
  format: string | null;
  width: number | null;
}

export interface AvMedia {
  alt: string;
  type: string;
  desc: string;
  src: string;
}

export interface Table {
  headers: string[];
  rows: string[][];
  caption: string;
}

export interface Metadata {
  title: string;
  description: string;
  keywords: string;
  author: string;
  canonical: string;
  robots: string;
}

export interface ScrapeOptions {
  excludedTags?: string[];
  excludedSelector?: string;
  cssSelector?: string | null;
  targetElements?: string[];
  onlyText?: boolean;
  removeForms?: boolean;
  excludeExternalLinks?: boolean;
  excludeSocialMediaLinks?: boolean;
  excludeExternalImages?: boolean;
  excludeAllImages?: boolean;
  excludeDomains?: string[];
  keepDataAttributes?: boolean;
  imageScoreThreshold?: number;
  imageDescriptionMinWordThreshold?: number;
}

export interface ScrapeResult {
  cleanedHtml: string;
  links: { internal: Link[]; external: Link[] };
  media: { images: ImageMedia[]; videos: AvMedia[]; audios: AvMedia[] };
  tables: Table[];
  metadata: Metadata;
}

interface SrcsetEntry {
  url: string;
  width: number | null;
}

/** Parse a `srcset` value into {url, width} entries (content_scraping_strategy.py:42). */
function parseSrcset(value: string | null): SrcsetEntry[] {
  if (!value) return [];
  const out: SrcsetEntry[] = [];
  for (const part of value.split(',')) {
    const tokens = part.trim().split(/\s+/);
    const url = tokens[0];
    if (!url) continue;
    const w = tokens[1] ? parseInt(tokens[1].replace(/w$/, ''), 10) : null;
    out.push({ url, width: w !== null && Number.isFinite(w) ? w : null });
  }
  return out;
}

/**
 * Nearest ancestor carrying at least `minWords` words of text.
 * Mirrors find_closest_parent_with_useful_text (content_scraping_strategy.py:380).
 */
function closestUsefulText(el: Element, minWords = 1): string {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const text = (p.textContent || '').trim();
    if (text && text.split(/\s+/).length >= minWords) return text;
  }
  return '';
}

/**
 * Score an image on crawl4ai's 7-point scale. Points for: width > 150,
 * height > 150, non-empty alt, appearing in the first half of the page's
 * images, a known raster format, a srcset, and a <picture> ancestor.
 */
function scoreImage(img: Element, index: number, total: number): { score: number; format: string | null } {
  let score = 0;
  const w = parseInt(img.getAttribute('width') || '', 10);
  const h = parseInt(img.getAttribute('height') || '', 10);
  if (Number.isFinite(w) && w > 150) score += 1;
  if (Number.isFinite(h) && h > 150) score += 1;
  if ((img.getAttribute('alt') || '').trim()) score += 1;
  if (total > 0 && index / total < 0.5) score += 1;

  const candidate = img.getAttribute('src') || img.getAttribute('data-src')
    || img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
  const lower = candidate.toLowerCase();
  const format = IMAGE_FORMATS.find((f) => lower.includes(f)) || null;
  if (format) score += 1;

  if (img.getAttribute('srcset') || img.getAttribute('data-srcset')) score += 1;
  if (img.closest('picture')) score += 1;

  return { score, format };
}

/** True if the image is decorative chrome rather than content. */
function isNoiseImage(img: Element): boolean {
  if ((img.getAttribute('style') || '').replace(/\s/g, '').includes('display:none')) return true;

  const parentTag = img.parentElement?.tagName.toLowerCase();
  if (parentTag === 'button' || parentTag === 'input') return true;

  for (let p = img.parentElement; p; p = p.parentElement) {
    const cls = (p.getAttribute('class') || '').toLowerCase();
    if (IMAGE_NOISE.some((n) => cls.includes(n))) return true;
  }

  const haystack = `${img.getAttribute('src') || ''} ${img.getAttribute('alt') || ''}`.toLowerCase();
  return IMAGE_NOISE.some((n) => haystack.includes(n));
}

/** Collect every distinct URL an <img> offers: src, data-src, srcsets, <source>. */
function imageUrlVariants(img: Element): SrcsetEntry[] {
  const out: SrcsetEntry[] = [];
  const push = (url: string | null, width: number | null = null) => {
    if (!url || url.startsWith('data:')) return;
    if (!out.some((v) => v.url === url)) out.push({ url, width });
  };

  push(img.getAttribute('src'));
  push(img.getAttribute('data-src'));
  for (const attr of ['srcset', 'data-srcset']) {
    for (const v of parseSrcset(img.getAttribute(attr))) push(v.url, v.width);
  }
  const picture = img.closest('picture');
  if (picture) {
    for (const source of picture.querySelectorAll('source[srcset]')) {
      for (const v of parseSrcset(source.getAttribute('srcset'))) push(v.url, v.width);
    }
  }
  for (const { name, value } of Array.from(img.attributes)) {
    if (/src/i.test(name) && value.includes('http')) push(value);
  }
  return out;
}

/** Extract <title>, meta description/keywords and canonical from the document head. */
function extractMetadata(doc: Document): Metadata {
  const meta = (sel: string, attr = 'content'): string => doc.querySelector(sel)?.getAttribute(attr)?.trim() || '';
  return {
    title: doc.querySelector('title')?.textContent?.trim() || '',
    description: meta('meta[name="description" i]') || meta('meta[property="og:description" i]'),
    keywords: meta('meta[name="keywords" i]'),
    author: meta('meta[name="author" i]'),
    canonical: meta('link[rel="canonical" i]', 'href'),
    robots: meta('meta[name="robots" i]'),
  };
}

/** Remove elements with no text and no meaningful children (remove_empty_elements_fast). */
const EMPTY_BYPASS = new Set(['a', 'img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'track', 'wbr', 'tr', 'td', 'th']);

function removeEmptyElements(root: Element): void {
  // Walk deepest-first so emptying a child can cascade to its parent.
  for (const el of [...root.querySelectorAll('*')].reverse()) {
    const tag = el.tagName.toLowerCase();
    if (EMPTY_BYPASS.has(tag)) continue;
    if (el.closest('pre, code')) continue;
    if (el.children.length > 0) continue;
    if ((el.textContent || '').trim().length > 0) continue;
    el.remove();
  }
}

/** Strip every attribute except IMPORTANT_ATTRS (and data-* when requested). */
function stripAttributes(root: Element, keepDataAttributes: boolean): void {
  for (const el of root.querySelectorAll('*')) {
    for (const { name } of Array.from(el.attributes)) {
      if (IMPORTANT_ATTRS.has(name)) continue;
      if (keepDataAttributes && name.startsWith('data-')) continue;
      el.removeAttribute(name);
    }
  }
}

/**
 * Clean a document and pull out links, media and metadata.
 *
 * @param doc  parsed document; MUTATED in place, pass a clone to keep the original
 * @param url  the page's own URL, used to resolve relative links
 */
export function scrape(doc: Document, url: string, options: ScrapeOptions = {}): ScrapeResult {
  const {
    excludedTags = [],
    excludedSelector = '',
    cssSelector = null,
    targetElements = [],
    onlyText = false,
    removeForms = false,
    excludeExternalLinks = false,
    excludeSocialMediaLinks = false,
    excludeExternalImages = false,
    excludeAllImages = false,
    excludeDomains = [],
    keepDataAttributes = false,
    imageScoreThreshold = IMAGE_SCORE_THRESHOLD,
    imageDescriptionMinWordThreshold = 1,
  } = options;

  // <base href> overrides the page URL for link resolution.
  const baseHref = doc.querySelector('head base[href]')?.getAttribute('href');
  const resolveBase = baseHref ? (normalizeUrl(baseHref, url) || url) : url;
  const baseDomain = getBaseDomain(resolveBase);

  const metadata = extractMetadata(doc); // captured before any pruning

  const blockedDomains = new Set([
    ...excludeDomains,
    ...(excludeSocialMediaLinks ? SOCIAL_MEDIA_DOMAINS : []),
  ]);

  const root: Element = doc.body || doc.documentElement;

  if (excludeAllImages) root.querySelectorAll('img').forEach((el) => el.remove());
  for (const tag of excludedTags) root.querySelectorAll(tag).forEach((el) => el.remove());
  if (excludedSelector) {
    try {
      root.querySelectorAll(excludedSelector).forEach((el) => el.remove());
    } catch { /* invalid selector: ignore, matching crawl4ai's tolerance */ }
  }
  if (removeForms) root.querySelectorAll('form').forEach((el) => el.remove());
  for (const tag of ALWAYS_STRIP) root.querySelectorAll(tag).forEach((el) => el.remove());

  // --- links -------------------------------------------------------------
  const internal = new Map<string, Link>();
  const external = new Map<string, Link>();

  for (const a of root.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href');
    if (!raw || !raw.trim()) continue;

    const href = normalizeUrl(raw, resolveBase);
    if (!href) continue;

    const record: Link = {
      href,
      text: (a.textContent || '').trim(),
      title: (a.getAttribute('title') || '').trim(),
      baseDomain: getBaseDomain(href),
    };

    const external_ = isExternalUrl(href, baseDomain);
    if (external_) {
      const blocked = excludeExternalLinks
        || blockedDomains.has(record.baseDomain)
        || (excludeSocialMediaLinks && isSocialMediaUrl(href));
      if (blocked) {
        a.remove(); // crawl4ai drops the anchor from the output entirely
        continue;
      }
      if (!external.has(href)) external.set(href, record);
    } else if (!internal.has(href)) {
      internal.set(href, record);
    }
  }

  // --- media -------------------------------------------------------------
  const images: ImageMedia[] = [];
  const allImages = [...root.querySelectorAll('img')];

  allImages.forEach((img, index) => {
    const src = img.getAttribute('src') || '';
    const absolute = src ? normalizeUrl(src, resolveBase) : null;

    if (absolute && (blockedDomains.has(getBaseDomain(absolute))
      || (excludeExternalImages && isExternalUrl(absolute, baseDomain)))) {
      img.remove();
      return;
    }
    if (isNoiseImage(img)) return;

    const { score, format } = scoreImage(img, index, allImages.length);
    if (score <= imageScoreThreshold) return;

    const desc = closestUsefulText(img, imageDescriptionMinWordThreshold);
    for (const variant of imageUrlVariants(img)) {
      const resolved = normalizeUrl(variant.url, resolveBase);
      if (!resolved) continue;
      images.push({
        src: resolved,
        alt: (img.getAttribute('alt') || '').trim(),
        desc,
        score,
        type: 'image',
        groupId: index,
        format,
        width: variant.width,
      });
    }
  });

  const collectAV = (tag: string): AvMedia[] => {
    const out: AvMedia[] = [];
    for (const el of root.querySelectorAll(tag)) {
      const desc = closestUsefulText(el, imageDescriptionMinWordThreshold);
      const base = { alt: el.getAttribute('alt') || '', type: tag, desc };
      const src = el.getAttribute('src');
      if (src) out.push({ ...base, src: normalizeUrl(src, resolveBase) || src });
      for (const source of el.querySelectorAll('source[src]')) {
        const s = source.getAttribute('src');
        out.push({ ...base, src: (s && normalizeUrl(s, resolveBase)) || s || '' });
      }
    }
    return out;
  };

  const videos = collectAV('video');
  const audios = collectAV('audio');

  // --- tables ------------------------------------------------------------
  const tables = excludedTags.includes('table') ? [] : extractTables(root);

  // --- final shaping -----------------------------------------------------
  let contentEl: Element = root;
  if (cssSelector) {
    const matches = [...root.querySelectorAll(cssSelector)];
    if (matches.length) {
      const wrapper = doc.createElement('div');
      matches.forEach((m) => wrapper.appendChild(m.cloneNode(true)));
      contentEl = wrapper;
    }
  }
  if (targetElements.length) {
    const matches = targetElements.flatMap((sel) => [...contentEl.querySelectorAll(sel)]);
    if (matches.length) {
      const wrapper = doc.createElement('div');
      matches.forEach((m) => wrapper.appendChild(m.cloneNode(true)));
      contentEl = wrapper;
    }
  }

  if (onlyText) {
    for (const el of [...contentEl.querySelectorAll('*')]) {
      if (!ONLY_TEXT_ELIGIBLE.has(el.tagName.toLowerCase())) continue;
      el.replaceWith(doc.createTextNode(el.textContent || ''));
    }
  }

  for (const img of contentEl.querySelectorAll('img[src^="data:image/"]')) {
    img.removeAttribute('src');
  }

  removeEmptyElements(contentEl);
  stripAttributes(contentEl, keepDataAttributes);

  return {
    cleanedHtml: (contentEl as HTMLElement).innerHTML.trim(),
    links: { internal: [...internal.values()], external: [...external.values()] },
    media: { images, videos, audios },
    tables,
    metadata,
  };
}

/** Extract tables as {headers, rows, caption}. */
function extractTables(root: Element): Table[] {
  const out: Table[] = [];
  for (const table of root.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tr')];
    const firstRow = rows[0];
    if (!firstRow) continue;

    let headers = [...firstRow.querySelectorAll('th')].map((c) => (c.textContent || '').trim());
    const bodyStart = headers.length ? 1 : 0;
    if (!headers.length) {
      headers = [...firstRow.querySelectorAll('td')].map((c) => (c.textContent || '').trim());
    }

    const body = rows.slice(bodyStart).map(
      (r) => [...r.querySelectorAll('td, th')].map((c) => (c.textContent || '').trim()),
    ).filter((r) => r.length);

    out.push({
      headers,
      rows: body,
      caption: (table.querySelector('caption')?.textContent || '').trim(),
    });
  }
  return out;
}

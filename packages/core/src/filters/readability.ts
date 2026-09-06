/**
 * Main-content extraction via Mozilla's Readability -- the default content
 * filter, and the algorithm behind Firefox Reader Mode.
 *
 * Chosen over a faithful port of crawl4ai's PruningContentFilter because that
 * filter's scoring is dominated by an unbounded length term and carries a
 * provably dead class/id term (see ./pruning.ts). Readability is
 * battle-tested across the web and yields materially cleaner article text.
 *
 * Uses the real, Mozilla-maintained `@mozilla/readability` package rather
 * than a hand-vendored copy.
 */

import { Readability } from '@mozilla/readability';

export interface Article {
  html: string;
  title: string;
  byline: string;
  excerpt: string;
  length: number;
}

export interface ReadabilityOptions {
  charThreshold?: number;
}

/**
 * Extract the readable article from a document.
 *
 * Readability MUTATES the document it is given, so callers must pass a clone
 * if they still need the original (see `readabilityFilter`).
 */
export function extractArticle(doc: Document, { charThreshold = 500 }: ReadabilityOptions = {}): Article | null {
  try {
    const article = new Readability(doc, {
      charThreshold,
      keepClasses: false,
    }).parse();
    if (!article || !article.content) return null;
    return {
      html: article.content,
      title: article.title || '',
      byline: article.byline || '',
      excerpt: article.excerpt || '',
      length: article.length || 0,
    };
  } catch {
    return null; // Readability throws on some malformed documents
  }
}

/**
 * Content-filter interface: document -> filtered HTML string.
 * Returns '' when no article is found, letting the caller fall back to the
 * cleaned HTML rather than emitting a broken fit_markdown.
 */
export function readabilityFilter(doc: Document, options: ReadabilityOptions = {}): string {
  const clone = doc.cloneNode(true) as Document;
  const article = extractArticle(clone, options);
  return article ? article.html : '';
}

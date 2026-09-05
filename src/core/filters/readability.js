/**
 * Main-content extraction via Mozilla's Readability -- the default content
 * filter, and the algorithm behind Firefox Reader Mode.
 *
 * Chosen over a faithful port of crawl4ai's PruningContentFilter because that
 * filter's scoring is dominated by an unbounded length term and carries a
 * provably dead class/id term (see ../filters/pruning.js). Readability is
 * battle-tested across the web and yields materially cleaner article text.
 */

import { Readability } from '../../vendor/Readability.js';

/**
 * Extract the readable article from a document.
 *
 * Readability MUTATES the document it is given, so callers must pass a clone
 * if they still need the original (see `readabilityFilter`).
 *
 * @returns {{html: string, title: string, byline: string, excerpt: string, length: number}|null}
 */
export function extractArticle(doc, { charThreshold = 500 } = {}) {
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
export function readabilityFilter(doc, options = {}) {
  const clone = doc.cloneNode(true);
  const article = extractArticle(clone, options);
  return article ? article.html : '';
}

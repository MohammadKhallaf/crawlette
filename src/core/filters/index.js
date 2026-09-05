/**
 * Content-filter registry.
 *
 * Every filter takes (document, options) and returns an HTML string -- the
 * "fit html" that becomes fit_markdown. An empty string means "no opinion",
 * and the caller falls back to the full cleaned HTML.
 */

import { readabilityFilter } from './readability.js';
import { pruningFilter } from './pruning.js';
import { bm25Filter } from './bm25.js';

export const FILTERS = {
  /** Mozilla Readability: best general-purpose article extraction. */
  readability: readabilityFilter,
  /** Faithful crawl4ai PruningContentFilter, defects included, for comparison. */
  'pruning-legacy': pruningFilter,
  /** BM25 relevance against a query; best for focused crawls. */
  bm25: bm25Filter,
  /** Explicit opt-out. */
  none: () => '',
};

export const DEFAULT_FILTER = 'readability';

/**
 * Apply a named filter to a document.
 *
 * The document is cloned first: Readability mutates what it is given, and
 * pruning removes nodes in place, so callers keep their original intact.
 *
 * @returns {string} filtered HTML, or '' if the filter had no opinion.
 */
export function applyFilter(doc, name = DEFAULT_FILTER, options = {}) {
  const filter = FILTERS[name];
  if (!filter) throw new Error(`Unknown content filter: ${name}`);
  try {
    return filter(doc.cloneNode(true), options) || '';
  } catch {
    return ''; // a filter failure must never abort the crawl
  }
}

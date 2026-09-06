/**
 * Content-filter registry.
 *
 * Every filter takes (document, options) and returns an HTML string -- the
 * "fit html" that becomes fit_markdown. An empty string means "no opinion",
 * and the caller falls back to the full cleaned HTML.
 */

import { readabilityFilter, type ReadabilityOptions } from './readability.ts';
import { pruningFilter, type PruningFilterOptions } from './pruning.ts';
import { bm25Filter, type Bm25FilterOptions } from './bm25.ts';

export type ContentFilterName = 'readability' | 'pruning-legacy' | 'bm25' | 'none';

/** Union of every filter's own options; each filter reads only what it needs. */
export type ContentFilterOptions = ReadabilityOptions & PruningFilterOptions & Bm25FilterOptions;

export type ContentFilter = (doc: Document, options: ContentFilterOptions) => string;

export const FILTERS: Record<ContentFilterName, ContentFilter> = {
  /** Mozilla Readability: best general-purpose article extraction. */
  readability: readabilityFilter,
  /** Faithful crawl4ai PruningContentFilter, defects included, for comparison. */
  'pruning-legacy': pruningFilter,
  /** BM25 relevance against a query; best for focused crawls. */
  bm25: bm25Filter,
  /** Explicit opt-out. */
  none: () => '',
};

export const DEFAULT_FILTER: ContentFilterName = 'readability';

/**
 * Apply a named filter to a document.
 *
 * The document is cloned first: Readability mutates what it is given, and
 * pruning removes nodes in place, so callers keep their original intact.
 *
 * @returns filtered HTML, or '' if the filter had no opinion.
 */
export function applyFilter(
  doc: Document,
  name: ContentFilterName = DEFAULT_FILTER,
  options: ContentFilterOptions = {},
): string {
  const filter = FILTERS[name];
  if (!filter) throw new Error(`Unknown content filter: ${name}`);
  try {
    return filter(doc.cloneNode(true) as Document, options) || '';
  } catch {
    return ''; // a filter failure must never abort the crawl
  }
}

/**
 * BM25 query-relevance content filter.
 *
 * Port of crawl4ai's BM25ContentFilter (crawl4ai/content_filter_strategy.py:381)
 * with one deliberate correction, documented at `idf` below.
 *
 * Kept hand-rolled rather than pulled from an npm search-engine package: this
 * is ~30 lines of standard Okapi BM25 scoring a handful of DOM chunks per
 * page, not building a search index, and it carries a documented correctness
 * fix over crawl4ai's own formula that a generic library would not replicate.
 */

/** Common English stopwords; dropped before scoring. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will',
  'with', 'from', 'has', 'have', 'had', 'we', 'you', 'your', 'our', 'can',
]);

/** Per-tag multipliers applied to the BM25 score (content_filter_strategy.py). */
const PRIORITY_TAGS: Record<string, number> = {
  h1: 5.0, h2: 4.0, h3: 3.0, title: 4.0, strong: 2.0, b: 1.5,
  em: 1.5, blockquote: 2.0, code: 2.0, pre: 1.5, th: 1.5,
};

/** Block-level tags treated as chunk boundaries. */
const BLOCK_TAGS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, dd, dt, figcaption, section, article';

const tokenize = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) || [];
const cleanTokens = (tokens: string[]): string[] => tokens.filter((t) => t.length > 1 && !STOPWORDS.has(t));

/**
 * Inverse document frequency.
 *
 * DIVERGENCE FROM crawl4ai (deliberate bug fix): upstream computes
 * `log((1+1)/(tf+0.5) + 1)` using *term frequency within one document*, so its
 * "IDF" falls as a term appears more often and does not consider the corpus at
 * all -- the opposite of what IDF means. This uses the standard Okapi BM25
 * formulation over document frequency across the chunk corpus.
 */
function idf(docFreq: number, totalDocs: number): number {
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
}

interface Chunk {
  element: Element;
  text: string;
  tag: string;
}

/** Split a document into scoreable text chunks, one per block element. */
function extractChunks(doc: Document): Chunk[] {
  const body: Element = doc.body || doc.documentElement;
  const chunks: Chunk[] = [];

  for (const el of body.querySelectorAll(BLOCK_TAGS)) {
    // Skip containers whose text belongs to a nested block we'll visit anyway.
    if (el.querySelector(BLOCK_TAGS)) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    chunks.push({ element: el, text, tag: el.tagName.toLowerCase() });
  }
  return chunks;
}

/**
 * Derive a query from page metadata when the user supplies none
 * (content_filter_strategy.py:125).
 */
export function derivePageQuery(doc: Document): string {
  const parts: string[] = [];
  const title = doc.querySelector('title')?.textContent?.trim();
  const h1 = doc.querySelector('h1')?.textContent?.trim();
  const keywords = doc.querySelector('meta[name="keywords" i]')?.getAttribute('content')?.trim();
  const description = doc.querySelector('meta[name="description" i]')?.getAttribute('content')?.trim();

  if (title) parts.push(title);
  if (h1) parts.push(h1);
  if (keywords) parts.push(keywords);
  if (description) parts.push(description);

  if (!keywords && !description) {
    for (const p of doc.querySelectorAll('p')) {
      const text = (p.textContent || '').trim();
      if (text.length > 150) { parts.push(text.slice(0, 150)); break; }
    }
  }
  return parts.join(' ');
}

export interface Bm25FilterOptions {
  query?: string | null;
  threshold?: number;
  k1?: number;
  b?: number;
}

/**
 * Keep only the chunks relevant to `query`.
 *
 * @returns HTML of the surviving chunks, in document order.
 */
export function bm25Filter(doc: Document, options: Bm25FilterOptions = {}): string {
  const {
    query = null, threshold = 1.0, k1 = 1.2, b = 0.75,
  } = options;

  const effectiveQuery = query || derivePageQuery(doc);
  const queryTerms = [...new Set(cleanTokens(tokenize(effectiveQuery)))];
  if (!queryTerms.length) return '';

  const chunks = extractChunks(doc);
  if (!chunks.length) return '';

  const tokenized = chunks.map((c) => cleanTokens(tokenize(c.text)));
  const avgLen = tokenized.reduce((sum, t) => sum + t.length, 0) / tokenized.length || 1;

  const docFreq = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }

  const kept: Element[] = [];
  chunks.forEach((chunk, i) => {
    const tokens = tokenized[i]!;
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) || 0;
      if (!tf) continue;
      const weight = idf(docFreq.get(term) || 0, chunks.length);
      score += weight * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (tokens.length / avgLen))));
    }

    score *= PRIORITY_TAGS[chunk.tag] ?? 1.0;
    if (score >= threshold) kept.push(chunk.element);
  });

  return kept.map((el) => (el as HTMLElement).outerHTML).join('\n');
}

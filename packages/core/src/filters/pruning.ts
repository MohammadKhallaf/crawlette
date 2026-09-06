/**
 * PruningContentFilter -- faithful port of crawl4ai's heuristic filter
 * (crawl4ai/content_filter_strategy.py:541).
 *
 * Ported with its exact constants so its output can be compared against
 * upstream, and offered in the UI as "pruning-legacy". It is NOT the default:
 * two defects in the original scoring are reproduced here deliberately and
 * documented at `compositeScore`, and Readability generally extracts main
 * content better. Keep this faithful -- if you "fix" the formula, it stops
 * being a reference implementation.
 */

/** Removed outright before scoring (content_filter_strategy.py:101). */
const EXCLUDED_TAGS = ['nav', 'footer', 'header', 'aside', 'script', 'style', 'form', 'iframe', 'noscript'];

/** Per-tag multipliers used by the composite score (content_filter_strategy.py:623). */
const TAG_WEIGHTS: Record<string, number> = {
  div: 0.5, p: 1.0, article: 1.5, section: 1.0, span: 0.3, li: 0.5,
  ul: 0.5, ol: 0.5, h1: 1.2, h2: 1.1, h3: 1.0, h4: 0.9, h5: 0.8, h6: 0.7,
};
const DEFAULT_TAG_WEIGHT = 0.5;

/** Used only by the dynamic threshold (content_filter_strategy.py:593). */
const TAG_IMPORTANCE: Record<string, number> = {
  article: 1.5, main: 1.4, section: 1.3, p: 1.2, h1: 1.4, h2: 1.3, h3: 1.2, div: 0.7, span: 0.6,
};
const DEFAULT_TAG_IMPORTANCE = 0.7;

/** Metric weights, summing to 1.0 (content_filter_strategy.py:615). */
const METRIC_WEIGHTS = {
  textDensity: 0.4, linkDensity: 0.2, tagWeight: 0.2, classIdWeight: 0.1, textLength: 0.1,
};

interface ScoringOptions {
  minWordThreshold?: number | null;
}

interface ThresholdOptions {
  threshold: number;
  thresholdType: 'fixed' | 'dynamic';
}

/**
 * Composite node score.
 *
 * Two upstream defects are reproduced intentionally:
 *
 * 1. `textLength` is `0.1 * ln(len + 1)` and therefore UNBOUNDED, while every
 *    other term is <= 1. Against the real 0.48 threshold a 2000-char paragraph
 *    scores ~1.49 and even a 5-char span scores ~0.54, so length dominates and
 *    almost everything with text survives.
 * 2. `classIdWeight` is always 0. Upstream matches its negative-class pattern
 *    with an anchored `.match()` (so `class="page-nav"` never matches) and then
 *    clamps the only possible value (-0.5) with `max(0, ...)`.
 *
 * `linkTextLen` likewise counts only direct-child anchors, matching upstream's
 * use of BeautifulSoup's `.string`, which is null for anchors with nested markup.
 */
function compositeScore(el: Element, { minWordThreshold }: ScoringOptions): number {
  const text = (el.textContent || '').trim();
  const textLen = text.length;

  if (minWordThreshold) {
    const words = text ? text.split(/\s+/).length : 0;
    if (words < minWordThreshold) return -1.0; // guaranteed removal
  }

  const tagLen = ((el as HTMLElement).innerHTML || '').length;

  let linkTextLen = 0;
  for (const child of el.children) {
    if (child.tagName !== 'A') continue;
    const only = child.children.length === 0 ? (child.textContent || '').trim() : '';
    linkTextLen += only.length;
  }

  const textDensity = tagLen > 0 ? textLen / tagLen : 0;
  const linkDensity = 1 - (textLen > 0 ? linkTextLen / textLen : 0);
  const tagWeight = TAG_WEIGHTS[el.tagName.toLowerCase()] ?? DEFAULT_TAG_WEIGHT;
  const classIdWeight = 0; // see defect 2 above
  const textLength = Math.log(textLen + 1);

  const score = METRIC_WEIGHTS.textDensity * textDensity
    + METRIC_WEIGHTS.linkDensity * linkDensity
    + METRIC_WEIGHTS.tagWeight * tagWeight
    + METRIC_WEIGHTS.classIdWeight * classIdWeight
    + METRIC_WEIGHTS.textLength * textLength;

  // total_weight is 1.0 with all five metrics enabled, so this is a no-op
  // division kept for fidelity with upstream.
  const totalWeight = Object.values(METRIC_WEIGHTS).reduce((a, b) => a + b, 0);
  return totalWeight > 0 ? score / totalWeight : 0;
}

/** Effective threshold for a node (content_filter_strategy.py:733). */
function thresholdFor(el: Element, { threshold, thresholdType }: ThresholdOptions): number {
  if (thresholdType === 'fixed') return threshold;

  const text = (el.textContent || '').trim();
  const textLen = text.length;
  const tagLen = ((el as HTMLElement).innerHTML || '').length;

  let linkTextLen = 0;
  for (const child of el.children) {
    if (child.tagName === 'A' && child.children.length === 0) {
      linkTextLen += (child.textContent || '').trim().length;
    }
  }

  const importance = TAG_IMPORTANCE[el.tagName.toLowerCase()] ?? DEFAULT_TAG_IMPORTANCE;
  const textRatio = tagLen > 0 ? textLen / tagLen : 0;
  const linkRatio = textLen > 0 ? linkTextLen / textLen : 1;

  let t = threshold;
  if (importance > 1) t *= 0.8;
  if (textRatio > 0.4) t *= 0.9;
  if (linkRatio > 0.6) t *= 1.2;
  return t;
}

interface PruneOptions extends ScoringOptions, ThresholdOptions {
  preserveTags: string[];
  preserveClasses: string[];
}

/**
 * Top-down prune: a node that passes is kept, but its children are still
 * scored individually and may be dropped (content_filter_strategy.py:745).
 */
function pruneTree(el: Element, opts: PruneOptions): void {
  const children = [...el.children];
  for (const child of children) {
    if (isPreserved(child, opts)) continue;
    const score = compositeScore(child, opts);
    if (score < thresholdFor(child, opts)) {
      child.remove();
    } else {
      pruneTree(child, opts);
    }
  }
}

function isPreserved(el: Element, { preserveTags, preserveClasses }: PruneOptions): boolean {
  if (preserveTags.includes(el.tagName.toLowerCase())) return true;
  const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  return classes.some((c) => preserveClasses.includes(c));
}

export interface PruningFilterOptions {
  threshold?: number;
  thresholdType?: 'fixed' | 'dynamic';
  minWordThreshold?: number | null;
  preserveTags?: string[];
  preserveClasses?: string[];
}

/**
 * Filter a document down to its high-scoring blocks.
 *
 * @returns HTML of the surviving top-level blocks, joined.
 */
export function pruningFilter(doc: Document, options: PruningFilterOptions = {}): string {
  const {
    threshold = 0.48,
    thresholdType = 'fixed',   // 'fixed' | 'dynamic'
    minWordThreshold = null,
    preserveTags = [],
    preserveClasses = [],
  } = options;

  const opts: PruneOptions = {
    threshold, thresholdType, minWordThreshold, preserveTags, preserveClasses,
  };
  const body: Element = doc.body || doc.documentElement;

  for (const tag of EXCLUDED_TAGS) body.querySelectorAll(tag).forEach((el) => el.remove());
  pruneTree(body, opts);

  return [...body.children]
    .filter((el) => (el.textContent || '').trim().length > 0)
    .map((el) => (el as HTMLElement).outerHTML)
    .join('\n');
}

export const _internals = {
  compositeScore, thresholdFor, TAG_WEIGHTS, METRIC_WEIGHTS,
};

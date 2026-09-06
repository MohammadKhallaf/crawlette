/**
 * URL scorers for best-first crawling.
 *
 * Port of crawl4ai/deep_crawling/scorers.py. Every scorer is a pure function of
 * the URL string -- no page content, no network -- so scoring is cheap and can
 * run synchronously at enqueue time.
 */

/** Base: applies the scorer's weight exactly once. */
export class URLScorer {
  weight: number;

  constructor(weight = 1.0) { this.weight = weight; }

  score(url: string): number { return this._calculate(url) * this.weight; }

  // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars
  protected _calculate(_url: string): number { return 0; }
}

export interface KeywordRelevanceScorerOptions {
  weight?: number;
  caseSensitive?: boolean;
}

/** Fraction of keywords present in the URL (scorers.py:160). */
export class KeywordRelevanceScorer extends URLScorer {
  caseSensitive: boolean;

  keywords: string[];

  constructor(keywords: string[] = [], { weight = 1.0, caseSensitive = false }: KeywordRelevanceScorerOptions = {}) {
    super(weight);
    this.caseSensitive = caseSensitive;
    this.keywords = keywords.map((k) => (caseSensitive ? k : k.toLowerCase()));
  }

  protected override _calculate(url: string): number {
    if (!this.keywords.length) return 0;
    const haystack = this.caseSensitive ? url : url.toLowerCase();
    const matches = this.keywords.filter((k) => haystack.includes(k)).length;
    if (!matches) return 0;
    if (matches === this.keywords.length) return 1;
    return matches / this.keywords.length;
  }
}

export interface PathDepthScorerOptions {
  optimalDepth?: number;
  weight?: number;
}

/**
 * Proximity to an ideal path depth (scorers.py:190).
 * Upstream's lookup table is exactly 1/(1+distance), so that closed form is used.
 */
export class PathDepthScorer extends URLScorer {
  optimalDepth: number;

  constructor({ optimalDepth = 3, weight = 1.0 }: PathDepthScorerOptions = {}) {
    super(weight);
    this.optimalDepth = optimalDepth;
  }

  static depth(url: string): number {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return 0;
    }
    return path.split('/').filter(Boolean).length;
  }

  protected override _calculate(url: string): number {
    return 1 / (1 + Math.abs(PathDepthScorer.depth(url) - this.optimalDepth));
  }
}

export interface FreshnessScorerOptions {
  weight?: number;
  currentYear?: number;
}

/** Recency inferred from a date in the URL (scorers.py:332). */
export class FreshnessScorer extends URLScorer {
  currentYear: number;

  // Upstream hardcodes 2024; using the real year keeps scores meaningful over time.
  constructor({ weight = 1.0, currentYear = new Date().getFullYear() }: FreshnessScorerOptions = {}) {
    super(weight);
    this.currentYear = currentYear;
  }

  protected override _calculate(url: string): number {
    const matches = [...url.matchAll(/[/\-_]((?:19|20)\d{2})(?=[/\-_]|$)/g)]
      .map((m) => parseInt(m[1]!, 10))
      .filter((y) => y <= this.currentYear);

    if (!matches.length) return 0.5; // undated URLs sit mid-pack
    const diff = this.currentYear - Math.max(...matches);
    if (diff < 6) return [1.0, 0.9, 0.8, 0.7, 0.6, 0.5][diff]!;
    return Math.max(0.1, 1.0 - diff * 0.1);
  }
}

export interface ContentTypeScorerOptions {
  weight?: number;
}

/** Per-extension weights, e.g. {html: 1.0, pdf: 0.4} (scorers.py:247). */
export class ContentTypeScorer extends URLScorer {
  typeWeights: Record<string, number>;

  constructor(typeWeights: Record<string, number> = {}, { weight = 1.0 }: ContentTypeScorerOptions = {}) {
    super(weight);
    this.typeWeights = Object.fromEntries(
      Object.entries(typeWeights).map(([k, v]) => [k.replace(/^\./, '').replace(/\$$/, '').toLowerCase(), v]),
    );
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

  protected override _calculate(url: string): number {
    return this.typeWeights[ContentTypeScorer.extension(url)] ?? 0;
  }
}

export interface DomainAuthorityScorerOptions {
  defaultWeight?: number;
  weight?: number;
}

/** Fixed per-domain weights (scorers.py:414). */
export class DomainAuthorityScorer extends URLScorer {
  defaultWeight: number;

  domainWeights: Record<string, number>;

  constructor(
    domainWeights: Record<string, number> = {},
    { defaultWeight = 0.5, weight = 1.0 }: DomainAuthorityScorerOptions = {},
  ) {
    super(weight);
    this.defaultWeight = defaultWeight;
    this.domainWeights = Object.fromEntries(
      Object.entries(domainWeights).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  protected override _calculate(url: string): number {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return this.defaultWeight;
    }
    return this.domainWeights[host] ?? this.defaultWeight;
  }
}

export interface CompositeScorerOptions {
  normalize?: boolean;
}

/**
 * Mean of its children's already-weighted scores.
 *
 * Upstream divides by the scorer COUNT rather than the weight sum, so weights
 * are relative only and the result is not bounded to [0,1]. Kept as-is for
 * fidelity; pass weights summing to <= count if you want a bounded score.
 */
export class CompositeScorer extends URLScorer {
  scorers: URLScorer[];

  normalize: boolean;

  constructor(scorers: URLScorer[] = [], { normalize = true }: CompositeScorerOptions = {}) {
    super(1.0);
    this.scorers = scorers;
    this.normalize = normalize;
  }

  protected override _calculate(url: string): number {
    if (!this.scorers.length) return 0;
    const total = this.scorers.reduce((sum, s) => sum + s.score(url), 0);
    return this.normalize ? total / this.scorers.length : total;
  }
}

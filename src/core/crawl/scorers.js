/**
 * URL scorers for best-first crawling.
 *
 * Port of crawl4ai/deep_crawling/scorers.py. Every scorer is a pure function of
 * the URL string -- no page content, no network -- so scoring is cheap and can
 * run synchronously at enqueue time.
 */

/** Base: applies the scorer's weight exactly once. */
class URLScorer {
  constructor(weight = 1.0) { this.weight = weight; }
  score(url) { return this._calculate(url) * this.weight; }
  _calculate() { return 0; }
}

/** Fraction of keywords present in the URL (scorers.py:160). */
export class KeywordRelevanceScorer extends URLScorer {
  constructor(keywords = [], { weight = 1.0, caseSensitive = false } = {}) {
    super(weight);
    this.caseSensitive = caseSensitive;
    this.keywords = keywords.map((k) => (caseSensitive ? k : k.toLowerCase()));
  }

  _calculate(url) {
    if (!this.keywords.length) return 0;
    const haystack = this.caseSensitive ? url : url.toLowerCase();
    const matches = this.keywords.filter((k) => haystack.includes(k)).length;
    if (!matches) return 0;
    if (matches === this.keywords.length) return 1;
    return matches / this.keywords.length;
  }
}

/**
 * Proximity to an ideal path depth (scorers.py:190).
 * Upstream's lookup table is exactly 1/(1+distance), so that closed form is used.
 */
export class PathDepthScorer extends URLScorer {
  constructor({ optimalDepth = 3, weight = 1.0 } = {}) {
    super(weight);
    this.optimalDepth = optimalDepth;
  }

  static depth(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      return 0;
    }
    return path.split('/').filter(Boolean).length;
  }

  _calculate(url) {
    return 1 / (1 + Math.abs(PathDepthScorer.depth(url) - this.optimalDepth));
  }
}

/** Recency inferred from a date in the URL (scorers.py:332). */
export class FreshnessScorer extends URLScorer {
  // Upstream hardcodes 2024; using the real year keeps scores meaningful over time.
  constructor({ weight = 1.0, currentYear = new Date().getFullYear() } = {}) {
    super(weight);
    this.currentYear = currentYear;
  }

  _calculate(url) {
    const matches = [...url.matchAll(/[/\-_]((?:19|20)\d{2})(?=[/\-_]|$)/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((y) => y <= this.currentYear);

    if (!matches.length) return 0.5; // undated URLs sit mid-pack
    const diff = this.currentYear - Math.max(...matches);
    if (diff < 6) return [1.0, 0.9, 0.8, 0.7, 0.6, 0.5][diff];
    return Math.max(0.1, 1.0 - diff * 0.1);
  }
}

/** Per-extension weights, e.g. {html: 1.0, pdf: 0.4} (scorers.py:247). */
export class ContentTypeScorer extends URLScorer {
  constructor(typeWeights = {}, { weight = 1.0 } = {}) {
    super(weight);
    this.typeWeights = Object.fromEntries(
      Object.entries(typeWeights).map(([k, v]) => [k.replace(/^\./, '').replace(/\$$/, '').toLowerCase(), v]),
    );
  }

  static extension(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      return '';
    }
    const last = path.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
  }

  _calculate(url) {
    return this.typeWeights[ContentTypeScorer.extension(url)] ?? 0;
  }
}

/** Fixed per-domain weights (scorers.py:414). */
export class DomainAuthorityScorer extends URLScorer {
  constructor(domainWeights = {}, { defaultWeight = 0.5, weight = 1.0 } = {}) {
    super(weight);
    this.defaultWeight = defaultWeight;
    this.domainWeights = Object.fromEntries(
      Object.entries(domainWeights).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  _calculate(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return this.defaultWeight;
    }
    return this.domainWeights[host] ?? this.defaultWeight;
  }
}

/**
 * Mean of its children's already-weighted scores.
 *
 * Upstream divides by the scorer COUNT rather than the weight sum, so weights
 * are relative only and the result is not bounded to [0,1]. Kept as-is for
 * fidelity; pass weights summing to <= count if you want a bounded score.
 */
export class CompositeScorer extends URLScorer {
  constructor(scorers = [], { normalize = true } = {}) {
    super(1.0);
    this.scorers = scorers;
    this.normalize = normalize;
  }

  _calculate(url) {
    if (!this.scorers.length) return 0;
    const total = this.scorers.reduce((sum, s) => sum + s.score(url), 0);
    return this.normalize ? total / this.scorers.length : total;
  }
}

export { URLScorer };

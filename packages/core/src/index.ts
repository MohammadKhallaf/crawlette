/**
 * crawlette-core -- the browser-native crawl processing engine behind
 * Crawlette: DOM cleaning, markdown generation, content filters, structured
 * extraction and deep-crawl strategies. No server, no Python.
 *
 * This package is the portable subset: everything here is a pure function of
 * a Document/HTML string plus a fetch function you supply -- nothing here
 * calls `chrome.*`. See the Crawlette extension for the browser-specific
 * pieces (network capture, tab automation, the visual picker) that build on
 * top of this.
 */

// -- URL handling ------------------------------------------------------------
export {
  normalizeUrl, getBaseDomain, isExternalUrl, isSocialMediaUrl, SOCIAL_MEDIA_DOMAINS,
  type NormalizeUrlOptions,
} from './normalize.ts';

// -- DOM cleaning and extraction ---------------------------------------------
export {
  scrape, IMAGE_SCORE_THRESHOLD,
  type ScrapeOptions, type ScrapeResult, type Link, type ImageMedia, type AvMedia, type Table, type Metadata,
} from './scrape.ts';

export {
  extractJsonCss, validateSchema,
  type ExtractionSchema, type ExtractionField, type ExtractedItem, type ExtractedValue, type FieldType,
} from './extract/jsonCss.ts';

// -- Markdown -----------------------------------------------------------------
export {
  htmlToMarkdown, convertLinksToCitations, generateMarkdown,
  type MarkdownGenerationResult, type Citation, type CitationResult, type GenerateMarkdownOptions,
} from './markdown.ts';

// -- Content filters ("what is the fit_markdown?") ---------------------------
export {
  FILTERS, DEFAULT_FILTER, applyFilter,
  type ContentFilterName, type ContentFilterOptions, type ContentFilter,
} from './filters/index.ts';
export { readabilityFilter, extractArticle, type Article, type ReadabilityOptions } from './filters/readability.ts';
export { pruningFilter, type PruningFilterOptions } from './filters/pruning.ts';
export { bm25Filter, derivePageQuery, type Bm25FilterOptions } from './filters/bm25.ts';

// -- The pure page-processing pipeline ---------------------------------------
export {
  processHtml, hasLocalDom, type ProcessHtmlOptions, type ProcessedPage,
} from './crawl/processHtml.ts';

// -- Deep-crawl traversal -----------------------------------------------------
export {
  crawl, bfsCrawl, dfsCrawl, bestFirstCrawl, canProcessUrl, STRATEGIES,
  type StrategyName, type CrawlOptions, type CrawlPageResult, type FetchPage, type PageLink,
} from './crawl/strategies.ts';

// -- URL filters and scorers, for constraining and prioritizing a crawl -----
export {
  FilterChain, URLFilter, URLPatternFilter, DomainFilter, ContentTypeFilter, PathDepthFilter,
  type URLPatternFilterOptions, type DomainFilterOptions, type ContentTypeFilterOptions, type PathDepthFilterOptions,
} from './crawl/urlFilters.ts';

export {
  URLScorer, KeywordRelevanceScorer, PathDepthScorer, FreshnessScorer, ContentTypeScorer,
  DomainAuthorityScorer, CompositeScorer,
  type KeywordRelevanceScorerOptions, type PathDepthScorerOptions, type FreshnessScorerOptions,
  type ContentTypeScorerOptions, type DomainAuthorityScorerOptions, type CompositeScorerOptions,
} from './crawl/scorers.ts';

// -- Sitemap seeding -----------------------------------------------------------
export {
  fetchSitemap, discoverSitemap, deriveMatchFromUrl, looksLikeSitemap, guessSitemapUrls, isSameOriginSitemap,
  type FetchSitemapOptions,
} from './crawl/sitemap.ts';

// -- Export shaping, including the "point at the API, don't call it" pieces --
export {
  apiCallsMarkdown, withDiscoveredApis, type ApiCall, type ExportedApiCall, type WithDiscoveredApis,
} from './exportFormat.ts';

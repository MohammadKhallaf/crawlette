/**
 * The pure page-processing pipeline: HTML in, a structured result out.
 *
 * This is the part of "fetching a page" that has nothing to do with actually
 * fetching it. How the HTML gets here -- `fetch()`, a Playwright page, a
 * browser extension's offscreen document, a file on disk -- is entirely the
 * caller's concern; this module never touches the network or a `chrome.*`
 * API. Extracted so both a plain Node/browser consumer of this package and
 * the Crawlette extension's own networking layer can share one pipeline.
 */

import { scrape, type ScrapeOptions, type ScrapeResult } from '../scrape.ts';
import { generateMarkdown, type MarkdownGenerationResult } from '../markdown.ts';
import { applyFilter, DEFAULT_FILTER, type ContentFilterName, type ContentFilterOptions } from '../filters/index.ts';
import { extractJsonCss, type ExtractionSchema, type ExtractedItem } from '../extract/jsonCss.ts';

export interface ProcessHtmlOptions {
  contentFilter?: ContentFilterName;
  filterOptions?: ContentFilterOptions;
  scrapeOptions?: ScrapeOptions;
  extractionSchema?: ExtractionSchema | null;
  citations?: boolean;
  statusCode?: number;
  /** Defaults to `new DOMParser().parseFromString(html, 'text/html')`. */
  parser?: (html: string) => Document;
}

export interface ProcessedPage {
  url: string;
  success: true;
  statusCode: number;
  cleanedHtml: string;
  markdown: MarkdownGenerationResult;
  links: ScrapeResult['links'];
  media: ScrapeResult['media'];
  tables: ScrapeResult['tables'];
  metadata: ScrapeResult['metadata'];
  extracted: ExtractedItem[] | { error: string } | null;
  wordCount: number;
}

/**
 * Turn raw HTML into a CrawlResult.
 *
 * Shape follows crawl4ai's CrawlResult (models.py:130) so downstream tooling
 * built against crawl4ai keeps working.
 */
export function processHtml(html: string, url: string, options: ProcessHtmlOptions = {}): ProcessedPage {
  const {
    contentFilter = DEFAULT_FILTER,
    filterOptions = {},
    scrapeOptions = {},
    extractionSchema = null,
    citations = true,
    statusCode = 200,
    parser = (h: string) => new DOMParser().parseFromString(h, 'text/html'),
  } = options;

  const doc = parser(html);

  // Both run against the unpruned document, before scrape() mutates it.
  const fitHtml = applyFilter(doc, contentFilter, filterOptions);

  let extracted: ProcessedPage['extracted'] = null;
  if (extractionSchema) {
    try {
      extracted = extractJsonCss(doc, extractionSchema);
    } catch (error) {
      extracted = { error: String((error as { message?: string })?.message ?? error) };
    }
  }

  const scraped = scrape(doc, url, scrapeOptions);
  const markdown = generateMarkdown(scraped.cleanedHtml, url, fitHtml, { citations });

  return {
    url,
    success: true,
    statusCode,
    cleanedHtml: scraped.cleanedHtml,
    markdown,
    links: scraped.links,
    media: scraped.media,
    tables: scraped.tables,
    metadata: scraped.metadata,
    extracted,
    wordCount: markdown.rawMarkdown ? markdown.rawMarkdown.split(/\s+/).filter(Boolean).length : 0,
  };
}

/** True when this context can parse HTML itself (a window, not a worker). */
export const hasLocalDom = (): boolean => typeof DOMParser !== 'undefined';

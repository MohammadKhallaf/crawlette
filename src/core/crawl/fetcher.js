/**
 * Page fetching and the per-page processing pipeline.
 *
 * Two modes behind one interface:
 *  - `raw`      fetch() + DOMParser. Fast and parallel, but blind to anything
 *               a page's JavaScript renders after load.
 *  - `rendered` load in an offscreen document so scripts run, then read the
 *               live DOM. Slower, but sees SPA content, lazy-loaded images and
 *               post-render mutations.
 *
 * Both send the user's cookies (`credentials: 'include'`), which is what lets
 * the extension crawl pages behind a login with no credential plumbing --
 * the main thing a detached server cannot do.
 */

import { scrape } from '../scrape.js';
import { generateMarkdown } from '../markdown.js';
import { applyFilter, DEFAULT_FILTER } from '../filters/index.js';
import { extractJsonCss } from '../extract/jsonCss.js';

/** Page-load ceiling, mirroring crawl4ai's PAGE_TIMEOUT. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Content types worth parsing as HTML. */
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * Turn raw HTML into a CrawlResult.
 *
 * Shape follows crawl4ai's CrawlResult (models.py:130) so downstream tooling
 * built against crawl4ai keeps working.
 */
export function processHtml(html, url, options = {}) {
  const {
    contentFilter = DEFAULT_FILTER,
    filterOptions = {},
    scrapeOptions = {},
    extractionSchema = null,
    citations = true,
    statusCode = 200,
    parser = (h) => new DOMParser().parseFromString(h, 'text/html'),
  } = options;

  const doc = parser(html);

  // Both run against the unpruned document, before scrape() mutates it.
  const fitHtml = applyFilter(doc, contentFilter, filterOptions);

  let extracted = null;
  if (extractionSchema) {
    try {
      extracted = extractJsonCss(doc, extractionSchema);
    } catch (error) {
      extracted = { error: String(error?.message ?? error) };
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
export const hasLocalDom = () => typeof DOMParser !== 'undefined';

/**
 * Process HTML wherever a DOM exists.
 *
 * MV3 service workers have no DOMParser, so when called from the worker this
 * hands the HTML to the offscreen document, which does have one. In a window
 * context (or under test) it parses directly.
 */
async function processAnywhere(html, url, options, statusCode) {
  if (hasLocalDom()) return processHtml(html, url, { ...options, statusCode });

  const response = await chrome.runtime.sendMessage({
    type: 'offscreen:process',
    html,
    url,
    options: { ...serializableOptions(options), statusCode },
  });
  if (!response) throw new Error('No response from the offscreen document');
  if (response.error) throw new Error(response.error);
  return response.result;
}

/** Strip values that cannot survive structured cloning across a message. */
function serializableOptions(options) {
  const { parser, signal, ...rest } = options;
  return rest;
}

/** Fetch a page over the network and process it. */
export async function rawFetch(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, {
      credentials: 'include',        // carries the user's session cookies
      redirect: 'follow',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    if (!HTML_TYPES.some((t) => contentType.includes(t))) {
      return {
        url, success: false, statusCode: response.status,
        error: `Unsupported content type: ${contentType || 'unknown'}`,
      };
    }

    const html = await response.text();
    const result = await processAnywhere(html, response.url || url, options, response.status);

    if (!response.ok) {
      return { ...result, success: false, error: `HTTP ${response.status}` };
    }
    if (response.url && response.url !== url) result.redirectedUrl = response.url;
    return result;
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      url,
      success: false,
      error: aborted ? `Timed out after ${timeoutMs}ms` : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render a page in the offscreen document, then process the resulting DOM.
 *
 * The offscreen document runs the page in an iframe and returns its serialized
 * DOM after scripts have run. Sites that forbid framing (`frame-ancestors`)
 * fall back to `rawFetch`, so a crawl degrades rather than failing.
 */
export async function renderedFetch(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, settleMs = 500, removeOverlays = true } = options;

  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      throw new Error('Rendering requires the extension runtime');
    }
    // The offscreen document both renders and processes: it owns the only DOM.
    const response = await chrome.runtime.sendMessage({
      type: 'offscreen:render',
      url,
      timeoutMs,
      settleMs,
      removeOverlays,
      options: serializableOptions(options),
    });
    if (!response) throw new Error('No response from the offscreen document');
    if (response.error) throw new Error(response.error);
    return response.result;
  } catch (error) {
    // Rendering is best-effort; a raw fetch still yields useful content.
    const fallback = await rawFetch(url, options);
    if (fallback.success) fallback.renderFallback = String(error?.message ?? error);
    return fallback;
  }
}

/**
 * Fetch a page in the requested mode.
 *
 * @param {string} url
 * @param {{mode?: 'raw'|'rendered'}} options
 */
export function fetchPage(url, options = {}) {
  const { mode = 'raw' } = options;
  return mode === 'rendered' ? renderedFetch(url, options) : rawFetch(url, options);
}

/** Build a single-argument fetcher for the crawl strategies. */
export function makeFetcher(options = {}) {
  return (url) => fetchPage(url, options);
}

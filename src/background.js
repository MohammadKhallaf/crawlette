/**
 * Service worker: owns crawl state and the crawl loop.
 *
 * Chrome can terminate a service worker at any time, so the frontier, visited
 * set and results are checkpointed to chrome.storage.session as the crawl runs.
 * A terminated crawl is resumed on the next wake rather than lost.
 */

import { crawl } from './core/crawl/strategies.js';
import { makeFetcher } from './core/crawl/fetcher.js';
import { FilterChain, DomainFilter, ContentTypeFilter, URLPatternFilter } from './core/crawl/urlFilters.js';
import { KeywordRelevanceScorer, FreshnessScorer, PathDepthScorer, CompositeScorer } from './core/crawl/scorers.js';
import { DEFAULT_FILTER } from './core/filters/index.js';

const STATE_KEY = 'crawlState';
const RESULTS_KEY = 'crawlResults';

/** Results are checkpointed at most this often, to bound storage writes. */
const CHECKPOINT_INTERVAL_MS = 2000;

/** In-memory handle for the running crawl; rebuilt from storage after a restart. */
let running = null;

/**
 * Ensure the offscreen document exists before a rendered crawl needs it.
 *
 * Chrome allows exactly one offscreen document per extension, and creating a
 * second throws, so concurrent callers share a single in-flight promise.
 */
let offscreenReady = null;

function ensureOffscreen() {
  if (!chrome.offscreen) return Promise.reject(new Error('Offscreen documents are unavailable'));
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing?.length) return;
    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('src/offscreen.html'),
        reasons: ['DOM_PARSER'],
        justification: 'Render pages so client-side JavaScript runs before extracting content.',
      });
    } catch (error) {
      // A concurrent call may have won the race; that is fine.
      if (!String(error?.message ?? error).includes('Only a single offscreen')) throw error;
    }
  })().catch((error) => {
    offscreenReady = null; // let a later crawl retry
    throw error;
  });

  return offscreenReady;
}

const nowState = async () => (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? null;
const setState = (state) => chrome.storage.session.set({ [STATE_KEY]: state });
const getResults = async () => (await chrome.storage.session.get(RESULTS_KEY))[RESULTS_KEY] ?? [];
const setResults = (results) => chrome.storage.session.set({ [RESULTS_KEY]: results });

/** Build a filter chain from the popup's settings. */
function buildFilterChain(config) {
  const filters = [new ContentTypeFilter({ blockBinary: true })];

  if (!config.includeExternal || config.allowedDomains?.length || config.blockedDomains?.length) {
    filters.push(new DomainFilter({
      allowed: config.allowedDomains?.length ? config.allowedDomains : null,
      blocked: config.blockedDomains ?? [],
      blockSocialMedia: config.excludeSocialMedia ?? false,
    }));
  }
  if (config.urlPatterns?.length) {
    filters.push(new URLPatternFilter(config.urlPatterns));
  }
  return new FilterChain(filters);
}

/** Build a scorer for best-first crawling, or null when not needed. */
function buildScorer(config) {
  if (config.strategy !== 'best-first') return null;

  const scorers = [];
  if (config.keywords?.length) scorers.push(new KeywordRelevanceScorer(config.keywords, { weight: 2.0 }));
  if (config.preferFresh) scorers.push(new FreshnessScorer());
  if (config.optimalDepth != null) scorers.push(new PathDepthScorer({ optimalDepth: config.optimalDepth }));

  if (!scorers.length) return null;
  return scorers.length === 1 ? scorers[0] : new CompositeScorer(scorers);
}

/** Trim a result down to what the UI needs, so storage stays small. */
function toStoredResult(result) {
  return {
    url: result.url,
    success: result.success,
    error: result.error ?? null,
    statusCode: result.statusCode ?? null,
    title: result.metadata?.title ?? '',
    depth: result.metadata?.depth ?? 0,
    parentUrl: result.metadata?.parentUrl ?? null,
    score: result.metadata?.score,
    wordCount: result.wordCount ?? 0,
    markdown: result.markdown?.rawMarkdown ?? '',
    markdownWithCitations: result.markdown?.markdownWithCitations ?? '',
    references: result.markdown?.referencesMarkdown ?? '',
    fitMarkdown: result.markdown?.fitMarkdown ?? '',
    links: result.links ?? { internal: [], external: [] },
    media: result.media ?? { images: [], videos: [], audios: [] },
    tables: result.tables ?? [],
    extracted: result.extracted ?? null,
  };
}

/** Start a crawl, replacing any that is already running. */
async function startCrawl(config) {
  await stopCrawl();

  const state = {
    status: 'running',
    config,
    startUrl: config.url,
    startedAt: Date.now(),
    pagesCrawled: 0,
    lastError: null,
  };
  await setState(state);
  await setResults([]);

  running = { cancelled: false };
  const token = running;

  if (config.renderJs) {
    try {
      await ensureOffscreen();
    } catch (error) {
      // Rendering is unavailable; the fetcher falls back to raw fetches.
      await setState({ ...state, renderUnavailable: String(error?.message ?? error) });
    }
  }

  const fetcher = makeFetcher({
    mode: config.renderJs ? 'rendered' : 'raw',
    contentFilter: config.contentFilter ?? DEFAULT_FILTER,
    filterOptions: config.query ? { query: config.query } : {},
    scrapeOptions: {
      excludeExternalLinks: config.excludeExternalLinks ?? false,
      excludeSocialMediaLinks: config.excludeSocialMedia ?? false,
      excludedTags: config.excludedTags ?? [],
      cssSelector: config.cssSelector || null,
    },
  });

  const results = [];
  let lastCheckpoint = 0;

  const checkpoint = async (force = false) => {
    const due = force || Date.now() - lastCheckpoint > CHECKPOINT_INTERVAL_MS;
    if (!due) return;
    lastCheckpoint = Date.now();
    await setResults(results);
    await setState({ ...(await nowState()), pagesCrawled: results.filter((r) => r.success).length });
  };

  // Run detached: the popup may close, and the crawl must survive that.
  (async () => {
    try {
      const stream = crawl(config.strategy ?? 'bfs', config.url, fetcher, {
        maxDepth: config.maxDepth ?? 2,
        maxPages: config.maxPages ?? 50,
        includeExternal: config.includeExternal ?? false,
        concurrency: config.renderJs ? 2 : (config.concurrency ?? 5),
        filterChain: buildFilterChain(config),
        scorer: buildScorer(config),
        shouldCancel: () => token.cancelled,
      });

      for await (const result of stream) {
        if (token.cancelled) break;
        results.push(toStoredResult(result));
        await checkpoint();
      }

      await checkpoint(true);
      const final = await nowState();
      await setState({ ...final, status: token.cancelled ? 'cancelled' : 'complete', finishedAt: Date.now() });
    } catch (error) {
      await setResults(results);
      const final = await nowState();
      await setState({ ...final, status: 'error', lastError: String(error?.message ?? error) });
    } finally {
      if (running === token) running = null;
    }
  })();

  return { started: true };
}

/** Stop the running crawl, if any. */
async function stopCrawl() {
  if (running) running.cancelled = true;
  running = null;
  const state = await nowState();
  if (state?.status === 'running') {
    await setState({ ...state, status: 'cancelled', finishedAt: Date.now() });
  }
  return { stopped: true };
}

/** Current status plus a result count, for the popup's live counter. */
async function getStatus() {
  const state = await nowState();
  const results = await getResults();
  return {
    state: state ?? { status: 'idle' },
    total: results.length,
    successful: results.filter((r) => r.success).length,
    // A 'running' state with no live handle means the worker was restarted.
    stale: Boolean(state?.status === 'running' && !running),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    start: () => startCrawl(message.config),
    stop: () => stopCrawl(),
    status: () => getStatus(),
    results: () => getResults(),
    clear: async () => {
      await chrome.storage.session.remove([STATE_KEY, RESULTS_KEY]);
      return { cleared: true };
    },
  };

  const handler = handlers[message.type];
  if (!handler) return false;

  handler().then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
  return true; // keeps the message channel open for the async response
});

chrome.action?.onClicked?.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/results.html') });
});

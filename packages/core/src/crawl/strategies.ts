/**
 * Deep-crawl traversal strategies.
 *
 * Port of crawl4ai/deep_crawling/{bfs,dfs,bff}_strategy.py. Each strategy is an
 * async generator yielding results as they arrive, so the UI can stream them.
 *
 * Semantics preserved from upstream, and easy to get wrong:
 *  - `maxDepth: 2` crawls THREE levels (0, 1, 2).
 *  - Depth 0 bypasses the filter chain, but never URL-shape validation.
 *  - `maxPages` counts SUCCESSFUL fetches only.
 *  - `visited` is marked at DISCOVERY time in BFS, but at POP time in DFS and
 *    best-first. This changes which parent a URL is attributed to.
 *  - Best-first orders by (-score, depth, url): highest score first, ties
 *    broken by shallower depth, then lexicographically. Upstream gets the tie
 *    breaking free from Python tuple comparison; here it is explicit.
 */

import TinyQueue from 'tinyqueue';
import { normalizeUrl, getBaseDomain, isExternalUrl } from '../normalize.ts';
import { FilterChain } from './urlFilters.ts';

export interface PageLink {
  href: string;
  [key: string]: unknown;
}

/**
 * What a fetcher must return. Deliberately loose (an index signature) beyond
 * the fields the strategies themselves read: the real page-processing result
 * (markdown, extracted data, media, ...) is produced by whatever embeds this
 * package, and strategies.ts only needs to know about success/links/metadata
 * to drive traversal.
 */
export interface CrawlPageResult {
  url: string;
  success: boolean;
  error?: string;
  links?: { internal?: PageLink[]; external?: PageLink[] };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type FetchPage = (url: string) => Promise<CrawlPageResult>;

/** Reject URLs that could never be fetched as a page (bfs_strategy.py:62). */
export function canProcessUrl(url: string, depth: number, filterChain: FilterChain): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Upstream requires a dot in the host, which excludes "localhost". Kept, so
  // a crawl cannot wander onto internal hostnames by accident.
  if (!parsed.hostname.includes('.')) return false;
  if (depth === 0) return true;
  return filterChain.apply(url);
}

interface QueueItem {
  url: string;
  parentUrl: string | null;
  depth: number;
  score: number;
}

/**
 * Order for best-first: score descending, then depth ascending, then URL.
 * Mirrors Python's tuple comparison on (-score, depth, url).
 */
function bestFirstCompare(a: QueueItem, b: QueueItem): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

/** Pull followable links out of a crawl result. */
function linksFrom(result: CrawlPageResult, includeExternal: boolean): PageLink[] {
  const links = result.links?.internal ?? [];
  return includeExternal ? links.concat(result.links?.external ?? []) : links;
}

export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  includeExternal?: boolean;
  scoreThreshold?: number;
  filterChain?: FilterChain;
  scorer?: { score: (url: string) => number } | null;
  shouldCancel?: () => boolean | Promise<boolean>;
  onProgress?: (info: { pagesCrawled: number; queued: number; depth: number }) => void;
  /**
   * Called with the frontier after each level/pop so the caller can
   * checkpoint it. Without this a killed service worker loses the queue and
   * the crawl cannot be continued, only restarted.
   */
  onState?: (snapshot: Record<string, unknown>) => void;
  concurrency?: number;
  resumeState?: Record<string, unknown> | null;
}

interface NormalizedOptions extends Required<Omit<CrawlOptions, 'resumeState' | 'scorer'>> {
  scorer: CrawlOptions['scorer'];
  resumeState: CrawlOptions['resumeState'];
}

/** Shared config with upstream's defaults applied. */
function normalizeOptions(options: CrawlOptions): NormalizedOptions {
  return {
    maxDepth: options.maxDepth ?? 2,
    maxPages: options.maxPages ?? Infinity,
    includeExternal: options.includeExternal ?? false,
    scoreThreshold: options.scoreThreshold ?? -Infinity,
    filterChain: options.filterChain ?? new FilterChain(),
    scorer: options.scorer ?? null,
    shouldCancel: options.shouldCancel ?? (() => false),
    onProgress: options.onProgress ?? (() => {}),
    onState: options.onState ?? (() => {}),
    concurrency: Math.max(1, options.concurrency ?? 5),
    resumeState: options.resumeState ?? null,
  };
}

interface Settled<T> {
  index: number;
  value?: T;
  error?: unknown;
}

/** Run `fn` over `items` with at most `limit` in flight, yielding as each settles. */
async function* mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<Settled<R>> {
  const executing = new Map<number, Promise<Settled<R>>>();
  let next = 0;

  while (next < items.length || executing.size) {
    while (next < items.length && executing.size < limit) {
      const index = next++;
      const promise = fn(items[index]!).then(
        (value): Settled<R> => ({ index, value }),
        (error): Settled<R> => ({ index, error }),
      );
      executing.set(index, promise);
    }
    const settled = await Promise.race(executing.values());
    executing.delete(settled.index);
    yield settled;
  }
}

/**
 * Accept either a single URL or a list of seeds.
 *
 * Seeding many URLs at once is how a sitemap-driven crawl works: listing pages
 * are often client-rendered and expose no links to follow, so the seeds ARE the
 * work rather than a starting point for discovery.
 */
function toSeeds(startUrl: string | string[]): string[] {
  const seeds = (Array.isArray(startUrl) ? startUrl : [startUrl]).filter(Boolean);
  if (!seeds.length) throw new Error('A crawl needs at least one start URL');
  return seeds;
}

interface LevelEntry {
  url: string;
  parentUrl: string | null;
}

/**
 * Breadth-first: fetch an entire level concurrently, then descend.
 *
 * `visited` is marked at discovery time, matching upstream, so a URL is never
 * re-queued even if its own fetch later fails.
 */
export async function* bfsCrawl(
  startUrl: string | string[],
  fetchPage: FetchPage,
  options: CrawlOptions = {},
): AsyncGenerator<CrawlPageResult> {
  const opts = normalizeOptions(options);
  const seeds = toSeeds(startUrl);
  const baseDomain = getBaseDomain(seeds[0]!);

  const resume = opts.resumeState as { visited?: string[]; depths?: [string, number][]; pending?: LevelEntry[]; pagesCrawled?: number } | null;

  const visited = new Set<string>(resume?.visited ?? []);
  const depths = new Map<string, number>(resume?.depths ?? seeds.map((u): [string, number] => [u, 0]));
  let currentLevel: LevelEntry[] = resume?.pending ?? seeds.map((u) => ({ url: u, parentUrl: null }));
  let pagesCrawled = resume?.pagesCrawled ?? 0;

  // DIVERGENCE FROM crawl4ai (bug fix): upstream's batch BFS seeds `visited`
  // empty and only marks URLs as it discovers them, so the start URL is never
  // marked. Any site whose pages link back to the entry point -- a logo in the
  // header, a nav "Home" -- re-queues it and crawls it twice.
  for (const entry of currentLevel) visited.add(entry.url);

  while (currentLevel.length) {
    if (pagesCrawled >= opts.maxPages) break;
    if (await opts.shouldCancel()) break;

    const nextLevel: LevelEntry[] = [];
    const parents = new Map(currentLevel.map((e) => [e.url, e.parentUrl]));

    for await (const settled of mapConcurrent(currentLevel, opts.concurrency, (e) => fetchPage(e.url))) {
      const entry = currentLevel[settled.index]!;
      const depth = depths.get(entry.url) ?? 0;

      if (settled.error) {
        yield {
          url: entry.url,
          success: false,
          error: String((settled.error as { message?: string })?.message ?? settled.error),
          metadata: { depth, parentUrl: parents.get(entry.url) ?? null },
        };
        continue;
      }

      const result = settled.value!;
      result.metadata = { ...result.metadata, depth, parentUrl: parents.get(entry.url) ?? null };
      yield result;

      if (!result.success) continue;
      pagesCrawled += 1;
      opts.onProgress({ pagesCrawled, queued: nextLevel.length, depth });

      if (depth + 1 > opts.maxDepth) continue;

      // Keep discovering even at the page limit. These URLs are not crawled --
      // the guard at the top of the loop stops that -- but recording them is
      // what lets a later run continue where this one stopped, instead of
      // starting over.
      const atLimit = pagesCrawled >= opts.maxPages;
      const remaining = opts.maxPages - pagesCrawled;
      const candidates: { url: string; score: number }[] = [];

      for (const link of linksFrom(result, opts.includeExternal)) {
        const url = normalizeUrl(link.href, result.url);
        if (!url || visited.has(url)) continue;
        if (!opts.includeExternal && isExternalUrl(url, baseDomain)) continue;
        if (!canProcessUrl(url, depth + 1, opts.filterChain)) continue;

        const score = opts.scorer ? opts.scorer.score(url) : 0;
        if (score < opts.scoreThreshold) continue;

        visited.add(url);
        candidates.push({ url, score });
      }

      // Over capacity: keep the best-scoring candidates. At the limit we keep
      // them all, because they are the resume frontier rather than work.
      if (!atLimit && candidates.length > remaining) {
        if (opts.scorer) candidates.sort((a, b) => b.score - a.score);
        candidates.length = Math.max(0, remaining);
      }

      for (const { url } of candidates) {
        nextLevel.push({ url, parentUrl: result.url });
        depths.set(url, depth + 1);
      }
    }

    currentLevel = nextLevel;
    opts.onState({
      strategy: 'bfs',
      visited: [...visited],
      pending: currentLevel,
      depths: [...depths],
      pagesCrawled,
    });
  }
}

interface StackEntry {
  url: string;
  parentUrl: string | null;
  depth: number;
}

/** Depth-first: one URL at a time, children pushed in reverse so order holds. */
export async function* dfsCrawl(
  startUrl: string | string[],
  fetchPage: FetchPage,
  options: CrawlOptions = {},
): AsyncGenerator<CrawlPageResult> {
  const opts = normalizeOptions(options);
  const seeds = toSeeds(startUrl);
  const baseDomain = getBaseDomain(seeds[0]!);

  const resume = opts.resumeState as { visited?: string[]; stack?: StackEntry[]; pagesCrawled?: number } | null;

  const visited = new Set<string>(resume?.visited ?? []);
  // Reversed so the first seed is popped first.
  const stack: StackEntry[] = resume?.stack
    ?? [...seeds].reverse().map((u) => ({ url: u, parentUrl: null, depth: 0 }));
  let pagesCrawled = resume?.pagesCrawled ?? 0;

  while (stack.length) {
    if (pagesCrawled >= opts.maxPages) break;
    if (await opts.shouldCancel()) break;

    const { url, parentUrl, depth } = stack.pop()!;
    if (visited.has(url) || depth > opts.maxDepth) continue;
    visited.add(url);

    let result: CrawlPageResult;
    try {
      result = await fetchPage(url);
    } catch (error) {
      yield {
        url, success: false, error: String((error as { message?: string })?.message ?? error), metadata: { depth, parentUrl },
      };
      continue;
    }

    const score = opts.scorer ? opts.scorer.score(url) : undefined;
    result.metadata = {
      ...result.metadata, depth, parentUrl, ...(score === undefined ? {} : { score }),
    };
    yield result;

    if (!result.success) continue;
    pagesCrawled += 1;
    opts.onProgress({ pagesCrawled, queued: stack.length, depth });

    if (pagesCrawled >= opts.maxPages) break;
    if (depth + 1 > opts.maxDepth) continue;

    const children: StackEntry[] = [];
    for (const link of linksFrom(result, opts.includeExternal)) {
      const child = normalizeUrl(link.href, result.url);
      if (!child || visited.has(child)) continue;
      if (!opts.includeExternal && isExternalUrl(child, baseDomain)) continue;
      if (!canProcessUrl(child, depth + 1, opts.filterChain)) continue;
      if (opts.scorer && opts.scorer.score(child) < opts.scoreThreshold) continue;
      children.push({ url: child, parentUrl: result.url, depth: depth + 1 });
    }
    // Reversed so the first-discovered child is popped first.
    for (const child of children.reverse()) stack.push(child);

    opts.onState({
      strategy: 'dfs', visited: [...visited], stack, pagesCrawled,
    });
  }
}

/**
 * Best-first: a scored priority queue, drained in batches.
 *
 * Results are collected then replayed in queue order, so discovery order
 * depends on score rather than on which fetch happened to finish first
 * (bff_strategy.py:275). The queue is `tinyqueue` (a small, widely-used binary
 * heap) rather than a hand-rolled one -- same algorithm, real dependency.
 */
export async function* bestFirstCrawl(
  startUrl: string | string[],
  fetchPage: FetchPage,
  options: CrawlOptions = {},
): AsyncGenerator<CrawlPageResult> {
  const opts = normalizeOptions(options);
  const seeds = toSeeds(startUrl);
  const baseDomain = getBaseDomain(seeds[0]!);
  const BATCH_SIZE = 10;

  const resume = opts.resumeState as { visited?: string[]; queue?: QueueItem[]; pagesCrawled?: number } | null;

  const visited = new Set<string>(resume?.visited ?? []);
  const initial: QueueItem[] = resume?.queue
    ?? seeds.map((u) => ({
      url: u, parentUrl: null, depth: 0, score: opts.scorer ? opts.scorer.score(u) : 0,
    }));
  const queue = new TinyQueue<QueueItem>(initial, bestFirstCompare);
  let pagesCrawled = resume?.pagesCrawled ?? 0;

  while (queue.length) {
    if (pagesCrawled >= opts.maxPages) break;
    if (await opts.shouldCancel()) break;

    const batch: QueueItem[] = [];
    while (batch.length < BATCH_SIZE && queue.length) {
      const item = queue.pop()!;
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      batch.push(item);
    }
    if (!batch.length) break;

    const settledByIndex = new Map<number, Settled<CrawlPageResult>>();
    for await (const settled of mapConcurrent(batch, opts.concurrency, (e) => fetchPage(e.url))) {
      settledByIndex.set(settled.index, settled);
    }

    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i]!;
      const settled = settledByIndex.get(i)!;

      if (settled.error) {
        yield {
          url: item.url,
          success: false,
          error: String((settled.error as { message?: string })?.message ?? settled.error),
          metadata: { depth: item.depth, parentUrl: item.parentUrl, score: item.score },
        };
        continue;
      }

      const result = settled.value!;
      result.metadata = {
        ...result.metadata, depth: item.depth, parentUrl: item.parentUrl, score: item.score,
      };
      yield result;

      if (!result.success) continue;
      pagesCrawled += 1;
      opts.onProgress({ pagesCrawled, queued: queue.length, depth: item.depth });

      if (pagesCrawled >= opts.maxPages) break;
      if (item.depth + 1 > opts.maxDepth) continue;

      for (const link of linksFrom(result, opts.includeExternal)) {
        const url = normalizeUrl(link.href, result.url);
        if (!url || visited.has(url)) continue;
        if (!opts.includeExternal && isExternalUrl(url, baseDomain)) continue;
        if (!canProcessUrl(url, item.depth + 1, opts.filterChain)) continue;

        const score = opts.scorer ? opts.scorer.score(url) : 0;
        if (score < opts.scoreThreshold) continue;

        queue.push({
          url, parentUrl: result.url, depth: item.depth + 1, score,
        });
      }
    }

    opts.onState({
      strategy: 'best-first',
      visited: [...visited],
      queue: [...queue.data],
      pagesCrawled,
    });
  }
}

export type StrategyName = 'bfs' | 'dfs' | 'best-first';

export const STRATEGIES: Record<StrategyName, typeof bfsCrawl> = {
  bfs: bfsCrawl, dfs: dfsCrawl, 'best-first': bestFirstCrawl,
};

/** Run a crawl by strategy name. */
export function crawl(
  strategy: StrategyName,
  startUrl: string | string[],
  fetchPage: FetchPage,
  options: CrawlOptions = {},
): AsyncGenerator<CrawlPageResult> {
  const fn = STRATEGIES[strategy];
  if (!fn) throw new Error(`Unknown crawl strategy: ${strategy}`);
  return fn(startUrl, fetchPage, options);
}

export const _internals = { bestFirstCompare, mapConcurrent, PriorityQueue: TinyQueue };

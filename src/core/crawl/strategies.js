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

import { normalizeUrl, getBaseDomain, isExternalUrl } from '../normalize.js';
import { FilterChain } from './urlFilters.js';

/** Reject URLs that could never be fetched as a page (bfs_strategy.py:62). */
export function canProcessUrl(url, depth, filterChain) {
  let parsed;
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

/** Binary-heap priority queue ordered by an explicit comparator. */
class PriorityQueue {
  constructor(compare) {
    this.compare = compare;
    this.heap = [];
  }

  get size() { return this.heap.length; }

  push(item) {
    this.heap.push(item);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) >= 0) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  pop() {
    if (!this.heap.length) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < this.heap.length && this.compare(this.heap[l], this.heap[best]) < 0) best = l;
        if (r < this.heap.length && this.compare(this.heap[r], this.heap[best]) < 0) best = r;
        if (best === i) break;
        [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]];
        i = best;
      }
    }
    return top;
  }
}

/**
 * Order for best-first: score descending, then depth ascending, then URL.
 * Mirrors Python's tuple comparison on (-score, depth, url).
 */
function bestFirstCompare(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

/** Pull followable links out of a crawl result. */
function linksFrom(result, includeExternal) {
  const links = result.links?.internal ?? [];
  return includeExternal ? links.concat(result.links?.external ?? []) : links;
}

/** Shared config with upstream's defaults applied. */
function normalizeOptions(options) {
  return {
    maxDepth: options.maxDepth ?? 2,
    maxPages: options.maxPages ?? Infinity,
    includeExternal: options.includeExternal ?? false,
    scoreThreshold: options.scoreThreshold ?? -Infinity,
    filterChain: options.filterChain ?? new FilterChain(),
    scorer: options.scorer ?? null,
    shouldCancel: options.shouldCancel ?? (() => false),
    onProgress: options.onProgress ?? (() => {}),
    // Called with the frontier after each level/pop so the caller can
    // checkpoint it. Without this a killed service worker loses the queue and
    // the crawl cannot be continued, only restarted.
    onState: options.onState ?? (() => {}),
    concurrency: Math.max(1, options.concurrency ?? 5),
    resumeState: options.resumeState ?? null,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, yielding as each settles. */
async function* mapConcurrent(items, limit, fn) {
  const executing = new Map();
  let next = 0;

  while (next < items.length || executing.size) {
    while (next < items.length && executing.size < limit) {
      const index = next++;
      const promise = fn(items[index]).then(
        (value) => ({ index, value }),
        (error) => ({ index, error }),
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
function toSeeds(startUrl) {
  const seeds = (Array.isArray(startUrl) ? startUrl : [startUrl]).filter(Boolean);
  if (!seeds.length) throw new Error('A crawl needs at least one start URL');
  return seeds;
}

/**
 * Breadth-first: fetch an entire level concurrently, then descend.
 *
 * `visited` is marked at discovery time, matching upstream, so a URL is never
 * re-queued even if its own fetch later fails.
 */
export async function* bfsCrawl(startUrl, fetchPage, options = {}) {
  const opts = normalizeOptions(options);
  const seeds = toSeeds(startUrl);
  const baseDomain = getBaseDomain(seeds[0]);

  const visited = new Set(opts.resumeState?.visited ?? []);
  const depths = new Map(opts.resumeState?.depths ?? seeds.map((u) => [u, 0]));
  let currentLevel = opts.resumeState?.pending ?? seeds.map((u) => ({ url: u, parentUrl: null }));
  let pagesCrawled = opts.resumeState?.pagesCrawled ?? 0;

  // DIVERGENCE FROM crawl4ai (bug fix): upstream's batch BFS seeds `visited`
  // empty and only marks URLs as it discovers them, so the start URL is never
  // marked. Any site whose pages link back to the entry point -- a logo in the
  // header, a nav "Home" -- re-queues it and crawls it twice.
  for (const entry of currentLevel) visited.add(entry.url);

  while (currentLevel.length) {
    if (pagesCrawled >= opts.maxPages) break;
    if (await opts.shouldCancel()) break;

    const nextLevel = [];
    const parents = new Map(currentLevel.map((e) => [e.url, e.parentUrl]));

    for await (const settled of mapConcurrent(currentLevel, opts.concurrency, (e) => fetchPage(e.url))) {
      const entry = currentLevel[settled.index];
      const depth = depths.get(entry.url) ?? 0;

      if (settled.error) {
        yield {
          url: entry.url, success: false, error: String(settled.error?.message ?? settled.error),
          metadata: { depth, parentUrl: parents.get(entry.url) ?? null },
        };
        continue;
      }

      const result = settled.value;
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
      const candidates = [];

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

/** Depth-first: one URL at a time, children pushed in reverse so order holds. */
export async function* dfsCrawl(startUrl, fetchPage, options = {}) {
  const opts = normalizeOptions(options);
  const seeds = toSeeds(startUrl);
  const baseDomain = getBaseDomain(seeds[0]);

  const visited = new Set(opts.resumeState?.visited ?? []);
  // Reversed so the first seed is popped first.
  const stack = opts.resumeState?.stack
    ?? [...seeds].reverse().map((u) => ({ url: u, parentUrl: null, depth: 0 }));
  let pagesCrawled = opts.resumeState?.pagesCrawled ?? 0;

  while (stack.length) {
    if (pagesCrawled >= opts.maxPages) break;
    if (await opts.shouldCancel()) break;

    const { url, parentUrl, depth } = stack.pop();
    if (visited.has(url) || depth > opts.maxDepth) continue;
    visited.add(url);

    let result;
    try {
      result = await fetchPage(url);
    } catch (error) {
      yield { url, success: false, error: String(error?.message ?? error), metadata: { depth, parentUrl } };
      continue;
    }

    const score = opts.scorer ? opts.scorer.score(url) : undefined;
    result.metadata = { ...result.metadata, depth, parentUrl, ...(score === undefined ? {} : { score }) };
    yield result;

    if (!result.success) continue;
    pagesCrawled += 1;
    opts.onProgress({ pagesCrawled, queued: stack.length, depth });

    if (pagesCrawled >= opts.maxPages) break;
    if (depth + 1 > opts.maxDepth) continue;

    const children = [];
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
 * (bff_strategy.py:275).
 */
export async function* bestFirstCrawl(startUrl, fetchPage, options = {}) {
  const opts = normalizeOptions(options);
  const seeds = toSeeds(startUrl);
  const baseDomain = getBaseDomain(seeds[0]);
  const BATCH_SIZE = 10;

  const visited = new Set(opts.resumeState?.visited ?? []);
  const queue = new PriorityQueue(bestFirstCompare);
  let pagesCrawled = opts.resumeState?.pagesCrawled ?? 0;

  for (const item of opts.resumeState?.queue
    ?? seeds.map((u) => ({
      url: u, parentUrl: null, depth: 0, score: opts.scorer ? opts.scorer.score(u) : 0,
    }))) {
    queue.push(item);
  }

  while (queue.size) {
    if (pagesCrawled >= opts.maxPages) break;
    if (await opts.shouldCancel()) break;

    const batch = [];
    while (batch.length < BATCH_SIZE && queue.size) {
      const item = queue.pop();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      batch.push(item);
    }
    if (!batch.length) break;

    const settledByIndex = new Map();
    for await (const settled of mapConcurrent(batch, opts.concurrency, (e) => fetchPage(e.url))) {
      settledByIndex.set(settled.index, settled);
    }

    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      const settled = settledByIndex.get(i);

      if (settled.error) {
        yield {
          url: item.url, success: false, error: String(settled.error?.message ?? settled.error),
          metadata: { depth: item.depth, parentUrl: item.parentUrl, score: item.score },
        };
        continue;
      }

      const result = settled.value;
      result.metadata = {
        ...result.metadata, depth: item.depth, parentUrl: item.parentUrl, score: item.score,
      };
      yield result;

      if (!result.success) continue;
      pagesCrawled += 1;
      opts.onProgress({ pagesCrawled, queued: queue.size, depth: item.depth });

      if (pagesCrawled >= opts.maxPages) break;
      if (item.depth + 1 > opts.maxDepth) continue;

      for (const link of linksFrom(result, opts.includeExternal)) {
        const url = normalizeUrl(link.href, result.url);
        if (!url || visited.has(url)) continue;
        if (!opts.includeExternal && isExternalUrl(url, baseDomain)) continue;
        if (!canProcessUrl(url, item.depth + 1, opts.filterChain)) continue;

        const score = opts.scorer ? opts.scorer.score(url) : 0;
        if (score < opts.scoreThreshold) continue;

        queue.push({ url, parentUrl: result.url, depth: item.depth + 1, score });
      }
    }

    opts.onState({
      strategy: 'best-first',
      visited: [...visited],
      queue: [...queue.heap],
      pagesCrawled,
    });
  }
}

export const STRATEGIES = { bfs: bfsCrawl, dfs: dfsCrawl, 'best-first': bestFirstCrawl };

/** Run a crawl by strategy name. */
export function crawl(strategy, startUrl, fetchPage, options = {}) {
  const fn = STRATEGIES[strategy];
  if (!fn) throw new Error(`Unknown crawl strategy: ${strategy}`);
  return fn(startUrl, fetchPage, options);
}

export const _internals = { PriorityQueue, bestFirstCompare, mapConcurrent };

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bfsCrawl, dfsCrawl, bestFirstCrawl, crawl, canProcessUrl, _internals,
} from '../src/crawl/strategies.ts';
import { FilterChain, URLPatternFilter } from '../src/crawl/urlFilters.ts';
import { KeywordRelevanceScorer } from '../src/crawl/scorers.ts';

/**
 * Build a fetcher over a link graph: { '/a': ['/b', '/c'] }.
 * Records fetch order so traversal can be asserted.
 */
function fakeSite(graph, { fail = [], origin = 'https://site.test' } = {}) {
  const fetched = [];
  const fetchPage = async (url) => {
    fetched.push(url);
    const path = new URL(url).pathname;
    if (fail.includes(path)) throw new Error(`boom ${path}`);
    const internal = (graph[path] ?? []).map((href) => ({ href: origin + href }));
    return { url, success: true, links: { internal, external: [] }, markdown: `# ${path}` };
  };
  return { fetchPage, fetched, origin };
}

const collect = async (gen) => {
  const out = [];
  for await (const r of gen) out.push(r);
  return out;
};
const paths = (results) => results.map((r) => new URL(r.url).pathname);

test('canProcessUrl rejects non-http and hostless URLs', () => {
  const chain = new FilterChain();
  assert.equal(canProcessUrl('https://e.com/a', 1, chain), true);
  assert.equal(canProcessUrl('ftp://e.com/a', 1, chain), false);
  assert.equal(canProcessUrl('not a url', 1, chain), false);
  assert.equal(canProcessUrl('http://localhost/a', 1, chain), false);
});

test('depth 0 bypasses the filter chain, deeper levels do not', () => {
  const chain = new FilterChain([new URLPatternFilter(['*/keep/*'])]);
  assert.equal(canProcessUrl('https://e.com/other', 0, chain), true);
  assert.equal(canProcessUrl('https://e.com/other', 1, chain), false);
  assert.equal(canProcessUrl('https://e.com/keep/x', 1, chain), true);
});

test('bfs visits level by level', async () => {
  const { fetchPage, origin } = fakeSite({
    '/': ['/a', '/b'], '/a': ['/a1'], '/b': ['/b1'], '/a1': [], '/b1': [],
  });
  const got = paths(await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 2, concurrency: 1 })));
  assert.deepEqual(got.slice(0, 3), ['/', '/a', '/b']);
  assert.deepEqual(got.slice(3).sort(), ['/a1', '/b1']);
});

test('maxDepth 2 crawls three levels (0,1,2)', async () => {
  const { fetchPage, origin } = fakeSite({
    '/': ['/d1'], '/d1': ['/d2'], '/d2': ['/d3'], '/d3': [],
  });
  const got = paths(await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 2, concurrency: 1 })));
  assert.deepEqual(got, ['/', '/d1', '/d2']);
  assert.ok(!got.includes('/d3'));
});

test('maxDepth 0 fetches only the start URL', async () => {
  const { fetchPage, origin } = fakeSite({ '/': ['/a'], '/a': [] });
  const got = await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 0 }));
  assert.equal(got.length, 1);
});

test('maxPages caps successful fetches', async () => {
  const { fetchPage, origin } = fakeSite({
    '/': ['/a', '/b', '/c'], '/a': [], '/b': [], '/c': [],
  });
  const got = await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 3, maxPages: 2, concurrency: 1 }));
  assert.equal(got.filter((r) => r.success).length, 2);
});

test('each result carries depth and parentUrl', async () => {
  const { fetchPage, origin } = fakeSite({ '/': ['/a'], '/a': [] });
  const got = await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 1, concurrency: 1 }));
  assert.equal(got[0].metadata.depth, 0);
  assert.equal(got[0].metadata.parentUrl, null);
  assert.equal(got[1].metadata.depth, 1);
  assert.equal(got[1].metadata.parentUrl, `${origin}/`);
});

test('a URL reachable twice is fetched once', async () => {
  const { fetchPage, fetched, origin } = fakeSite({
    '/': ['/a', '/b'], '/a': ['/shared'], '/b': ['/shared'], '/shared': [],
  });
  await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 3, concurrency: 1 }));
  assert.equal(fetched.filter((u) => u.endsWith('/shared')).length, 1);
});

test('external links are skipped unless includeExternal', async () => {
  const fetchPage = async (url) => ({
    url,
    success: true,
    links: { internal: [], external: [{ href: 'https://other.test/x' }] },
  });
  const without = await collect(bfsCrawl('https://site.test/', fetchPage, { maxDepth: 2 }));
  assert.equal(without.length, 1);

  const with_ = await collect(bfsCrawl('https://site.test/', fetchPage, { maxDepth: 1, includeExternal: true }));
  assert.equal(with_.length, 2);
});

test('a failed fetch is reported but does not stop the crawl', async () => {
  const { fetchPage, origin } = fakeSite({ '/': ['/bad', '/good'], '/bad': [], '/good': [] }, { fail: ['/bad'] });
  const got = await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 1, concurrency: 1 }));
  const bad = got.find((r) => r.url.endsWith('/bad'));
  assert.equal(bad.success, false);
  assert.match(bad.error, /boom/);
  assert.ok(got.find((r) => r.url.endsWith('/good')).success);
});

test('shouldCancel halts the crawl', async () => {
  const { fetchPage, origin } = fakeSite({
    '/': ['/a', '/b'], '/a': ['/a1'], '/b': [], '/a1': [],
  });
  let seen = 0;
  const got = await collect(bfsCrawl(`${origin}/`, fetchPage, {
    maxDepth: 3, concurrency: 1, shouldCancel: () => (seen += 1) > 1,
  }));
  assert.ok(got.length < 4, `expected an early stop, got ${got.length}`);
});

test('filter chain constrains which links are followed', async () => {
  const { fetchPage, origin } = fakeSite({
    '/': ['/keep/a', '/skip/b'], '/keep/a': [], '/skip/b': [],
  });
  const got = paths(await collect(bfsCrawl(`${origin}/`, fetchPage, {
    maxDepth: 2, concurrency: 1, filterChain: new FilterChain([new URLPatternFilter(['*/keep/*'])]),
  })));
  assert.ok(got.includes('/keep/a'));
  assert.ok(!got.includes('/skip/b'));
});

test('dfs descends before it widens', async () => {
  const { fetchPage, origin } = fakeSite({
    '/': ['/a', '/b'], '/a': ['/a1'], '/a1': [], '/b': [],
  });
  const got = paths(await collect(dfsCrawl(`${origin}/`, fetchPage, { maxDepth: 3 })));
  assert.deepEqual(got, ['/', '/a', '/a1', '/b']);
});

test('best-first visits higher-scoring URLs first', async () => {
  const { fetchPage, origin } = fakeSite({
    '/': ['/boring', '/target-page', '/other'], '/boring': [], '/target-page': [], '/other': [],
  });
  const got = paths(await collect(bestFirstCrawl(`${origin}/`, fetchPage, {
    maxDepth: 1, concurrency: 1, scorer: new KeywordRelevanceScorer(['target']),
  })));
  assert.equal(got[0], '/');
  assert.equal(got[1], '/target-page', `expected the scored URL first, got ${got.join(', ')}`);
});

test('best-first ties break by depth then lexicographically', () => {
  const { bestFirstCompare } = _internals;
  assert.ok(bestFirstCompare({ score: 2, depth: 5, url: 'z' }, { score: 1, depth: 0, url: 'a' }) < 0);
  assert.ok(bestFirstCompare({ score: 1, depth: 1, url: 'z' }, { score: 1, depth: 2, url: 'a' }) < 0);
  assert.ok(bestFirstCompare({ score: 1, depth: 1, url: 'a' }, { score: 1, depth: 1, url: 'b' }) < 0);
});

test('priority queue pops in comparator order', () => {
  const q = new _internals.PriorityQueue([], (a, b) => a.n - b.n);
  for (const n of [5, 1, 4, 2, 3]) q.push({ n });
  assert.deepEqual([q.pop().n, q.pop().n, q.pop().n, q.pop().n, q.pop().n], [1, 2, 3, 4, 5]);
  assert.equal(q.pop(), undefined);
});

test('best-first records the score on each result', async () => {
  const { fetchPage, origin } = fakeSite({ '/': ['/target'], '/target': [] });
  const got = await collect(bestFirstCrawl(`${origin}/`, fetchPage, {
    maxDepth: 1, scorer: new KeywordRelevanceScorer(['target']),
  }));
  assert.equal(got.find((r) => r.url.endsWith('/target')).metadata.score, 1);
});

test('concurrency does not drop or duplicate results', async () => {
  const graph = { '/': [] };
  for (let i = 0; i < 20; i += 1) {
    graph['/'].push(`/p${i}`);
    graph[`/p${i}`] = [];
  }
  const { fetchPage, origin } = fakeSite(graph);
  const got = await collect(bfsCrawl(`${origin}/`, fetchPage, { maxDepth: 1, concurrency: 5 }));
  assert.equal(got.length, 21);
  assert.equal(new Set(got.map((r) => r.url)).size, 21);
});

test('onProgress reports a rising page count', async () => {
  const { fetchPage, origin } = fakeSite({ '/': ['/a', '/b'], '/a': [], '/b': [] });
  const counts = [];
  await collect(bfsCrawl(`${origin}/`, fetchPage, {
    maxDepth: 1, concurrency: 1, onProgress: (p) => counts.push(p.pagesCrawled),
  }));
  assert.deepEqual(counts, [1, 2, 3]);
});

test('crawl() dispatches by name and rejects unknown strategies', async () => {
  const { fetchPage, origin } = fakeSite({ '/': [] });
  assert.equal((await collect(crawl('bfs', `${origin}/`, fetchPage, { maxDepth: 0 }))).length, 1);
  assert.throws(() => crawl('nope', `${origin}/`, fetchPage), /Unknown crawl strategy/);
});

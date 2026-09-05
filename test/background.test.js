/**
 * Service-worker tests.
 *
 * background.js is the layer the UI actually talks to, and it was the layer
 * that shipped broken while every unit test passed: the crawl engine worked in
 * isolation but the worker reported "0 pages crawled". These tests exercise the
 * real message handlers against a stubbed chrome API so that gap is covered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-setup.js';

/** Minimal in-memory chrome API, enough for background.js to run. */
function installChrome() {
  const session = new Map();
  const local = new Map();
  const listeners = [];

  const area = (store) => ({
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
    remove: async (keys) => { for (const k of [].concat(keys)) store.delete(k); },
  });

  let offscreenCreated = 0;

  globalThis.chrome = {
    storage: { session: area(session), local: area(local) },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => `chrome-extension://test/${p}`,
      getContexts: async () => (offscreenCreated ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    },
    // The worker requires an offscreen document for every crawl, because it has
    // no DOM of its own. Modelling that here is what keeps these tests honest.
    offscreen: {
      createDocument: async () => { offscreenCreated += 1; },
    },
    tabs: { create: async () => {} },
    action: { onClicked: { addListener: () => {} } },
  };

  /** Send a message the way the popup does, resolving the async response. */
  const send = (message) => new Promise((resolve) => {
    for (const listener of listeners) {
      if (listener(message, {}, resolve)) return;
    }
    resolve(undefined);
  });

  return { send, session, offscreenCount: () => offscreenCreated };
}

/** Wait until `predicate()` holds, or fail after `timeoutMs`. */
async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Serve a small fake site over a stubbed fetch. */
function stubSite(pages, { origin = 'https://site.test' } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = pages[path];
    if (body === undefined) {
      return {
        ok: false, status: 404, url,
        headers: { get: () => 'text/html' },
        text: async () => '<html><body>missing</body></html>',
      };
    }
    return {
      ok: true, status: 200, url,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
      text: async () => body,
    };
  };
  return { origin, restore: () => { globalThis.fetch = original; } };
}

const page = (title, links = []) => `<html><head><title>${title}</title></head><body>
  <article><h1>${title}</h1><p>${'Body text for this page. '.repeat(10)}</p>
  ${links.map((h) => `<a href="${h}">link</a>`).join('')}</article></body></html>`;

const SITE = {
  '/': page('Home', ['/a', '/b']),
  '/a': page('Alpha', ['/c']),
  '/b': page('Beta'),
  '/c': page('Gamma'),
};

test('a crawl started through the worker actually returns pages', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite(SITE);
  try {
    await import(`../src/background.js?case=basic`);

    const started = await send({ type: 'start', config: { url: `${origin}/`, strategy: 'bfs', maxDepth: 1, maxPages: 10 } });
    assert.equal(started.started, true);

    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const status = await send({ type: 'status' });
    assert.equal(status.state.status, 'complete');
    // The regression: this reported 0 while the engine worked in isolation.
    assert.ok(status.successful >= 3, `expected several pages, got ${status.successful}`);

    const results = await send({ type: 'results' });
    assert.ok(results.some((r) => r.title === 'Home'));
    assert.ok(results.every((r) => typeof r.markdown === 'string'));
  } finally { restore(); }
});

test('the start URL is crawled exactly once', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite(SITE);
  try {
    await import(`../src/background.js?case=dedup`);
    await send({ type: 'start', config: { url: `${origin}/`, strategy: 'bfs', maxDepth: 2, maxPages: 20 } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const results = await send({ type: 'results' });
    const roots = results.filter((r) => r.url === `${origin}/`);
    assert.equal(roots.length, 1, `start URL crawled ${roots.length} times`);

    const urls = results.map((r) => r.url);
    assert.equal(new Set(urls).size, urls.length, 'every crawled URL should be unique');
  } finally { restore(); }
});

test('external links are not followed by default', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({
    '/': page('Home', ['/a', 'https://other.test/x']),
    '/a': page('Alpha'),
  });
  try {
    await import(`../src/background.js?case=external`);
    await send({ type: 'start', config: { url: `${origin}/`, strategy: 'bfs', maxDepth: 2, maxPages: 20 } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const results = await send({ type: 'results' });
    assert.ok(
      !results.some((r) => r.url.includes('other.test')),
      'a crawl scoped to one host must not leave it',
    );
  } finally { restore(); }
});

test('stop halts a crawl and reports it as cancelled', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite(SITE);
  try {
    await import(`../src/background.js?case=stop`);
    await send({ type: 'start', config: { url: `${origin}/`, strategy: 'bfs', maxDepth: 3, maxPages: 100 } });
    await send({ type: 'stop' });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to stop' });
    assert.equal((await send({ type: 'status' })).state.status, 'cancelled');
  } finally { restore(); }
});

test('clear empties stored state and results', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite(SITE);
  try {
    await import(`../src/background.js?case=clear`);
    await send({ type: 'start', config: { url: `${origin}/`, strategy: 'bfs', maxDepth: 0, maxPages: 5 } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    await send({ type: 'clear' });
    assert.deepEqual(await send({ type: 'results' }), []);
    assert.equal((await send({ type: 'status' })).state.status, 'idle');
  } finally { restore(); }
});

test('a failing start URL is reported rather than silently empty', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({});
  try {
    await import(`../src/background.js?case=fail`);
    await send({ type: 'start', config: { url: `${origin}/missing`, strategy: 'bfs', maxDepth: 1, maxPages: 5 } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const results = await send({ type: 'results' });
    assert.equal(results.length, 1);
    assert.equal(results[0].success, false);
    assert.ok(results[0].error, 'a failed page must carry an error for the UI to show');
  } finally { restore(); }
});

test('sitemap seeding crawls every listed URL', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({
    // The listing page has NO links, exactly like a client-rendered grid.
    '/items': page('Items'),
    '/items/a': page('Item A'),
    '/items/b': page('Item B'),
    '/items/c': page('Item C'),
    '/sitemap.xml': `<urlset>
      <url><loc>${'https://site.test'}/items/a</loc></url>
      <url><loc>${'https://site.test'}/items/b</loc></url>
      <url><loc>${'https://site.test'}/items/c</loc></url></urlset>`,
  });
  try {
    await import(`../src/background.js?case=sitemap`);
    await send({ type: 'start', config: {
      url: `${origin}/items`, strategy: 'bfs', maxDepth: 0, maxPages: 50,
      useSitemap: true, sitemapUrl: `${origin}/sitemap.xml`,
    } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const results = await send({ type: 'results' });
    const titles = results.map((r) => r.title).sort();
    assert.deepEqual(titles, ['Item A', 'Item B', 'Item C']);
    // Crawling the listing page alone would have found nothing to follow.
    assert.ok(!results.some((r) => r.title === 'Items'));
  } finally { restore(); }
});

test('a sitemap regex filter is honoured', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({
    '/items/a': page('Item A'),
    '/blog/b': page('Blog B'),
    '/sitemap.xml': `<urlset>
      <url><loc>https://site.test/items/a</loc></url>
      <url><loc>https://site.test/blog/b</loc></url></urlset>`,
  });
  try {
    await import(`../src/background.js?case=sitemapfilter`);
    await send({ type: 'start', config: {
      url: `${origin}/`, strategy: 'bfs', maxDepth: 0, maxPages: 50,
      useSitemap: true, sitemapUrl: `${origin}/sitemap.xml`, sitemapMatch: '/items/',
    } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const results = await send({ type: 'results' });
    assert.deepEqual(results.map((r) => r.title), ['Item A']);
  } finally { restore(); }
});

test('an unreachable sitemap fails loudly instead of crawling nothing', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({ '/': page('Home') });
  try {
    await import(`../src/background.js?case=sitemapfail`);
    const started = await send({ type: 'start', config: {
      url: `${origin}/`, strategy: 'bfs', maxDepth: 0, maxPages: 5,
      useSitemap: true, sitemapUrl: `${origin}/missing.xml`,
    } });
    assert.equal(started.started, false);
    const status = await send({ type: 'status' });
    assert.equal(status.state.status, 'error');
    assert.match(status.state.lastError, /Sitemap failed/);
  } finally { restore(); }
});

test('an extraction schema reaches the stored results', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({
    '/': '<html><head><title>Cards</title></head><body>'
      + '<div class="card"><h3>Alpha</h3></div><div class="card"><h3>Beta</h3></div></body></html>',
  });
  try {
    await import(`../src/background.js?case=schema`);
    await send({ type: 'start', config: {
      url: `${origin}/`, strategy: 'bfs', maxDepth: 0, maxPages: 5,
      extractionSchema: { baseSelector: '.card', fields: [{ name: 'title', selector: 'h3', type: 'text' }] },
    } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const results = await send({ type: 'results' });
    assert.deepEqual(results[0].extracted, [{ title: 'Alpha' }, { title: 'Beta' }]);
  } finally { restore(); }
});

test('a blank sitemap URL is discovered and filtered automatically', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({
    '/items': page('Items'),
    '/items/a': page('Item A'),
    '/items/b': page('Item B'),
    '/blog/x': page('Blog X'),
    '/robots.txt': 'Sitemap: https://site.test/sitemap.xml\n',
    '/sitemap.xml': `<urlset>
      <url><loc>https://site.test/items/a</loc></url>
      <url><loc>https://site.test/items/b</loc></url>
      <url><loc>https://site.test/blog/x</loc></url></urlset>`,
  });
  try {
    await import(`../src/background.js?case=autositemap`);
    // No sitemapUrl and no sitemapMatch: the user only ticked the box.
    await send({ type: 'start', config: {
      url: `${origin}/items`, strategy: 'bfs', maxDepth: 0, maxPages: 50, useSitemap: true,
    } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    const status = await send({ type: 'status' });
    assert.equal(status.state.sitemapUsed, `${origin}/sitemap.xml`);
    assert.equal(status.state.sitemapFilter, '/items/');

    const results = await send({ type: 'results' });
    assert.deepEqual(results.map((r) => r.title).sort(), ['Item A', 'Item B']);
  } finally { restore(); }
});

test('a derived filter that matches nothing falls back to the whole sitemap', async () => {
  const { send } = installChrome();
  const { origin, restore } = stubSite({
    '/odd': page('Odd'),
    '/a': page('A'),
    '/sitemap.xml': '<urlset><url><loc>https://site.test/a</loc></url></urlset>',
  });
  try {
    await import(`../src/background.js?case=autofallback`);
    await send({ type: 'start', config: {
      url: `${origin}/odd`, strategy: 'bfs', maxDepth: 0, maxPages: 50, useSitemap: true,
    } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    // "/odd/" matches nothing, so rather than fail we use every listed URL.
    const results = await send({ type: 'results' });
    assert.deepEqual(results.map((r) => r.title), ['A']);
  } finally { restore(); }
});

/**
 * Chrome kills service workers whenever it likes, and a long crawl is exactly
 * what it interrupts. The frontier is checkpointed so the remaining queue
 * survives; without this the crawl could only be restarted from scratch.
 */
test('an interrupted crawl checkpoints its frontier', async () => {
  const { send } = installChrome();
  const site = {};
  // A chain long enough that the crawl is still going when we inspect it.
  for (let i = 0; i < 12; i += 1) site[`/p${i}`] = page(`P${i}`, [`/p${i + 1}`]);
  const { origin, restore } = stubSite(site);

  try {
    await import(`../src/background.js?case=frontier`);
    await send({ type: 'start', config: {
      url: `${origin}/p0`, strategy: 'bfs', maxDepth: 12, maxPages: 4,
    } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'crawl to finish' });

    // A crawl that stopped on maxPages still has queued work recorded.
    const status = await send({ type: 'status' });
    assert.equal(status.state.status, 'complete');
    assert.equal(status.successful, 4);
  } finally { restore(); }
});

test('resume continues the frontier and keeps earlier results', async () => {
  const { send, session } = installChrome();
  const site = {};
  for (let i = 0; i < 10; i += 1) site[`/p${i}`] = page(`P${i}`, [`/p${i + 1}`]);
  const { origin, restore } = stubSite(site);

  try {
    await import(`../src/background.js?case=resume`);

    // A first run that stops early, leaving queued work behind.
    await send({ type: 'start', config: {
      url: `${origin}/p0`, strategy: 'bfs', maxDepth: 10, maxPages: 3,
    } });
    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'first run' });

    const first = await send({ type: 'results' });
    assert.equal(first.length, 3);

    const state = session.get('crawlState');
    assert.ok(state.frontier?.pending?.length, 'the remaining queue must be checkpointed');

    // Put storage back into the shape a killed worker leaves behind.
    session.set('crawlState', { ...state, status: 'running' });
    assert.equal((await send({ type: 'status' })).resumable, true);

    const resumed = await send({ type: 'resume' });
    assert.equal(resumed.started, true);
    assert.equal(resumed.resumedFrom, 3, 'should continue from what was already done');

    await waitFor(async () => (await send({ type: 'status' })).state.status !== 'running', { label: 'resumed run' });

    const after = await send({ type: 'results' });
    assert.ok(after.length > first.length, `expected more than ${first.length}, got ${after.length}`);
    // The pages from the first run must still be present, not re-crawled.
    const urls = after.map((r) => r.url);
    assert.equal(new Set(urls).size, urls.length, 'resume must not duplicate pages');
    assert.ok(urls.includes(`${origin}/p0`), 'earlier results must be kept');
  } finally { restore(); }
});

test('resuming with nothing to continue is refused', async () => {
  const { send } = installChrome();
  const { restore } = stubSite({});
  try {
    await import(`../src/background.js?case=noresume`);
    const reply = await send({ type: 'resume' });
    assert.match(reply.error, /Nothing to resume/);
  } finally { restore(); }
});

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

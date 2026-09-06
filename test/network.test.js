import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * network.js runs unmodified inside a page's MAIN world and reads `location`
 * and `XMLHttpRequest` as ambient globals, so it is exercised here by
 * installing a minimal page environment and loading it fresh each time.
 *
 * The module captures whatever `fetch` exists at load time as its "original"
 * and replaces `globalThis.fetch` with a wrapper around it. Tests must
 * therefore call the wrapper (still `globalThis.fetch` after import) rather
 * than stub `globalThis.fetch` directly for each response -- doing that would
 * bypass the patch entirely and the module's `record()` would never run. A
 * mutable queue lets each test control what the underlying mock returns while
 * still going through the real, patched fetch.
 */
async function loadNetworkModule({ href = 'https://site.test/list' } = {}) {
  globalThis.window = globalThis;
  globalThis.location = { href };
  globalThis.XMLHttpRequest = class {
    open() {}
    addEventListener() {}
  };

  const queue = { status: 200, body: '' };
  globalThis.fetch = async () => ({
    status: queue.status,
    clone: () => ({ text: async () => queue.body }),
  });

  // Bust the module cache and the capture store, so each test starts clean.
  globalThis.__crawletteNet = undefined;
  await import(`../src/content/network.js?t=${Math.random()}`);

  return { store: globalThis.__crawletteNet, queue };
}

/** Set the next response and call the module's (already-patched) fetch. */
async function fetchWith(queue, body, url, options) {
  queue.body = body;
  await globalThis.fetch(url, options);
}

test('captures a JSON array response and counts its items', async () => {
  const { store, queue } = await loadNetworkModule();
  await fetchWith(queue, '[1,2,3]', 'https://site.test/api/items?page=2&per_page=20', { method: 'GET' });

  const call = store.calls.at(-1);
  assert.equal(call.itemCount, 3);
  assert.equal(call.itemKey, '');
  assert.deepEqual(call.paginationParams.sort(), ['page', 'per_page']);
});

test('finds the largest array under a wrapper key', async () => {
  const { store, queue } = await loadNetworkModule();
  const body = JSON.stringify({ meta: { total: 400 }, data: [1, 2, 3, 4, 5] });
  await fetchWith(queue, body, 'https://site.test/api/speakers');

  const call = store.calls.at(-1);
  assert.equal(call.itemCount, 5);
  assert.equal(call.itemKey, 'data');
  assert.deepEqual(call.paginationHints, ['meta']);
});

test('surfaces total/hasMore-style pagination metadata', async () => {
  const { store, queue } = await loadNetworkModule();
  const body = JSON.stringify({ items: [1, 2], total: 333, hasMore: true, nextCursor: 'abc' });
  await fetchWith(queue, body, 'https://site.test/api/speakers?cursor=xyz');

  const call = store.calls.at(-1);
  assert.deepEqual(call.paginationHints.sort(), ['hasMore', 'nextCursor', 'total'].sort());
  assert.deepEqual(call.paginationParams, ['cursor']);
});

test('ignores non-JSON bodies (HTML, assets)', async () => {
  const { store, queue } = await loadNetworkModule();
  await fetchWith(queue, '<html></html>', 'https://site.test/page.html');
  assert.equal(store.calls.length, 0);
});

test('ignores unparseable JSON-looking bodies without throwing', async () => {
  const { store, queue } = await loadNetworkModule();
  await fetchWith(queue, '{not valid', 'https://site.test/broken');
  assert.equal(store.calls.length, 0);
});

test('a relative URL with no pagination params yields an empty list, not a throw', async () => {
  const { store, queue } = await loadNetworkModule({ href: 'https://site.test/list' });
  await fetchWith(queue, '[1,2]', '/api/items');

  const call = store.calls.at(-1);
  assert.deepEqual(call.paginationParams, []);
});

test('recognises a bare JSON array with no wrapper', async () => {
  const { store, queue } = await loadNetworkModule();
  await fetchWith(queue, '[{"a":1},{"a":2},{"a":3},{"a":4}]', 'https://site.test/api/raw');
  const call = store.calls.at(-1);
  assert.equal(call.itemCount, 4);
  assert.equal(call.itemKey, '');
});

test('a call with no arrays anywhere reports zero items', async () => {
  const { store, queue } = await loadNetworkModule();
  await fetchWith(queue, JSON.stringify({ ok: true }), 'https://site.test/api/ping');
  assert.equal(store.calls.at(-1).itemCount, 0);
});

test('caps captured bodies so a huge asset response is skipped', async () => {
  const { store, queue } = await loadNetworkModule();
  const huge = `[${'1,'.repeat(2_500_000)}1]`; // well over the 4MB cap
  await fetchWith(queue, huge, 'https://site.test/api/huge');
  assert.equal(store.calls.length, 0);
});

test('does not re-patch fetch if the module is already installed', async () => {
  const { store: first } = await loadNetworkModule();
  // Loading again with the store still present must be a no-op guard.
  await import(`../src/content/network.js?t=${Math.random()}`);
  assert.equal(globalThis.__crawletteNet, first);
});

/**
 * Regression, built from a real capture on unbound.hubspot.com/speakers.
 *
 * The "biggest array wins" rule picked `all_tags` (81 plain tag strings) over
 * `speakers` (20 rich objects: name, job_title, company, images, sessions) --
 * exactly backwards, since `speakers` is the actual paginated record the user
 * was recording and `all_tags` is a filter taxonomy that just happens to be
 * longer. An LLM reading `itemKey: "all_tags"` would look in the wrong place
 * entirely for the data it was told this endpoint returns.
 */
test('prefers a rich record array over a longer flat array (real HubSpot shape)', async () => {
  const { store, queue } = await loadNetworkModule();

  const speaker = (i) => ({
    id: `id-${i}`,
    slug: `speaker-${i}`,
    name: `Speaker ${i}`,
    profile_image: [{ url: `https://cdn.test/${i}.png` }],
    featured_speaker_image: [],
    featured_speaker_logo: [],
    job_title: 'Community Lead',
    company: 'Gamma',
    featured: false,
    featured_order: null,
    bio: 'A short bio for this speaker.',
    sessions: [],
  });

  const body = JSON.stringify({
    total: 334,
    pages: 17,
    current_page: '2',
    per_page: '20',
    offset: 20,
    speakers: Array.from({ length: 20 }, (_, i) => speaker(i)),
    all_tags: Array.from({ length: 81 }, (_, i) => `tag-${i}`),
  });

  await fetchWith(queue, body, 'https://unbound.hubspot.com/api/v2/speakers?year=2026&page=2&per_page=20');

  const call = store.calls.at(-1);
  assert.equal(call.itemKey, 'speakers', `expected "speakers", got "${call.itemKey}"`);
  assert.equal(call.itemCount, 20);
});

test('catches the pagination keys a real API actually used (pages, per_page, current_page)', async () => {
  const { store, queue } = await loadNetworkModule();
  const body = JSON.stringify({
    total: 334, pages: 17, current_page: '2', per_page: '20', offset: 20, speakers: [{ id: 1 }],
  });
  await fetchWith(queue, body, 'https://unbound.hubspot.com/api/v2/speakers?page=2&per_page=20');

  const call = store.calls.at(-1);
  for (const key of ['total', 'pages', 'current_page', 'per_page', 'offset']) {
    assert.ok(call.paginationHints.includes(key), `expected paginationHints to include "${key}", got ${JSON.stringify(call.paginationHints)}`);
  }
});

test('a short flat array still wins when nothing richer exists', async () => {
  const { store, queue } = await loadNetworkModule();
  const body = JSON.stringify({ tags: ['a', 'b', 'c'] });
  await fetchWith(queue, body, 'https://site.test/api/tags');
  const call = store.calls.at(-1);
  assert.equal(call.itemKey, 'tags');
  assert.equal(call.itemCount, 3);
});

test('an array of near-empty objects does not beat a smaller array of rich ones', async () => {
  const { store, queue } = await loadNetworkModule();
  const body = JSON.stringify({
    ids: Array.from({ length: 50 }, (_, i) => ({ id: i })),          // 50 objects, 1 key each
    records: Array.from({ length: 10 }, (_, i) => ({                  // 10 objects, 6 keys each
      id: i, name: `N${i}`, email: 'x', role: 'y', active: true, tag: 'z',
    })),
  });
  await fetchWith(queue, body, 'https://site.test/api/mixed');
  const call = store.calls.at(-1);
  assert.equal(call.itemKey, 'records', `expected "records" (richer) over "ids" (longer), got "${call.itemKey}"`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSitemap, looksLikeSitemap, guessSitemapUrls } from '../src/core/crawl/sitemap.js';

/** Serve a map of url -> body over a stubbed fetch. */
function stubFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  return () => { globalThis.fetch = original; };
}

const urlset = (urls) => `<?xml version="1.0"?><urlset>${
  urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

test('reads URLs from a urlset', async () => {
  const restore = stubFetch({
    'https://s.test/sitemap.xml': urlset(['https://s.test/a', 'https://s.test/b']),
  });
  try {
    assert.deepEqual(await fetchSitemap('https://s.test/sitemap.xml'), ['https://s.test/a', 'https://s.test/b']);
  } finally { restore(); }
});

test('follows a sitemap index', async () => {
  const restore = stubFetch({
    'https://s.test/index.xml': `<sitemapindex>
      <sitemap><loc>https://s.test/one.xml</loc></sitemap>
      <sitemap><loc>https://s.test/two.xml</loc></sitemap></sitemapindex>`,
    'https://s.test/one.xml': urlset(['https://s.test/a']),
    'https://s.test/two.xml': urlset(['https://s.test/b']),
  });
  try {
    const urls = await fetchSitemap('https://s.test/index.xml');
    assert.deepEqual(urls.sort(), ['https://s.test/a', 'https://s.test/b']);
  } finally { restore(); }
});

test('a broken child sitemap does not sink the rest', async () => {
  const restore = stubFetch({
    'https://s.test/index.xml': `<sitemapindex>
      <sitemap><loc>https://s.test/missing.xml</loc></sitemap>
      <sitemap><loc>https://s.test/ok.xml</loc></sitemap></sitemapindex>`,
    'https://s.test/ok.xml': urlset(['https://s.test/a']),
  });
  try {
    assert.deepEqual(await fetchSitemap('https://s.test/index.xml'), ['https://s.test/a']);
  } finally { restore(); }
});

test('match filters URLs and limit caps them', async () => {
  const restore = stubFetch({
    'https://s.test/s.xml': urlset([
      'https://s.test/speakers/a', 'https://s.test/blog/b', 'https://s.test/speakers/c',
    ]),
  });
  try {
    const filtered = await fetchSitemap('https://s.test/s.xml', { match: /\/speakers\// });
    assert.deepEqual(filtered, ['https://s.test/speakers/a', 'https://s.test/speakers/c']);

    const capped = await fetchSitemap('https://s.test/s.xml', { limit: 2 });
    assert.equal(capped.length, 2);
  } finally { restore(); }
});

test('de-duplicates repeated URLs', async () => {
  const restore = stubFetch({
    'https://s.test/s.xml': urlset(['https://s.test/a', 'https://s.test/a', 'https://s.test/b']),
  });
  try {
    assert.equal((await fetchSitemap('https://s.test/s.xml')).length, 2);
  } finally { restore(); }
});

test('reads a plain-text sitemap', async () => {
  const restore = stubFetch({
    'https://s.test/s.txt': 'https://s.test/a\nhttps://s.test/b\n\n',
  });
  try {
    assert.deepEqual(await fetchSitemap('https://s.test/s.txt'), ['https://s.test/a', 'https://s.test/b']);
  } finally { restore(); }
});

test('ignores non-http entries', async () => {
  const restore = stubFetch({
    'https://s.test/s.xml': urlset(['ftp://s.test/a', 'https://s.test/b', 'javascript:void(0)']),
  });
  try {
    assert.deepEqual(await fetchSitemap('https://s.test/s.xml'), ['https://s.test/b']);
  } finally { restore(); }
});

test('a failed fetch throws with the status', async () => {
  const restore = stubFetch({});
  try {
    await assert.rejects(() => fetchSitemap('https://s.test/nope.xml'), /404/);
  } finally { restore(); }
});

test('recognises sitemap-looking URLs', () => {
  assert.equal(looksLikeSitemap('https://s.test/sitemap.xml'), true);
  assert.equal(looksLikeSitemap('https://s.test/__sitemap__/speakers.xml'), true);
  assert.equal(looksLikeSitemap('https://s.test/speakers'), false);
});

test('guesses conventional sitemap locations', () => {
  const guesses = guessSitemapUrls('https://s.test/some/page');
  assert.ok(guesses.includes('https://s.test/sitemap.xml'));
  assert.equal(guessSitemapUrls('not a url').length, 0);
});

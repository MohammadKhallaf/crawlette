import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchSitemap, looksLikeSitemap, guessSitemapUrls, isSameOriginSitemap,
  discoverSitemap, deriveMatchFromUrl,
} from '../src/crawl/sitemap.ts';

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

/**
 * A sitemap index is content the crawl target controls. Following its children
 * to arbitrary hosts would let it aim credentialed requests at internal
 * services -- SSRF driven by a remote document.
 */
test('a hostile sitemap index cannot reach other origins', async () => {
  let fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(url);
    if (url === 'https://evil.test/sitemap.xml') {
      return { ok: true, status: 200, text: async () => `<sitemapindex>
        <sitemap><loc>http://localhost:8080/admin.xml</loc></sitemap>
        <sitemap><loc>http://169.254.169.254/latest/meta-data.xml</loc></sitemap>
        <sitemap><loc>https://intranet.corp/sitemap.xml</loc></sitemap>
        <sitemap><loc>https://evil.test/ok.xml</loc></sitemap></sitemapindex>` };
    }
    if (url === 'https://evil.test/ok.xml') {
      return { ok: true, status: 200, text: async () => urlset(['https://evil.test/page']) };
    }
    return { ok: true, status: 200, text: async () => urlset(['https://leaked.test/secret']) };
  };

  try {
    const urls = await fetchSitemap('https://evil.test/sitemap.xml');

    for (const bad of ['localhost', '169.254.169.254', 'intranet.corp']) {
      assert.ok(
        !fetched.some((u) => u.includes(bad)),
        `must not fetch ${bad}; fetched ${JSON.stringify(fetched)}`,
      );
    }
    assert.deepEqual(urls, ['https://evil.test/page']);
  } finally { globalThis.fetch = original; }
});

test('same-origin children are still followed', async () => {
  const restore = stubFetch({
    'https://s.test/index.xml': `<sitemapindex>
      <sitemap><loc>https://s.test/child.xml</loc></sitemap></sitemapindex>`,
    'https://s.test/child.xml': urlset(['https://s.test/a']),
  });
  try {
    assert.deepEqual(await fetchSitemap('https://s.test/index.xml'), ['https://s.test/a']);
  } finally { restore(); }
});

test('isSameOriginSitemap rejects other origins, ports and schemes', () => {
  const parent = 'https://s.test/sitemap.xml';
  assert.equal(isSameOriginSitemap('https://s.test/child.xml', parent), true);
  assert.equal(isSameOriginSitemap('https://other.test/child.xml', parent), false);
  assert.equal(isSameOriginSitemap('http://s.test/child.xml', parent), false); // scheme differs
  assert.equal(isSameOriginSitemap('https://s.test:8443/child.xml', parent), false); // port differs
  assert.equal(isSameOriginSitemap('file:///etc/passwd', parent), false);
  assert.equal(isSameOriginSitemap('javascript:alert(1)', parent), false);
  assert.equal(isSameOriginSitemap('not a url', parent), false);
});

test('discovers the sitemap advertised in robots.txt', async () => {
  const restore = stubFetch({
    'https://s.test/robots.txt': 'User-agent: *\nAllow: /\n\nSitemap: https://s.test/custom/deep.xml\n',
    'https://s.test/custom/deep.xml': urlset(['https://s.test/a']),
  });
  try {
    assert.equal(await discoverSitemap('https://s.test/speakers'), 'https://s.test/custom/deep.xml');
  } finally { restore(); }
});

test('falls back to conventional sitemap paths', async () => {
  const restore = stubFetch({
    'https://s.test/sitemap.xml': urlset(['https://s.test/a']),
  });
  try {
    assert.equal(await discoverSitemap('https://s.test/page'), 'https://s.test/sitemap.xml');
  } finally { restore(); }
});

test('discovery ignores an off-origin robots.txt advertisement', async () => {
  // robots.txt is remote content; it must not be able to aim us elsewhere.
  const restore = stubFetch({
    'https://s.test/robots.txt': 'Sitemap: http://localhost:8080/internal.xml\n',
    'https://s.test/sitemap.xml': urlset(['https://s.test/a']),
  });
  try {
    assert.equal(await discoverSitemap('https://s.test/page'), 'https://s.test/sitemap.xml');
  } finally { restore(); }
});

test('discovery returns null when nothing responds', async () => {
  const restore = stubFetch({});
  try {
    assert.equal(await discoverSitemap('https://s.test/page'), null);
    assert.equal(await discoverSitemap('not a url'), null);
  } finally { restore(); }
});

test('derives a section filter from the start URL', () => {
  assert.equal(deriveMatchFromUrl('https://s.test/speakers'), '/speakers/');
  assert.equal(deriveMatchFromUrl('https://s.test/speakers/adam'), '/speakers/');
  assert.equal(deriveMatchFromUrl('https://s.test/'), null);
});

/**
 * The hand-rolled <loc> regex this replaced captured raw tag text without
 * decoding entities, so a tracking-parameter URL containing "&amp;" stayed
 * literally "&amp;" in the returned list instead of "&". fast-xml-parser
 * decodes entities as any real XML parser must.
 */
test('decodes XML entities in <loc> (e.g. &amp; -> &)', async () => {
  const restore = stubFetch({
    'https://s.test/s.xml': urlset(['https://s.test/a?x=1&amp;y=2']),
  });
  try {
    const urls = await fetchSitemap('https://s.test/s.xml');
    assert.deepEqual(urls, ['https://s.test/a?x=1&y=2']);
  } finally { restore(); }
});

test('handles a CDATA-wrapped <loc>', async () => {
  const restore = stubFetch({
    'https://s.test/s.xml': '<urlset><url><loc><![CDATA[https://s.test/a?x=1&y=2]]></loc></url></urlset>',
  });
  try {
    const urls = await fetchSitemap('https://s.test/s.xml');
    assert.deepEqual(urls, ['https://s.test/a?x=1&y=2']);
  } finally { restore(); }
});

/**
 * fetchSitemap/discoverSitemap fetch whatever URL they are given. That was a
 * non-issue in the one context this module originally shipped in -- a
 * browser extension popup where the "attacker" would have to be the user
 * typing into their own address bar. It stops being a non-issue as a
 * general-purpose package: a server exposing "fetch the sitemap for this
 * URL" as a public endpoint, fed user input, is a textbook SSRF proxy
 * otherwise. The fix does not attempt to block private IP ranges (that needs
 * DNS-level control this module cannot exercise soundly) -- it closes what a
 * library reasonably can: refuse non-http(s) schemes outright.
 */
test('fetchSitemap rejects non-http(s) schemes', async () => {
  const restore = stubFetch({});
  try {
    await assert.rejects(() => fetchSitemap('file:///etc/passwd'), /only http\(s\) URLs/);
    await assert.rejects(() => fetchSitemap('javascript:alert(1)'), /only http\(s\) URLs/);
    await assert.rejects(() => fetchSitemap('ftp://example.com/x'), /only http\(s\) URLs/);
  } finally { restore(); }
});

test('fetchSitemap rejects a data: URI rather than resolving it locally', async () => {
  // Some fetch implementations resolve data: URIs with no network request at
  // all, letting a caller inject fabricated "sitemap" content while bypassing
  // the assumption that a real remote resource is being fetched.
  const restore = stubFetch({});
  try {
    await assert.rejects(
      () => fetchSitemap('data:text/xml,<urlset><url><loc>http://evil.test/x</loc></url></urlset>'),
      /only http\(s\) URLs/,
    );
  } finally { restore(); }
});

test('fetchSitemap still rejects an unparseable URL clearly', async () => {
  const restore = stubFetch({});
  try {
    await assert.rejects(() => fetchSitemap('not a url'), /not a valid URL/);
  } finally { restore(); }
});

test('discoverSitemap degrades to null on a non-http(s) pageUrl rather than throwing', async () => {
  const restore = stubFetch({});
  try {
    assert.equal(await discoverSitemap('javascript:alert(1)'), null);
    assert.equal(await discoverSitemap('data:text/html,x'), null);
  } finally { restore(); }
});

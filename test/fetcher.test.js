import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-setup.js';
import { processHtml, rawFetch, fetchPage } from '../src/core/crawl/fetcher.js';

const URL_ = 'https://example.com/post';

const PAGE = `<html><head><title>Post Title</title>
  <meta name="description" content="A description"></head>
  <body>
    <nav><a href="/nav">nav link</a></nav>
    <article>
      <h1>Heading</h1>
      <p>${'This is the body of the article with enough words to be real content. '.repeat(5)}</p>
      <a href="/next">next page</a>
      <a href="https://other.org/x">external</a>
      <img src="/hero.jpg" alt="Hero image" width="900" height="600" srcset="/hero.jpg 900w">
    </article>
  </body></html>`;

/** Install a fake global fetch returning `body`. */
function stubFetch(body, { status = 200, contentType = 'text/html', url = URL_ } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  });
  return () => { globalThis.fetch = original; };
}

test('processHtml returns a crawl4ai-shaped result', () => {
  const r = processHtml(PAGE, URL_);
  for (const k of ['url', 'success', 'cleanedHtml', 'markdown', 'links', 'media', 'tables', 'metadata', 'wordCount']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.equal(r.success, true);
  assert.equal(r.metadata.title, 'Post Title');
  assert.ok(r.wordCount > 20);
});

test('processHtml produces every markdown variant', () => {
  const r = processHtml(PAGE, URL_);
  assert.match(r.markdown.rawMarkdown, /Heading/);
  assert.match(r.markdown.markdownWithCitations, /⟨1⟩/);
  assert.match(r.markdown.referencesMarkdown, /## References/);
});

test('processHtml classifies links relative to the page', () => {
  const r = processHtml(PAGE, URL_);
  assert.ok(r.links.internal.some((l) => l.href.endsWith('/next')));
  assert.ok(r.links.external.some((l) => l.href.includes('other.org')));
});

test('processHtml keeps a well-scored image', () => {
  const r = processHtml(PAGE, URL_);
  assert.ok(r.media.images.some((i) => i.src.includes('hero.jpg')));
});

test('readability filter yields fit markdown for an article', () => {
  const r = processHtml(PAGE, URL_, { contentFilter: 'readability' });
  assert.ok(r.markdown.fitMarkdown.length > 0, 'expected fit markdown from an article page');
  assert.ok(!r.markdown.fitMarkdown.includes('nav link'));
});

test('contentFilter "none" leaves fit markdown empty', () => {
  const r = processHtml(PAGE, URL_, { contentFilter: 'none' });
  assert.equal(r.markdown.fitMarkdown, '');
});

test('scrapeOptions pass through to the scraper', () => {
  const r = processHtml(PAGE, URL_, { scrapeOptions: { excludeExternalLinks: true } });
  assert.equal(r.links.external.length, 0);
});

test('rawFetch returns a processed page', async () => {
  const restore = stubFetch(PAGE);
  try {
    const r = await rawFetch(URL_);
    assert.equal(r.success, true);
    assert.equal(r.statusCode, 200);
    assert.match(r.markdown.rawMarkdown, /Heading/);
  } finally { restore(); }
});

test('rawFetch reports HTTP errors without throwing', async () => {
  const restore = stubFetch('<html><body>nope</body></html>', { status: 404 });
  try {
    const r = await rawFetch(URL_);
    assert.equal(r.success, false);
    assert.match(r.error, /404/);
  } finally { restore(); }
});

test('rawFetch skips non-HTML content types', async () => {
  const restore = stubFetch('{}', { contentType: 'application/json' });
  try {
    const r = await rawFetch(URL_);
    assert.equal(r.success, false);
    assert.match(r.error, /Unsupported content type/);
  } finally { restore(); }
});

test('rawFetch surfaces network errors as failed results', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const r = await rawFetch(URL_);
    assert.equal(r.success, false);
    assert.match(r.error, /network down/);
  } finally { globalThis.fetch = original; }
});

test('rawFetch records a redirect', async () => {
  const restore = stubFetch(PAGE, { url: 'https://example.com/final' });
  try {
    const r = await rawFetch(URL_);
    assert.equal(r.redirectedUrl, 'https://example.com/final');
  } finally { restore(); }
});

test('fetchPage defaults to raw mode', async () => {
  const restore = stubFetch(PAGE);
  try {
    assert.equal((await fetchPage(URL_)).success, true);
  } finally { restore(); }
});

test('rendered mode falls back to raw outside the extension runtime', async () => {
  const restore = stubFetch(PAGE);
  try {
    const r = await fetchPage(URL_, { mode: 'rendered' });
    assert.equal(r.success, true, 'should fall back rather than fail');
  } finally { restore(); }
});

test('an extraction schema populates result.extracted', () => {
  const r = processHtml(
    '<html><body><div class="item"><h3>Alpha</h3></div><div class="item"><h3>Beta</h3></div></body></html>',
    URL_,
    { extractionSchema: { baseSelector: 'div.item', fields: [{ name: 'title', selector: 'h3', type: 'text' }] } },
  );
  assert.deepEqual(r.extracted, [{ title: 'Alpha' }, { title: 'Beta' }]);
});

test('extracted is null when no schema is given', () => {
  assert.equal(processHtml(PAGE, URL_).extracted, null);
});

test('a broken schema is reported without failing the page', () => {
  const r = processHtml(PAGE, URL_, { extractionSchema: { fields: [] } });
  assert.equal(r.success, true);
  assert.match(r.extracted.error, /baseSelector/);
});

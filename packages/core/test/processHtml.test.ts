import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-setup.ts';
import { processHtml } from '../src/crawl/processHtml.ts';

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
  const r = processHtml(PAGE, URL_, { extractionSchema: { fields: [] } as never });
  assert.equal(r.success, true);
  assert.match((r.extracted as { error: string }).error, /baseSelector/);
});

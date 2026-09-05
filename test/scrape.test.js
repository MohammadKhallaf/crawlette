import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { scrape } from '../src/core/scrape.js';

const URL_ = 'https://example.com/blog/post';

const doc = (html) => parseHTML(`<html><head><title>T</title></head><body>${html}</body></html>`).document;

test('strips script, style and noscript unconditionally', () => {
  const r = scrape(doc('<p>keep</p><script>bad()</script><style>.x{}</style><noscript>ns</noscript>'), URL_);
  assert.match(r.cleanedHtml, /keep/);
  for (const gone of ['bad()', '.x{}', 'ns']) assert.ok(!r.cleanedHtml.includes(gone));
});

test('classifies links and dedupes by normalized href', () => {
  const r = scrape(doc(`
    <a href="/a">one</a><a href="/a?utm_source=x">dup</a>
    <a href="https://other.org/b">ext</a>
    <a href="https://docs.example.com/c">sub</a>`), URL_);
  assert.equal(r.links.internal.length, 2); // /a and the docs subdomain
  assert.equal(r.links.external.length, 1);
  assert.equal(r.links.external[0].href, 'https://other.org/b');
});

test('excludeExternalLinks removes the anchor from output', () => {
  const r = scrape(doc('<a href="https://other.org/b">x</a><p>body</p>'), URL_, { excludeExternalLinks: true });
  assert.equal(r.links.external.length, 0);
  assert.ok(!r.cleanedHtml.includes('other.org'));
});

test('excludeSocialMediaLinks drops social hosts only', () => {
  const r = scrape(doc('<a href="https://twitter.com/a">t</a><a href="https://other.org/b">o</a>'),
    URL_, { excludeSocialMediaLinks: true });
  assert.deepEqual(r.links.external.map((l) => l.href), ['https://other.org/b']);
});

test('keeps high-scoring images and rejects low-scoring ones', () => {
  // width+height+alt+first-half+format+srcset = 6 > 2
  const good = '<img src="/big.jpg" alt="A photo" width="800" height="600" srcset="/big.jpg 800w">';
  // no dimensions, no alt, no format -> below threshold
  const bad = '<img src="/tiny">';
  const r = scrape(doc(good + bad), URL_);
  const srcs = r.media.images.map((i) => i.src);
  assert.ok(srcs.includes('https://example.com/big.jpg'));
  assert.ok(!srcs.includes('https://example.com/tiny'));
});

test('rejects images that look like chrome', () => {
  const r = scrape(doc('<img src="/nav-icon.png" alt="icon" width="800" height="600" srcset="/a 2w">'), URL_);
  assert.equal(r.media.images.length, 0);
});

test('resolves relative image URLs and records variants in one group', () => {
  const r = scrape(doc('<img src="a.png" alt="x" width="900" height="900" srcset="b.png 400w">'), URL_);
  assert.ok(r.media.images.length >= 2);
  assert.ok(r.media.images.every((i) => i.src.startsWith('https://example.com/blog/')));
  assert.equal(new Set(r.media.images.map((i) => i.groupId)).size, 1);
});

test('extracts tables with headers and rows', () => {
  const r = scrape(doc('<table><caption>Cap</caption><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></table>'), URL_);
  assert.equal(r.tables.length, 1);
  assert.deepEqual(r.tables[0].headers, ['H1', 'H2']);
  assert.deepEqual(r.tables[0].rows, [['a', 'b']]);
  assert.equal(r.tables[0].caption, 'Cap');
});

test('cssSelector narrows the emitted content', () => {
  const r = scrape(doc('<div class="main"><p>wanted</p></div><div class="side"><p>unwanted</p></div>'),
    URL_, { cssSelector: '.main' });
  assert.match(r.cleanedHtml, /wanted/);
  assert.ok(!r.cleanedHtml.includes('unwanted'));
});

test('strips unimportant attributes but keeps important ones', () => {
  const r = scrape(doc('<p class="c" id="i" style="color:red" onclick="x()" data-k="v">t</p>'), URL_);
  assert.match(r.cleanedHtml, /class="c"/);
  assert.match(r.cleanedHtml, /id="i"/);
  assert.ok(!r.cleanedHtml.includes('onclick'));
  assert.ok(!r.cleanedHtml.includes('style='));
  assert.ok(!r.cleanedHtml.includes('data-k'));
});

test('keepDataAttributes preserves data-*', () => {
  const r = scrape(doc('<p data-k="v">t</p>'), URL_, { keepDataAttributes: true });
  assert.match(r.cleanedHtml, /data-k="v"/);
});

test('honours <base href> when resolving links', () => {
  const d = parseHTML('<html><head><base href="https://cdn.example.com/x/"></head><body><a href="y">l</a></body></html>').document;
  const r = scrape(d, URL_);
  const all = [...r.links.internal, ...r.links.external];
  assert.equal(all[0].href, 'https://cdn.example.com/x/y');
});

test('captures metadata before pruning', () => {
  const d = parseHTML(`<html><head><title>My Title</title>
    <meta name="description" content="A description">
    <link rel="canonical" href="https://example.com/c"></head><body><p>x</p></body></html>`).document;
  const r = scrape(d, URL_);
  assert.equal(r.metadata.title, 'My Title');
  assert.equal(r.metadata.description, 'A description');
  assert.equal(r.metadata.canonical, 'https://example.com/c');
});

test('removes empty elements but keeps void tags', () => {
  const r = scrape(doc('<p>text</p><div></div><span>  </span><hr><img src="/a.jpg" alt="a" width="900" height="900" srcset="/a.jpg 9w">'), URL_);
  assert.ok(!/<div><\/div>/.test(r.cleanedHtml));
  assert.match(r.cleanedHtml, /<hr>/);
});

test('onlyText unwraps inline formatting tags', () => {
  const r = scrape(doc('<p>a <strong>bold</strong> b</p>'), URL_, { onlyText: true });
  assert.ok(!r.cleanedHtml.includes('<strong>'));
  assert.match(r.cleanedHtml, /bold/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { scrape } from '../src/scrape.ts';

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

/**
 * A "cleaned" page is expected to be safe to render or link to elsewhere.
 * `<a href="javascript:...">` survived tag-based cleaning entirely -- no
 * <script> tag is involved -- and executed in the clicking page's origin the
 * moment any consumer rendered the resulting HTML or the structured link.
 */
test('drops a javascript: href entirely, from html and from links', () => {
  const r = scrape(doc('<a href="javascript:alert(document.cookie)">click</a><p>filler content here</p>'), URL_);
  assert.ok(!r.cleanedHtml.includes('javascript:'));
  assert.equal(r.links.internal.length + r.links.external.length, 0);
});

test('catches a whitespace-obfuscated javascript: href', () => {
  // Browsers strip tab/newline/CR from a URL before parsing its scheme, so
  // "jav\tascript:" still executes on click -- a naive prefix check would miss it.
  const r = scrape(doc('<a href="jav	ascript:alert(1)">click</a>'), URL_);
  assert.ok(!r.cleanedHtml.toLowerCase().includes('javascript:'));
});

test('drops a javascript: src from img, video and audio', () => {
  const r = scrape(doc(
    '<img src="javascript:alert(1)" alt="a photo of something" width="900" height="900" srcset="/x.jpg 9w">'
    + '<video src="javascript:alert(2)"></video>'
    + '<audio src="javascript:alert(3)"></audio>',
  ), URL_);
  assert.ok(!r.cleanedHtml.includes('javascript:'));
  assert.equal(r.media.images.length, 0);
  assert.equal(r.media.videos.length, 0);
  assert.equal(r.media.audios.length, 0);
});

test('drops a data:text/html href but keeps a legitimate http link', () => {
  const r = scrape(doc(
    '<a href="data:text/html,<script>alert(1)</script>">bad</a>'
    + '<a href="https://example.com/safe">good</a>',
  ), URL_);
  assert.ok(!r.cleanedHtml.includes('data:text/html'));
  assert.match(r.cleanedHtml, /https:\/\/example\.com\/safe/);
});

test('keeps a normal http link and a normal image untouched', () => {
  // A single srcset URL, matching src, so this is unambiguously "one image"
  // rather than exercising the (correct, separately-tested) one-entry-per-
  // distinct-URL-variant behavior for a differing srcset.
  const r = scrape(doc(
    '<a href="https://example.com/x">go</a>'
    + '<img src="https://example.com/photo.jpg" alt="a real photo here" width="900" height="900" srcset="https://example.com/photo.jpg 900w">',
  ), URL_);
  assert.equal(r.links.internal.length + r.links.external.length, 1);
  assert.equal(r.media.images.length, 1);
  assert.equal(r.media.images[0].src, 'https://example.com/photo.jpg');
});

/**
 * Regression: an absolute-URL srcset (the common case for CDN-served images)
 * contains "http" in its raw attribute value, and the catch-all lazy-load
 * loop matched any attribute NAME containing "src" without excluding srcset
 * itself -- double-processing it as a second, malformed candidate: the whole
 * "url widthw" descriptor string, width suffix and all, treated as one URL.
 */
test('an absolute-URL srcset is not double-counted as a second, malformed variant', () => {
  const r = scrape(doc(
    '<img src="https://example.com/photo.jpg" alt="a real photo here" width="900" height="900" '
    + 'srcset="https://example.com/photo.jpg 900w">',
  ), URL_);
  assert.equal(r.media.images.length, 1);
  assert.equal(r.media.images[0].src, 'https://example.com/photo.jpg');
  assert.ok(!r.media.images.some((i) => i.src.includes('%20') || i.src.includes('900w')));
});

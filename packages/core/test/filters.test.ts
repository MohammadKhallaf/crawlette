import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from './dom-setup.ts';
import { pruningFilter, _internals } from '../src/filters/pruning.ts';
import { bm25Filter, derivePageQuery } from '../src/filters/bm25.ts';
import { applyFilter, FILTERS, DEFAULT_FILTER } from '../src/filters/index.ts';

const page = (body, head = '') => parseDoc(`<html><head>${head}</head><body>${body}</body></html>`);

test('pruning removes structural chrome tags', () => {
  const html = pruningFilter(page('<nav>menu</nav><p>Real content here, long enough to survive.</p><footer>f</footer>'));
  assert.ok(!html.includes('menu'));
  assert.ok(!html.includes('<footer'));
  assert.match(html, /Real content/);
});

test('pruning keeps substantial paragraphs', () => {
  const long = 'This is a substantial paragraph with plenty of words. '.repeat(10);
  assert.match(pruningFilter(page(`<p>${long}</p>`)), /substantial paragraph/);
});

test('pruning minWordThreshold forces removal of short nodes', () => {
  const html = pruningFilter(page('<p>tiny</p>'), { minWordThreshold: 20 });
  assert.ok(!html.includes('tiny'));
});

test('preserveTags shields a subtree from scoring', () => {
  const html = pruningFilter(page('<aside>x</aside><blockquote>q</blockquote>'), { preserveTags: ['blockquote'] });
  assert.match(html, /<blockquote>/);
});

test('documents the unbounded length term (upstream defect)', () => {
  // A long node scores far above the 0.48 threshold purely on length, while a
  // 5-char span still clears it -- this is why pruning is not the default.
  const doc = page('<p>x</p>');
  const el = doc.querySelector('p');
  const short = _internals.compositeScore(el, { minWordThreshold: null });
  assert.ok(short > 0.48, `expected a 1-char node to survive, scored ${short}`);
});

test('classIdWeight contributes nothing (upstream dead code)', () => {
  assert.equal(_internals.METRIC_WEIGHTS.classIdWeight, 0.1);
  const plain = page('<p>Some reasonably long content for scoring purposes.</p>').querySelector('p');
  const spam = page('<p class="advert sidebar promo">Some reasonably long content for scoring purposes.</p>').querySelector('p');
  assert.equal(
    _internals.compositeScore(plain, { minWordThreshold: null }),
    _internals.compositeScore(spam, { minWordThreshold: null }),
  );
});

test('dynamic threshold differs from fixed for important tags', () => {
  const el = page('<article>Content that is long enough to be scored properly here.</article>').querySelector('article');
  const fixed = _internals.thresholdFor(el, { threshold: 0.48, thresholdType: 'fixed' });
  const dynamic = _internals.thresholdFor(el, { threshold: 0.48, thresholdType: 'dynamic' });
  assert.equal(fixed, 0.48);
  assert.ok(dynamic < fixed, 'important tags should get a lowered threshold');
});

test('bm25 keeps query-relevant chunks and drops the rest', () => {
  const doc = page(`
    <p>Machine learning models require training data to learn patterns.</p>
    <p>The restaurant served excellent pasta and wine last evening.</p>`);
  const html = bm25Filter(doc, { query: 'machine learning training', threshold: 0.5 });
  assert.match(html, /Machine learning/);
  assert.ok(!html.includes('pasta'));
});

test('bm25 boosts headings over body text', () => {
  const doc = page('<h1>Kubernetes networking</h1><p>Unrelated filler text about gardening.</p>');
  const html = bm25Filter(doc, { query: 'kubernetes networking', threshold: 1.0 });
  assert.match(html, /Kubernetes/);
});

test('bm25 returns empty when no query can be derived', () => {
  assert.equal(bm25Filter(page('<p>text</p>'), { query: '' }), '');
});

test('derivePageQuery pulls from title, h1 and meta', () => {
  const doc = page('<h1>Heading Here</h1>', '<title>Page Title</title><meta name="keywords" content="alpha beta">');
  const q = derivePageQuery(doc);
  assert.match(q, /Page Title/);
  assert.match(q, /Heading Here/);
  assert.match(q, /alpha beta/);
});

test('registry exposes every filter and a sane default', () => {
  for (const k of ['readability', 'pruning-legacy', 'bm25', 'none']) assert.ok(k in FILTERS);
  assert.equal(DEFAULT_FILTER, 'readability');
  assert.equal(FILTERS.none(), '');
});

test('applyFilter does not mutate the caller document', () => {
  const doc = page('<nav>menu</nav><p>Body content that is long enough to matter here.</p>');
  applyFilter(doc, 'pruning-legacy');
  assert.ok(doc.querySelector('nav'), 'original document should still have its nav');
});

test('applyFilter rejects an unknown filter name', () => {
  assert.throws(() => applyFilter(page('<p>x</p>'), 'nope'), /Unknown content filter/);
});

test('applyFilter swallows filter errors and returns empty', () => {
  const doc = page('<p>x</p>');
  FILTERS.__boom = () => { throw new Error('boom'); };
  assert.equal(applyFilter(doc, '__boom'), '');
  delete FILTERS.__boom;
});

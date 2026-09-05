import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from './dom-setup.js';
import {
  isMeaningfulClass, meaningfulClasses, inferSelector, findRepeatingContainer,
  findMeaningfulAncestor, suggestFields, buildSchema, pathSelector,
} from '../src/content/selector.js';

const page = (html) => parseDoc(`<html><body>${html}</body></html>`);

test('rejects hashed and scoped class names', () => {
  for (const bad of ['css-1x2y3z', 'sc-bdVaJa', 'jsx-123456', 'svelte-1a2b3c', '_1a2b3c4d']) {
    assert.equal(isMeaningfulClass(bad), false, `${bad} should be rejected`);
  }
});

test('rejects Tailwind utility classes', () => {
  for (const bad of ['flex', 'gap-4', 'text-sm', 'mt-2', 'px-6', 'bg-white', 'rounded-lg',
    'items-center', 'justify-between', 'md:flex', 'w-full', 'shadow-md', 'sr-only']) {
    assert.equal(isMeaningfulClass(bad), false, `${bad} should be rejected`);
  }
});

test('keeps component-looking class names', () => {
  for (const good of ['speaker-card', 'product', 'article-body', 'speaker-hero', 'listing_item']) {
    assert.equal(isMeaningfulClass(good), true, `${good} should be kept`);
  }
});

test('prefers hyphenated component classes over bare words', () => {
  const el = page('<div class="flex gap-4 speaker-card wrapper"></div>').querySelector('div');
  assert.equal(meaningfulClasses(el)[0], 'speaker-card');
});

test('a click inside a card resolves to the repeating card', () => {
  const doc = page(`
    <div class="grid">
      <div class="speaker-card"><h3 class="name">Ada</h3></div>
      <div class="speaker-card"><h3 class="name">Bob</h3></div>
      <div class="speaker-card"><h3 class="name">Cy</h3></div>
    </div>`);
  // The user clicks the heading, but means the card.
  const clicked = doc.querySelector('h3.name');
  const found = findRepeatingContainer(clicked, doc);
  assert.equal(found.selector, 'div.speaker-card');
  assert.equal(found.count, 3);
});

test('inferSelector matches every sibling from one example', () => {
  const doc = page(`
    <div class="product"><h3>A</h3></div>
    <div class="product"><h3>B</h3></div>`);
  const result = inferSelector(doc.querySelector('h3'), doc);
  assert.equal(result.selector, 'div.product');
  assert.equal(result.count, 2);
  assert.equal(doc.querySelectorAll(result.selector).length, 2);
});

test('ignores utility soup when choosing the card selector', () => {
  const doc = page(`
    <div class="flex flex-col gap-4">
      <div class="flex gap-2 speaker-card rounded-lg"><span>A</span></div>
      <div class="flex gap-2 speaker-card rounded-lg"><span>B</span></div>
    </div>`);
  const result = inferSelector(doc.querySelector('span'), doc);
  assert.equal(result.selector, 'div.speaker-card');
  assert.equal(result.count, 2);
});

test('a unique element falls back to its own class or id', () => {
  const doc = page('<div class="speaker-detail"><h2>Solo</h2></div>');
  const result = inferSelector(doc.querySelector('div'), doc);
  assert.equal(result.selector, 'div.speaker-detail');
  assert.equal(result.count, 1);
});

test('an element with nothing stable gets a structural path', () => {
  const doc = page('<section><div><span>x</span></div></section>');
  const result = inferSelector(doc.querySelector('span'), doc);
  assert.ok(result.selector.includes('span'));
  assert.equal(doc.querySelectorAll(result.selector).length, 1);
});

test('pathSelector disambiguates repeated siblings', () => {
  const doc = page('<ul><li>a</li><li>b</li><li>c</li></ul>');
  const second = doc.querySelectorAll('li')[1];
  const selector = pathSelector(second, doc);
  assert.match(selector, /nth-of-type\(2\)/);
  assert.equal(doc.querySelector(selector).textContent, 'b');
});

test('suggests fields from the contents of an example', () => {
  const doc = page(`
    <div class="card">
      <h3 class="card-title">Ada Lovelace</h3>
      <p class="card-role">Engineer</p>
      <a href="/ada">profile</a>
      <img src="/ada.jpg" alt="Ada">
    </div>`);
  const fields = suggestFields(doc.querySelector('.card'));
  const names = fields.map((f) => f.name);
  assert.ok(names.includes('title'));
  assert.ok(names.includes('url'));
  assert.ok(names.includes('image'));
  assert.equal(fields.find((f) => f.name === 'url').attribute, 'href');
});

test('buildSchema produces a schema that actually extracts', async () => {
  const doc = page(`
    <div class="speaker-card"><h3 class="sp-name">Ada</h3><a href="/ada">go</a></div>
    <div class="speaker-card"><h3 class="sp-name">Bob</h3><a href="/bob">go</a></div>`);

  const built = buildSchema(doc.querySelector('h3'), doc);
  assert.equal(built.count, 2);

  // The point of the picker: what it emits must run unmodified.
  const { extractJsonCss } = await import('../src/core/extract/jsonCss.js');
  const rows = extractJsonCss(doc, built.schema);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Ada');
  assert.equal(rows[1].url, '/bob');
});

test('a schema with no obvious fields still captures text', () => {
  const doc = page('<div class="row">One</div><div class="row">Two</div>');
  const built = buildSchema(doc.querySelector('.row'), doc);
  assert.deepEqual(built.schema.fields, [{ name: 'text', type: 'text' }]);
});

test('does not pick a generic wrapper matching the whole page', () => {
  const doc = page(`
    <div class="container"><div class="item">A</div></div>
    <div class="container"><div class="item">B</div></div>`);
  const result = inferSelector(doc.querySelector('.item'), doc);
  // Both repeat, but the click was inside .item, so it wins as the nearest.
  assert.equal(result.selector, 'div.item');
});

/**
 * Regression: `flex-col` slipped through an earlier utility filter and became
 * the chosen selector on a real page, matching 17 unrelated wrappers.
 * Utilities have to be matched as families, not exact words.
 */
test('rejects modifier forms of utility classes', () => {
  for (const bad of ['flex-col', 'flex-row', 'flex-wrap', 'grid-cols-3', 'inline-flex',
    'gap-[19px]', 'text-[40px]', 'min-w-0', 'lg:flex-row', 'md:gap-[80px]',
    'normal-case', 'no-underline', 'rounded-lg', 'items-start', 'transition-all']) {
    assert.equal(isMeaningfulClass(bad), false, `${bad} should be rejected`);
  }
});

/**
 * Detail pages hold a single record, so nothing repeats. The picker must still
 * find the page's real container instead of falling back to a fragile path.
 */
test('a single-record page resolves to its container, not a path', () => {
  const doc = parseDoc(`<html><body>
    <div class="speaker-detail">
      <div class="speaker-hero flex flex-col gap-[28px]">
        <div class="flex flex-col gap-[19px]">
          <h2 class="font-hubspot-serif text-[40px]">Ada Lovelace</h2>
          <p class="font-hubspot-sans text-[12px]">Engineer @ Analytical</p>
        </div>
      </div>
    </div></body></html>`);

  const result = inferSelector(doc.querySelector('h2'), doc);
  assert.equal(result.selector, 'div.speaker-hero');
  assert.ok(!result.selector.includes('nth-of-type'), 'should not need a structural path');
});

test('findMeaningfulAncestor skips utility-only wrappers', () => {
  const doc = parseDoc(`<html><body>
    <div class="product-detail">
      <div class="flex flex-col"><span>Target</span></div>
    </div></body></html>`);
  assert.equal(findMeaningfulAncestor(doc.querySelector('span'), doc).selector, 'div.product-detail');
});

test('a repeating list still wins over a single ancestor', () => {
  const doc = parseDoc(`<html><body>
    <div class="page-wrap">
      <div class="card"><h3>A</h3></div>
      <div class="card"><h3>B</h3></div>
    </div></body></html>`);
  const result = inferSelector(doc.querySelector('h3'), doc);
  assert.equal(result.selector, 'div.card');
  assert.equal(result.count, 2);
});

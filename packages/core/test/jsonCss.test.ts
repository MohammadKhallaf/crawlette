import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from './dom-setup.ts';
import { extractJsonCss, validateSchema } from '../src/extract/jsonCss.ts';

const SHOP = parseDoc(`<html><body>
  <div class="product" data-id="p1">
    <h3>Widget</h3>
    <span class="price">$19.99</span>
    <a class="more" href="/widget">details</a>
    <span class="tag">new</span><span class="tag">SALE</span>
    <div class="review"><span class="stars">5</span><span class="who">Ada</span></div>
    <div class="review"><span class="stars">4</span><span class="who">Bob</span></div>
    <div class="spec"><span class="sku">SKU-1</span></div>
  </div>
  <div class="product" data-id="p2">
    <h3>Gadget</h3>
    <span class="price">$5.00</span>
  </div>
</body></html>`);

test('extracts text fields from each base element', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{ name: 'title', selector: 'h3', type: 'text' }],
  });
  assert.deepEqual(rows, [{ title: 'Widget' }, { title: 'Gadget' }]);
});

test('baseFields read from the base element itself', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    baseFields: [{ name: 'id', type: 'attribute', attribute: 'data-id' }],
    fields: [{ name: 'title', selector: 'h3', type: 'text' }],
  });
  assert.equal(rows[0].id, 'p1');
  assert.equal(rows[1].id, 'p2');
});

test('attribute and html field types', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [
      { name: 'href', selector: 'a.more', type: 'attribute', attribute: 'href' },
      { name: 'inner', selector: 'h3', type: 'html' },
    ],
  });
  assert.equal(rows[0].href, '/widget');
  assert.equal(rows[0].inner, 'Widget');
});

test('type pipelines chain steps', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{
      name: 'amount', selector: '.price', type: ['text', 'regex'], pattern: '([\\d.]+)',
    }],
  });
  assert.equal(rows[0].amount, '19.99');
  assert.equal(rows[1].amount, '5.00');
});

test('missing selectors fall back to the default', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{ name: 'href', selector: 'a.missing', type: 'attribute', attribute: 'href', default: 'none' }],
  });
  assert.equal(rows[1].href, 'none');
});

test('transform is applied to extracted text', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{ name: 'title', selector: 'h3', type: 'text', transform: 'lowercase' }],
  });
  assert.equal(rows[0].title, 'widget');
});

test('list type collects repeated scalars', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{
      name: 'tags', selector: '.tag', type: 'list',
      fields: [{ name: 'label', type: 'text', transform: 'lowercase' }],
    }],
  });
  assert.deepEqual(rows[0].tags, [{ label: 'new' }, { label: 'sale' }]);
  assert.deepEqual(rows[1].tags, []);
});

test('nested type extracts a single sub-object', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{
      name: 'spec', selector: '.spec', type: 'nested',
      fields: [{ name: 'sku', selector: '.sku', type: 'text' }],
    }],
  });
  assert.deepEqual(rows[0].spec, { sku: 'SKU-1' });
  assert.deepEqual(rows[1].spec, {});
});

test('nested_list recurses into sub-structure', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{
      name: 'reviews', selector: '.review', type: 'nested_list',
      fields: [
        { name: 'stars', selector: '.stars', type: 'text' },
        { name: 'who', selector: '.who', type: 'text' },
      ],
    }],
  });
  assert.deepEqual(rows[0].reviews, [
    { stars: '5', who: 'Ada' },
    { stars: '4', who: 'Bob' },
  ]);
});

test('sibling source navigation', () => {
  const doc = parseDoc('<html><body><div class="row"><h3>A</h3></div><p class="note">note text</p></body></html>');
  const rows = extractJsonCss(doc, {
    baseSelector: 'div.row',
    fields: [{ name: 'note', type: 'text', source: '+ p.note' }],
  });
  assert.equal(rows[0].note, 'note text');
});

test('base elements yielding nothing are dropped', () => {
  const doc = parseDoc('<html><body><div class="x"></div></body></html>');
  const rows = extractJsonCss(doc, {
    baseSelector: 'div.x',
    fields: [{ name: 'title', selector: 'h3', type: 'text' }],
  });
  assert.deepEqual(rows, []);
});

test('no matching base selector yields an empty array', () => {
  assert.deepEqual(extractJsonCss(SHOP, { baseSelector: '.nope', fields: [{ name: 'a', type: 'text' }] }), []);
});

test('a bad regex in one field does not abort extraction', () => {
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [
      { name: 'broken', selector: '.price', type: ['text', 'regex'], pattern: '([unclosed', default: 'fallback' },
      { name: 'title', selector: 'h3', type: 'text' },
    ],
  });
  assert.equal(rows[0].title, 'Widget');
  assert.equal(rows[0].broken, 'fallback');
});

test('schemas without baseSelector or fields are rejected', () => {
  assert.throws(() => extractJsonCss(SHOP, { fields: [] }), /baseSelector/);
  assert.throws(() => extractJsonCss(SHOP, { baseSelector: 'div' }), /fields/);
});

test('validateSchema accepts a good schema', () => {
  assert.deepEqual(validateSchema({
    baseSelector: 'div',
    fields: [{ name: 'a', type: 'text' }],
  }), []);
});

test('validateSchema reports concrete problems', () => {
  const errors = validateSchema({
    baseSelector: 'div',
    fields: [
      { type: 'text' },                    // no name
      { name: 'b' },                       // no type
      { name: 'c', type: 'attribute' },    // no attribute
      { name: 'd', type: 'nested' },       // no fields
    ],
  });
  assert.equal(errors.length, 4);
  assert.ok(errors.some((e) => /missing name/.test(e)));
  assert.ok(errors.some((e) => /requires an attribute/.test(e)));
});

test('validateSchema refuses expression-based computed fields', () => {
  const errors = validateSchema({
    baseSelector: 'div',
    fields: [{ name: 'x', type: 'computed', expression: 'price * 2' }],
  });
  assert.ok(errors.some((e) => /unsupported for security/.test(e)));
});

test('computed expressions are never evaluated', () => {
  globalThis.__pwned = false;
  const rows = extractJsonCss(SHOP, {
    baseSelector: 'div.product',
    fields: [{ name: 'x', type: 'computed', expression: 'globalThis.__pwned = true', default: 'safe' }],
  });
  assert.equal(globalThis.__pwned, false, 'expression must not be evaluated');
  assert.equal(rows[0].x, 'safe');
  delete globalThis.__pwned;
});

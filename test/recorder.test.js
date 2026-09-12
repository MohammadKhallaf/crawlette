import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from './dom-setup.js';

/** Install a document plus the DOM globals the recorder touches. */
function installPage(html) {
  const doc = parseDoc(`<html><body>${html}</body></html>`);
  globalThis.document = doc;
  globalThis.location = { href: 'https://site.test/list' };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  return doc;
}

installPage('<div></div>');
const { _internals } = await import('../src/content/recorder.js');
const { itemKey, collect, session } = _internals;

test('itemKey is stable across re-renders', () => {
  const doc = installPage('<div class="c" id="r1"><a href="/a">A</a></div>');
  const el = doc.querySelector('.c');
  assert.equal(itemKey(el), 'id:r1');

  const doc2 = installPage('<div class="c"><a href="/a">A</a></div>');
  assert.equal(itemKey(doc2.querySelector('.c')), 'href:/a');
});

/**
 * Regression, found on a real conference exhibitor listing recorded via Pick
 * & record: a sidebar filter widget assigns a FRESH random hash to each
 * control's href fragment on every re-render ("#filter_body_side_field_4_
 * 03885bfba7a4..." one capture, "...01a7a8a4f475..." the next), same visible
 * label both times. Trusting that href for identity made 10 filter labels
 * look "new" a second time and get recorded twice under different keys.
 */
test('a same-page fragment href is not trusted for identity (only its text)', () => {
  const first = installPage(
    '<div class="filter"><a href="#filter_body_side_field_4_03885bfba7a41bb96aa06cf27675fe15">Product Categories</a></div>',
  );
  const second = installPage(
    '<div class="filter"><a href="#filter_body_side_field_4_01a7a8a4f475611aaf27e8c6de4417af">Product Categories</a></div>',
  );
  const keyA = itemKey(first.querySelector('.filter'));
  const keyB = itemKey(second.querySelector('.filter'));
  assert.equal(keyA, keyB, 'the same visible label must key identically despite the churning fragment id');
  assert.equal(keyA, 'text:Product Categories');
});

test('a real cross-page href is still trusted for identity', () => {
  // The same page's actual exhibitor cards used stable, real links and were
  // never duplicated -- only same-page fragment anchors are untrusted.
  const doc = installPage('<div class="card"><a href="https://events.example.com/map?id=4037">Aalto Scientific</a></div>');
  assert.equal(itemKey(doc.querySelector('.card')), 'href:https://events.example.com/map?id=4037');
});

/**
 * The heart of record mode: the user paginates, content is replaced, and
 * everything seen along the way must still be there at the end.
 */
test('collects across pagination that replaces the list', () => {
  session.items.clear();
  session.selector = '.card';

  installPage('<div class="card" id="c1">One</div><div class="card" id="c2">Two</div>');
  assert.equal(collect(), 2);

  // User clicks "next": page 1 is gone, page 2 rendered in its place.
  installPage('<div class="card" id="c3">Three</div><div class="card" id="c4">Four</div>');
  assert.equal(collect(), 2);

  installPage('<div class="card" id="c5">Five</div>');
  assert.equal(collect(), 1);

  assert.equal(session.items.size, 5, 'items from earlier pages must survive');
  assert.deepEqual(
    [...session.items.values()].map((i) => i.text).sort(),
    ['Five', 'Four', 'One', 'Three', 'Two'],
  );
});

test('re-collecting the same page adds nothing', () => {
  session.items.clear();
  session.selector = '.card';
  installPage('<div class="card" id="a">A</div>');
  assert.equal(collect(), 1);
  assert.equal(collect(), 0);
  assert.equal(session.items.size, 1);
});

test('infinite scroll that appends is collected once each', () => {
  session.items.clear();
  session.selector = '.row';

  installPage('<div class="row" id="1">1</div>');
  collect();
  // Scrolling appends to the existing list rather than replacing it.
  installPage('<div class="row" id="1">1</div><div class="row" id="2">2</div>');
  assert.equal(collect(), 1, 'only the new row should be added');
  assert.equal(session.items.size, 2);
});

test('the recorder never collects its own UI', () => {
  session.items.clear();
  session.selector = 'div';
  const doc = installPage('<div class="real">Content</div>');

  const host = doc.createElement('div');
  host.id = '__crawlette_recorder';
  const inner = doc.createElement('div');
  inner.textContent = 'overlay chrome';
  host.appendChild(inner);
  doc.body.appendChild(host);

  collect();
  const texts = [...session.items.values()].map((i) => i.text);
  assert.ok(!texts.includes('overlay chrome'), 'overlay must not end up in the data');
});

test('collecting without a selector is a no-op', () => {
  session.items.clear();
  session.selector = null;
  installPage('<div class="card">A</div>');
  assert.equal(collect(), 0);
});

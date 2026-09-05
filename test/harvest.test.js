import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc } from './dom-setup.js';

/**
 * The content script reads globals (`document`, `getComputedStyle`, `window`)
 * the way it will in a page. Install a document, then import it.
 */
function installPage(html) {
  const doc = parseDoc(`<html><body>${html}</body></html>`);
  globalThis.document = doc;
  // linkedom has no layout engine, so stand in for visibility: an element is
  // visible unless it says otherwise. Enough to exercise the filtering logic.
  globalThis.getComputedStyle = (el) => {
    const style = (el.getAttribute('style') || '').replace(/\s/g, '');
    return {
      display: style.includes('display:none') ? 'none' : 'block',
      visibility: style.includes('visibility:hidden') ? 'hidden' : 'visible',
      opacity: style.includes('opacity:0') ? '0' : '1',
      position: 'static',
    };
  };
  for (const el of doc.querySelectorAll('*')) {
    el.getBoundingClientRect = () => ({ width: 100, height: 30, top: 0, left: 0 });
    el.scrollIntoView = () => {};
  }
  return doc;
}

const { _internals } = await import('../src/content/harvest.js');
const {
  itemKey, findLoadMore, detectBlocker, harvestVisible, state,
} = _internals;

test('finds a "Load more" button by its label', () => {
  installPage('<button>Load more</button>');
  assert.equal(findLoadMore()?.textContent, 'Load more');
});

test('matches the common load-more phrasings', () => {
  for (const label of ['Load more', 'Show more', 'View all', 'See more', 'More', 'Next', 'Load 20 more']) {
    installPage(`<button>${label}</button>`);
    assert.ok(findLoadMore(), `should match "${label}"`);
  }
});

test('ignores unrelated and disabled buttons', () => {
  installPage('<button>Submit order</button><button>Delete account</button>');
  assert.equal(findLoadMore(), null);

  installPage('<button disabled>Load more</button>');
  assert.equal(findLoadMore(), null, 'a disabled button cannot reveal anything');

  installPage('<button aria-disabled="true">Load more</button>');
  assert.equal(findLoadMore(), null);
});

test('ignores hidden buttons', () => {
  installPage('<button style="display:none">Load more</button>');
  assert.equal(findLoadMore(), null);
});

test('ignores long labels that merely contain "more"', () => {
  installPage('<button>Read more about our privacy policy and cookie choices</button>');
  assert.equal(findLoadMore(), null);
});

test('detects walls that need a person', () => {
  installPage('<input type="password">');
  assert.match(detectBlocker(), /sign in/i);

  installPage('<div class="g-recaptcha"></div>');
  assert.match(detectBlocker(), /CAPTCHA/i);

  installPage('<div class="paywall-overlay">Subscribe</div>');
  assert.ok(detectBlocker());
});

test('an ordinary page reports no blocker', () => {
  installPage('<article><p>Just content.</p></article>');
  assert.equal(detectBlocker(), null);
});

test('a hidden password field is not treated as a wall', () => {
  // Many pages carry an off-screen login form that is not blocking anything.
  installPage('<input type="password" style="display:none">');
  assert.equal(detectBlocker(), null);
});

test('itemKey prefers a stable id over text', () => {
  const doc = installPage('<div id="row-1">Alpha</div><div data-id="row-2">Beta</div>');
  const [a, b] = doc.querySelectorAll('div');
  assert.equal(itemKey(a), 'id:row-1');
  assert.equal(itemKey(b), 'id:row-2');
});

test('itemKey falls back to a link, then to text', () => {
  const doc = installPage('<div><a href="/x">Alpha</a></div><div>Beta</div>');
  const [a, b] = doc.querySelectorAll('div');
  assert.equal(itemKey(a), 'href:/x');
  assert.equal(itemKey(b), 'text:Beta');
});

/**
 * The reason harvesting is incremental: virtualised lists destroy nodes as you
 * scroll. Reading the DOM once at the end would return only the final window.
 */
test('items survive DOM recycling', () => {
  state.items.clear();

  installPage('<div class="card" id="c1">One</div><div class="card" id="c2">Two</div>');
  assert.equal(harvestVisible('.card'), 2);

  // The list recycles: the first two nodes are gone, replaced by new ones.
  installPage('<div class="card" id="c3">Three</div><div class="card" id="c4">Four</div>');
  assert.equal(harvestVisible('.card'), 2);

  assert.equal(state.items.size, 4, 'earlier items must not be lost when nodes are recycled');
  const texts = [...state.items.values()].map((i) => i.text).sort();
  assert.deepEqual(texts, ['Four', 'One', 'Three', 'Two']);
});

test('re-harvesting the same nodes does not duplicate them', () => {
  state.items.clear();
  installPage('<div class="card" id="c1">One</div>');
  assert.equal(harvestVisible('.card'), 1);
  assert.equal(harvestVisible('.card'), 0, 'second pass should add nothing');
  assert.equal(state.items.size, 1);
});

test('harvesting without a selector is a no-op', () => {
  state.items.clear();
  installPage('<div class="card">One</div>');
  assert.equal(harvestVisible(null), 0);
  assert.equal(state.items.size, 0);
});

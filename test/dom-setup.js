/**
 * Installs a DOM into globalThis so browser-targeted modules run under Node.
 *
 * The extension itself runs in a real browser and needs none of this; linkedom
 * is a dev-only dependency that stands in for the browser during tests.
 * Turndown picks its parser at import time via a global `DOMParser`, so this
 * must be imported before any module that imports Turndown.
 */
import { parseHTML, DOMParser } from 'linkedom';

const window = parseHTML('<html><head></head><body></body></html>');

/**
 * linkedom omits the HTMLTable* interfaces (`table.rows`, `tr.cells`) that
 * Turndown's GFM plugin reads. Real browsers implement these natively, so this
 * shim exists purely so tables get genuine coverage under Node.
 *
 * Turndown clones nodes into a document of its own, so patching parsed
 * documents is not enough -- the getters go on linkedom's shared HTMLElement
 * prototype, which every element inherits from regardless of how it was made.
 */
function polyfillTableApis(proto) {
  if (!proto || Object.getOwnPropertyDescriptor(proto, 'rows')) return;

  Object.defineProperty(proto, 'rows', {
    configurable: true,
    get() {
      if (this.tagName !== 'TABLE' && this.tagName !== 'TBODY') return undefined;
      return [...this.querySelectorAll('tr')];
    },
  });
  Object.defineProperty(proto, 'cells', {
    configurable: true,
    get() {
      if (this.tagName !== 'TR') return undefined;
      return [...this.querySelectorAll('td, th')];
    },
  });
}

polyfillTableApis(
  Object.getPrototypeOf(window.document.createElement('table')),
);

// Turndown reads `window.DOMParser` (see its `root` binding), so the patched
// parser must be installed on the window object as well as on globalThis.
globalThis.DOMParser = DOMParser;
window.DOMParser = DOMParser;
for (const key of ['document', 'Node', 'HTMLElement', 'Element', 'NodeFilter', 'window']) {
  if (globalThis[key] === undefined && window[key] !== undefined) {
    globalThis[key] = window[key];
  }
}
if (globalThis.window === undefined) globalThis.window = window;

/** Parse an HTML string into a standalone Document. */
export function parseDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

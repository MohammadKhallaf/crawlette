/**
 * Installs a DOM into globalThis so browser-targeted modules run under Node.
 *
 * This package is meant to run in a real browser and needs none of this;
 * linkedom is a dev-only dependency that stands in for the browser during
 * tests. Turndown picks its parser at import time via a global `DOMParser`,
 * so this must be imported before any module that imports Turndown.
 */
import { parseHTML, DOMParser } from 'linkedom';

const win = parseHTML('<html><head></head><body></body></html>');

/**
 * linkedom omits the HTMLTable* interfaces (`table.rows`, `tr.cells`) that
 * Turndown's GFM plugin reads. Real browsers implement these natively, so this
 * shim exists purely so tables get genuine coverage under Node.
 *
 * Turndown clones nodes into a document of its own, so patching parsed
 * documents is not enough -- the getters go on linkedom's shared HTMLElement
 * prototype, which every element inherits from regardless of how it was made.
 */
function polyfillTableApis(proto: object | null): void {
  if (!proto || Object.getOwnPropertyDescriptor(proto, 'rows')) return;

  Object.defineProperty(proto, 'rows', {
    configurable: true,
    get(this: Element) {
      if (this.tagName !== 'TABLE' && this.tagName !== 'TBODY') return undefined;
      return [...this.querySelectorAll('tr')];
    },
  });
  Object.defineProperty(proto, 'cells', {
    configurable: true,
    get(this: Element) {
      if (this.tagName !== 'TR') return undefined;
      return [...this.querySelectorAll('td, th')];
    },
  });
}

polyfillTableApis(
  Object.getPrototypeOf(win.document.createElement('table')),
);

// Turndown reads `window.DOMParser` (see its `root` binding), so the patched
// parser must be installed on the window object as well as on globalThis.
const g = globalThis as Record<string, unknown>;
const w = win as unknown as Record<string, unknown>;

g.DOMParser = DOMParser;
w.DOMParser = DOMParser;
for (const key of ['document', 'Node', 'HTMLElement', 'Element', 'NodeFilter', 'window']) {
  if (g[key] === undefined && w[key] !== undefined) g[key] = w[key];
}
if (g.window === undefined) g.window = win;

/** Parse an HTML string into a standalone Document. */
export function parseDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

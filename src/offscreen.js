/**
 * Offscreen document: the only place in the extension with a real DOM.
 *
 * MV3 service workers have no `DOMParser`, no `Document` and no `document` --
 * they are workers, not windows. Every step of the page pipeline that touches
 * HTML therefore runs here, and the service worker orchestrates over messages.
 *
 * Two jobs:
 *  - `process` parse fetched HTML and run the full pipeline on it.
 *  - `render`  load a URL in an iframe so its JavaScript runs, then process
 *              the resulting live DOM.
 */

import { processHtml } from './core/crawl/fetcher.js';

/** Overlay/consent dismissal, adapted from crawl4ai's js_snippet directory. */
function dismissOverlays(win) {
  const doc = win.document;
  const isVisible = (el) => {
    const s = win.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  // Never remove document structure -- doing so empties the page.
  const isStructural = (el) => ['HTML', 'HEAD', 'BODY'].includes(el.tagName);

  for (const sel of [
    'button[class*="close" i]', 'button[class*="dismiss" i]',
    'button[aria-label*="close" i]', 'button[title*="close" i]',
    'button[id*="accept" i]', 'button[class*="accept" i]',
  ]) {
    for (const btn of doc.querySelectorAll(sel)) {
      if (isVisible(btn)) { try { btn.click(); } catch { /* non-fatal */ } }
    }
  }

  for (const sel of [
    '[class*="cookie-banner" i]', '[id*="cookie-banner" i]',
    '[class*="cookie-consent" i]', '[id*="cookie-consent" i]',
    '[class*="newsletter" i]', '[class*="subscribe" i]',
    '[class*="popup" i]', '[class*="modal" i]', '[class*="overlay" i]',
    '[role="dialog"]', '[role="alertdialog"]',
  ]) {
    for (const el of doc.querySelectorAll(sel)) {
      if (!isStructural(el) && isVisible(el)) el.remove();
    }
  }

  // Fixed/sticky elements covering much of the viewport are almost always chrome.
  for (const el of doc.querySelectorAll('body *')) {
    if (isStructural(el)) continue;
    const s = win.getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.width > win.innerWidth * 0.5 && r.height > win.innerHeight * 0.5) el.remove();
  }

  doc.documentElement.style.overflow = 'auto';
  doc.body.style.overflow = 'auto';
}

/** Load `url` in an iframe and return its post-script HTML. */
function renderInFrame(url, { timeoutMs, settleMs, removeOverlays }) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;width:1280px;height:900px;left:-9999px;top:-9999px;border:0';

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      frame.remove();
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`Render timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    frame.addEventListener('load', () => {
      // Give client-side rendering a moment to paint before reading the DOM.
      setTimeout(() => {
        try {
          const doc = frame.contentDocument;
          if (!doc) throw new Error('Frame document is inaccessible (likely blocked by CSP)');
          if (removeOverlays) {
            try {
              dismissOverlays(frame.contentWindow);
            } catch { /* overlay removal is best-effort */ }
          }
          finish(resolve, doc.documentElement.outerHTML);
        } catch (error) {
          finish(reject, error);
        }
      }, settleMs);
    });

    frame.addEventListener('error', () => finish(reject, new Error('Frame failed to load')));

    frame.src = url;
    document.body.appendChild(frame);
  });
}

/** Messages are addressed explicitly so the service worker ignores its own. */
const HANDLERS = {
  /** Parse and process already-fetched HTML. */
  async 'offscreen:process'({ html, url, options }) {
    return processHtml(html, url, options);
  },

  /** Render a URL, then process what the browser actually built. */
  async 'offscreen:render'({ url, options, timeoutMs, settleMs, removeOverlays }) {
    const html = await renderInFrame(url, {
      timeoutMs: timeoutMs ?? 60_000,
      settleMs: settleMs ?? 500,
      removeOverlays: removeOverlays ?? true,
    });
    return processHtml(html, url, options ?? {});
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  handler(message).then(
    (result) => sendResponse({ result }),
    (error) => sendResponse({ error: String(error?.message ?? error) }),
  );
  return true; // async response
});

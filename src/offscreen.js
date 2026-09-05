/**
 * Offscreen renderer: loads a URL in an iframe so its JavaScript runs, then
 * returns the post-render DOM.
 *
 * This is what lets the extension see SPA content, lazy-loaded images and
 * anything else that only exists after scripts execute -- the capability a
 * raw fetch cannot provide.
 *
 * Sites that forbid framing (`X-Frame-Options`, CSP `frame-ancestors`) cannot
 * be rendered this way; the error propagates and the caller falls back to a
 * raw fetch.
 */

/** Overlay/consent-dismissal scripts, adapted from crawl4ai's js_snippet/. */
const DISMISS_OVERLAYS = `
(() => {
  const isVisible = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  // Never remove document structure -- doing so empties the page.
  const isStructural = (el) => ['HTML', 'HEAD', 'BODY'].includes(el.tagName);

  const closeSelectors = [
    'button[class*="close" i]', 'button[class*="dismiss" i]',
    'button[aria-label*="close" i]', 'button[title*="close" i]',
    'button[id*="accept" i]', 'button[class*="accept" i]',
  ];
  for (const sel of closeSelectors) {
    for (const btn of document.querySelectorAll(sel)) {
      if (isVisible(btn)) { try { btn.click(); } catch {} }
    }
  }

  const overlaySelectors = [
    '[class*="cookie-banner" i]', '[id*="cookie-banner" i]',
    '[class*="cookie-consent" i]', '[id*="cookie-consent" i]',
    '[class*="newsletter" i]', '[class*="subscribe" i]',
    '[class*="popup" i]', '[class*="modal" i]', '[class*="overlay" i]',
    '[role="dialog"]', '[role="alertdialog"]',
  ];
  for (const sel of overlaySelectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (!isStructural(el) && isVisible(el)) el.remove();
    }
  }

  // Fixed/sticky elements covering much of the viewport are almost always chrome.
  for (const el of document.querySelectorAll('body *')) {
    if (isStructural(el)) continue;
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.width > innerWidth * 0.5 && r.height > innerHeight * 0.5) el.remove();
  }

  // Restore scrolling that a modal may have locked.
  document.documentElement.style.overflow = 'auto';
  document.body.style.overflow = 'auto';
})();
`;

/**
 * Load `url` in a sandboxed iframe and return its serialized DOM.
 *
 * Same-origin access to the frame's document is what makes this work; the
 * extension's host permissions grant it.
 */
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
              frame.contentWindow.eval(DISMISS_OVERLAYS);
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'render') return false;

  renderInFrame(message.url, {
    timeoutMs: message.timeoutMs ?? 60_000,
    settleMs: message.settleMs ?? 500,
    removeOverlays: message.removeOverlays ?? true,
  }).then(
    (html) => sendResponse({ html }),
    (error) => sendResponse({ error: String(error?.message ?? error) }),
  );

  return true; // async response
});

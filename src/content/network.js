/**
 * Network capture, injected into the page's OWN world.
 *
 * When a listing paginates it almost always asks a server for the next batch.
 * That request is worth more than the DOM it produces: one call with a raised
 * limit can return every record at once, with fields the interface never shows,
 * and none of the selector brittleness of scraping cards.
 *
 * Two things follow from experiment rather than assumption:
 *
 *  - This must run in the MAIN world. A content script's isolated world has its
 *    own `fetch`, so patching there sees nothing the page does.
 *  - It must run WHILE the user paginates. Capturing only at page load found no
 *    data endpoint on a real client-rendered listing -- the request fires on
 *    interaction, which is the whole reason this pairs with record mode.
 *
 * Nothing is sent anywhere: captures are held on `window` and read back by the
 * extension when the user finishes.
 */

(() => {
  const KEY = '__crawletteNet';
  if (window[KEY]) return;   // already patched

  /** Bodies above this are almost certainly assets, not data. */
  const MAX_BODY = 4_000_000;

  const store = { calls: [], enabled: true };
  window[KEY] = store;

  /** Record one response if it looks like data rather than markup or an asset. */
  function record(url, status, body, method) {
    if (!store.enabled || !body) return;
    const trimmed = body.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
    if (body.length > MAX_BODY) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    // How many records did it carry? The biggest array anywhere in the payload
    // is a good proxy, since APIs bury lists under keys like data/items/results.
    let best = Array.isArray(parsed) ? parsed.length : 0;
    let bestKey = Array.isArray(parsed) ? '' : null;
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.length > best) { best = v.length; bestKey = k; }
      }
    }

    store.calls.push({
      url: String(url),
      method: method || 'GET',
      status,
      bytes: body.length,
      itemCount: best,
      itemKey: bestKey,
      // A small sample makes the endpoint recognisable without keeping it all.
      sample: trimmed.slice(0, 600),
      at: Date.now(),
    });
  }

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request?.url;
    const method = args[1]?.method || (typeof request === 'object' ? request?.method : 'GET');
    const response = await originalFetch.apply(this, args);
    try {
      // Clone, so the page still gets to read its own body.
      record(url, response.status, await response.clone().text(), method);
    } catch { /* an opaque or already-consumed body is not our problem */ }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.addEventListener('load', () => {
      try {
        record(url, this.status, this.responseText || '', method);
      } catch { /* responseType may not be text */ }
    });
    return originalOpen.call(this, method, url, ...rest);
  };
})();

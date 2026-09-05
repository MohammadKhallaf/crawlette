/**
 * Record mode: the user drives, the extension collects.
 *
 * Auto-detecting pagination is a losing game -- infinite scroll, numbered
 * pages, "load more", next arrows, filters and tabs all look different, and a
 * synthetic click carries `isTrusted: false` so anti-bot and paywall code can
 * refuse it. But the person is already here, already knows how the site works,
 * and every gesture they make is genuine.
 *
 * So: they click one example of what they want, we infer a selector, and then
 * they browse however the site expects. A MutationObserver harvests matches as
 * they appear, which also survives virtualised lists that recycle nodes behind
 * you. They press Done when finished.
 *
 * This makes the visual picker and pagination the same feature rather than two.
 */

/**
 * Selector logic is loaded lazily.
 *
 * Content scripts injected with `chrome.scripting.executeScript` are not
 * modules, so a static `import` would fail at runtime. A dynamic import of a
 * web-accessible extension URL does work, and the same call resolves normally
 * under test where `chrome` is absent.
 */
let selectorModule = null;
async function selectors() {
  if (selectorModule) return selectorModule;
  selectorModule = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
    ? await import(chrome.runtime.getURL('src/content/selector.js'))
    : await import('./selector.js');
  return selectorModule;
}

const HOST_ID = '__crawlette_recorder';

const session = {
  mode: 'idle',          // idle | picking | recording
  selector: null,
  schema: null,
  items: new Map(),      // key -> {html, text} so recycled nodes are not lost
  observer: null,
  highlight: null,
  overlay: null,
  ui: {},
  onDone: null,
};

/** Identity that survives DOM recycling and re-renders. */
function itemKey(el) {
  const id = el.id || el.getAttribute('data-id') || el.getAttribute('data-key');
  if (id) return `id:${id}`;
  const href = el.querySelector('a[href]')?.getAttribute('href');
  if (href) return `href:${href}`;
  return `text:${(el.textContent || '').trim().slice(0, 160)}`;
}

/** Capture everything currently matching, ignoring our own UI. */
function collect() {
  if (!session.selector) return 0;
  let added = 0;
  for (const el of document.querySelectorAll(session.selector)) {
    if (el.closest(`#${HOST_ID}`)) continue;
    const key = itemKey(el);
    if (session.items.has(key)) continue;
    session.items.set(key, { html: el.outerHTML, text: (el.textContent || '').trim() });
    added += 1;
  }
  if (added) updateCount();
  return added;
}

// ---------------------------------------------------------------- overlay UI

/** Build the control bar. Shadow DOM keeps page CSS out and ours in. */
function buildOverlay() {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .bar {
      position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; gap: 12px; align-items: center;
      padding: 12px 16px; border-radius: 12px;
      background: #1c1c1e; color: #f5f5f7;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 8px 30px rgba(0,0,0,.4);
    }
    .info { flex: 1; min-width: 0; }
    .info b { display: block; margin-bottom: 2px; }
    .info span { opacity: .72; font-size: 12px; }
    .count { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 18px; }
    button {
      padding: 7px 14px; border-radius: 8px; border: 0; cursor: pointer;
      font: inherit; font-weight: 600; background: #2563eb; color: #fff; white-space: nowrap;
    }
    button.ghost { background: #3a3a3c; }
    .hl {
      position: fixed; z-index: 2147483646; pointer-events: none;
      border: 2px solid #2563eb; border-radius: 4px;
      background: rgba(37,99,235,.14); transition: all .05s linear;
    }
  `;

  const bar = document.createElement('div');
  bar.className = 'bar';

  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('b');
  const detail = document.createElement('span');
  info.append(title, detail);

  const count = document.createElement('div');
  count.className = 'count';
  count.hidden = true;

  const primary = document.createElement('button');
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => finish(true));

  bar.append(info, count, primary, cancel);

  const highlight = document.createElement('div');
  highlight.className = 'hl';
  highlight.hidden = true;

  root.append(style, bar, highlight);
  document.documentElement.appendChild(host);

  session.overlay = host;
  session.highlight = highlight;
  session.ui = { title, detail, count, primary };
  return host;
}

function updateCount() {
  if (!session.ui.count) return;
  session.ui.count.hidden = false;
  session.ui.count.textContent = String(session.items.size);
}

/** Move the highlight box over an element. */
function highlightElement(el) {
  if (!session.highlight) return;
  if (!el) { session.highlight.hidden = true; return; }
  const r = el.getBoundingClientRect();
  Object.assign(session.highlight.style, {
    top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px`,
  });
  session.highlight.hidden = false;
}

// ------------------------------------------------------------------ picking

function onHover(event) {
  if (session.mode !== 'picking') return;
  const el = event.target;
  if (!el?.tagName || el.closest?.(`#${HOST_ID}`)) return;
  highlightElement(el);
}

function onPick(event) {
  if (session.mode !== 'picking') return;
  const el = event.target;
  if (!el?.tagName || el.closest?.(`#${HOST_ID}`)) return;

  // Stop the page acting on this click -- the user is choosing, not navigating.
  event.preventDefault();
  event.stopPropagation();

  selectors().then(({ buildSchema }) => {
    const built = buildSchema(el, document);
    if (!built) return;
    session.selector = built.schema.baseSelector;
    session.schema = built.schema;
    startRecording();
  });
}

function bindPicking(on) {
  const fn = on ? 'addEventListener' : 'removeEventListener';
  // Capture phase, so we see the event before the page can swallow it.
  document[fn]('mouseover', onHover, true);
  document[fn]('click', onPick, true);
}

// ---------------------------------------------------------------- recording

/**
 * Watch for new matches while the user navigates.
 *
 * A MutationObserver covers every way content can arrive -- infinite scroll,
 * a load-more click, a page-2 link, a filter change -- without knowing which
 * one the site uses.
 */
function startRecording() {
  session.mode = 'recording';
  bindPicking(false);
  highlightElement(null);

  session.ui.title.textContent = 'Recording — browse as you normally would';
  session.ui.detail.textContent = `Collecting ${session.selector} · scroll, paginate or filter; press Done when finished`;
  session.ui.primary.textContent = 'Done';
  session.ui.primary.onclick = () => finish(false);

  collect();

  session.observer = new MutationObserver(() => collect());
  session.observer.observe(document.body, { childList: true, subtree: true });

  // Some sites swap content without mutating in a way we notice; poll gently.
  session.pollTimer = setInterval(collect, 1500);
}

/** Stop, tear down the UI, and hand back what was gathered. */
function finish(cancelled) {
  session.observer?.disconnect();
  clearInterval(session.pollTimer);
  bindPicking(false);
  document.getElementById(HOST_ID)?.remove();

  const result = {
    cancelled,
    selector: session.selector,
    schema: session.schema,
    items: [...session.items.values()],
    count: session.items.size,
    url: location.href,
  };

  session.mode = 'idle';
  session.observer = null;
  session.overlay = null;
  session.highlight = null;
  session.ui = {};

  session.onDone?.(result);
  session.onDone = null;
  return result;
}

/** Begin a session: pick an example, then record while the user browses. */
function start(options = {}) {
  return new Promise((resolve) => {
    session.items.clear();
    session.selector = options.selector ?? null;
    session.schema = null;
    session.onDone = resolve;

    buildOverlay();

    if (session.selector) {
      // Selector already known (a repeat run): go straight to recording.
      session.schema = options.schema ?? null;
      startRecording();
      return;
    }

    session.mode = 'picking';
    session.ui.title.textContent = 'Click one example of what you want';
    session.ui.detail.textContent = 'Hover to highlight — click a card, row or heading';
    session.ui.primary.textContent = 'Pick anything';
    session.ui.primary.onclick = () => {};
    bindPicking(true);
  });
}

export const _internals = { itemKey, collect, session, finish };

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handlers = {
      'content:record': () => start(message.options ?? {}),
      'content:recordStop': async () => finish(false),
      'content:ping': async () => ({ ready: true, url: location.href }),
    };

    const handler = handlers[message?.type];
    if (!handler) return false;

    handler().then(
      (result) => sendResponse({ result }),
      (error) => sendResponse({ error: String(error?.message ?? error) }),
    );
    return true; // async response
  });
}

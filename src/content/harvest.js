/**
 * Content script: drives a real page to reveal all of its content.
 *
 * Runs in a genuine tab rather than the offscreen document, for two reasons:
 *
 * 1. A page can be waiting on the user -- a consent wall, a login, a CAPTCHA,
 *    or a control that only reacts to a real gesture. An offscreen iframe is
 *    invisible, so there is nothing to click and the crawl simply hangs. In a
 *    tab we can surface the page and let the user act, which is the one thing a
 *    server-side crawler can never do.
 * 2. Synthetic events carry `isTrusted: false`. Most handlers do not care, but
 *    paywall and anti-bot code often checks, and browsers gate popups,
 *    fullscreen and clipboard on real gestures. When synthetic interaction
 *    stalls, a human hand is the reliable fallback.
 *
 * Harvesting is INCREMENTAL. Virtualised lists (Twitter- or Instagram-style)
 * recycle DOM nodes as you scroll, so reading the DOM once at the end loses
 * everything scrolled past. Items are captured every cycle and de-duplicated.
 */

const DEFAULTS = {
  maxScrolls: 50,
  scrollDelayMs: 700,
  stableRounds: 3,        // consecutive no-growth rounds before we call it done
  itemSelector: null,     // when set, harvest matching elements incrementally
  clickLoadMore: true,
  maxClicks: 30,
};

/** Text on buttons that reveal more content. */
const LOAD_MORE_PATTERNS = [
  /^\s*(load|show|view|see)\s+(more|all)/i,
  /^\s*more\s*$/i,
  /^\s*next\s*$/i,
  /^\s*(load|show)\s+\d+\s+more/i,
];

/** Signals that the page wants a human before it will show anything. */
const BLOCKER_SELECTORS = [
  'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[title*="challenge" i]',
  '[class*="captcha" i]', '[id*="captcha" i]',
  'input[type="password"]',
  '[class*="paywall" i]', '[id*="paywall" i]',
];

const state = {
  running: false,
  paused: false,
  items: new Map(),   // key -> {html, text} so recycled nodes are not lost
  overlay: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stable-ish identity for a harvested element, so recycling does not duplicate. */
function itemKey(el) {
  const id = el.id || el.getAttribute('data-id') || el.getAttribute('data-key');
  if (id) return `id:${id}`;
  const link = el.querySelector('a[href]')?.getAttribute('href');
  if (link) return `href:${link}`;
  return `text:${(el.textContent || '').trim().slice(0, 120)}`;
}

/** Capture currently-rendered items before the page can recycle them away. */
function harvestVisible(selector) {
  if (!selector) return 0;
  let added = 0;
  for (const el of document.querySelectorAll(selector)) {
    const key = itemKey(el);
    if (state.items.has(key)) continue;
    state.items.set(key, { html: el.outerHTML, text: (el.textContent || '').trim() });
    added += 1;
  }
  return added;
}

/** Is this element actually visible and clickable? */
function isVisible(el) {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Find a "load more" control, if the page has one. */
function findLoadMore() {
  const candidates = document.querySelectorAll(
    'button, a[role="button"], [role="button"], a.button, .btn, [class*="load" i], [class*="more" i]',
  );
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
    if (!label || label.length > 40) continue;
    if (LOAD_MORE_PATTERNS.some((p) => p.test(label))) return el;
  }
  return null;
}

/** Detect a wall that needs a human. */
function detectBlocker() {
  for (const selector of BLOCKER_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && isVisible(el)) {
      if (selector.includes('captcha')) return 'A CAPTCHA is blocking this page.';
      if (selector.includes('password')) return 'This page is asking you to sign in.';
      return 'Content on this page is gated.';
    }
  }
  return null;
}

/** Total scrollable height, used to detect whether scrolling achieved anything. */
const pageHeight = () => Math.max(
  document.body?.scrollHeight ?? 0,
  document.documentElement?.scrollHeight ?? 0,
);

/**
 * Scroll and click until the page stops growing.
 *
 * Returns a report rather than throwing, so a partial harvest is still usable
 * and the caller can tell the user what happened.
 */
async function autoScroll(options) {
  const opts = { ...DEFAULTS, ...options };
  const report = {
    scrolls: 0, clicks: 0, itemsFound: 0, stopped: 'complete', blocker: null,
  };

  let stable = 0;
  let lastHeight = pageHeight();
  harvestVisible(opts.itemSelector);

  while (report.scrolls < opts.maxScrolls) {
    if (!state.running) { report.stopped = 'cancelled'; break; }

    // Let the user take over when we hit something only a human can clear.
    const blocker = detectBlocker();
    if (blocker) {
      report.blocker = blocker;
      report.stopped = 'blocked';
      break;
    }

    window.scrollTo({ top: pageHeight(), behavior: 'instant' });
    report.scrolls += 1;
    await sleep(opts.scrollDelayMs);

    // Harvest BEFORE checking growth: virtualised lists recycle nodes, so
    // whatever is on screen now may be gone after the next scroll.
    report.itemsFound += harvestVisible(opts.itemSelector);

    const height = pageHeight();
    if (height > lastHeight) {
      lastHeight = height;
      stable = 0;
      continue;
    }

    stable += 1;
    if (stable < opts.stableRounds) continue;

    // Height stopped growing -- a "load more" button may be waiting.
    if (opts.clickLoadMore && report.clicks < opts.maxClicks) {
      const button = findLoadMore();
      if (button) {
        button.scrollIntoView({ block: 'center' });
        button.click(); // synthetic; if the page ignores it we fall through to 'stalled'
        report.clicks += 1;
        await sleep(opts.scrollDelayMs);
        report.itemsFound += harvestVisible(opts.itemSelector);
        if (pageHeight() > lastHeight) { lastHeight = pageHeight(); stable = 0; continue; }
      }
    }

    report.stopped = report.scrolls >= opts.maxScrolls ? 'max-scrolls' : 'complete';
    break;
  }

  if (report.scrolls >= opts.maxScrolls) report.stopped = 'max-scrolls';
  report.itemCount = state.items.size;
  return report;
}

/**
 * Ask the user to intervene, then wait for them.
 *
 * This is the capability a headless crawler cannot have: the page is real and
 * in front of a person who can log in, dismiss a wall, or solve a challenge.
 */
function showOverlay(message) {
  removeOverlay();

  const host = document.createElement('div');
  host.id = '__crawlette_overlay';
  // A shadow root keeps the page's CSS from reaching our UI, and ours from
  // leaking into the page we are about to scrape.
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .bar {
      position: fixed; inset: auto 16px 16px 16px; z-index: 2147483647;
      display: flex; gap: 12px; align-items: center;
      padding: 12px 16px; border-radius: 10px;
      background: #1c1c1e; color: #f5f5f7;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
    }
    .msg { flex: 1; }
    .msg b { display: block; margin-bottom: 2px; }
    .msg span { opacity: .7; font-size: 12px; }
    button {
      padding: 7px 14px; border-radius: 7px; border: 0; cursor: pointer;
      font: inherit; font-weight: 600; background: #2563eb; color: #fff;
    }
    button.ghost { background: #3a3a3c; }
  `;

  const bar = document.createElement('div');
  bar.className = 'bar';

  const msg = document.createElement('div');
  msg.className = 'msg';
  const title = document.createElement('b');
  title.textContent = 'Crawlette needs a hand';
  const detail = document.createElement('span');
  detail.textContent = message; // textContent: this string can quote page content
  msg.append(title, detail);

  const cont = document.createElement('button');
  cont.textContent = 'Continue';
  cont.addEventListener('click', () => {
    state.paused = false;
    removeOverlay();
  });

  const skip = document.createElement('button');
  skip.className = 'ghost';
  skip.textContent = 'Skip page';
  skip.addEventListener('click', () => {
    state.paused = false;
    state.running = false;
    removeOverlay();
  });

  bar.append(msg, cont, skip);
  root.append(style, bar);
  document.documentElement.appendChild(host);
  state.overlay = host;
}

function removeOverlay() {
  state.overlay?.remove();
  document.getElementById('__crawlette_overlay')?.remove();
  state.overlay = null;
}

/** Block until the user presses Continue (or Skip), or the wait times out. */
async function waitForUser(message, timeoutMs = 300_000) {
  state.paused = true;
  showOverlay(message);

  const deadline = Date.now() + timeoutMs;
  while (state.paused && Date.now() < deadline) await sleep(250);

  removeOverlay();
  if (state.paused) { state.paused = false; return 'timeout'; }
  return state.running ? 'continued' : 'skipped';
}

/** Full harvest: scroll, ask for help if blocked, return the page and items. */
async function run(options = {}) {
  state.running = true;
  state.items.clear();

  let report = await autoScroll(options);

  if (report.stopped === 'blocked' && options.allowAssist !== false) {
    const outcome = await waitForUser(report.blocker);
    if (outcome === 'continued') {
      const second = await autoScroll(options);
      report = { ...second, assisted: true, scrolls: report.scrolls + second.scrolls };
    } else {
      report.assisted = false;
      report.stopped = outcome === 'timeout' ? 'timed-out-waiting' : 'skipped';
    }
  }

  state.running = false;
  return {
    html: document.documentElement.outerHTML,
    url: location.href,
    title: document.title,
    items: [...state.items.values()],
    report,
  };
}

/**
 * Pure helpers, exported for tests.
 *
 * The scroll loop itself needs a live layout engine, but the decisions it makes
 * -- what counts as a "load more" control, what identifies an item across DOM
 * recycling, what looks like a wall needing a human -- are testable logic and
 * are where the bugs live.
 */
export const _internals = {
  itemKey, findLoadMore, detectBlocker, harvestVisible, autoScroll, state,
  LOAD_MORE_PATTERNS, BLOCKER_SELECTORS, DEFAULTS,
};

// The listener only exists inside the extension; tests import the helpers above.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    'content:harvest': () => run(message.options ?? {}),
    'content:stop': async () => { state.running = false; state.paused = false; removeOverlay(); return { stopped: true }; },
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

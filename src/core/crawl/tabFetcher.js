/**
 * Fetching through a real browser tab.
 *
 * The offscreen renderer runs pages invisibly, which is fine until a page wants
 * something from a person: a consent wall, a sign-in, a CAPTCHA, or a control
 * that only responds to a genuine gesture. Nothing is on screen, so nobody can
 * help and the crawl stalls until it times out.
 *
 * A tab fixes that. It loads in the background (no focus stolen), a content
 * script scrolls and clicks to reveal everything, and when it meets a wall it
 * brings the tab forward and asks the user to clear it. That hand-off is the
 * capability a detached crawler structurally cannot have.
 */

import { injectModule } from './injectModule.js';

/** How long to wait for a tab to finish loading before giving up. */
const LOAD_TIMEOUT_MS = 45_000;

/** How long to allow the content script to scroll, click and wait for a human. */
const HARVEST_TIMEOUT_MS = 360_000;

/** Wait for a tab to reach "complete", or reject. */
function waitForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);

    // The tab may already be loaded by the time we start listening.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => { /* the listener will handle it, or time out */ });
  });
}

/** Send a message to a tab's content script with a deadline. */
async function askTab(tabId, message, timeoutMs) {
  const reply = await Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Content script did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    )),
  ]);
  if (!reply) throw new Error('No reply from the content script');
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

/**
 * Load `url` in a background tab, reveal its content, and return the final HTML.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.assist]   surface the tab when a human is needed
 * @param {string}  [options.itemSelector] harvest matches incrementally, for
 *                                         virtualised lists that recycle nodes
 * @param {(info: object) => void} [options.onAssistNeeded]
 * @returns {Promise<{html: string, url: string, items: object[], report: object}>}
 */
export async function harvestInTab(url, options = {}) {
  const {
    assist = true,
    itemSelector = null,
    maxScrolls = 50,
    scrollDelayMs = 700,
    reuseTabId = null,
    onAssistNeeded = () => {},
  } = options;

  let tabId = reuseTabId;
  let createdTab = false;

  try {
    if (tabId == null) {
      // active:false keeps the user's focus where it was; the tab is still real
      // and visible in the strip, so they can look at it whenever they want.
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      createdTab = true;
    } else {
      await chrome.tabs.update(tabId, { url });
    }

    await waitForLoad(tabId);

    await injectModule(tabId, 'src/content/harvest.js');

    const harvest = await askTab(
      tabId,
      {
        type: 'content:harvest',
        options: { itemSelector, maxScrolls, scrollDelayMs, allowAssist: assist },
      },
      HARVEST_TIMEOUT_MS,
    );

    // If the page needed a person, bring it forward so they can act. The
    // content script is already showing its own prompt on the page.
    if (harvest.report?.stopped === 'blocked' && assist) {
      await chrome.tabs.update(tabId, { active: true });
      onAssistNeeded({ url, reason: harvest.report.blocker });
    }

    return harvest;
  } finally {
    // Leave a reused tab alone; only clean up what we created.
    if (createdTab && tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch { /* the user may have closed it already */ }
    }
  }
}

/** Harvest whatever is in a tab the user already has open and has prepared. */
export async function harvestCurrentTab(options = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  if (!/^https?:/.test(tab.url ?? '')) throw new Error('That tab is not a web page');

  await injectModule(tab.id, 'src/content/harvest.js');

  return askTab(
    tab.id,
    { type: 'content:harvest', options: { ...options, allowAssist: true } },
    HARVEST_TIMEOUT_MS,
  );
}

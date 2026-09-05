/**
 * Inject a content script as an ES module.
 *
 * `chrome.scripting.executeScript({files})` injects a CLASSIC script, so any
 * top-level `import` or `export` is a syntax error. The script then fails to
 * parse, no message listener is ever registered, and the next `sendMessage`
 * fails with "Could not establish connection. Receiving end does not exist" --
 * which points at messaging rather than at the real cause.
 *
 * Injecting a tiny loader that dynamically imports the extension URL gets a
 * real module instead, so imports and exports work normally. The module is
 * cached per page, so re-injecting is cheap and idempotent.
 */

/**
 * Load `path` as a module inside `tabId`, and wait for it to be ready.
 *
 * @param {number} tabId
 * @param {string} path  extension-relative, e.g. 'src/content/recorder.js'
 */
export async function injectModule(tabId, path) {
  const url = chrome.runtime.getURL(path);

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    // Runs in the isolated content-script world, where chrome.runtime exists.
    func: async (moduleUrl) => {
      globalThis.__crawletteModules ??= new Map();
      if (globalThis.__crawletteModules.has(moduleUrl)) return { ok: true, cached: true };
      try {
        await import(moduleUrl);
        globalThis.__crawletteModules.set(moduleUrl, true);
        return { ok: true, cached: false };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
    args: [url],
  });

  const result = injection?.result;
  if (!result?.ok) {
    throw new Error(`Could not load ${path}: ${result?.error ?? 'unknown error'}`);
  }
  return result;
}

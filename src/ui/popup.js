/**
 * Popup: collects crawl settings, drives start/stop, shows a live counter.
 *
 * The popup closes whenever it loses focus, so it holds no crawl state of its
 * own -- the service worker owns everything and the popup just polls it.
 */

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

const SETTINGS_KEY = 'crawlSettings';
const POLL_MS = 500;

/** Fields persisted between popup sessions. */
const FIELDS = {
  strategy: 'value',
  contentFilter: 'value',
  maxDepth: 'value',
  maxPages: 'value',
  query: 'value',
  keywords: 'value',
  cssSelector: 'value',
  sitemapUrl: 'value',
  sitemapMatch: 'value',
  extractionSchema: 'value',
  useSitemap: 'checked',
  renderJs: 'checked',
  includeExternal: 'checked',
  excludeSocialMedia: 'checked',
};

let pollTimer = null;

/** Show or hide the fields that only apply to certain modes. */
function syncConditionalFields() {
  $('queryRow').hidden = $('contentFilter').value !== 'bm25';
  $('keywordsRow').hidden = $('strategy').value !== 'best-first';
  $('sitemapFields').hidden = !$('useSitemap').checked;
}

/**
 * Parse the schema box, reporting problems as the user types.
 *
 * @returns {{schema: object|null, error: string|null}}
 */
function readSchema() {
  const raw = $('extractionSchema').value.trim();
  if (!raw) return { schema: null, error: null };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { schema: null, error: `Invalid JSON: ${e.message}` };
  }
  if (!parsed.baseSelector) return { schema: null, error: 'Schema needs a baseSelector' };
  if (!Array.isArray(parsed.fields)) return { schema: null, error: 'Schema needs a fields array' };
  return { schema: parsed, error: null };
}

/** Show schema validity under the textarea. */
function validateSchemaField() {
  const el = $('schemaStatus');
  const raw = $('extractionSchema').value.trim();
  if (!raw) { el.textContent = ''; el.className = 'hint'; return; }

  const { schema, error } = readSchema();
  if (error) {
    el.textContent = error;
    el.className = 'hint bad';
  } else {
    el.textContent = `Valid — ${schema.fields.length} field(s) per "${schema.baseSelector}"`;
    el.className = 'hint good';
  }
}

async function loadSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
  for (const [id, prop] of Object.entries(FIELDS)) {
    if (stored[id] !== undefined) $(id)[prop] = stored[id];
  }

  // Default the URL to the active tab, which is nearly always what's wanted.
  if (!$('url').value) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith('http')) $('url').value = tab.url;
  }
  syncConditionalFields();
}

function saveSettings() {
  const settings = {};
  for (const [id, prop] of Object.entries(FIELDS)) settings[id] = $(id)[prop];
  return chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/** Split a comma or whitespace separated list into trimmed entries. */
const parseList = (value) => value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

function buildConfig() {
  return {
    url: $('url').value.trim(),
    strategy: $('strategy').value,
    contentFilter: $('contentFilter').value,
    maxDepth: parseInt($('maxDepth').value, 10),
    maxPages: parseInt($('maxPages').value, 10),
    query: $('query').value.trim(),
    keywords: parseList($('keywords').value),
    cssSelector: $('cssSelector').value.trim(),
    useSitemap: $('useSitemap').checked,
    sitemapUrl: $('sitemapUrl').value.trim(),
    sitemapMatch: $('sitemapMatch').value.trim(),
    extractionSchema: readSchema().schema,
    renderJs: $('renderJs').checked,
    includeExternal: $('includeExternal').checked,
    excludeSocialMedia: $('excludeSocialMedia').checked,
  };
}

/**
 * Render a status line.
 *
 * `parts` are appended as text nodes or elements, never parsed as HTML: error
 * strings can carry text from a crawled page (a URL, a server message), and
 * interpolating that into innerHTML would make a hostile site able to inject
 * markup into the extension's own UI.
 */
function setStatus(parts, isError = false) {
  const el = $('status');
  el.textContent = '';

  const container = document.createElement('span');
  if (isError) container.className = 'err';

  for (const part of Array.isArray(parts) ? parts : [parts]) {
    if (part instanceof Node) container.appendChild(part);
    else container.appendChild(document.createTextNode(String(part)));
  }

  el.appendChild(container);
  el.classList.add('show');
}

/** A bold fragment, for counts inside a status line. */
function strong(text) {
  const el = document.createElement('strong');
  el.textContent = String(text);
  return el;
}

function setRunning(isRunning) {
  $('start').disabled = isRunning;
  $('stop').disabled = !isRunning;
}

async function refresh() {
  const status = await send({ type: 'status' });
  if (!status || status.error) return;

  const { state, total, successful, stale } = status;
  const isRunning = state.status === 'running' && !stale;
  setRunning(isRunning);

  if (state.status === 'idle') {
    $('status').classList.remove('show');
  } else if (isRunning) {
    setStatus(['Crawling… ', strong(successful), ` pages (${total} attempted)`]);
  } else if (stale) {
    setStatus(`Interrupted at ${successful} pages — the browser paused the crawl.`, true);
  } else if (state.status === 'error') {
    setStatus(`Failed: ${state.lastError}`, true);
  } else {
    const label = state.status === 'cancelled' ? 'Stopped' : 'Done';
    setStatus([`${label} — `, strong(successful), ' pages crawled.']);
  }

  if (!isRunning && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
}

$('start').addEventListener('click', async () => {
  const config = buildConfig();
  if (!config.url) return setStatus('Enter a URL to crawl.', true);
  try {
    new URL(config.url);
  } catch {
    return setStatus('That URL is not valid.', true);
  }

  const { error: schemaError } = readSchema();
  if (schemaError) return setStatus(schemaError, true);

  if (config.useSitemap && !config.sitemapUrl) {
    return setStatus('Enter a sitemap URL, or turn off sitemap seeding.', true);
  }

  await saveSettings();
  setRunning(true);
  setStatus('Starting…');

  const response = await send({ type: 'start', config });
  if (response?.error) {
    setRunning(false);
    return setStatus(response.error, true);
  }
  startPolling();
  return undefined;
});

$('stop').addEventListener('click', async () => {
  await send({ type: 'stop' });
  await refresh();
});

$('view').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/results.html') });
});

for (const id of ['contentFilter', 'strategy', 'useSitemap']) {
  $(id).addEventListener('change', syncConditionalFields);
}
$('extractionSchema').addEventListener('input', validateSchemaField);

loadSettings().then(validateSchemaField).then(refresh).then(() => {
  if (!$('stop').disabled) startPolling();
});

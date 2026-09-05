/**
 * Results view: a sortable page list with a detail pane and exports.
 *
 * Everything rendered here originates from crawled pages, so all of it is
 * untrusted: titles, URLs, markdown and link text are inserted as text nodes,
 * never as HTML. A crawled site must not be able to inject markup or script
 * into the extension's own origin.
 */

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let results = [];
let selected = null;
let activeTab = 'markdown';
let sortKey = null;
let sortAsc = true;

/** Replace an element's children with freshly built nodes. */
function render(parent, nodes) {
  parent.textContent = '';
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    parent.appendChild(node);
  }
}

const text = (tag, value, className) => {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  return el;
};

function sortedResults() {
  if (!sortKey) return results;
  const sorted = [...results].sort((a, b) => {
    const x = a[sortKey] ?? '';
    const y = b[sortKey] ?? '';
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  });
  return sortAsc ? sorted : sorted.reverse();
}

function renderList() {
  const tbody = $('rows');
  tbody.textContent = '';

  for (const result of sortedResults()) {
    const tr = document.createElement('tr');
    if (result === selected) tr.className = 'active';

    // Prefer the page title, falling back to the path.
    let label = result.title;
    if (!label) {
      try {
        label = new URL(result.url).pathname;
      } catch {
        label = result.url;
      }
    }

    const urlCell = text('td', label);
    urlCell.title = result.url;
    if (!result.success) {
      urlCell.textContent = `${label} — failed`;
      urlCell.className = 'fail';
    }

    tr.append(urlCell, text('td', result.depth, 'num'), text('td', result.wordCount || 0, 'num'));
    tr.addEventListener('click', () => {
      selected = result;
      activeTab = bestTabFor(result);
      syncTabs();
      renderList();
      renderDetail();
    });
    tbody.appendChild(tr);
  }
}

/** Build the body for the active detail tab. */
function detailNodes(result) {
  if (!result.success) {
    return text('p', `This page failed: ${result.error ?? 'unknown error'}`, 'empty');
  }

  if (activeTab === 'links') {
    const all = [
      ...result.links.internal.map((l) => ({ ...l, kind: 'internal' })),
      ...result.links.external.map((l) => ({ ...l, kind: 'external' })),
    ];
    if (!all.length) return text('p', 'No links found.', 'empty');

    const ul = document.createElement('ul');
    ul.className = 'links';
    for (const link of all) {
      ul.appendChild(text('li', `[${link.kind}] ${link.text || '(no text)'} — ${link.href}`));
    }
    return ul;
  }

  if (activeTab === 'media') {
    const { images = [], videos = [], audios = [] } = result.media;
    const all = [...images, ...videos, ...audios];
    if (!all.length) return text('p', 'No media found.', 'empty');

    const ul = document.createElement('ul');
    ul.className = 'links';
    for (const item of all) {
      const bits = [item.type ?? 'image', item.src];
      if (item.alt) bits.push(`alt: ${item.alt}`);
      ul.appendChild(text('li', bits.join(' — ')));
    }
    return ul;
  }

  if (activeTab === 'extracted') {
    const rows = result.extracted;
    if (!rows || (Array.isArray(rows) && !rows.length)) {
      return text('p', 'Nothing extracted for this page.', 'empty');
    }
    if (rows.error) return text('p', `Schema problem: ${rows.error}`, 'empty');

    // Recorded items read far better as a table than as a wall of JSON.
    if (Array.isArray(rows) && typeof rows[0] === 'object') {
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const table = document.createElement('table');

      const head = document.createElement('tr');
      for (const c of columns) head.appendChild(text('th', c));
      table.appendChild(head);

      for (const row of rows.slice(0, 500)) {
        const tr = document.createElement('tr');
        for (const c of columns) tr.appendChild(text('td', row[c] ?? ''));
        table.appendChild(tr);
      }

      const wrap = document.createElement('div');
      wrap.style.overflowX = 'auto';
      wrap.append(text('p', `${rows.length} items`, 'empty'), table);
      return wrap;
    }
    return text('pre', JSON.stringify(rows, null, 2));
  }

  if (activeTab === 'fitMarkdown') {
    if (!result.fitMarkdown) {
      return text('p', 'No filtered content — the content filter found nothing to keep.', 'empty');
    }
    return text('pre', result.fitMarkdown);
  }

  const body = result.markdown + (result.references ? `\n${result.references}` : '');
  return text('pre', body || '(empty)');
}

/** Pick the tab that actually has something in it for this result. */
function bestTabFor(result) {
  if (!result?.success) return activeTab;
  if (!result.markdown && Array.isArray(result.extracted) && result.extracted.length) {
    return 'extracted';
  }
  return activeTab;
}

/** Reflect the active tab in the tab strip. */
function syncTabs() {
  for (const button of document.querySelectorAll('.tabs button')) {
    button.classList.toggle('active', button.dataset.tab === activeTab);
  }
}

function renderDetail() {
  if (!selected) {
    $('detailUrl').textContent = '';
    render($('content'), text('p', 'Select a page to view its content.', 'empty'));
    return;
  }
  $('detailUrl').textContent = selected.url;
  render($('content'), detailNodes(selected));
}

function renderStats(status) {
  const { state } = status;
  const ok = results.filter((r) => r.success).length;
  const failed = results.length - ok;

  const bits = [`${ok} pages`];
  if (failed) bits.push(`${failed} failed`);
  if (state?.status === 'running') bits.push('crawling…');
  else if (state?.status === 'cancelled') bits.push('stopped');
  else if (state?.status === 'error') bits.push(`error: ${state.lastError}`);

  $('stats').textContent = results.length ? bits.join(' · ') : 'No results yet';
}

async function load() {
  const [status, stored] = await Promise.all([send({ type: 'status' }), send({ type: 'results' })]);
  results = Array.isArray(stored) ? stored : [];

  // Keep the selection across refreshes when the page is still present.
  if (selected) selected = results.find((r) => r.url === selected.url) ?? null;

  renderStats(status ?? {});
  renderList();
  renderDetail();

  // Poll while a crawl is in flight so the table fills in live.
  if (status?.state?.status === 'running') setTimeout(load, 1000);
}

/** Trigger a download of `content` as `filename`. */
function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 10);

$('exportMd').addEventListener('click', () => {
  const doc = results
    .filter((r) => r.success)
    .map((r) => `# ${r.title || r.url}\n\n<${r.url}>\n\n${r.markdown}\n`)
    .join('\n---\n\n');
  download(doc, `crawlette-${stamp()}.md`, 'text/markdown');
});

$('exportJson').addEventListener('click', () => {
  // If every page carries extracted rows, export those flattened -- that is the
  // shape worth pasting into a model, rather than the crawl bookkeeping.
  const extracted = results.flatMap((r) => (Array.isArray(r.extracted) ? r.extracted : []));
  const payload = extracted.length ? extracted : results;
  download(JSON.stringify(payload, null, 2), `crawlette-${stamp()}.json`, 'application/json');
});

$('refresh').addEventListener('click', load);

$('clear').addEventListener('click', async () => {
  await send({ type: 'clear' });
  results = [];
  selected = null;
  await load();
});

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs button')) other.classList.remove('active');
    button.classList.add('active');
    activeTab = button.dataset.tab;
    renderDetail();
  });
}

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortAsc = !sortAsc;
    else { sortKey = key; sortAsc = true; }
    renderList();
  });
}

load();

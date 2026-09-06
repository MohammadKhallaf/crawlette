/**
 * Shaping crawl results for export.
 *
 * Scope note: Crawlette's job stops at pointing an LLM (or a person) at a
 * better API -- it does not call that API itself. crawl4ai's own philosophy is
 * the same: hand back well-formed, LLM-ready data and let the consumer decide
 * what to do with a discovered shortcut. So the functions here only FORMAT the
 * captured calls; nothing here issues a request. See src/content/network.js
 * for where the calls are captured, during a Pick & record session.
 */

/** Markdown block for one captured API call, with its pagination hints. */
function apiCallMarkdown(call) {
  const hints = [];
  if (call.paginationParams?.length) {
    hints.push(`query params to page through: ${call.paginationParams.join(', ')}`);
  }
  if (call.paginationHints?.length) {
    hints.push(`response fields describing more pages: ${call.paginationHints.join(', ')}`);
  }
  const hintLines = hints.length ? `\n- ${hints.join('\n- ')}` : '';
  const itemKeyNote = call.itemKey ? ` under \`${call.itemKey}\`` : '';

  return `### ${call.method} ${call.url}\n\n`
    + `${call.itemCount} item(s)${itemKeyNote}.${hintLines}\n\n`
    + `Sample response:\n\n\`\`\`json\n${call.sample}\n\`\`\`\n`;
}

/**
 * A markdown section listing every API call seen during a recording.
 *
 * @param {object[]} apiCalls
 * @returns {string} empty string when there is nothing to report
 */
export function apiCallsMarkdown(apiCalls) {
  if (!apiCalls?.length) return '';

  const intro = '\n## Data APIs seen during recording\n\n'
    + 'Calling these directly, with a raised page size or by following their '
    + 'pagination fields, is usually faster and more complete than scraping '
    + 'the rendered page.\n\n';

  return intro + apiCalls.map(apiCallMarkdown).join('\n');
}

/** The subset of a captured call worth keeping in an export. */
function apiCallForExport(call) {
  return {
    method: call.method,
    url: call.url,
    itemCount: call.itemCount,
    itemKey: call.itemKey || null,
    paginationParams: call.paginationParams ?? [],
    paginationHints: call.paginationHints ?? [],
    sample: call.sample,
  };
}

/**
 * Attach discovered APIs to a JSON export payload.
 *
 * Returns `payload` unchanged when there is nothing to attach, so a crawl with
 * no recording still exports exactly the plain data shape it always did.
 *
 * @param {*} payload   the data being exported (an array of rows, typically)
 * @param {object[]} apiCalls
 */
export function withDiscoveredApis(payload, apiCalls) {
  if (!apiCalls?.length) return payload;
  return { data: payload, discoveredApis: apiCalls.map(apiCallForExport) };
}

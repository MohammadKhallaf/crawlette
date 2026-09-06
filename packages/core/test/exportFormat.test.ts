import test from 'node:test';
import assert from 'node:assert/strict';
import { apiCallsMarkdown, withDiscoveredApis } from '../src/exportFormat.ts';

const call = (overrides = {}) => ({
  method: 'GET',
  url: 'https://unbound.hubspot.com/api/speakers?page=1',
  itemCount: 30,
  itemKey: 'speakers',
  paginationParams: ['page'],
  paginationHints: ['total', 'hasMore'],
  sample: '{"speakers":[{"name":"Ada"}],"total":333,"hasMore":true}',
  ...overrides,
});

test('apiCallsMarkdown returns empty string when nothing was captured', () => {
  assert.equal(apiCallsMarkdown([]), '');
  assert.equal(apiCallsMarkdown(undefined), '');
  assert.equal(apiCallsMarkdown(null), '');
});

test('apiCallsMarkdown names the endpoint, method and item count', () => {
  const md = apiCallsMarkdown([call()]);
  assert.match(md, /### GET https:\/\/unbound\.hubspot\.com\/api\/speakers\?page=1/);
  assert.match(md, /30 item\(s\) under `speakers`/);
});

test('apiCallsMarkdown surfaces pagination params and hints as actionable lines', () => {
  const md = apiCallsMarkdown([call()]);
  assert.match(md, /query params to page through: page/);
  assert.match(md, /response fields describing more pages: total, hasMore/);
});

test('apiCallsMarkdown includes the raw sample as a fenced code block', () => {
  const md = apiCallsMarkdown([call()]);
  assert.match(md, /```json\n\{"speakers":\[\{"name":"Ada"\}\],"total":333,"hasMore":true\}\n```/);
});

test('apiCallsMarkdown omits the itemKey clause when there is none', () => {
  const md = apiCallsMarkdown([call({ itemKey: '' })]);
  assert.match(md, /30 item\(s\)\./);
  assert.ok(!md.includes('item(s) under'));
});

test('apiCallsMarkdown omits hint bullets entirely when there are none', () => {
  const md = apiCallsMarkdown([call({ paginationParams: [], paginationHints: [] })]);
  assert.ok(!md.includes('query params to page through'));
  assert.ok(!md.includes('response fields describing more pages'));
});

test('apiCallsMarkdown lists multiple calls in order', () => {
  const md = apiCallsMarkdown([
    call({ url: 'https://s.test/a' }),
    call({ url: 'https://s.test/b' }),
  ]);
  const posA = md.indexOf('https://s.test/a');
  const posB = md.indexOf('https://s.test/b');
  assert.ok(posA > -1 && posB > -1 && posA < posB);
});

test('withDiscoveredApis leaves the payload untouched when nothing was captured', () => {
  const payload = [{ name: 'Ada' }];
  assert.equal(withDiscoveredApis(payload, []), payload);
  assert.equal(withDiscoveredApis(payload, undefined), payload);
});

test('withDiscoveredApis wraps the payload and includes discovered APIs', () => {
  const payload = [{ name: 'Ada' }];
  const result = withDiscoveredApis(payload, [call()]);
  assert.equal(result.data, payload);
  assert.equal(result.discoveredApis.length, 1);
  assert.equal(result.discoveredApis[0].url, call().url);
});

test('withDiscoveredApis strips fields down to what an LLM needs, not internal bookkeeping', () => {
  const result = withDiscoveredApis([], [call({ bytes: 99999, status: 200, at: Date.now() })]);
  const exported = result.discoveredApis[0];
  assert.deepEqual(Object.keys(exported).sort(), [
    'itemCount', 'itemKey', 'method', 'paginationHints', 'paginationParams', 'sample', 'url',
  ].sort());
  assert.ok(!('bytes' in exported), 'internal byte counts are not useful to an LLM');
  assert.ok(!('at' in exported), 'capture timestamps are not useful to an LLM');
});

test('withDiscoveredApis normalises a missing itemKey to null rather than empty string', () => {
  const result = withDiscoveredApis([], [call({ itemKey: '' })]);
  assert.equal(result.discoveredApis[0].itemKey, null);
});

test('withDiscoveredApis defaults missing pagination arrays rather than throwing', () => {
  const result = withDiscoveredApis([], [call({ paginationParams: undefined, paginationHints: undefined })]);
  assert.deepEqual(result.discoveredApis[0].paginationParams, []);
  assert.deepEqual(result.discoveredApis[0].paginationHints, []);
});

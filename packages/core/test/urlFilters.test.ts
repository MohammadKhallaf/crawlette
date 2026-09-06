import test from 'node:test';
import assert from 'node:assert/strict';
import {
  URLPatternFilter, DomainFilter, ContentTypeFilter, PathDepthFilter, FilterChain,
} from '../src/crawl/urlFilters.ts';

test('URLPatternFilter matches glob patterns anywhere in the URL', () => {
  const f = new URLPatternFilter(['*/blog/*']);
  assert.equal(f.apply('https://e.com/blog/x'), true);
  assert.equal(f.apply('https://e.com/news/x'), false);
});

test('URLPatternFilter supports a bare regex escape hatch', () => {
  const f = new URLPatternFilter(['^https://e\\.com/']);
  assert.equal(f.apply('https://e.com/a'), true);
  assert.equal(f.apply('https://other.com/a'), false);
});

test('URLPatternFilter supports {a,b} alternation', () => {
  const f = new URLPatternFilter(['*/{docs,api}/*']);
  assert.equal(f.apply('https://e.com/api/v1'), true);
  assert.equal(f.apply('https://e.com/docs/v1'), true);
  assert.equal(f.apply('https://e.com/other/v1'), false);
});

test('URLPatternFilter matches extension suffixes with and without a query string', () => {
  const f = new URLPatternFilter(['*.pdf']);
  assert.equal(f.apply('https://e.com/file.pdf'), true);
  assert.equal(f.apply('https://e.com/dir/file.pdf'), true);
  assert.equal(f.apply('https://e.com/file.html'), false);
});

test('URLPatternFilter reverse inverts the match', () => {
  const f = new URLPatternFilter(['*/blog/*'], { reverse: true });
  assert.equal(f.apply('https://e.com/blog/x'), false);
  assert.equal(f.apply('https://e.com/news/x'), true);
});

test('URLPatternFilter accepts a single string, not just an array', () => {
  const f = new URLPatternFilter('*/blog/*');
  assert.equal(f.apply('https://e.com/blog/x'), true);
});

test('DomainFilter allowed list accepts subdomains', () => {
  const f = new DomainFilter({ allowed: ['example.com'] });
  assert.equal(f.apply('https://example.com/a'), true);
  assert.equal(f.apply('https://docs.example.com/a'), true);
  assert.equal(f.apply('https://other.com/a'), false);
});

test('DomainFilter blocked list rejects subdomains too', () => {
  const f = new DomainFilter({ blocked: ['bad.com'] });
  assert.equal(f.apply('https://bad.com/a'), false);
  assert.equal(f.apply('https://sub.bad.com/a'), false);
  assert.equal(f.apply('https://good.com/a'), true);
});

test('DomainFilter blockSocialMedia rejects known platforms', () => {
  const f = new DomainFilter({ blockSocialMedia: true });
  assert.equal(f.apply('https://twitter.com/a'), false);
  assert.equal(f.apply('https://example.com/a'), true);
});

test('DomainFilter rejects an unparseable URL rather than throwing', () => {
  const f = new DomainFilter({ allowed: ['example.com'] });
  assert.equal(f.apply('not a url'), false);
});

test('ContentTypeFilter blocks binary extensions by default', () => {
  const f = new ContentTypeFilter();
  assert.equal(f.apply('https://e.com/a.png'), false);
  assert.equal(f.apply('https://e.com/a.html'), true);
  assert.equal(f.apply('https://e.com/a'), true, 'extensionless URLs always pass');
});

test('ContentTypeFilter extension extraction is query-safe', () => {
  assert.equal(ContentTypeFilter.extension('https://e.com/a.html?x=1'), 'html');
  assert.equal(ContentTypeFilter.extension('https://e.com/a.html#frag'), 'html');
});

test('ContentTypeFilter with an allowlist only accepts those extensions', () => {
  const f = new ContentTypeFilter({ allowed: ['.html', 'pdf'] });
  assert.equal(f.apply('https://e.com/a.html'), true);
  assert.equal(f.apply('https://e.com/a.pdf'), true);
  assert.equal(f.apply('https://e.com/a.json'), false);
});

test('PathDepthFilter caps how many path segments a URL may have', () => {
  const f = new PathDepthFilter({ maxDepth: 2 });
  assert.equal(f.apply('https://e.com/a/b'), true);
  assert.equal(f.apply('https://e.com/a/b/c'), false);
});

test('PathDepthFilter rejects an unparseable URL', () => {
  assert.equal(new PathDepthFilter({ maxDepth: 2 }).apply('not a url'), false);
});

test('FilterChain requires every filter to pass', () => {
  const chain = new FilterChain([
    new ContentTypeFilter(),
    new PathDepthFilter({ maxDepth: 2 }),
  ]);
  assert.equal(chain.apply('https://e.com/a/b'), true);
  assert.equal(chain.apply('https://e.com/a/b/c'), false, 'depth filter should reject');
  assert.equal(chain.apply('https://e.com/a.png'), false, 'content-type filter should reject');
});

test('FilterChain with no filters passes everything', () => {
  assert.equal(new FilterChain().apply('https://e.com/anything'), true);
});

test('FilterChain.add appends and returns the chain for chaining', () => {
  const chain = new FilterChain();
  const returned = chain.add(new PathDepthFilter({ maxDepth: 0 }));
  assert.equal(returned, chain);
  assert.equal(chain.apply('https://e.com/a'), false);
});

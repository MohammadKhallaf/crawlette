import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KeywordRelevanceScorer, PathDepthScorer, FreshnessScorer,
  ContentTypeScorer, DomainAuthorityScorer, CompositeScorer,
} from '../src/crawl/scorers.ts';

test('keyword scorer returns the matched fraction', () => {
  const s = new KeywordRelevanceScorer(['python', 'tutorial']);
  assert.equal(s.score('https://e.com/python/tutorial'), 1);
  assert.equal(s.score('https://e.com/python/guide'), 0.5);
  assert.equal(s.score('https://e.com/other'), 0);
});

test('keyword scorer honours case sensitivity', () => {
  assert.equal(new KeywordRelevanceScorer(['API']).score('https://e.com/api'), 1);
  assert.equal(new KeywordRelevanceScorer(['API'], { caseSensitive: true }).score('https://e.com/api'), 0);
});

test('keyword scorer applies its weight once', () => {
  assert.equal(new KeywordRelevanceScorer(['x'], { weight: 2 }).score('https://e.com/x'), 2);
});

test('path depth scorer peaks at the optimal depth', () => {
  const s = new PathDepthScorer({ optimalDepth: 2 });
  assert.equal(s.score('https://e.com/a/b'), 1);           // distance 0
  assert.equal(s.score('https://e.com/a'), 0.5);           // distance 1
  assert.equal(s.score('https://e.com/a/b/c/d'), 1 / 3);   // distance 2
});

test('path depth follows 1/(1+distance)', () => {
  const s = new PathDepthScorer({ optimalDepth: 0 });
  assert.equal(s.score('https://e.com/'), 1);
  assert.equal(s.score('https://e.com/a'), 0.5);
  assert.equal(s.score('https://e.com/a/b'), 1 / 3);
  assert.equal(s.score('https://e.com/a/b/c'), 0.25);
});

test('path depth ignores trailing slashes', () => {
  assert.equal(PathDepthScorer.depth('https://e.com/a/b/'), 2);
  assert.equal(PathDepthScorer.depth('https://e.com/'), 0);
});

test('freshness scorer prefers recent years', () => {
  const s = new FreshnessScorer({ currentYear: 2026 });
  assert.equal(s.score('https://e.com/2026/01/post'), 1.0);
  assert.equal(s.score('https://e.com/2025/01/post'), 0.9);
  assert.equal(s.score('https://e.com/2021/01/post'), 0.5);
});

test('freshness scorer gives undated URLs a neutral 0.5', () => {
  assert.equal(new FreshnessScorer({ currentYear: 2026 }).score('https://e.com/about'), 0.5);
});

test('freshness scorer ignores future years', () => {
  const s = new FreshnessScorer({ currentYear: 2026 });
  assert.equal(s.score('https://e.com/2099/post'), 0.5);
});

test('freshness scorer floors old content at 0.1', () => {
  assert.equal(new FreshnessScorer({ currentYear: 2026 }).score('https://e.com/1999/post'), 0.1);
});

test('content type scorer maps extensions to weights', () => {
  const s = new ContentTypeScorer({ '.html$': 1.0, pdf: 0.4 });
  assert.equal(s.score('https://e.com/a.html'), 1.0);
  assert.equal(s.score('https://e.com/a.pdf'), 0.4);
  assert.equal(s.score('https://e.com/a.zip'), 0);
});

test('content type extension is query-safe', () => {
  assert.equal(ContentTypeScorer.extension('https://e.com/a.html?x=1#y'), 'html');
  assert.equal(ContentTypeScorer.extension('https://e.com/about'), '');
});

test('domain authority scorer falls back to its default', () => {
  const s = new DomainAuthorityScorer({ 'good.com': 1.0 }, { defaultWeight: 0.2 });
  assert.equal(s.score('https://good.com/a'), 1.0);
  assert.equal(s.score('https://unknown.com/a'), 0.2);
});

test('composite scorer averages by scorer count', () => {
  const c = new CompositeScorer([
    new KeywordRelevanceScorer(['x']),     // 1
    new PathDepthScorer({ optimalDepth: 0 }), // 0.5 at depth 1
  ]);
  assert.equal(c.score('https://e.com/x'), 0.75);
});

test('composite scorer can skip normalization', () => {
  const c = new CompositeScorer([new KeywordRelevanceScorer(['x'])], { normalize: false });
  assert.equal(c.score('https://e.com/x'), 1);
});

test('composite scorer with no children scores zero', () => {
  assert.equal(new CompositeScorer([]).score('https://e.com/x'), 0);
});

test('scorers tolerate malformed URLs', () => {
  for (const s of [
    new PathDepthScorer(), new ContentTypeScorer({ html: 1 }), new DomainAuthorityScorer({}),
  ]) {
    assert.equal(Number.isFinite(s.score('not a url')), true);
  }
});

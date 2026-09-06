import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrl, getBaseDomain, isExternalUrl, isSocialMediaUrl,
} from '../src/normalize.ts';

const BASE = 'https://example.com/docs/guide';

test('resolves relative hrefs against the base', () => {
  assert.equal(normalizeUrl('intro', BASE), 'https://example.com/docs/intro');
  assert.equal(normalizeUrl('/top', BASE), 'https://example.com/top');
  assert.equal(normalizeUrl('//cdn.example.com/x', BASE), 'https://cdn.example.com/x');
});

test('strips the fragment but keeps the query', () => {
  assert.equal(normalizeUrl('/a?b=1#sec', BASE), 'https://example.com/a?b=1');
});

test('drops tracking params, keeps the rest', () => {
  assert.equal(
    normalizeUrl('/a?utm_source=nl&id=7&fbclid=z&gclid=q', BASE),
    'https://example.com/a?id=7',
  );
});

test('lowercases the host and maps empty path to /', () => {
  assert.equal(normalizeUrl('https://EXAMPLE.com', BASE), 'https://example.com/');
});

test('trailing slash is significant', () => {
  assert.notEqual(normalizeUrl('/a', BASE), normalizeUrl('/a/', BASE));
});

test('returns null for empty or malformed hrefs', () => {
  for (const bad of ['', null, undefined, 'http://[bad']) {
    assert.equal(normalizeUrl(bad, BASE), null);
  }
});

test('getBaseDomain strips www and honours compound TLDs', () => {
  assert.equal(getBaseDomain('https://www.example.com/x'), 'example.com');
  assert.equal(getBaseDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(getBaseDomain('sub.deep.example.com'), 'example.com');
  assert.equal(getBaseDomain('example.com:8080'), 'example.com');
});

test('subdomains are internal, other domains are external', () => {
  assert.equal(isExternalUrl('https://docs.example.com/a', 'example.com'), false);
  assert.equal(isExternalUrl('/relative', 'example.com'), false);
  assert.equal(isExternalUrl('https://other.org/a', 'example.com'), true);
});

test('lookalike domains are external (divergence from crawl4ai)', () => {
  // crawl4ai's bare endswith() would call these internal, letting a scoped
  // crawl wander onto an attacker-controlled domain.
  assert.equal(isExternalUrl('https://evilexample.com/', 'example.com'), true);
  assert.equal(isExternalUrl('https://notexample.com/', 'example.com'), true);
});

test('non-http schemes are external', () => {
  for (const u of ['mailto:a@b.com', 'tel:+123', 'javascript:void(0)', 'data:text/plain,x']) {
    assert.equal(isExternalUrl(u, 'example.com'), true);
  }
});

test('recognises social media hosts including subdomains', () => {
  assert.equal(isSocialMediaUrl('https://twitter.com/a'), true);
  assert.equal(isSocialMediaUrl('https://www.reddit.com/r/x'), true);
  assert.equal(isSocialMediaUrl('https://example.com/twitter.com'), false);
});

/**
 * crawl4ai hardcodes a dozen-entry compound-suffix list (utils.py:2480), which
 * gets these wrong: ".com.au" isn't in the list at all, and registry-run
 * suffixes like "github.io" only worked by the 2-part fallback coincidence.
 * getBaseDomain now uses tldts (the real, maintained Public Suffix List), so
 * these resolve correctly rather than by luck.
 */
test('getBaseDomain handles public suffixes crawl4ai\'s hardcoded list does not', () => {
  assert.equal(getBaseDomain('https://shop.example.com.au'), 'example.com.au');
  assert.equal(getBaseDomain('https://someone.github.io/repo'), 'github.io');
  // vercel.app is itself a registered public suffix (every deployment gets a
  // subdomain under it), so the registrable domain is vercel.app -- getting
  // this right at all requires the real Public Suffix List, not a guess.
  assert.equal(getBaseDomain('https://my-app.vercel.app'), 'vercel.app');
});

test('getBaseDomain falls back to the bare host for non-registrable hosts', () => {
  assert.equal(getBaseDomain('http://localhost:3000/x'), 'localhost');
  assert.equal(getBaseDomain('http://192.168.1.1/x'), '192.168.1.1');
  assert.equal(getBaseDomain('http://intranet/x'), 'intranet');
});

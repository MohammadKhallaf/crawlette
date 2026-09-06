# crawlette-core

The browser-native crawl processing engine behind [Crawlette](https://github.com/MohammadKhallaf/crawlette): DOM cleaning, markdown generation, content filters, structured extraction and deep-crawl strategies — a JavaScript/TypeScript port of [crawl4ai](https://github.com/unclecode/crawl4ai)'s core pipeline. No server, no Python.

This package is the **portable** subset. Everything here is a pure function of a `Document`/HTML string plus a fetch function you supply — nothing calls `chrome.*` or issues a network request on its own. The [Crawlette extension](https://github.com/MohammadKhallaf/crawlette) builds the browser-specific pieces (network capture, tab automation, the visual picker) on top of this.

## Install

```bash
npm install crawlette-core
```

Runs in any environment with a `DOMParser` — a real browser natively, or Node with a DOM polyfill such as [`linkedom`](https://github.com/WebReflection/linkedom) or `jsdom`:

```js
import { parseHTML, DOMParser } from 'linkedom';
const { document } = parseHTML('<html><body></body></html>');
globalThis.DOMParser = DOMParser;
globalThis.document = document;
```

## Quick start

```js
import { processHtml } from 'crawlette-core';

const html = await (await fetch('https://example.com')).text();
const page = processHtml(html, 'https://example.com', {
  contentFilter: 'readability',   // 'readability' | 'pruning-legacy' | 'bm25' | 'none'
  extractionSchema: {
    baseSelector: '.product',
    fields: [
      { name: 'title', selector: 'h3', type: 'text' },
      { name: 'price', selector: '.price', type: ['text', 'regex'], pattern: '([\\d.]+)' },
    ],
  },
});

page.markdown.rawMarkdown;   // full-page markdown
page.markdown.fitMarkdown;   // filtered to the main content
page.extracted;              // structured rows from the schema
page.links;                  // { internal, external }
```

## Deep crawling

`bfsCrawl` / `dfsCrawl` / `bestFirstCrawl` are async generators. You supply the fetcher — how a URL becomes a `processHtml`-shaped result is entirely up to you:

```js
import { bfsCrawl, processHtml } from 'crawlette-core';

async function fetchPage(url) {
  const res = await fetch(url);
  return processHtml(await res.text(), url);
}

for await (const result of bfsCrawl('https://example.com', fetchPage, { maxDepth: 2, maxPages: 50 })) {
  console.log(result.url, result.success);
}
```

## Sitemap seeding

For sites whose listing pages are client-rendered, seed from the sitemap instead of following links:

```js
import { discoverSitemap, fetchSitemap, deriveMatchFromUrl, bfsCrawl } from 'crawlette-core';

const sitemapUrl = await discoverSitemap('https://example.com/products');
const seeds = await fetchSitemap(sitemapUrl, { match: new RegExp(deriveMatchFromUrl('https://example.com/products')) });

for await (const result of bfsCrawl(seeds, fetchPage, { maxDepth: 0, maxPages: seeds.length })) { /* ... */ }
```

## Divergences from crawl4ai

Faithful where crawl4ai is strong (deep-crawl traversal, URL normalization, the extraction schema format, the result shape), and deliberately different in a few documented places — see the [main repository's README](https://github.com/MohammadKhallaf/crawlette#divergences-from-crawl4ai) for the full list and reasoning. In short:

- **Readability**, not `PruningContentFilter`, is the default content filter — the faithful port ships as `pruning-legacy` with its upstream defects intact, for comparison.
- **Lookalike domains are external** (`is_external_url`'s bare `endswith` check in crawl4ai lets a crawl wander onto an attacker-controlled domain).
- **BM25's inverted IDF is corrected** to the standard Okapi formulation.
- **Sitemap index recursion is same-origin only**, closing an SSRF path a hostile sitemap index could otherwise open.

## Built on real dependencies, not hand-vendored copies

- [`turndown`](https://github.com/mixmark-io/turndown) + [`turndown-plugin-gfm`](https://github.com/mixmark-io/turndown-plugin-gfm) for HTML → Markdown
- [`@mozilla/readability`](https://github.com/mozilla/readability) — the actual Firefox Reader Mode algorithm
- [`tldts`](https://github.com/remusao/tldts) for registrable-domain resolution against the real Public Suffix List
- [`picomatch`](https://github.com/micromatch/picomatch) for URL glob matching
- [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) for sitemap XML
- [`tinyqueue`](https://github.com/mourner/tinyqueue) for the best-first crawl's priority queue

## License

MIT

# Crawlette

A browser-native web crawler that turns sites into LLM-ready markdown and structured JSON. It is a JavaScript port of [crawl4ai](https://github.com/unclecode/crawl4ai) (v0.9.3) built as a Chrome MV3 extension, so it needs **no server, no Python, and no Docker**.

## Why a browser extension

A server-side crawler spends most of its complexity budget simulating a browser. This one simply is one:

| crawl4ai needs | Python cost | Browser cost |
|---|---|---|
| Fetch cross-origin pages | httpx + proxy config | `fetch()` under `host_permissions` |
| Render JS-heavy pages | Playwright + ~300MB Chromium | it *is* Chromium |
| Parse HTML into a tree | lxml / BeautifulSoup | `DOMParser` |

Beyond parity, it does things a detached server structurally cannot:

- **Authenticated crawling for free.** It uses your live session cookies, so pages behind a login — internal wikis, dashboards, paywalled docs — work with no credential plumbing and no headless-login script to maintain.
- **It looks like a real user, because it is one.** Real TLS fingerprint, User-Agent, timezone and `navigator` surface. crawl4ai ships an entire `antibot_detector.py` to fake what this has natively.
- **Your own network identity** — VPN, corporate proxy, DNS, geography. Region-locked content resolves correctly without renting a residential proxy.
- **The rendered DOM is the real DOM** — shadow DOM, lazy-loaded images, post-render mutations.
- **Nothing leaves your machine.** No API key, no open port, no third-party service.

Trade-offs in the other direction, stated honestly: no headless or cron operation (the browser must be open), throughput bounded by one browser rather than a worker pool, and service-worker lifetime limits that require checkpointing.

## Install

1. Clone this repository.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository directory.

No build step. Dependencies are vendored as ES modules because MV3's CSP forbids loading scripts from a CDN.

## Use

Click the toolbar icon. The start URL defaults to your active tab.

| Setting | What it does |
|---|---|
| **Strategy** | `breadth-first` (level by level), `depth-first` (follow one branch down), `best-first` (highest-scoring URLs first) |
| **Content** | Which filter produces `fit_markdown` — see below |
| **Max depth** | `1` means the start page plus one level of links |
| **Max pages** | Hard cap on successful fetches |
| **Render JavaScript** | Load each page in an offscreen frame so scripts run. Slower; needed for SPAs |
| **Follow external links** | Leave the starting domain |
| **Seed from sitemap** | Crawl every URL a sitemap lists, instead of following links. Leave the URL box empty and it is found for you |
| **Extraction schema** | JSON-CSS schema; results gain a structured `extracted` array |

Results open in a full tab with per-page markdown, fit markdown, links, media, and `.md` / `.json` export.

### Crawling a site whose listing page is client-rendered

Modern sites often build their listing pages in JavaScript. Fetch such a page
and the HTML contains **no links to follow**, so an ordinary crawl returns one
page and finds nothing. Rendering the listing works but is slow, and infinite
scroll or pagination can still hide most of the set.

Sitemaps solve this properly: they are static XML, list every URL, and cost one
request. Tick **Seed from sitemap** and leave the boxes empty — the sitemap is
read from `robots.txt` (falling back to the conventional paths), and the section
filter is derived from the URL you started on, so starting at `/speakers` keeps
only `/speakers/` pages. Fill the boxes only to override those guesses.

A worked example — 390 conference speakers whose grid is client-rendered, but
whose detail pages are server-rendered:

- **Start URL** `https://unbound.hubspot.com/speakers`
- **Seed from sitemap** ticked, both boxes left empty

  The extension reads `robots.txt`, finds `sitemap_index.xml`, follows it to
  `__sitemap__/speakers.xml`, and filters to `/speakers/` — 396 URLs, nothing
  typed. That path is not guessable, which is exactly why it is not asked for.
- **Max depth** `0` (the seeds are the work; do not follow their links)
- **Max pages** `400`
- **Content** `None` (the schema is the output; markdown would be wasted work)
- **Extraction schema** — optional; leave empty to get markdown instead

```json
{
  "baseSelector": ".speaker-detail",
  "fields": [
    { "name": "name",     "selector": ".speaker-hero h2", "type": "text" },
    { "name": "role",     "selector": ".speaker-hero p",  "type": "text" },
    { "name": "linkedin", "selector": ".speaker-hero a[href*='linkedin.com/in']",
      "type": "attribute", "attribute": "href", "default": "" },
    { "name": "sessions", "selector": "a[href*='/sessions/']", "type": "nested_list",
      "fields": [
        { "name": "title", "selector": "h3", "type": "text" },
        { "name": "url",   "type": "attribute", "attribute": "href" }
      ] }
  ]
}
```

Export the results as `.json` and the whole set is one file.

### Sizing output for an LLM

Prefer a schema over markdown when the goal is feeding a model. For the 390
speakers above, structured JSON came to roughly **54k tokens** — small enough to
paste whole. The same pages as markdown are around ten times larger, and mixing
390 people's prose invites the model to attribute the wrong role to the wrong
person. Extract the fields you need, and the model reasons over facts rather
than re-parsing page furniture.

## Architecture

```
src/
  core/
    normalize.js       URL canonicalization, internal/external classification
    scrape.js          DOM cleaning, link + media extraction
    markdown.js        Turndown -> raw / citations / references / fit
    filters/           readability (default), pruning-legacy, bm25
    extract/           JSON-CSS schema engine
    crawl/
      strategies.js    BFS / DFS / best-first as async generators
      urlFilters.js    pattern, domain, content-type, depth filters
      scorers.js       keyword, path-depth, freshness, composite
      sitemap.js       sitemap seeding (urlsets, indexes, plain text)
      fetcher.js       raw fetch or offscreen render, then the pipeline
  background.js        service worker: owns crawl state, checkpoints it
  offscreen.js         owns the only DOM: parses HTML and renders pages
  ui/                  popup and results view
```

## Divergences from crawl4ai

The port is faithful where crawl4ai is strong — deep-crawl traversal, URL normalization, the extraction schema, and the result shape are ported closely, so crawl4ai schemas work unchanged. It deliberately differs in five places.

### 1. Lookalike domains are external (security)

`is_external_url` upstream tests `not url_domain.endswith(base)`. That bare suffix match classifies `evilexample.com` as *internal* to `example.com`, so a crawl scoped to one site can be walked onto an attacker-controlled lookalike domain. Crawlette requires an exact match or a dot-delimited suffix, keeping real subdomains internal while rejecting lookalikes.

### 2. Readability is the default content filter

crawl4ai's `PruningContentFilter` scores each node as:

```
0.4·(text/tag) + 0.2·(1−link_ratio) + 0.2·tag_weight + 0.1·class_id + 0.1·ln(text_len+1)
```

Two defects are visible in the source and reproduced by our test suite:

- **The length term is unbounded.** `0.1·ln(len+1)` has no ceiling while every other term is ≤ 1. Against the real `0.48` threshold, a 2000-char paragraph scores **1.49**, and even a *5-character span* scores **0.539**. Length dominates, so nearly everything with text survives.
- **The class/id term is dead code.** It matches with an anchored `.match()` (so `class="page-nav"` never matches) and then clamps the only possible value (−0.5) with `max(0, …)`. It contributes exactly **0** in every default configuration.

Mozilla's Readability — the algorithm behind Firefox Reader Mode — is the default instead. The faithful pruning port ships as **`pruning-legacy`**, constants and defects intact, so you can compare the two on real pages. It is kept deliberately un-"fixed" so it remains a reference implementation.

### 3. BM25's inverted IDF is corrected

Upstream computes `log((1+1)/(tf+0.5)+1)` from *term frequency within one document*, so its "IDF" falls as a term gets more common and never consults the corpus — the opposite of what IDF means. Crawlette uses standard Okapi BM25 over document frequency.

### 4. Filters and scorers

- `ContentTypeFilter` reads the extension from the parsed pathname. Upstream reads `"html?x=1"` out of `/a.html?x=1` and then fails to match it.
- `FreshnessScorer` uses the current year; upstream hardcodes `2024`.
- `SEOFilter` and `ContentRelevanceFilter` are **not ported** — each performs a network HEAD fetch per candidate URL, multiplying a crawl's request count. Use the BM25 content filter after fetching instead.
- `CompositeScorer` keeps upstream's behaviour of normalizing by scorer *count* rather than weight sum, so weights are relative only.

### 5. Markdown

Turndown + the GFM plugin replace crawl4ai's vendored `html2text`. Whitespace will differ from upstream output. Images receive citations rather than upstream's `![alt⟨n⟩]`, which drops the image target entirely.

## Behaviour worth knowing

- **`maxDepth: 2` crawls three levels** (0, 1, 2), matching crawl4ai.
- **`maxPages` counts successful fetches only.**
- **Depth 0 bypasses the filter chain** but never URL validation.
- **`visited` is marked at discovery in BFS, at pop in DFS/best-first** — this affects parent attribution.
- **Best-first orders by `(-score, depth, url)`**, so ties break on shallower depth then lexicographically.
- **`robots.txt` is not consulted**, matching crawl4ai's `check_robots_txt=False` default. Crawl responsibly and within the terms of the sites you visit.

## Development

```bash
npm install     # linkedom, a dev-only DOM for tests
npm test        # 146 tests, no framework beyond node --test
```

Tests run under Node using [linkedom](https://github.com/WebReflection/linkedom) as a stand-in for the browser DOM; the extension itself ships no test dependencies.

## Credits

Algorithms and semantics ported from [crawl4ai](https://github.com/unclecode/crawl4ai) by [unclecode](https://github.com/unclecode), Apache 2.0. Bundles [Turndown](https://github.com/mixmark-io/turndown) (MIT) and [Readability](https://github.com/mozilla/readability) (Apache 2.0).

## License

MIT

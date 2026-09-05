/**
 * HTML -> Markdown, producing crawl4ai's four-variant result.
 *
 * Replaces crawl4ai's vendored html2text with Turndown + the GFM plugin
 * (tables, strikethrough, task lists). Output shape matches
 * MarkdownGenerationResult (crawl4ai/models.py:120).
 */

import TurndownService from '../vendor/turndown.js';
import { gfm } from '../vendor/turndown-plugin-gfm.js';

/** Matches markdown links and images, capturing text, url and optional title. */
const LINK_PATTERN = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;

function createTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',            // "## H2" rather than underlines
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.use(gfm);
  // Drop anything that survived scraping but carries no reading value.
  td.remove(['script', 'style', 'noscript', 'iframe']);
  return td;
}

const turndown = createTurndown();

/**
 * Rewrite inline links as numbered citations plus a reference list.
 *
 * Port of convert_links_to_citations (markdown_generation_strategy.py:82).
 * Unlike upstream -- which emits `![alt⟨n⟩]` and loses the image target -- we
 * keep images addressable by giving them citations too.
 */
export function convertLinksToCitations(markdown, baseUrl) {
  const order = [];
  const numbers = new Map();

  const body = markdown.replace(LINK_PATTERN, (match, bang, text, url, title) => {
    let resolved = url;
    if (!/^(https?:|mailto:)/i.test(url)) {
      try {
        resolved = new URL(url, baseUrl).toString();
      } catch {
        return match; // unresolvable: leave the original markdown untouched
      }
    }
    if (!numbers.has(resolved)) {
      numbers.set(resolved, numbers.size + 1);
      order.push({ url: resolved, text, title });
    }
    return `${bang}${text}⟨${numbers.get(resolved)}⟩`;
  });

  if (!order.length) return { markdown: body, references: '' };

  const lines = order.map((ref, i) => {
    const parts = [];
    if (ref.title) parts.push(ref.title);
    if (ref.text && ref.text !== ref.title) parts.push(ref.text);
    const desc = parts.length ? `: ${parts.join(' - ')}` : '';
    return `⟨${i + 1}⟩ ${ref.url}${desc}`;
  });

  return { markdown: body, references: `\n\n## References\n\n${lines.join('\n')}\n` };
}

/** Convert an HTML string to markdown, tolerating malformed input. */
export function htmlToMarkdown(html) {
  if (!html || !html.trim()) return '';
  try {
    return turndown.turndown(html).replace(/ {4}```/g, '```').trim();
  } catch (err) {
    return `<!-- markdown conversion failed: ${err.message} -->`;
  }
}

/**
 * Build every markdown variant for a page.
 *
 * @param {string} cleanedHtml  output of scrape()
 * @param {string} baseUrl      for resolving relative links in citations
 * @param {string|null} fitHtml filtered HTML from a content filter, if any
 * @returns {{rawMarkdown, markdownWithCitations, referencesMarkdown, fitMarkdown, fitHtml}}
 */
export function generateMarkdown(cleanedHtml, baseUrl, fitHtml = null, { citations = true } = {}) {
  const rawMarkdown = htmlToMarkdown(cleanedHtml);

  let markdownWithCitations = rawMarkdown;
  let referencesMarkdown = '';
  if (citations && rawMarkdown) {
    const converted = convertLinksToCitations(rawMarkdown, baseUrl);
    markdownWithCitations = converted.markdown;
    referencesMarkdown = converted.references;
  }

  return {
    rawMarkdown,
    markdownWithCitations,
    referencesMarkdown,
    fitMarkdown: fitHtml ? htmlToMarkdown(fitHtml) : '',
    fitHtml: fitHtml || '',
  };
}

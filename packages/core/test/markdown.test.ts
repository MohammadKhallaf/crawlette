import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-setup.ts'; // must precede the markdown import (Turndown binds a parser at load)
import { htmlToMarkdown, convertLinksToCitations, generateMarkdown } from '../src/markdown.ts';

const BASE = 'https://example.com/docs/';

test('converts headings, emphasis and lists', () => {
  assert.equal(htmlToMarkdown('<h1>Title</h1>'), '# Title');
  assert.equal(htmlToMarkdown('<h2>Sub</h2>'), '## Sub');
  assert.match(htmlToMarkdown('<p>a <strong>b</strong> <em>c</em></p>'), /\*\*b\*\*/);
  assert.match(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>'), /- +one/);
});

test('converts GFM tables', () => {
  const md = htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
  assert.match(md, /\| A \| B \|/);
  assert.match(md, /\| 1 \| 2 \|/);
});

test('converts fenced code blocks', () => {
  assert.match(htmlToMarkdown('<pre><code>x = 1</code></pre>'), /```/);
});

test('returns empty string for empty input', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(htmlToMarkdown(v), '');
});

test('numbers citations and builds a reference list', () => {
  const { markdown, references } = convertLinksToCitations('See [docs](/guide) and [site](https://other.org).', BASE);
  assert.match(markdown, /docs⟨1⟩/);
  assert.match(markdown, /site⟨2⟩/);
  assert.match(references, /## References/);
  assert.match(references, /⟨1⟩ https:\/\/example\.com\/guide/);
  assert.match(references, /⟨2⟩ https:\/\/other\.org/);
});

test('reuses one number for a repeated URL', () => {
  const { markdown, references } = convertLinksToCitations('[a](/x) then [b](/x)', BASE);
  assert.match(markdown, /a⟨1⟩/);
  assert.match(markdown, /b⟨1⟩/);
  assert.equal(references.match(/⟨1⟩/g).length, 1);
  assert.ok(!references.includes('⟨2⟩'));
});

test('gives images citations too (divergence: upstream drops the target)', () => {
  const { markdown, references } = convertLinksToCitations('![alt](/img.png)', BASE);
  assert.match(markdown, /!alt⟨1⟩/);
  assert.match(references, /img\.png/);
});

test('leaves text without links untouched and emits no references', () => {
  const { markdown, references } = convertLinksToCitations('Plain text.', BASE);
  assert.equal(markdown, 'Plain text.');
  assert.equal(references, '');
});

test('generateMarkdown returns all five fields', () => {
  const r = generateMarkdown('<h1>T</h1><p><a href="/x">l</a></p>', BASE);
  for (const k of ['rawMarkdown', 'markdownWithCitations', 'referencesMarkdown', 'fitMarkdown', 'fitHtml']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.match(r.rawMarkdown, /# T/);
  assert.match(r.rawMarkdown, /\[l\]\(\/x\)/);   // raw keeps inline links
  assert.match(r.markdownWithCitations, /l⟨1⟩/); // citations variant does not
});

test('generateMarkdown derives fitMarkdown from filtered html', () => {
  const r = generateMarkdown('<p>all</p>', BASE, '<p>just this</p>');
  assert.equal(r.fitMarkdown, 'just this');
  assert.equal(r.fitHtml, '<p>just this</p>');
});

test('citations can be disabled', () => {
  const r = generateMarkdown('<p><a href="/x">l</a></p>', BASE, null, { citations: false });
  assert.equal(r.markdownWithCitations, r.rawMarkdown);
  assert.equal(r.referencesMarkdown, '');
});

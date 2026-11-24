import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderMarkdown, formatMaybeJson } from '../public/format.js';

test('escapeHtml escapes tags and quotes', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
});

test('renderMarkdown escapes raw HTML and does not produce executable tags', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
});

test('renderMarkdown renders fenced code blocks and escapes their content', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  assert.match(html, /<pre><code/);
  assert.match(html, /const a = 1 &lt; 2;/);
});

test('renderMarkdown renders inline code, bold text, and lists', () => {
  const html = renderMarkdown('这是 `code` 和 **粗体**\n\n- a\n- b');
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>a<\/li>/);
});

test('renderMarkdown renders headings, blockquotes, and safe links', () => {
  const html = renderMarkdown('# 标题\n> 引用\n\n[示例](https://example.com)');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('renderMarkdown does not turn javascript: links into anchors', () => {
  const html = renderMarkdown('[坏](javascript:alert(1))');
  assert.equal(html.includes('<a '), false);
  assert.match(html, /\[坏\]/);
});

test('renderMarkdown does not hang on an incomplete code fence line', () => {
  const html = renderMarkdown('```js extra\n下一行');
  assert.match(html, /```js extra/);
  assert.match(html, /下一行/);
});

test('formatMaybeJson formats JSON and returns null for non-JSON input', () => {
  assert.equal(formatMaybeJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatMaybeJson('[1,2]'), '[\n  1,\n  2\n]');
  assert.equal(formatMaybeJson('hello'), null);
  assert.equal(formatMaybeJson(''), null);
  assert.equal(formatMaybeJson('{bad'), null);
});

test('renderMarkdown renders local images as img tags to be resolved later', () => {
  const html = renderMarkdown('![页头实机效果](session-hub-logo/live-header.png)');
  assert.match(html, /<img /);
  assert.match(html, /data-image-src="session-hub-logo\/live-header\.png"/);
  assert.match(html, /alt="页头实机效果"/);
  assert.equal(html.includes('<a '), false);
});

test('renderMarkdown rejects unsafe image URLs such as javascript:', () => {
  const html = renderMarkdown('![坏](javascript:alert(1))');
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('javascript:alert'), true);
});

test('renderMarkdown escapes tags in image alt text', () => {
  const html = renderMarkdown('![<script>x</script>](a.png)');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /alt="&lt;script&gt;x&lt;\/script&gt;"/);
});

test('renderMarkdown marks local file links as viewable in the browser', () => {
  const html = renderMarkdown('[cordis.patch.yml:58-62](/Users/felinx/.dsh/profiles/desktop/cordis.patch.yml#L58-L62)');
  assert.match(html, /<a class="file-link" data-file-href="\/Users\/felinx\/\.dsh\/profiles\/desktop\/cordis\.patch\.yml#L58-L62"/);
  assert.match(html, />cordis\.patch\.yml:58-62<\/a>/);
  assert.doesNotMatch(html, /<a href="\/Users/);
});

test('renderMarkdown distinguishes anchors from relative file links', () => {
  const anchor = renderMarkdown('[跳到说明](#说明)');
  assert.match(anchor, /<a href="#说明"/);
  assert.equal(anchor.includes('data-file-href'), false);

  const file = renderMarkdown('[说明](docs/README.md)');
  assert.match(file, /data-file-href="docs\/README\.md"/);
  assert.doesNotMatch(file, /<a href="docs/);
});

test('renderMarkdown renders remote images as external links instead of img tags blocked by CSP', () => {
  const html = renderMarkdown('![npm](https://img.shields.io/npm/v/dsh-lark-channel)');
  assert.equal(html.includes('<img'), false);
  assert.match(
    html,
    /<a class="image-external" href="https:\/\/img\.shields\.io\/npm\/v\/dsh-lark-channel" target="_blank" rel="noopener noreferrer" title="https:\/\/img\.shields\.io\/npm\/v\/dsh-lark-channel">npm<\/a>/
  );
});

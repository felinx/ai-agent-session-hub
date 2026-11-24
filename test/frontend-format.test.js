import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderMarkdown, formatMaybeJson } from '../public/format.js';

test('escapeHtml 转义标签与引号', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
});

test('renderMarkdown 转义原始 HTML，不产生可执行标签', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
});

test('renderMarkdown 渲染代码围栏并转义内容', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  assert.match(html, /<pre><code/);
  assert.match(html, /const a = 1 &lt; 2;/);
});

test('renderMarkdown 渲染行内代码、粗体与列表', () => {
  const html = renderMarkdown('这是 `code` 和 **粗体**\n\n- a\n- b');
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>a<\/li>/);
});

test('renderMarkdown 渲染标题、引用与安全链接', () => {
  const html = renderMarkdown('# 标题\n> 引用\n\n[示例](https://example.com)');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('renderMarkdown 不把 javascript: 链接变成锚点', () => {
  const html = renderMarkdown('[坏](javascript:alert(1))');
  assert.equal(html.includes('<a '), false);
  assert.match(html, /\[坏\]/);
});

test('renderMarkdown 遇到不完整的代码围栏行不会卡死', () => {
  const html = renderMarkdown('```js extra\n下一行');
  assert.match(html, /```js extra/);
  assert.match(html, /下一行/);
});

test('formatMaybeJson 格式化 JSON，非 JSON 返回 null', () => {
  assert.equal(formatMaybeJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatMaybeJson('[1,2]'), '[\n  1,\n  2\n]');
  assert.equal(formatMaybeJson('hello'), null);
  assert.equal(formatMaybeJson(''), null);
  assert.equal(formatMaybeJson('{bad'), null);
});

test('renderMarkdown 把本地图片渲染成待解析的 img 标签', () => {
  const html = renderMarkdown('![页头实机效果](session-hub-logo/live-header.png)');
  assert.match(html, /<img /);
  assert.match(html, /data-image-src="session-hub-logo\/live-header\.png"/);
  assert.match(html, /alt="页头实机效果"/);
  assert.equal(html.includes('<a '), false);
});

test('renderMarkdown 拒绝 javascript: 等危险图片地址', () => {
  const html = renderMarkdown('![坏](javascript:alert(1))');
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('javascript:alert'), true);
});

test('renderMarkdown 转义图片 alt 中的标签', () => {
  const html = renderMarkdown('![<script>x</script>](a.png)');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /alt="&lt;script&gt;x&lt;\/script&gt;"/);
});

test('renderMarkdown 把本地文件链接标记为可在浏览器查看', () => {
  const html = renderMarkdown('[cordis.patch.yml:58-62](/Users/felinx/.dsh/profiles/desktop/cordis.patch.yml#L58-L62)');
  assert.match(html, /<a class="file-link" data-file-href="\/Users\/felinx\/\.dsh\/profiles\/desktop\/cordis\.patch\.yml#L58-L62"/);
  assert.match(html, />cordis\.patch\.yml:58-62<\/a>/);
  assert.doesNotMatch(html, /<a href="\/Users/);
});

test('renderMarkdown 保留锚点与相对文件链接的区分', () => {
  const anchor = renderMarkdown('[跳到说明](#说明)');
  assert.match(anchor, /<a href="#说明"/);
  assert.equal(anchor.includes('data-file-href'), false);

  const file = renderMarkdown('[说明](docs/README.md)');
  assert.match(file, /data-file-href="docs\/README\.md"/);
  assert.doesNotMatch(file, /<a href="docs/);
});

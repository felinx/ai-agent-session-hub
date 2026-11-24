import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalFilePath, viewerUrl } from '../public/links.js';

test('绝对文件路径保留行号片段并带上会话', () => {
  assert.equal(
    viewerUrl('dsh:s1', '/Users/felinx/.dsh/profiles/desktop/cordis.patch.yml#L58-L62'),
    '/viewer.html?path=%2FUsers%2Ffelinx%2F.dsh%2Fprofiles%2Fdesktop%2Fcordis.patch.yml&session=dsh%3As1#L58-L62'
  );
});

test('相对文件路径按会话解析', () => {
  assert.equal(
    viewerUrl('claude:a', './docs/README.md'),
    '/viewer.html?path=.%2Fdocs%2FREADME.md&session=claude%3Aa'
  );
  assert.equal(
    viewerUrl(null, 'src/server.js'),
    '/viewer.html?path=src%2Fserver.js'
  );
});

test('只把本地文件路径当作文件链接', () => {
  assert.equal(isLocalFilePath('/Users/felinx/a.yml'), true);
  assert.equal(isLocalFilePath('/tmp/x.txt'), true);
  assert.equal(isLocalFilePath('./a/b.md'), true);
  assert.equal(isLocalFilePath('a/b.md'), true);
  assert.equal(isLocalFilePath('https://example.com/a.md'), false);
  assert.equal(isLocalFilePath('mailto:a@b.c'), false);
  assert.equal(isLocalFilePath('#section'), false);
  assert.equal(isLocalFilePath('/icons/claude.png'), false);
  assert.equal(isLocalFilePath('javascript:alert(1)'), false);
});

test('非文件链接不生成查看地址', () => {
  assert.equal(viewerUrl('k', 'https://example.com/a.md'), null);
  assert.equal(viewerUrl('k', '#section'), null);
  assert.equal(viewerUrl('k', 'javascript:alert(1)'), null);
});

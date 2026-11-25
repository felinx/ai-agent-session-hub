import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalFilePath, viewerUrl } from '../web/links.js';

test('absolute file paths keep the line-number fragment and include the session', () => {
  assert.equal(
    viewerUrl('dsh:s1', '/Users/felinx/.dsh/profiles/desktop/cordis.patch.yml#L58-L62'),
    '/viewer.html?path=%2FUsers%2Ffelinx%2F.dsh%2Fprofiles%2Fdesktop%2Fcordis.patch.yml&session=dsh%3As1#L58-L62'
  );
});

test('relative file paths are resolved against the session', () => {
  assert.equal(
    viewerUrl('claude:a', './docs/README.md'),
    '/viewer.html?path=.%2Fdocs%2FREADME.md&session=claude%3Aa'
  );
  assert.equal(
    viewerUrl(null, 'src/server.js'),
    '/viewer.html?path=src%2Fserver.js'
  );
});

test('treats only local file paths as file links', () => {
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

test('does not generate a viewer URL for non-file links', () => {
  assert.equal(viewerUrl('k', 'https://example.com/a.md'), null);
  assert.equal(viewerUrl('k', '#section'), null);
  assert.equal(viewerUrl('k', 'javascript:alert(1)'), null);
});

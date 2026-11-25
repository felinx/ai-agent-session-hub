import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, resolveLanguage, MESSAGES } from '../web/i18n.js';

test('resolveLanguage follows the explicit preference or falls back to the system language', () => {
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh');
  assert.equal(resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(resolveLanguage('auto', 'fr-FR'), 'en');
  assert.equal(resolveLanguage(undefined, 'zh-Hans'), 'zh');
  assert.equal(resolveLanguage('nope', 'en-GB'), 'en');
});

test('t supports parameter interpolation and falls back for missing keys', () => {
  assert.equal(t('zh', 'status.sessions', { count: 3 }), '3 个会话');
  assert.equal(t('en', 'status.sessions', { count: 3 }), '3 sessions');
  assert.equal(t('en', 'missing.key'), 'missing.key');
});

test('Chinese and English message catalogs contain the same keys', () => {
  assert.deepEqual(Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort());
});

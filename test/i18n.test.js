import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, resolveLanguage, MESSAGES } from '../public/i18n.js';

test('resolveLanguage 按显式偏好或系统语言解析', () => {
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh');
  assert.equal(resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(resolveLanguage('auto', 'fr-FR'), 'en');
  assert.equal(resolveLanguage(undefined, 'zh-Hans'), 'zh');
  assert.equal(resolveLanguage('nope', 'en-GB'), 'en');
});

test('t 支持参数插值与缺失键回退', () => {
  assert.equal(t('zh', 'status.sessions', { count: 3 }), '3 个会话');
  assert.equal(t('en', 'status.sessions', { count: 3 }), '3 sessions');
  assert.equal(t('en', 'missing.key'), 'missing.key');
});

test('中英文目录包含相同的键', () => {
  assert.deepEqual(Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort());
});

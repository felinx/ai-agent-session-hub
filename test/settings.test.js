import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, initSchema } from '../src/db.js';
import { getSettings, saveSettings, SUPPORTED_AGENTS } from '../src/settings.js';

function freshDb() {
  const db = openDb(':memory:');
  initSchema(db);
  return db;
}

test('默认设置：隐藏空会话和临时会话，启用全部 Agent，语言跟随系统', () => {
  const db = freshDb();
  assert.deepEqual(getSettings(db), {
    showEmptySessions: false,
    showTempSessions: false,
    enabledAgents: SUPPORTED_AGENTS.map(agent => agent.id),
    language: 'auto'
  });
  db.close();
});

test('部分更新持久化，不影响其它设置', () => {
  const db = freshDb();
  assert.equal(saveSettings(db, { showEmptySessions: true }).showEmptySessions, true);
  assert.deepEqual(getSettings(db), {
    showEmptySessions: true,
    showTempSessions: false,
    enabledAgents: SUPPORTED_AGENTS.map(agent => agent.id),
    language: 'auto'
  });
  assert.deepEqual(
    saveSettings(db, { enabledAgents: ['claude', 'workbuddy'] }).enabledAgents,
    ['claude', 'workbuddy']
  );
  assert.equal(getSettings(db).showEmptySessions, true);
  assert.equal(saveSettings(db, { language: 'en' }).language, 'en');
  assert.equal(getSettings(db).language, 'en');
  assert.equal(saveSettings(db, { language: 'zh' }).language, 'zh');
  db.close();
});

test('拒绝非法设置值并返回稳定错误码', () => {
  const db = freshDb();
  const cases = [
    [null, 'settings.error.invalidFormat'],
    [[], 'settings.error.invalidFormat'],
    [{ showEmptySessions: 'yes' }, 'settings.error.boolean'],
    [{ unknown: true }, 'settings.error.unknownKey'],
    [{ enabledAgents: 'claude' }, 'settings.error.agents'],
    [{ enabledAgents: [] }, 'settings.error.agents'],
    [{ enabledAgents: ['claude', 'claude'] }, 'settings.error.agents'],
    [{ enabledAgents: ['nope'] }, 'settings.error.agents'],
    [{ language: 'fr' }, 'settings.error.language'],
    [{ language: true }, 'settings.error.language']
  ];
  for (const [patch, code] of cases) {
    assert.throws(
      () => saveSettings(db, patch),
      error => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, code);
        return true;
      },
      JSON.stringify(patch)
    );
  }
  db.close();
});

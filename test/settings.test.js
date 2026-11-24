import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, initSchema } from '../src/db.js';
import { getSettings, saveSettings, SUPPORTED_AGENTS } from '../src/settings.js';

function freshDb() {
  const db = openDb(':memory:');
  initSchema(db);
  return db;
}

test('default settings hide empty and temp sessions, enable all agents, and follow the system language', () => {
  const db = freshDb();
  assert.deepEqual(getSettings(db), {
    showEmptySessions: false,
    showTempSessions: false,
    enabledAgents: SUPPORTED_AGENTS.map(agent => agent.id),
    language: 'auto'
  });
  db.close();
});

test('partial updates persist without affecting other settings', () => {
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

test('invalid setting values are rejected with stable error codes', () => {
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

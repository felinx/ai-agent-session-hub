import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { startHub } from '../src/hub.js';

const publicDir = path.join(import.meta.dirname, '..', 'public');

function testConfig(dir) {
  const empty = path.join(dir, 'missing');
  return {
    ...loadConfig({
      SESSION_HUB_DB: path.join(dir, 'hub.db'),
      CLAUDE_HOME: empty,
      CODEX_HOME: empty,
      DSH_HOME: empty,
      WORKBUDDY_HOME: empty,
      LARK_CHANNEL_HOME: empty
    }, {}),
    port: 0
  };
}

test('startHub serves the status API, logs startup, and closes cleanly', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-hub-'));
  const lines = [];
  const hub = await startHub({
    config: testConfig(dir),
    publicDir,
    emit: (line) => lines.push(line),
    syncInterval: 60_000
  });

  try {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.agents));
    assert.equal(typeof body.totals.sessions, 'number');
    assert.ok(lines.some(line => line.includes('Agent Session Hub → http://127.0.0.1:')));
    assert.ok(lines.some(line => line.includes('hub.db')));
  } finally {
    await hub.close();
  }
});

test('close waits for the sync in flight before closing the database', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-hub-'));
  let finished = false;

  const hub = await startHub({
    config: testConfig(dir),
    publicDir,
    emit: () => {},
    syncInterval: 60_000,
    sync: async () => {
      await new Promise(resolve => setTimeout(resolve, 120));
      finished = true;
      return { changes: [], warnings: [] };
    }
  });

  await hub.close();
  assert.equal(finished, true);
  assert.throws(() => hub.db.prepare('SELECT 1').get());
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildChatMap, chatIdFromDshDir } from '../src/sources/larkMap.js';

function writeCatalog(root, profile, entries) {
  const dir = path.join(root, 'profiles', profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'sessions.json.catalog.json'), JSON.stringify(entries));
}

test('reads claude/codex catalogs and builds the mapping', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-lark-'));
  writeCatalog(root, 'claude', [{ scopeId: 'oc_A', agentId: 'claude', sessionId: 's1' }]);
  writeCatalog(root, 'codex', [{ scopeId: 'oc_B', agentId: 'codex', threadId: 't1' }]);

  const map = await buildChatMap({ roots: { larkChannel: root } });
  assert.equal(map.get('claude:s1'), 'oc_A');
  assert.equal(map.get('codex:t1'), 'oc_B');
});

test('returns an empty map without throwing when the catalog is missing or corrupt', async () => {
  const missing = mkdtempSync(path.join(tmpdir(), 'session-hub-lark-'));
  assert.equal((await buildChatMap({ roots: { larkChannel: missing } })).size, 0);

  const broken = mkdtempSync(path.join(tmpdir(), 'session-hub-lark-'));
  const dir = path.join(broken, 'profiles', 'claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'sessions.json.catalog.json'), 'not json');
  assert.equal((await buildChatMap({ roots: { larkChannel: broken } })).size, 0);
});

test('extracts chatId from dsh directory names', () => {
  assert.equal(chatIdFromDshDir('lark-oc_ABC123'), 'oc_ABC123');
  assert.equal(chatIdFromDshDir('lark-oc_ABC123--800327b4cf'), 'oc_ABC123');
  assert.equal(chatIdFromDshDir('session-abc'), null);
});

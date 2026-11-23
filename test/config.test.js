import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('默认值', () => {
  const c = loadConfig({}, []);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 7317);
  assert.equal(c.rebuild, false);
  assert.equal(c.dbPath, path.join(os.homedir(), '.session-hub', 'hub.db'));
  assert.equal(c.roots.claude, path.join(os.homedir(), '.claude'));
  assert.equal(c.roots.codex, path.join(os.homedir(), '.codex'));
  assert.equal(c.roots.dsh, path.join(os.homedir(), '.dsh'));
  assert.equal(c.roots.larkChannel, path.join(os.homedir(), '.lark-channel'));
});

test('环境变量覆盖与 --rebuild', () => {
  const c = loadConfig({
    SESSION_HUB_HOST: '0.0.0.0',
    SESSION_HUB_PORT: '9000',
    SESSION_HUB_DB: '/tmp/hub.db',
    CLAUDE_HOME: '/c', CODEX_HOME: '/x', DSH_HOME: '/d', LARK_CHANNEL_HOME: '/l'
  }, ['--rebuild']);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 9000);
  assert.equal(c.dbPath, '/tmp/hub.db');
  assert.equal(c.rebuild, true);
  assert.deepEqual(c.roots, { claude: '/c', codex: '/x', dsh: '/d', larkChannel: '/l' });
});

test('非法端口回退默认值', () => {
  assert.equal(loadConfig({ SESSION_HUB_PORT: 'abc' }, []).port, 7317);
});

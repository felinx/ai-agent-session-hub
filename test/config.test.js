import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('default values', () => {
  const c = loadConfig({}, {});
  const home = os.homedir();
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 7317);
  assert.equal(c.rebuild, false);
  assert.equal(c.dbPath, path.join(home, '.session-hub', 'hub.db'));
  assert.equal(c.logDir, path.join(home, '.session-hub', 'logs'));
  assert.equal(c.pidPath, path.join(home, '.session-hub', 'hub.pid'));
  assert.equal(c.roots.claude, path.join(home, '.claude'));
  assert.equal(c.roots.codex, path.join(home, '.codex'));
  assert.equal(c.roots.dsh, path.join(home, '.dsh'));
  assert.equal(c.roots.workbuddy, path.join(home, '.workbuddy'));
  assert.equal(c.roots.larkChannel, path.join(home, '.lark-channel'));
});

test('environment variable overrides', () => {
  const c = loadConfig({
    SESSION_HUB_HOST: '0.0.0.0',
    SESSION_HUB_PORT: '9000',
    SESSION_HUB_DB: '/tmp/hub.db',
    SESSION_HUB_LOG_DIR: '/tmp/logs',
    CLAUDE_HOME: '/c', CODEX_HOME: '/x', DSH_HOME: '/d', LARK_CHANNEL_HOME: '/l',
    WORKBUDDY_HOME: '/w'
  }, {});
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 9000);
  assert.equal(c.dbPath, '/tmp/hub.db');
  assert.equal(c.logDir, '/tmp/logs');
  assert.equal(c.rebuild, false);
  assert.deepEqual(c.roots, {
    claude: '/c', codex: '/x', dsh: '/d', workbuddy: '/w', larkChannel: '/l'
  });
});

test('command-line options override the environment', () => {
  const c = loadConfig({ SESSION_HUB_PORT: '9000', SESSION_HUB_DB: '/env.db' }, {
    port: 8000,
    db: '/cli.db',
    host: '127.0.0.2',
    rebuild: true
  });
  assert.equal(c.port, 8000);
  assert.equal(c.dbPath, '/cli.db');
  assert.equal(c.host, '127.0.0.2');
  assert.equal(c.rebuild, true);
});

test('invalid port falls back to the default', () => {
  assert.equal(loadConfig({ SESSION_HUB_PORT: 'abc' }, {}).port, 7317);
});

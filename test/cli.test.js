import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

function capture() {
  const out = [];
  const err = [];
  return {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n')
  };
}

test('help lists every command', () => {
  const io = capture();
  return main(['--help'], io).then(code => {
    assert.equal(code, 0);
    for (const command of ['start', 'run', 'stop', 'restart', 'status', 'logs', 'doctor']) {
      assert.match(io.stdout(), new RegExp(`\\b${command}\\b`));
    }
  });
});

test('version prints the package version', async () => {
  const io = capture();
  assert.equal(await main(['--version'], io), 0);
  assert.match(io.stdout(), /^session-hub \d+\.\d+\.\d+/);
});

test('unknown commands and options exit with a usage error', async () => {
  const unknown = capture();
  assert.equal(await main(['frobnicate'], unknown), 2);
  assert.match(unknown.stderr(), /unknown command/i);
  assert.match(unknown.stderr(), /Usage:/);

  const badOption = capture();
  assert.equal(await main(['run', '--nope'], badOption), 2);
  assert.match(badOption.stderr(), /unknown option/i);
});

test('run starts the hub with parsed options and writes logs to files', async () => {  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-cli-'));
  const io = {
    ...capture(),
    env: { SESSION_HUB_DB: path.join(dir, 'hub.db') },
    noWait: true,
    startHub: async ({ config, emit }) => {
      emit('started');
      emit('bad thing', 'error');
      return { close: async () => {}, port: config.port, config };
    }
  };

  const code = await main(['run', '--port', '8080', '--db', path.join(dir, 'cli.db')], io);

  assert.equal(code, 0);
  assert.match(io.stdout(), /started/);
  assert.match(io.stderr(), /bad thing/);

  const logs = path.join(dir, 'logs');
  const [name] = readdirSync(logs);
  const text = readFileSync(path.join(logs, name), 'utf8');
  assert.match(text, /^started$/m);
  assert.match(text, /^bad thing$/m);
});

test('status prints a human summary and exits 0 while running', async () => {
  const io = {
    ...capture(),
    env: {},
    collectStatus: async () => ({
      running: true, host: '127.0.0.1', port: 7317, source: 'http', lastSyncAt: 1764000000000,
      agents: [{ agent: 'claude', sessions: 1, messages: 2, lastSyncAt: 1764000000000, latest: { id: 'abcd1234', summary: 'hi' } }],
      totals: { sessions: 1, messages: 2 }
    })
  };

  assert.equal(await main(['status'], io), 0);
  assert.match(io.stdout(), /running on http:\/\/127\.0\.0\.1:7317/);
  assert.match(io.stdout(), /abcd1234/);
});

test('status --json emits stable JSON and exits 1 when stopped', async () => {
  const io = {
    ...capture(),
    env: {},
    collectStatus: async () => ({
      running: false, host: '127.0.0.1', port: 7317, source: 'none',
      lastSyncAt: null, agents: [], totals: { sessions: 0, messages: 0 }
    })
  };

  assert.equal(await main(['status', '--json'], io), 1);
  const body = JSON.parse(io.stdout());
  assert.equal(body.running, false);
  assert.equal(body.source, 'none');
  assert.deepEqual(body.totals, { sessions: 0, messages: 0 });
});

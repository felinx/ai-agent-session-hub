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

test('run starts the hub with parsed options and writes logs to files', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-cli-'));
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

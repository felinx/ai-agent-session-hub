import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listLogFiles, tailLines, clearLogs, followLogs } from '../src/logs.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('listLogFiles sorts by date then numeric rollover index', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-logs-'));
  for (const name of [
    'hub-2026-11-24.10.log',
    'hub-2026-11-24.2.log',
    'hub-2026-11-24.log',
    'hub-2026-11-20.1.log',
    'notes.txt'
  ]) {
    writeFileSync(path.join(dir, name), 'x');
  }

  assert.deepEqual(listLogFiles(dir).map(file => file.name), [
    'hub-2026-11-20.1.log',
    'hub-2026-11-24.log',
    'hub-2026-11-24.2.log',
    'hub-2026-11-24.10.log'
  ]);
});

test('tailLines takes the newest lines across rotated files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-logs-'));
  writeFileSync(path.join(dir, 'hub-2026-11-24.log'), 'a\nb\n');
  writeFileSync(path.join(dir, 'hub-2026-11-24.1.log'), 'c\nd\n');

  assert.deepEqual(tailLines(dir, 3), ['b', 'c', 'd']);
  assert.deepEqual(tailLines(dir, 10), ['a', 'b', 'c', 'd']);
});

test('clearLogs removes only hub log files and reports how many', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-logs-'));
  writeFileSync(path.join(dir, 'hub-2026-11-24.log'), 'x');
  writeFileSync(path.join(dir, 'hub-2026-11-24.1.log'), 'x');
  writeFileSync(path.join(dir, 'notes.txt'), 'x');

  assert.equal(clearLogs(dir), 2);
  assert.deepEqual(readdirSync(dir), ['notes.txt']);
  assert.equal(clearLogs(dir), 0);
});

test('followLogs prints existing lines and then appended ones until aborted', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-logs-'));
  const file = path.join(dir, 'hub-2026-11-24.log');
  writeFileSync(file, 'one\n');

  const seen = [];
  const controller = new AbortController();
  const running = followLogs(dir, {
    out: (line) => seen.push(line),
    signal: controller.signal,
    intervalMs: 10
  });

  await sleep(50);
  appendFileSync(file, 'two\n');
  await sleep(100);
  controller.abort();
  await running;

  assert.deepEqual(seen, ['one', 'two']);
});

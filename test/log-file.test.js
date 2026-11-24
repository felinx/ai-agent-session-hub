import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogStore } from '../src/log-file.js';

function fixedNow() {
  return new Date(2026, 10, 24, 15, 30, 0);
}

test('createLogStore appends to a date-named file with private permissions', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'session-hub-log-')), 'logs');
  const store = createLogStore({ dir, now: fixedNow });

  store.write('[2026-11-24 15:30:00] first');
  store.write('[2026-11-24 15:30:01] second');

  assert.deepEqual(readdirSync(dir), ['hub-2026-11-24.log']);
  assert.equal(
    readFileSync(path.join(dir, 'hub-2026-11-24.log'), 'utf8'),
    '[2026-11-24 15:30:00] first\n[2026-11-24 15:30:01] second\n'
  );
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(dir, 'hub-2026-11-24.log')).mode & 0o777, 0o600);
});

test('createLogStore rolls to a numbered file when the size cap is reached', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-log-'));
  const store = createLogStore({ dir, now: fixedNow, maxBytes: 20 });

  store.write('0123456789');
  store.write('abcdefghij');
  store.write('KLMNOPQRST');

  assert.deepEqual(readdirSync(dir).sort(), [
    'hub-2026-11-24.1.log',
    'hub-2026-11-24.2.log',
    'hub-2026-11-24.log'
  ]);
  assert.equal(readFileSync(path.join(dir, 'hub-2026-11-24.log'), 'utf8'), '0123456789\n');
  assert.equal(readFileSync(path.join(dir, 'hub-2026-11-24.1.log'), 'utf8'), 'abcdefghij\n');
  assert.equal(readFileSync(path.join(dir, 'hub-2026-11-24.2.log'), 'utf8'), 'KLMNOPQRST\n');
});

test('createLogStore prunes files older than the retention window', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-log-'));
  mkdirSync(dir, { recursive: true });
  for (const name of [
    'hub-2026-01-01.log',
    'hub-2026-01-01.2.log',
    'hub-2026-11-20.log',
    'hub-2026-11-24.log',
    'notes.txt'
  ]) {
    writeFileSync(path.join(dir, name), 'x');
  }

  const store = createLogStore({ dir, now: fixedNow, keepDays: 30 });
  store.prune();

  assert.deepEqual(readdirSync(dir).sort(), [
    'hub-2026-11-20.log',
    'hub-2026-11-24.log',
    'notes.txt'
  ]);
});

test('createLogStore clear removes only its own log files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-log-'));
  for (const name of ['hub-2026-11-24.log', 'hub-2026-11-24.1.log', 'notes.txt']) {
    writeFileSync(path.join(dir, name), 'x');
  }

  createLogStore({ dir, now: fixedNow }).clear();

  assert.deepEqual(readdirSync(dir), ['notes.txt']);
});

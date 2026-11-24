import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('defaults to the start command', () => {
  assert.deepEqual(parseArgs([]), { command: 'start', options: {}, errors: [] });
});

test('parses the run command with server options', () => {
  const result = parseArgs(['run', '--port', '8080', '--db', '/tmp/hub.db', '--host', '127.0.0.1', '--rebuild']);
  assert.deepEqual(result.errors, []);
  assert.equal(result.command, 'run');
  assert.deepEqual(result.options, {
    port: 8080,
    db: '/tmp/hub.db',
    host: '127.0.0.1',
    rebuild: true
  });
});

test('accepts --name=value form', () => {
  const result = parseArgs(['run', '--port=9000', '--db=/tmp/x.db']);
  assert.deepEqual(result.errors, []);
  assert.equal(result.options.port, 9000);
  assert.equal(result.options.db, '/tmp/x.db');
});

test('parses status flags', () => {
  const result = parseArgs(['status', '--json']);
  assert.deepEqual(result, { command: 'status', options: { json: true }, errors: [] });

  assert.deepEqual(parseArgs(['status', '--json', '--port', '8080', '--db', '/tmp/x.db']), {
    command: 'status',
    options: { json: true, port: 8080, db: '/tmp/x.db' },
    errors: []
  });
});

test('parses log flags', () => {
  assert.deepEqual(parseArgs(['logs', '-f', '-n', '20']), {
    command: 'logs', options: { follow: true, lines: 20 }, errors: []
  });
  assert.deepEqual(parseArgs(['logs', '--clear']), {
    command: 'logs', options: { clear: true }, errors: []
  });
});

test('help and version flags', () => {
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['help']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
});

test('rejects unknown commands and options', () => {
  const unknownCommand = parseArgs(['frobnicate']);
  assert.equal(unknownCommand.command, null);
  assert.deepEqual(unknownCommand.errors, [{ code: 'unknownCommand', arg: 'frobnicate' }]);

  const unknownOption = parseArgs(['run', '--nope']);
  assert.equal(unknownOption.command, null);
  assert.deepEqual(unknownOption.errors, [{ code: 'unknownOption', arg: '--nope' }]);

  const wrongCommandOption = parseArgs(['stop', '--json']);
  assert.equal(wrongCommandOption.command, null);
  assert.deepEqual(wrongCommandOption.errors, [{ code: 'unknownOption', arg: '--json' }]);
});

test('rejects missing and invalid values', () => {
  assert.deepEqual(parseArgs(['run', '--port']).errors, [{ code: 'missingValue', arg: '--port' }]);
  assert.deepEqual(parseArgs(['logs', '-n']).errors, [{ code: 'missingValue', arg: '-n' }]);
  assert.deepEqual(parseArgs(['run', '--port', 'abc']).errors, [{ code: 'invalidPort', arg: 'abc' }]);
  assert.deepEqual(parseArgs(['logs', '-n', '0']).errors, [{ code: 'invalidLines', arg: '0' }]);
});

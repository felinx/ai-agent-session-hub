// Hand-rolled argument parsing: the project has no third-party dependencies, so the
// CLI grammar stays small enough to spell out here.

const COMMANDS = new Set(['run', 'start', 'stop', 'restart', 'status', 'logs', 'doctor', 'help', 'version']);

const SERVER_FLAGS = {
  '--port': { key: 'port', value: 'port' },
  '--host': { key: 'host', value: 'string' },
  '--db': { key: 'db', value: 'string' },
  '--rebuild': { key: 'rebuild', value: 'flag' }
};

const SPECS = {
  run: SERVER_FLAGS,
  start: SERVER_FLAGS,
  restart: SERVER_FLAGS,
  stop: {},
  status: {
    '--json': { key: 'json', value: 'flag' },
    '--port': SERVER_FLAGS['--port'],
    '--db': SERVER_FLAGS['--db']
  },
  logs: {
    '-f': { key: 'follow', value: 'flag' },
    '--follow': { key: 'follow', value: 'flag' },
    '-n': { key: 'lines', value: 'lines' },
    '--lines': { key: 'lines', value: 'lines' },
    '--clear': { key: 'clear', value: 'flag' }
  },
  doctor: {},
  help: {},
  version: {}
};

function fail(code, arg) {
  return { command: null, options: {}, errors: [{ code, arg }] };
}

export function parseArgs(argv = []) {
  if (argv[0] === '--help' || argv[0] === '-h') return { command: 'help', options: {}, errors: [] };
  if (argv[0] === '--version') return { command: 'version', options: {}, errors: [] };

  let command = 'start';
  let rest = argv;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    command = argv[0];
    rest = argv.slice(1);
    if (!COMMANDS.has(command)) return fail('unknownCommand', command);
  }

  const spec = SPECS[command];
  const options = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const entry = spec[name];
    if (!entry) return fail('unknownOption', name);

    if (entry.value === 'flag') {
      options[entry.key] = true;
      continue;
    }

    let value = inline;
    if (value === null) {
      value = rest[i + 1];
      if (value === undefined) return fail('missingValue', name);
      i += 1;
    }

    if (entry.value === 'port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('invalidPort', value);
      options[entry.key] = port;
    } else if (entry.value === 'lines') {
      const lines = Number(value);
      if (!Number.isInteger(lines) || lines < 1) return fail('invalidLines', value);
      options[entry.key] = lines;
    } else {
      options[entry.key] = value;
    }
  }

  return { command, options, errors: [] };
}

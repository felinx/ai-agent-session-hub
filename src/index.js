#!/usr/bin/env node
// Compatibility entry point: `node src/index.js` keeps running the hub in the
// foreground, exactly like `session-hub run`.
import { main } from './cli.js';

process.exitCode = await main(['run', ...process.argv.slice(2)]);

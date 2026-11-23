#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb, initSchema, clearAll } from './db.js';
import { syncOnce } from './sync.js';
import { createServer } from './server.js';

const config = loadConfig();
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

await mkdir(path.dirname(config.dbPath), { recursive: true });

const db = openDb(config.dbPath);
initSchema(db);

if (config.rebuild) clearAll(db);

const state = { scanning: false, lastSyncAt: null, warnings: [] };
const server = createServer({ db, state, publicDir });

let syncing = false;
let forceNext = config.rebuild;

async function runSync() {
  if (syncing) return;
  syncing = true;
  state.scanning = true;

  try {
    const result = await syncOnce(db, config, { force: forceNext });
    forceNext = false;
    state.lastSyncAt = Date.now();
    state.warnings = result.warnings;

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) console.warn(`[sync] ${warning}`);
    }
    console.log(
      `[sync] +${result.added} ~${result.updated} =${result.unchanged} -${result.removed}`
    );
  } catch (error) {
    state.warnings = [String(error?.message ?? error)];
    console.error('[sync] failed:', error);
  } finally {
    syncing = false;
    state.scanning = false;
  }
}

server.on('error', (error) => {
  console.error(`无法监听 ${config.host}:${config.port} — ${error.message}`);
  db.close();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`Session Hub → http://${config.host}:${config.port}`);
  console.log(`数据库：${config.dbPath}`);
  runSync();
});

const timer = setInterval(runSync, 5000);

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在退出…`);
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

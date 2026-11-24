#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb, initSchema, clearAll } from './db.js';
import { syncOnce } from './sync.js';
import { createServer } from './server.js';
import { getSettings } from './settings.js';
import { formatWarning, resolveLanguage, t, detectSystemLanguage } from '../public/i18n.js';
import { stamp, describeSync, hasChanges } from './log.js';

const config = loadConfig();
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

await mkdir(path.dirname(config.dbPath), { recursive: true });

const db = openDb(config.dbPath);
initSchema(db);

if (config.rebuild) clearAll(db);

const state = { scanning: false, lastSyncAt: null, warnings: [] };
const server = createServer({ db, state, publicDir, config });

function currentLanguage() {
  return resolveLanguage(getSettings(db).language, detectSystemLanguage());
}

let syncing = false;
let forceNext = config.rebuild;
let lastQuietLogAt = 0;
// 静默同步每 5 秒一次，只在有变化或有告警时打明细；无变化时最多每 5 分钟留一行心跳。
const QUIET_LOG_INTERVAL_MS = 5 * 60_000;

async function runSync() {
  if (syncing) return;
  syncing = true;
  state.scanning = true;
  const startedAt = Date.now();

  try {
    const result = await syncOnce(db, config, { force: forceNext });
    forceNext = false;
    state.lastSyncAt = Date.now();
    state.warnings = result.warnings;

    const lang = currentLanguage();
    for (const warning of result.warnings) {
      console.warn(`${stamp()} ${formatWarning(lang, warning)}`);
    }

    const now = new Date();
    const quiet = !hasChanges(result);
    if (!quiet || now.getTime() - lastQuietLogAt >= QUIET_LOG_INTERVAL_MS) {
      for (const line of describeSync(result, lang, { now, elapsedMs: now.getTime() - startedAt })) {
        console.log(line);
      }
      if (quiet) lastQuietLogAt = now.getTime();
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    state.warnings = [{ code: 'syncFailed', params: { message } }];
    console.error(`${stamp()} ${formatWarning(currentLanguage(), state.warnings[0])}`);
  } finally {
    syncing = false;
    state.scanning = false;
  }
}

server.on('error', (error) => {
  console.error(`${stamp()} ${t(currentLanguage(), 'server.listenFailed', {
    host: config.host,
    port: config.port,
    message: error.message
  })}`);
  db.close();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`${stamp()} Agent Session Hub → http://${config.host}:${config.port}`);
  console.log(`${stamp()} ${t(currentLanguage(), 'server.database', { path: config.dbPath })}`);
  runSync();
});

const timer = setInterval(runSync, 5000);

function shutdown(signal) {
  console.log(`${stamp()} ${t(currentLanguage(), 'server.shutdown', { signal })}`);
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

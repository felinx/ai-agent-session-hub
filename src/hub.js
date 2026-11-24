import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, initSchema, clearAll } from './db.js';
import { syncOnce } from './sync.js';
import { createServer } from './server.js';
import { getSettings } from './settings.js';
import { formatWarning, resolveLanguage, t, detectSystemLanguage } from '../public/i18n.js';
import { stamp, describeSync } from './log.js';

export const defaultPublicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

// Runs the hub until the returned handle is closed: opens the local copy, serves the
// UI and API, and syncs incrementally. `emit(line, level)` receives every log line so
// the caller decides where it goes (terminal, log files, or silence in daemon mode).
export async function startHub({
  config,
  publicDir = defaultPublicDir,
  emit = () => {},
  syncInterval = 5000,
  sync = syncOnce
}) {
  const db = openDb(config.dbPath);
  initSchema(db);

  if (config.rebuild) clearAll(db);

  const state = { scanning: false, lastSyncAt: null, warnings: [] };
  const server = createServer({ db, state, publicDir, config });

  function currentLanguage() {
    return resolveLanguage(getSettings(db).language, detectSystemLanguage());
  }

  let syncPromise = null;
  let closed = false;
  let forceNext = config.rebuild;

  function runSync() {
    if (closed || syncPromise) return syncPromise ?? Promise.resolve();
    state.scanning = true;

    syncPromise = (async () => {
      try {
        const result = await sync(db, config, { force: forceNext });
        forceNext = false;
        state.lastSyncAt = Date.now();
        state.warnings = result.warnings;

        const lang = currentLanguage();
        for (const warning of result.warnings) {
          emit(`${stamp()} ${formatWarning(lang, warning)}`, 'warn');
        }
        // Only real changes produce output; the status page covers the overall picture.
        for (const line of describeSync(result, lang)) {
          emit(line);
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        state.warnings = [{ code: 'syncFailed', params: { message } }];
        emit(`${stamp()} ${formatWarning(currentLanguage(), state.warnings[0])}`, 'error');
      } finally {
        state.scanning = false;
        syncPromise = null;
      }
    })();

    return syncPromise;
  }

  try {
    await listen(server, config.port, config.host);
  } catch (error) {
    db.close();
    throw error;
  }

  const port = server.address().port;
  emit(`${stamp()} Agent Session Hub → http://${config.host}:${port}`);
  emit(`${stamp()} ${t(currentLanguage(), 'server.database', { path: config.dbPath })}`);
  runSync();

  const timer = setInterval(runSync, syncInterval);

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    // Let a sync that already started finish before the database goes away.
    if (syncPromise) await syncPromise;
    await new Promise(resolve => server.close(resolve));
    db.close();
  }

  return { server, db, state, port, runSync, close, language: currentLanguage };
}

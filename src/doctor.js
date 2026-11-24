import { existsSync, statSync } from 'node:fs';
import { openDb } from './db.js';
import { listLogFiles } from './logs.js';
import { collectStatus } from './status.js';

const MIN_NODE = [22, 5, 0];

function versionAtLeast(current, minimum) {
  const parts = String(current).split('.').map(Number);
  for (let i = 0; i < minimum.length; i += 1) {
    const part = parts[i] ?? 0;
    if (part !== minimum[i]) return part > minimum[i];
  }
  return true;
}

function logSummary(dir) {
  const files = listLogFiles(dir);
  let bytes = 0;
  for (const file of files) {
    try { bytes += statSync(file.path).size; } catch {}
  }
  return `${dir} (${files.length} files, ${Math.round(bytes / 1024)} KB)`;
}

// Read-only health checks: nothing here creates or changes hub state.
export async function runDoctor({ config, nodeVersion = process.versions.node }) {
  const checks = [];

  checks.push({
    label: 'Node.js',
    level: versionAtLeast(nodeVersion, MIN_NODE) ? 'ok' : 'fail',
    detail: `${nodeVersion} (needs >= ${MIN_NODE.join('.')})`
  });

  if (existsSync(config.dbPath)) {
    let detail;
    let level = 'ok';
    try {
      const db = openDb(config.dbPath);
      try {
        const row = db.prepare('SELECT count(*) AS total FROM sessions').get();
        detail = `${config.dbPath} (${row?.total ?? 0} sessions)`;
      } finally {
        db.close();
      }
    } catch (error) {
      level = 'fail';
      detail = `${config.dbPath} (${error?.message ?? error})`;
    }
    checks.push({ label: 'Database', level, detail });
  } else {
    checks.push({ label: 'Database', level: 'warn', detail: `${config.dbPath} (not created yet)` });
  }

  checks.push({ label: 'Logs', level: 'ok', detail: logSummary(config.logDir) });

  for (const [agent, root] of Object.entries(config.roots)) {
    checks.push({
      label: `Source: ${agent}`,
      level: existsSync(root) ? 'ok' : 'warn',
      detail: root
    });
  }

  const status = await collectStatus({ config });
  checks.push({
    label: 'Server',
    level: status.running ? 'ok' : 'warn',
    detail: status.running
      ? `running on http://${status.host}:${status.port}`
      : `not running (port ${status.port})`
  });

  return checks;
}

export function formatChecks(checks) {
  return checks.map(check => `[${check.level}] ${check.label}: ${check.detail}`).join('\n');
}

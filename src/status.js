import { existsSync } from 'node:fs';
import { openDb, initSchema, getAgentStats } from './db.js';

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTime(ms) {
  if (!ms) return 'never';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// A wildcard bind is not an address clients can connect to.
function queryHost(host) {
  return !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

function totalsOf(agents) {
  return {
    sessions: agents.reduce((sum, row) => sum + row.sessions, 0),
    messages: agents.reduce((sum, row) => sum + row.messages, 0)
  };
}

// Ask the running hub first; if it does not answer, read the local copy directly so
// status still works while the daemon is stopped. Never creates the database.
export async function collectStatus({ config, timeoutMs = 1500 }) {
  const host = queryHost(config.host);

  try {
    const res = await fetch(`http://${host}:${config.port}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.ok) {
      const body = await res.json();
      const agents = Array.isArray(body.agents) ? body.agents : [];
      return {
        running: true,
        host,
        port: config.port,
        source: 'http',
        lastSyncAt: body.lastSyncAt ?? null,
        agents,
        totals: totalsOf(agents)
      };
    }
  } catch {
    // Server down or unresponsive: fall through to the local copy.
  }

  if (existsSync(config.dbPath)) {
    let db;
    try {
      db = openDb(config.dbPath);
      initSchema(db);
      const agents = getAgentStats(db);
      const row = db.prepare('SELECT max(updated_at) AS last FROM sessions').get();
      return {
        running: false,
        host,
        port: config.port,
        source: 'db',
        lastSyncAt: row?.last ?? null,
        agents,
        totals: totalsOf(agents)
      };
    } catch {
      // An unreadable copy is reported as empty rather than failing the whole command.
    } finally {
      db?.close();
    }
  }

  return {
    running: false,
    host,
    port: config.port,
    source: 'none',
    lastSyncAt: null,
    agents: [],
    totals: { sessions: 0, messages: 0 }
  };
}

export function formatStatus(status) {
  const lines = [];

  if (status.running) {
    lines.push(`Status:   running on http://${status.host}:${status.port}`);
  } else {
    lines.push(`Status:   stopped (port ${status.port})`);
    if (status.source === 'db') {
      lines.push('          showing the local copy; start it with "session-hub start"');
    }
  }
  lines.push(`Synced:   ${formatTime(status.lastSyncAt)}`);
  lines.push(`Sessions: ${status.totals.sessions}    Messages: ${status.totals.messages}`);
  lines.push('');

  if (status.agents.length === 0) {
    lines.push('No sessions synced yet.');
    return lines.join('\n');
  }

  const headers = ['AGENT', 'SESSIONS', 'MESSAGES', 'LAST SYNC', 'LATEST'];
  const rows = status.agents.map(agent => [
    agent.agent,
    String(agent.sessions),
    String(agent.messages),
    formatTime(agent.lastSyncAt),
    agent.latest ? [agent.latest.id ? `#${agent.latest.id}` : '', agent.latest.summary ?? ''].join(' ').trim() : ''
  ]);
  const widths = headers.slice(0, 4).map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index].length))
  );

  lines.push(headers.map((header, index) => index === 4 ? header : header.padEnd(widths[index])).join('  ').trimEnd());
  for (const row of rows) {
    lines.push(row.map((cell, index) => index === 4 ? cell : cell.padEnd(widths[index])).join('  ').trimEnd());
  }
  return lines.join('\n');
}

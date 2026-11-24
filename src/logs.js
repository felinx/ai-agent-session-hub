import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { createLogStore } from './log-file.js';

const NAME_RE = /^hub-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function listLogFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map(name => {
      const match = NAME_RE.exec(name);
      if (!match) return null;
      return {
        name,
        path: path.join(dir, name),
        date: match[1],
        index: match[2] ? Number(match[2]) : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1));
}

// Newest lines, taken newest file first so a long retention window does not have to
// be read in full for a short tail.
export function tailLines(dir, count = 50) {
  const files = listLogFiles(dir);
  const collected = [];

  for (let i = files.length - 1; i >= 0 && collected.length < count; i -= 1) {
    const text = readFileSync(files[i].path, 'utf8');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    collected.unshift(...lines.slice(Math.max(0, lines.length - (count - collected.length))));
  }

  return collected;
}

export function clearLogs(dir) {
  const count = listLogFiles(dir).length;
  createLogStore({ dir }).clear();
  return count;
}

// Follow the newest log file, printing what is already there and then what gets
// appended. Switching to a newly rotated file restarts at its beginning.
export async function followLogs(dir, { out, signal, intervalMs = 300, sleepImpl = sleep }) {
  let current = null;
  let offset = 0;

  while (!signal?.aborted) {
    const newest = listLogFiles(dir).at(-1);
    if (newest) {
      if (newest.path !== current) {
        current = newest.path;
        offset = 0;
      }
      try {
        const size = statSync(current).size;
        if (size > offset) {
          const buffer = Buffer.alloc(size - offset);
          const fd = openSync(current, 'r');
          try {
            readSync(fd, buffer, 0, buffer.length, offset);
          } finally {
            closeSync(fd);
          }
          offset = size;
          for (const line of buffer.toString('utf8').split('\n')) {
            if (line !== '') out(line);
          }
        }
      } catch {
        // The file disappeared (logs --clear); pick the newest one up again.
        current = null;
        offset = 0;
      }
    }
    await sleepImpl(intervalMs);
  }
}

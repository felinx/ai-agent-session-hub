import { mkdirSync, appendFileSync, statSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Rotating log files under a private directory: one file per day, rolled to
// `<base>-<date>.1.log` and so on once a file reaches the size cap. Files older
// than the retention window are removed when the store is used on a new day.
export function createLogStore({ dir, baseName = 'hub', maxBytes = 10 * 1024 * 1024, keepDays = 30, now = () => new Date() }) {
  const nameRe = new RegExp(`^${baseName}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.log$`);
  let lastDate = null;

  function ensureDir() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
  }

  function logFiles() {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map(name => {
        const match = nameRe.exec(name);
        return match ? { name, date: match[1] } : null;
      })
      .filter(Boolean);
  }

  function prune() {
    // Calendar subtraction, so a DST change does not shift the cutoff by a day.
    const current = now();
    const cutoff = dateKey(new Date(current.getFullYear(), current.getMonth(), current.getDate() - keepDays));
    for (const file of logFiles()) {
      if (file.date < cutoff) {
        try { unlinkSync(path.join(dir, file.name)); } catch {}
      }
    }
  }

  function pickFile(date, text) {
    const base = `${baseName}-${date}`;
    const bytes = Buffer.byteLength(text);
    for (let index = 0; ; index += 1) {
      const name = index === 0 ? `${base}.log` : `${base}.${index}.log`;
      const target = path.join(dir, name);
      let size = 0;
      try {
        size = statSync(target).size;
      } catch {
        return target;
      }
      if (size + bytes <= maxBytes) return target;
    }
  }

  function write(line) {
    const date = dateKey(now());
    ensureDir();
    if (lastDate !== date) {
      lastDate = date;
      prune();
    }
    const text = line.endsWith('\n') ? line : `${line}\n`;
    const target = pickFile(date, text);
    appendFileSync(target, text, { mode: 0o600 });
    try { chmodSync(target, 0o600); } catch {}
    return target;
  }

  function clear() {
    for (const file of logFiles()) {
      try { unlinkSync(path.join(dir, file.name)); } catch {}
    }
  }

  return { dir, write, prune, clear, file: () => pickFile(dateKey(now()), '') };
}

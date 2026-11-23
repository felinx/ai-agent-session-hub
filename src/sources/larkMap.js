import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PROFILES = ['claude', 'codex'];
const LARK_DIR_RE = /^lark-(oc_[A-Za-z0-9]+)/;

async function readCatalog(root, profile) {
  const catalogPath = path.join(root, 'profiles', profile, 'sessions.json.catalog.json');
  try {
    const parsed = JSON.parse(await readFile(catalogPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function buildChatMap(config) {
  const root = config.roots.larkChannel;
  const map = new Map();

  for (const profile of PROFILES) {
    for (const entry of await readCatalog(root, profile)) {
      if (!entry || typeof entry !== 'object') continue;
      const chatId = entry.scopeId;
      const nativeId = entry.sessionId || entry.threadId;
      if (!chatId || !nativeId) continue;
      map.set(`${entry.agentId || profile}:${nativeId}`, chatId);
    }
  }

  return map;
}

export function chatIdFromDshDir(dirName) {
  if (typeof dirName !== 'string') return null;
  return dirName.match(LARK_DIR_RE)?.[1] ?? null;
}

import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  textFromContent, stripBridgeContext, isSyntheticUserText, deriveTitle, toEpochMs
} from '../normalize.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isMissing(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

async function readFirstLine(filePath, maxBytes = 65536) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    await handle.close();
  }
}

async function readSessionIndex(indexPath) {
  const titles = new Map();
  let raw;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch (err) {
    if (isMissing(err)) return titles;
    throw err;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry?.id && typeof entry.thread_name === 'string' && entry.thread_name.trim()) {
        titles.set(entry.id, entry.thread_name.trim());
      }
    } catch {}
  }
  return titles;
}

async function toDiscovered(sourcePath, archived, titles) {
  let meta = {};

  let firstLine;
  try {
    firstLine = await readFirstLine(sourcePath);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  try {
    const first = JSON.parse(firstLine);
    if (first?.type === 'session_meta' && first.payload && typeof first.payload === 'object') {
      meta = first.payload;
    }
  } catch {}

  if (meta.parent_thread_id || meta.forked_from_id || meta.agent_path) return null;
  if (meta.thread_source === 'onboarding_checklist') return null;

  let stats;
  try {
    stats = await stat(sourcePath);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }

  const nativeId = meta.id || meta.session_id ||
    (path.basename(sourcePath).match(UUID_RE)?.[0] ?? path.basename(sourcePath, '.jsonl'));

  return {
    agent: 'codex',
    sourcePath,
    archived,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    titleHint: titles.get(nativeId),
    nativeId
  };
}

async function walk(dirPath, archived, titles, out) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walk(full, archived, titles, out);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      const file = await toDiscovered(full, archived, titles);
      if (file) out.push(file);
    }
  }
}

export async function discoverCodex(config) {
  const root = config.roots.codex;
  const titles = await readSessionIndex(path.join(root, 'session_index.jsonl'));
  const discovered = [];
  await walk(path.join(root, 'sessions'), false, titles, discovered);

  let archivedEntries = [];
  try {
    archivedEntries = await readdir(path.join(root, 'archived_sessions'), { withFileTypes: true });
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  for (const entry of archivedEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = await toDiscovered(path.join(root, 'archived_sessions', entry.name), true, titles);
    if (file) discovered.push(file);
  }

  return discovered;
}

function lastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

function ownerFor(callId, callOwner) {
  if (!callId) return undefined;
  if (callOwner.has(callId)) return callOwner.get(callId);
  const stripped = callId.replace(/^(fc_|ctc_)/, '');
  return callOwner.get(stripped);
}

export async function parseCodex(sourcePath, discovery) {
  const raw = await readFile(sourcePath, 'utf8');
  const messages = [];
  const callOwner = new Map();

  let nativeId = discovery?.nativeId;
  let cwd = null;
  let createdAt = null;
  let firstUserText = '';
  let pendingThinking = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'session_meta') {
      const meta = entry.payload ?? {};
      nativeId ??= meta.id || meta.session_id;
      if (cwd === null && meta.cwd) cwd = meta.cwd;
      if (createdAt === null && meta.timestamp) createdAt = toEpochMs(meta.timestamp);
      continue;
    }

    if (entry.type !== 'response_item' || !entry.payload) continue;
    const payload = entry.payload;

    if (payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      const cleaned = stripBridgeContext(textFromContent(payload.content));
      if (payload.role === 'user' && isSyntheticUserText(cleaned)) continue;
      if (payload.role === 'user' && !firstUserText && cleaned) firstUserText = cleaned;

      const message = {
        role: payload.role,
        at: null,
        text: cleaned,
        thinking: payload.role === 'assistant' ? pendingThinking : null,
        toolCalls: [],
        toolResults: []
      };
      if (payload.role === 'assistant') pendingThinking = null;
      if (!message.text && !message.thinking) continue;
      messages.push(message);
      continue;
    }

    if (payload.type === 'reasoning') {
      const text = (payload.summary ?? [])
        .map(item => item?.text)
        .filter(text => typeof text === 'string' && text !== '')
        .join('\n');
      if (text) pendingThinking = pendingThinking ? `${pendingThinking}\n${text}` : text;
      continue;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      let input = payload.arguments ?? payload.input ?? null;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch {}
      }
      let owner = lastAssistantIndex(messages);
      if (owner < 0) {
        messages.push({ role: 'assistant', at: null, text: '', thinking: pendingThinking, toolCalls: [], toolResults: [] });
        pendingThinking = null;
        owner = messages.length - 1;
      }
      const callId = payload.call_id || payload.id || null;
      messages[owner].toolCalls.push({ id: callId, name: payload.name ?? null, input });
      if (callId) callOwner.set(callId, owner);
      if (payload.id && payload.id !== callId) callOwner.set(payload.id, owner);
      continue;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = payload.call_id || payload.id || null;
      const output = typeof payload.output === 'string'
        ? payload.output
        : Array.isArray(payload.output)
          ? textFromContent(payload.output)
          : JSON.stringify(payload.output ?? '');
      const result = { callId, output, isError: !!payload.is_error };

      let owner = ownerFor(callId, callOwner);
      if (owner === undefined) owner = lastAssistantIndex(messages);
      if (owner >= 0) messages[owner].toolResults.push(result);
      continue;
    }
  }

  return {
    nativeId: nativeId ?? path.basename(sourcePath).replace(/\.jsonl$/, ''),
    title: discovery?.titleHint ||
      deriveTitle(firstUserText, nativeId ? `未命名会话 · ${nativeId.slice(0, 8)}` : '未命名会话'),
    cwd,
    createdAt,
    messages
  };
}

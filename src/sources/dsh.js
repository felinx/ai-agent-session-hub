import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  textFromContent, stripBridgeContext, isSyntheticUserText, deriveTitle, toEpochMs
} from '../normalize.js';
import { isSettled } from '../turns.js';

const SESSION_FILE = 'session.v4.jsonl.zstd';
const LARK_DIR_RE = /^lark-(oc_[A-Za-z0-9]+)/;
const VISIBLE_USER_KINDS = new Set(['user', 'agent-message']);

function isMissing(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

export async function discoverDsh(config) {
  const sessionsRoot = path.join(config.roots.dsh, 'sessions');
  let slugs;
  try {
    slugs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }

  const discovered = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugPath = path.join(sessionsRoot, slug.name);

    let dirs;
    try {
      dirs = await readdir(slugPath, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const sourcePath = path.join(slugPath, dir.name, SESSION_FILE);

      let stats;
      try {
        stats = await stat(sourcePath);
      } catch (err) {
        if (isMissing(err)) continue;
        throw err;
      }

      discovered.push({
        agent: 'dsh',
        sourcePath,
        archived: false,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        chatHint: dir.name.match(LARK_DIR_RE)?.[1],
        nativeId: dir.name
      });
    }
  }

  return discovered;
}

function assistantBlocks(content) {
  let text = '';
  let thinking = null;
  if (!Array.isArray(content)) {
    return { text: typeof content === 'string' ? content : '', thinking };
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      text += (text ? '\n' : '') + (block.text ?? '');
    } else if (block.type === 'reasoning') {
      thinking = (thinking ?? '') + (thinking ? '\n' : '') + (block.text ?? '');
    }
  }
  return { text, thinking };
}

function lastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

const STATUS_BY_REASON = {
  completed: 'completed',
  blocked: 'blocked',
  aborted: 'aborted',
  error: 'error'
};

export async function parseDsh(sourcePath, discovery) {
  const raw = zstdDecompressSync(await readFile(sourcePath)).toString('utf8');
  const messages = [];
  const callOwner = new Map();
  const turns = [];
  const unresolvedCalls = new Set();

  let nativeId = discovery?.nativeId;
  let cwd = null;
  let createdAt = null;
  let firstUserText = '';
  let explicitTitle = null;
  let openTurn = null;

  function closeOpenTurn(status, endedAt, finalIndex = null) {
    if (openTurn && openTurn.promptIndex !== null) {
      turns.push({
        turnId: openTurn.turnId,
        status,
        signal: 'native',
        startedAt: openTurn.startedAt,
        endedAt,
        promptIndex: openTurn.promptIndex,
        finalIndex
      });
    }
    openTurn = null;
    unresolvedCalls.clear();
  }

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

    const data = entry.data ?? {};
    const at = toEpochMs(entry.time);

    switch (entry.type) {
      case 'session': {
        const info = entry.data ?? entry;
        nativeId = info.id ?? info.sessionId ?? nativeId;
        if (cwd === null && info.cwd) cwd = info.cwd;
        if (createdAt === null) createdAt = toEpochMs(info.createdAt);
        break;
      }
      case 'turn/start': {
        closeOpenTurn('interrupted', messages[messages.length - 1]?.at ?? at);
        openTurn = {
          turnId: data.turn === undefined || data.turn === null ? null : String(data.turn),
          startedAt: at,
          promptIndex: null
        };
        break;
      }
      case 'turn/end': {
        if (!openTurn) break;
        const kind = data.reason?.kind;
        const finalIndex = lastAssistantIndex(messages);
        closeOpenTurn(
          STATUS_BY_REASON[kind] ?? 'error',
          at,
          finalIndex >= openTurn.promptIndex ? finalIndex : null
        );
        break;
      }
      case 'user/message': {
        const kind = data.source?.kind;
        if (kind !== undefined && !VISIBLE_USER_KINDS.has(kind)) break;
        const cleaned = stripBridgeContext(textFromContent(data.content ?? data.message?.content));
        if (!cleaned || isSyntheticUserText(cleaned)) break;
        if (!firstUserText) firstUserText = cleaned;
        messages.push({ role: 'user', at, text: cleaned, thinking: null, toolCalls: [], toolResults: [] });
        if (openTurn && openTurn.promptIndex === null) {
          openTurn.promptIndex = messages.length - 1;
        }
        break;
      }
      case 'assistant/message': {
        const { text, thinking } = assistantBlocks(data.message?.content ?? data.content);
        if (!text && !thinking) break;
        messages.push({
          role: 'assistant',
          at,
          text: stripBridgeContext(text),
          thinking,
          toolCalls: [],
          toolResults: []
        });
        break;
      }
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim()) explicitTitle = data.title.trim();
        break;
      }
      case 'tool/call': {
        let input = data.arguments ?? data.input ?? null;
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch {}
        }
        let owner = lastAssistantIndex(messages);
        if (owner < 0) {
          messages.push({ role: 'assistant', at, text: '', thinking: null, toolCalls: [], toolResults: [] });
          owner = messages.length - 1;
        }
        const callId = data.callId ?? data.id ?? null;
        messages[owner].toolCalls.push({ id: callId, name: data.name ?? null, input });
        if (callId) {
          callOwner.set(callId, owner);
          unresolvedCalls.add(callId);
        }
        break;
      }
      case 'tool/result': {
        const callId = data.toolCallId ?? data.callId ?? null;
        const result = {
          callId,
          output: textFromContent(data.content ?? data.message?.content),
          isError: !!data.isError
        };
        if (callId) unresolvedCalls.delete(callId);
        const owner = callId !== null ? callOwner.get(callId) : undefined;
        const target = owner ?? lastAssistantIndex(messages);
        if (target >= 0) messages[target].toolResults.push(result);
        break;
      }
      default:
        break;
    }
  }

  if (openTurn) {
    const last = messages[messages.length - 1];
    const settled = isSettled(discovery?.mtimeMs);
    if (
      settled && openTurn.promptIndex !== null &&
      (last?.role === 'user' || unresolvedCalls.size > 0)
    ) {
      closeOpenTurn('interrupted', last?.at ?? null);
    }
  }

  return {
    nativeId: nativeId ?? path.basename(path.dirname(sourcePath)),
    title: explicitTitle || deriveTitle(firstUserText),
    cwd,
    createdAt,
    messages,
    turns
  };
}

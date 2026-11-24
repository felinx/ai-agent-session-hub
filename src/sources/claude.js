import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  textFromContent, stripBridgeContext, isSyntheticUserText, deriveTitle, toEpochMs
} from '../normalize.js';
import { isSettled } from '../turns.js';

const SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

function isMissing(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

export async function discoverClaude(config) {
  const projectsRoot = path.join(config.roots.claude, 'projects');
  let projectDirs;
  try {
    projectDirs = await readdir(projectsRoot, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }

  const discovered = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, projectDir.name);

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_FILE_RE.test(entry.name)) continue;
      const sourcePath = path.join(dirPath, entry.name);

      let stats;
      try {
        stats = await stat(sourcePath);
      } catch (err) {
        if (isMissing(err)) continue;
        throw err;
      }

      const nativeId = entry.name.slice(0, -'.jsonl'.length);
      let titleHint;
      try {
        const custom = JSON.parse(
          await readFile(path.join(dirPath, nativeId, 'custom-title.json'), 'utf8')
        );
        if (typeof custom.customTitle === 'string' && custom.customTitle.trim()) {
          titleHint = custom.customTitle.trim();
        }
      } catch {}

      discovered.push({
        agent: 'claude',
        sourcePath,
        archived: false,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        titleHint,
        nativeId
      });
    }
  }

  return discovered;
}

export async function parseClaude(sourcePath, discovery) {
  const raw = await readFile(sourcePath, 'utf8');
  const messages = [];
  const callOwner = new Map();
  const turns = [];
  const unresolvedCalls = new Set();

  let sessionId;
  let cwd = null;
  let createdAt = null;
  let firstUserText = '';
  let openTurn = null;
  let group = null;

  const TERMINAL_STOP = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

  // One assistant message is split across up to eight lines sharing message.id. The
  // terminal stop_reason appears on those lines, not only the last, so the group is
  // closed only when a different message id or a user entry arrives.
  function closeAssistantGroup() {
    if (!group) return;
    const closed = group;
    group = null;
    if (!openTurn || !TERMINAL_STOP.has(closed.stopReason)) return;
    turns.push({
      turnId: closed.id,
      status: closed.stopReason === 'max_tokens' ? 'truncated' : 'completed',
      signal: 'native',
      startedAt: openTurn.startedAt,
      endedAt: closed.lastAt ?? openTurn.startedAt,
      promptIndex: openTurn.promptIndex,
      finalIndex: closed.lastIndex >= 0 ? closed.lastIndex : null,
      finalText: closed.texts.length ? closed.texts.join('\n') : undefined
    });
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

    if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
    if (cwd === null && entry.cwd) cwd = entry.cwd;
    if (createdAt === null && entry.timestamp) createdAt = toEpochMs(entry.timestamp);

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const isSidechain = entry.isSidechain === true;
    const content = entry.message?.content;
    const messageId = entry.type === 'assistant' ? entry.message?.id ?? null : null;
    const stopReason = entry.type === 'assistant' ? entry.message?.stop_reason ?? null : null;
    if (!isSidechain && entry.type === 'user') closeAssistantGroup();
    if (!isSidechain && entry.type === 'assistant' && group && group.id !== messageId) {
      closeAssistantGroup();
    }

    let text = '';
    let thinking = null;
    let hasNonToolResult = typeof content === 'string';
    const toolCalls = [];
    const pendingResults = [];

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type !== 'tool_result') hasNonToolResult = true;
        if (block.type === 'text') {
          text += (text ? '\n' : '') + (block.text ?? '');
        } else if (block.type === 'thinking') {
          thinking = (thinking ?? '') + (block.thinking ?? '');
        } else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id ?? null, name: block.name ?? null, input: block.input ?? null });
        } else if (block.type === 'tool_result') {
          pendingResults.push({
            callId: block.tool_use_id ?? null,
            output: textFromContent(block.content),
            isError: !!block.is_error
          });
        }
      }
    }

    const cleaned = stripBridgeContext(text);
    if (entry.type === 'user' && !firstUserText && cleaned && !isSyntheticUserText(cleaned)) {
      firstUserText = cleaned;
    }

    let index = -1;
    if (cleaned || thinking || toolCalls.length) {
      index = messages.length;
      messages.push({
        role: entry.type,
        at: toEpochMs(entry.timestamp),
        text: cleaned,
        thinking,
        toolCalls,
        toolResults: []
      });
      for (const call of toolCalls) {
        if (call.id) {
          callOwner.set(call.id, index);
          if (!isSidechain) unresolvedCalls.add(call.id);
        }
      }
    }

    for (const result of pendingResults) {
      if (result.callId) unresolvedCalls.delete(result.callId);
      const owner = result.callId ? callOwner.get(result.callId) : undefined;
      if (owner !== undefined) messages[owner].toolResults.push(result);
      else if (index >= 0) messages[index].toolResults.push(result);
    }

    if (isSidechain) continue;

    const at = toEpochMs(entry.timestamp);
    if (entry.type === 'user') {
      const isPrompt = !!cleaned && hasNonToolResult && !isSyntheticUserText(cleaned);
      // A prompt that arrives while a turn is open is a queued/intermediate message:
      // whether it starts a new turn depends on what follows it.
      if (isPrompt && index >= 0 && !openTurn) {
        openTurn = { promptIndex: index, startedAt: at };
      }
      continue;
    }

    if (messageId) {
      if (!group) {
        group = { id: messageId, stopReason: null, texts: [], lastIndex: -1, lastAt: null };
      }
      if (stopReason) group.stopReason = stopReason;
      if (cleaned) group.texts.push(cleaned);
      if (index >= 0) group.lastIndex = index;
      if (at !== null) group.lastAt = at;
    } else if (TERMINAL_STOP.has(stopReason) && openTurn) {
      turns.push({
        turnId: null,
        status: stopReason === 'max_tokens' ? 'truncated' : 'completed',
        signal: 'native',
        startedAt: openTurn.startedAt,
        endedAt: at ?? openTurn.startedAt,
        promptIndex: openTurn.promptIndex,
        finalIndex: index >= 0 ? index : null
      });
      openTurn = null;
      unresolvedCalls.clear();
    }
  }

  closeAssistantGroup();

  if (openTurn) {
    const last = messages[messages.length - 1];
    const settled = isSettled(discovery?.mtimeMs);
    if (settled && (last?.role === 'user' || unresolvedCalls.size > 0)) {
      turns.push({
        turnId: null,
        status: 'interrupted',
        signal: 'native',
        startedAt: openTurn.startedAt,
        endedAt: last?.at ?? null,
        promptIndex: openTurn.promptIndex,
        finalIndex: null
      });
    }
  }

  return {
    nativeId: sessionId ?? path.basename(sourcePath).replace(/\.jsonl$/, ''),
    title: discovery?.titleHint || deriveTitle(firstUserText),
    cwd,
    createdAt,
    messages,
    turns
  };
}

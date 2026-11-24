import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
  textFromContent, stripBridgeContext, isSyntheticUserText, deriveTitle, toEpochMs
} from '../normalize.js';
import { isSettled } from '../turns.js';

const SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g;
const USER_QUERY_RE = /<user_query\b[^>]*>([\s\S]*?)<\/user_query>/;

function isMissing(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

function isInternal(entry) {
  const pd = entry.providerData ?? {};
  return Boolean(
    pd.isMeta || pd.skipRun || pd.isCompactInternal ||
    pd.isCompacted || pd.isSummary || pd.isPartialAborted
  );
}

function cleanUserText(text) {
  if (typeof text !== 'string') return '';
  const withoutReminders = text.replace(SYSTEM_REMINDER_RE, '');
  const query = withoutReminders.match(USER_QUERY_RE);
  return stripBridgeContext(query ? query[1] : withoutReminders).trim();
}

function userText(content) {
  const text = cleanUserText(textFromContent(content));
  const images = Array.isArray(content)
    ? content.filter(block => block?.type === 'image_blob_ref')
    : [];
  if (images.length === 0) return text;
  const label = images
    .map(image => image.original_filename ? `[image: ${image.original_filename}]` : '[image]')
    .join('\n');
  return text ? `${text}\n${label}` : label;
}

function reasoningText(entry) {
  const blocks = Array.isArray(entry.rawContent) && entry.rawContent.length
    ? entry.rawContent
    : (Array.isArray(entry.content) ? entry.content : []);
  return blocks
    .map(block => typeof block === 'string' ? block : block?.text)
    .filter(text => typeof text === 'string' && text !== '')
    .join('\n');
}

function resultOutput(output) {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  if (typeof output.text === 'string') return output.text;
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

function emptyAssistant(at = null) {
  return { role: 'assistant', at, text: '', thinking: null, toolCalls: [], toolResults: [] };
}

export async function discoverWorkbuddy(config) {
  const projectsRoot = path.join(config.roots.workbuddy, 'projects');
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

      discovered.push({
        agent: 'workbuddy',
        sourcePath,
        archived: false,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        nativeId: entry.name.slice(0, -'.jsonl'.length)
      });
    }
  }

  return discovered;
}

export async function parseWorkbuddy(sourcePath, discovery) {
  const messages = [];
  const ownerByMessageId = new Map();
  const turns = [];
  let lastAssistant = -1;
  let openTurn = null;

  let nativeId = discovery?.nativeId;
  let cwd = null;
  let createdAt = null;
  let firstUserText = '';
  let aiTitle = '';

  // WorkBuddy writes no completion record. A turn is structurally terminal when its
  // last visible item is a completed assistant text and no call shares that messageId;
  // the call for a model step is appended after its text, so emission waits for the
  // file to settle before declaring the turn finished.
  function evaluateTurn(turn) {
    const text = turn.lastAssistantText;
    if (turn.lastKind === 'text' && text) {
      if (text.status === 'incomplete' && text.hasError) return 'aborted';
      if (text.status === 'completed' && !turn.callMessageIds.has(text.messageId)) {
        return 'completed';
      }
    }
    if (turn.lastKind === 'user' || turn.pendingCalls.size > 0) return 'interrupted';
    return null;
  }

  function pushTurn(turn, status, endedAt) {
    if (!turn || turn.promptIndex === null || !status) return;
    turns.push({
      turnId: turn.turnId,
      status,
      signal: 'inferred',
      startedAt: turn.startedAt,
      endedAt: endedAt ?? turn.startedAt,
      promptIndex: turn.promptIndex,
      finalIndex: status === 'completed' && turn.lastAssistantText
        ? turn.lastAssistantText.index
        : null
    });
  }

  function closeOpenTurn(endedAt) {
    if (!openTurn) return;
    pushTurn(openTurn, evaluateTurn(openTurn) ?? 'interrupted', endedAt);
    openTurn = null;
  }

  function touch(kind, at) {
    if (!openTurn) return;
    openTurn.lastKind = kind;
    if (at !== null && at !== undefined) openTurn.lastAt = at;
  }

  function ownerIndex(messageId, at = null) {
    if (messageId && ownerByMessageId.has(messageId)) {
      return ownerByMessageId.get(messageId);
    }
    if (messageId) {
      const index = messages.length;
      messages.push(emptyAssistant(at));
      ownerByMessageId.set(messageId, index);
      lastAssistant = index;
      return index;
    }
    if (lastAssistant >= 0) return lastAssistant;
    lastAssistant = messages.length;
    messages.push(emptyAssistant(at));
    return lastAssistant;
  }

  function assistantIndexFor(entry) {
    const messageId = entry.providerData?.messageId ?? null;
    const at = toEpochMs(entry.timestamp);
    if (messageId) return ownerIndex(messageId, at);
    lastAssistant = messages.length;
    messages.push(emptyAssistant(at));
    return lastAssistant;
  }

  const stream = createReadStream(sourcePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;

      if (!nativeId && typeof entry.sessionId === 'string' && entry.sessionId) {
        nativeId = entry.sessionId;
      }
      if (cwd === null && typeof entry.cwd === 'string' && entry.cwd) {
        cwd = entry.cwd;
      }
      if (createdAt === null) {
        createdAt = toEpochMs(entry.timestamp);
      }

      if (entry.type === 'ai-title') {
        if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
          aiTitle = entry.aiTitle.trim();
        }
        continue;
      }

      if (entry.type === 'message') {
        if (isInternal(entry)) continue;

        if (entry.role === 'user') {
          const plainText = cleanUserText(textFromContent(entry.content));
          const text = userText(entry.content);
          if (!text || isSyntheticUserText(text) || text.startsWith('<teammate-message')) continue;
          if (/^<(cb_summary|conversation_history_summary)\b/.test(text)) continue;
          if (!firstUserText && plainText) firstUserText = plainText;

          const at = toEpochMs(entry.timestamp);
          const startsTurn = entry.providerData?.startsNewUserRequest !== false;
          if (startsTurn) closeOpenTurn(at);
          messages.push({
            role: 'user',
            at,
            text,
            thinking: null,
            toolCalls: [],
            toolResults: []
          });
          if (startsTurn) {
            openTurn = {
              promptIndex: messages.length - 1,
              startedAt: at,
              turnId: entry.providerData?.conversationRequestId ?? entry.id ?? null,
              callMessageIds: new Set(),
              pendingCalls: new Set(),
              lastKind: 'user',
              lastAt: at,
              lastAssistantText: null
            };
          } else {
            touch('user', at);
          }
          continue;
        }

        if (entry.role === 'assistant') {
          const text = textFromContent(entry.content);
          const index = assistantIndexFor(entry);
          const owner = messages[index];
          if (text) owner.text = owner.text ? `${owner.text}\n${text}` : text;
          const at = toEpochMs(entry.timestamp);
          if (at !== null) owner.at = at;
          if (text) {
            if (openTurn) {
              openTurn.lastAssistantText = {
                index,
                messageId: entry.providerData?.messageId ?? null,
                status: typeof entry.status === 'string' ? entry.status : null,
                hasError: Boolean(entry.providerData?.error)
              };
            }
            touch('text', at);
          }
        }
        continue;
      }

      if (entry.type === 'reasoning') {
        if (isInternal(entry)) continue;
        const text = reasoningText(entry);
        if (!text) continue;
        const owner = messages[ownerIndex(
          entry.providerData?.messageId ?? null, toEpochMs(entry.timestamp)
        )];
        owner.thinking = owner.thinking ? `${owner.thinking}\n${text}` : text;
        continue;
      }

      if (entry.type === 'function_call') {
        if (isInternal(entry)) continue;
        let input = entry.arguments ?? null;
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch {}
        }
        const messageId = entry.providerData?.messageId ?? null;
        const at = toEpochMs(entry.timestamp);
        const owner = messages[ownerIndex(messageId, at)];
        const callId = entry.callId ?? entry.id ?? null;
        owner.toolCalls.push({
          id: callId,
          name: entry.name ?? null,
          input
        });
        if (openTurn) {
          if (messageId) openTurn.callMessageIds.add(messageId);
          if (callId) openTurn.pendingCalls.add(callId);
        }
        touch('call', at);
        continue;
      }

      if (entry.type === 'function_call_result') {
        if (isInternal(entry)) continue;
        const messageId = entry.providerData?.messageId ?? null;
        const at = toEpochMs(entry.timestamp);
        const owner = messages[ownerIndex(messageId, at)];
        const callId = entry.callId ?? null;
        owner.toolResults.push({
          callId,
          output: resultOutput(entry.output),
          isError: entry.status !== 'completed'
        });
        if (openTurn && callId) openTurn.pendingCalls.delete(callId);
        touch('result', at);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (openTurn) {
    const status = evaluateTurn(openTurn);
    if (status && isSettled(discovery?.mtimeMs)) {
      pushTurn(openTurn, status, openTurn.lastAt);
      openTurn = null;
    }
  }

  // Drop empty grouping shells, then remap turn indices onto the returned messages.
  const visible = [];
  const visibleIndex = new Map();
  messages.forEach((message, index) => {
    if (
      message.text || message.thinking ||
      message.toolCalls.length > 0 || message.toolResults.length > 0
    ) {
      visibleIndex.set(index, visible.length);
      visible.push(message);
    }
  });

  const visibleTurns = turns
    .map(turn => ({
      ...turn,
      promptIndex: visibleIndex.get(turn.promptIndex) ?? -1,
      finalIndex: turn.finalIndex === null || turn.finalIndex === undefined
        ? null
        : visibleIndex.get(turn.finalIndex) ?? null
    }))
    .filter(turn => turn.promptIndex >= 0);

  return {
    nativeId: nativeId || path.basename(sourcePath).replace(/\.jsonl$/i, ''),
    title: aiTitle || deriveTitle(firstUserText),
    cwd,
    createdAt,
    messages: visible,
    turns: visibleTurns
  };
}

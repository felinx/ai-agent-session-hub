import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  textFromContent, stripBridgeContext, isSyntheticUserText, deriveTitle, toEpochMs
} from '../normalize.js';

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

  let sessionId;
  let cwd = null;
  let createdAt = null;
  let firstUserText = '';

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

    const content = entry.message?.content;
    let text = '';
    let thinking = null;
    const toolCalls = [];
    const pendingResults = [];

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
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
        if (call.id) callOwner.set(call.id, index);
      }
    }

    for (const result of pendingResults) {
      const owner = result.callId ? callOwner.get(result.callId) : undefined;
      if (owner !== undefined) messages[owner].toolResults.push(result);
      else if (index >= 0) messages[index].toolResults.push(result);
    }
  }

  return {
    nativeId: sessionId ?? path.basename(sourcePath).replace(/\.jsonl$/, ''),
    title: discovery?.titleHint || deriveTitle(firstUserText),
    cwd,
    createdAt,
    messages
  };
}

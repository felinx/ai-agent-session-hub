import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import {
  listSessions, getSession, getSessionCwd, getFacets, countVisibleSessions, getAgentStats,
  eventsSince, getLastEventSeq, getTurn, getTurnMessages
} from './db.js';
import { serializeEvent, resolveSince } from './events.js';
import { getSettings, saveSettings, SUPPORTED_AGENTS } from './settings.js';
import { t, resolveLanguage, formatWarning, detectSystemLanguage } from '../public/i18n.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

const ASSET_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;

// The file viewer only reads regular text files (truncated past 1 MB); binary content is never returned.
async function readLocalFile(target) {
  try {
    const real = await realpath(target);
    const info = await stat(real);
    if (!info.isFile()) return null;
    const length = Math.min(info.size, MAX_FILE_BYTES);
    const handle = await open(real, 'r');
    let buffer;
    try {
      buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, 0);
    } finally {
      await handle.close();
    }
    const binary = buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0);
    return {
      path: real,
      name: path.basename(real),
      size: info.size,
      truncated: info.size > MAX_FILE_BYTES,
      binary,
      content: binary ? '' : buffer.toString('utf8')
    };
  } catch {
    return null;
  }
}

// Only serve image files inside the session cwd: the resolved real path must still sit
// inside the cwd, so `..`, absolute paths, and symlinks cannot escape it.
async function readSessionAsset(cwd, requested) {
  if (!ASSET_MIME[path.extname(requested).toLowerCase()]) return null;
  try {
    const baseReal = await realpath(cwd);
    const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(baseReal, requested);
    const targetReal = await realpath(target);
    if (targetReal !== baseReal && !targetReal.startsWith(baseReal + path.sep)) return null;
    const info = await stat(targetReal);
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null;
    const type = ASSET_MIME[path.extname(targetReal).toLowerCase()];
    if (!type) return null;
    return { data: await readFile(targetReal), type };
  } catch {
    return null;
  }
}

function isAllowedHost(hostHeader) {
  if (!hostHeader) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' ||
    hostname === '[::1]' || hostname === '::1';
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Comma-separated query parameter; an empty value means "no filter".
function parseFilterList(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const items = value.split(',').map(item => item.trim()).filter(Boolean);
  return items.length ? items : null;
}

// `scope` selects the sessions a subscription follows: all, one agent, one
// project directory, or one internal session id / session key.
function parseScope(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === 'all') {
    return { scope: null };
  }
  const value = raw.trim();
  const colon = value.indexOf(':');
  const kind = colon > 0 ? value.slice(0, colon) : '';
  const rest = colon > 0 ? value.slice(colon + 1) : '';
  if (!rest || !['agent', 'project', 'session'].includes(kind)) return { error: true };
  return { scope: { kind, value: rest } };
}

function positiveInt(value, fallback, cap) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, cap);
}

function nonNegativeInt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

const EVENT_LIMIT_MAX = 1000;
const EVENT_BYTES_DEFAULT = 8 * 1024 * 1024;
const EVENT_BYTES_MAX = 64 * 1024 * 1024;
const EVENT_WAIT_MAX_SECONDS = 25;
const SSE_PAGE_LIMIT = 500;
const SSE_QUEUE_EVENTS = 1000;
const SSE_QUEUE_BYTES = 32 * 1024 * 1024;

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('error.bodyTooLarge');
        error.statusCode = 413;
        error.i18nKey = 'error.bodyTooLarge';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        const error = new Error('error.invalidJson');
        error.statusCode = 400;
        error.i18nKey = 'error.invalidJson';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function createServer({
  db, state, publicDir, config, systemLanguage = detectSystemLanguage(),
  sseHeartbeatMs = 15_000, ssePollMs = 250, eventsWaitPollMs = 250
}) {
  const rootDir = path.resolve(publicDir);

  function visibility(includeHidden = false) {
    const settings = getSettings(db);
    return {
      settings,
      options: {
        showEmpty: includeHidden || settings.showEmptySessions,
        showTemp: includeHidden || settings.showTempSessions,
        agents: settings.enabledAgents
      }
    };
  }

  function resolveRequestLanguage() {
    const preference = getSettings(db).language;
    if (preference === 'zh' || preference === 'en') return preference;
    return resolveLanguage('auto', systemLanguage);
  }

  function sendError(res, status, lang, key, params) {
    return sendJson(res, status, { error: t(lang, key, params), code: key });
  }

  // Append a content hash to static assets referenced by the HTML pages, so editing a file
  // changes its URL and bypasses browser and favicon caches.
  const versionCache = new Map();

  async function assetVersion(ref) {
    let filePath;
    try {
      filePath = path.resolve(rootDir, decodeURIComponent(ref).replace(/^\/+/, ''));
    } catch {
      return null;
    }
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) return null;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return null;
      const cached = versionCache.get(filePath);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        return cached.version;
      }
      const data = await readFile(filePath);
      const version = createHash('sha256').update(data).digest('hex').slice(0, 10);
      versionCache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, version });
      return version;
    } catch {
      return null;
    }
  }

  async function withAssetVersions(html) {
    const refs = new Set();
    for (const match of html.matchAll(/(?:href|src)="(\/[^"?#]+)"/g)) refs.add(match[1]);
    const versions = new Map();
    await Promise.all([...refs].map(async ref => {
      const version = await assetVersion(ref);
      if (version) versions.set(ref, version);
    }));
    return html.replace(/(href|src)="(\/[^"?#]+)"/g, (match, attr, ref) => {
      const version = versions.get(ref);
      return version ? `${attr}="${ref}?v=${version}"` : match;
    });
  }

  // Server-Sent Events channel. Each connection polls the event log on the main
  // thread (no long-lived database handle) and stops as soon as the client leaves.
  function startEventStream(req, res, { since, agents, types, scope = null }) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');

    let cursor = since;
    let stopped = false;
    let unflushed = 0;
    let poller = null;

    function stop() {
      stopped = true;
      clearInterval(heartbeat);
      if (poller) clearInterval(poller);
    }

    function sendResync(seq) {
      if (res.writableEnded) return;
      res.write(`event: resync\ndata: ${JSON.stringify({ v: 1, seq, type: 'resync', resync: true })}\n\n`);
      res.end();
    }

    function sendFrame(event) {
      const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${serializeEvent(event)}\n\n`;
      if (res.write(frame)) unflushed = 0;
      else unflushed += 1;
      cursor = event.seq;
    }

    function poll() {
      if (stopped || res.writableEnded) return;
      for (;;) {
        const page = eventsSince(db, {
          since: cursor, limit: SSE_PAGE_LIMIT, maxBytes: EVENT_BYTES_DEFAULT,
          agents, types, scope
        });
        if (page.resync) {
          sendResync(page.cursor);
          stop();
          return;
        }
        for (const event of page.events) {
          sendFrame(event);
          if (unflushed >= SSE_QUEUE_EVENTS || res.writableLength > SSE_QUEUE_BYTES) {
            sendResync(cursor);
            stop();
            return;
          }
        }
        if (!page.hasMore) break;
      }
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, sseHeartbeatMs);

    poller = setInterval(poll, ssePollMs);
    res.on('drain', () => { unflushed = 0; });
    res.on('close', stop);
    res.on('error', stop);
    req.on('close', stop);
    poll();
  }

  return http.createServer(async (req, res) => {
    const lang = resolveRequestLanguage();
    try {
      if (req.method !== 'GET' && req.method !== 'PUT') {
        return sendError(res, 405, lang, 'error.methodNotAllowed');
      }

      if (!isAllowedHost(req.headers.host)) {
        return sendError(res, 403, lang, 'error.forbiddenHost');
      }

      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/api/settings') {
        if (req.method === 'PUT') {
          let patch;
          try {
            patch = await readJsonBody(req);
          } catch (error) {
            return sendError(
              res,
              error.statusCode ?? 400,
              lang,
              error.i18nKey ?? 'error.internal'
            );
          }
          let settings;
          try {
            settings = saveSettings(db, patch);
          } catch (error) {
            return sendError(
              res,
              error.statusCode ?? 500,
              lang,
              error.i18nKey ?? 'error.internal',
              error.i18nParams ?? {}
            );
          }
          return sendJson(res, 200, { settings });
        }
        const { settings } = visibility();
        return sendJson(res, 200, {
          settings,
          agents: SUPPORTED_AGENTS,
          dbPath: config?.dbPath ?? null,
          roots: config?.roots ?? {},
          systemLanguage
        });
      }

      if (req.method !== 'GET') {
        return sendError(res, 405, lang, 'error.methodNotAllowed');
      }

      if (pathname === '/api/health') {
        const { options } = visibility();
        return sendJson(res, 200, {
          ok: true,
          sessions: countVisibleSessions(db, options),
          scanning: !!state?.scanning,
          lastSyncAt: state?.lastSyncAt ?? null,
          warnings: (state?.warnings ?? []).map(warning => formatWarning(lang, warning))
        });
      }

      if (pathname === '/api/status') {
        const agents = getAgentStats(db);
        return sendJson(res, 200, {
          scanning: !!state?.scanning,
          lastSyncAt: state?.lastSyncAt ?? null,
          lastEventSeq: getLastEventSeq(db),
          agents,
          totals: {
            sessions: agents.reduce((sum, row) => sum + row.sessions, 0),
            messages: agents.reduce((sum, row) => sum + row.messages, 0)
          }
        });
      }

      if (pathname === '/api/events') {
        const params = url.searchParams;
        const head = getLastEventSeq(db);
        const since = resolveSince(params.get('since'), head);
        if (since === null) return sendError(res, 400, lang, 'error.invalidCursor');

        const limit = positiveInt(params.get('limit'), 200, EVENT_LIMIT_MAX);
        const maxBytes = positiveInt(params.get('maxBytes'), EVENT_BYTES_DEFAULT, EVENT_BYTES_MAX);
        const agents = parseFilterList(params.get('agent'));
        const types = parseFilterList(params.get('type'));
        const parsedScope = parseScope(params.get('scope'));
        if (parsedScope.error) return sendError(res, 400, lang, 'error.invalidScope');
        const scope = parsedScope.scope;
        const waitRaw = Number(params.get('wait'));
        const waitSeconds = Number.isFinite(waitRaw)
          ? Math.min(Math.max(waitRaw, 0), EVENT_WAIT_MAX_SECONDS)
          : 0;
        const deadline = Date.now() + waitSeconds * 1000;

        const read = () => eventsSince(db, { since, limit, maxBytes, agents, types, scope });
        let body = read();
        while (
          waitSeconds > 0 && body.events.length === 0 && !body.resync &&
          !res.writableEnded && Date.now() < deadline
        ) {
          await sleep(Math.min(eventsWaitPollMs, deadline - Date.now()));
          body = read();
        }
        return sendJson(res, 200, body);
      }

      if (pathname === '/api/events/stream') {
        const head = getLastEventSeq(db);
        const lastEventId = req.headers['last-event-id'];
        const since = resolveSince(
          typeof lastEventId === 'string' && lastEventId !== ''
            ? lastEventId
            : url.searchParams.get('since'),
          head
        );
        if (since === null) return sendError(res, 400, lang, 'error.invalidCursor');
        const parsedScope = parseScope(url.searchParams.get('scope'));
        if (parsedScope.error) return sendError(res, 400, lang, 'error.invalidScope');
        startEventStream(req, res, {
          since,
          agents: parseFilterList(url.searchParams.get('agent')),
          types: parseFilterList(url.searchParams.get('type')),
          scope: parsedScope.scope
        });
        return;
      }

      if (pathname === '/api/turn') {
        const key = url.searchParams.get('key');
        if (!key) return sendError(res, 400, lang, 'error.keyRequired');
        const turnSeq = nonNegativeInt(url.searchParams.get('turn'));
        if (turnSeq === null) return sendError(res, 404, lang, 'error.notFound');
        const result = getTurn(db, key, turnSeq);
        if (!result) return sendError(res, 404, lang, 'error.notFound');
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/turn/messages') {
        const key = url.searchParams.get('key');
        if (!key) return sendError(res, 400, lang, 'error.keyRequired');
        const turnSeq = nonNegativeInt(url.searchParams.get('turn'));
        if (turnSeq === null) return sendError(res, 404, lang, 'error.notFound');
        const result = getTurnMessages(db, key, turnSeq, {
          after: nonNegativeInt(url.searchParams.get('after')) ?? null,
          limit: positiveInt(url.searchParams.get('limit'), 200, 1000),
          maxBytes: positiveInt(url.searchParams.get('maxBytes'), 2 * 1024 * 1024, EVENT_BYTES_MAX)
        });
        if (!result) return sendError(res, 404, lang, 'error.notFound');
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/file') {
        const requested = url.searchParams.get('path');
        if (!requested) return sendError(res, 400, lang, 'error.pathRequired');
        let target;
        if (path.isAbsolute(requested)) {
          target = requested;
        } else {
          const sessionKey = url.searchParams.get('session');
          const cwd = sessionKey ? getSessionCwd(db, sessionKey) : null;
          if (!cwd) return sendError(res, 400, lang, 'error.sessionRequired');
          target = path.resolve(cwd, requested);
        }
        const file = await readLocalFile(target);
        if (!file) return sendError(res, 404, lang, 'error.fileNotFound');
        return sendJson(res, 200, file);
      }

      if (pathname === '/api/sessions') {
        const params = url.searchParams;
        const rawLimit = Number(params.get('limit'));
        const rawSince = Number(params.get('since'));
        const includeHidden = params.get('includeHidden') === '1';
        const { options } = visibility(includeHidden);
        const sessions = listSessions(db, {
          ...options,
          agent: params.get('agent') || undefined,
          chat: params.get('chat') || undefined,
          cwd: params.get('cwd') || undefined,
          q: params.get('q') || undefined,
          since: Number.isFinite(rawSince) && rawSince > 0 ? rawSince : undefined,
          limit: Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5000) : undefined,
          includeArchived: params.get('archived') !== '0'
        });
        return sendJson(res, 200, {
          sessions,
          facets: getFacets(db, options),
          lastEventSeq: getLastEventSeq(db)
        });
      }

      if (pathname === '/api/session/asset') {
        const key = url.searchParams.get('key');
        const requested = url.searchParams.get('path');
        if (!key || !requested) return sendError(res, 400, lang, 'error.keyRequired');
        const cwd = getSessionCwd(db, key);
        const asset = cwd ? await readSessionAsset(cwd, requested) : null;
        if (!asset) return sendError(res, 404, lang, 'error.assetNotFound');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': asset.type,
          ...(asset.type === 'image/svg+xml'
            ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
            : {})
        });
        res.end(asset.data);
        return;
      }

      if (pathname === '/api/session') {
        const key = url.searchParams.get('key');
        if (!key) return sendError(res, 400, lang, 'error.keyRequired');
        const detail = getSession(db, key);
        if (!detail) return sendError(res, 404, lang, 'error.notFound');
        return sendJson(res, 200, detail);
      }

      if (pathname === '/api/facets') {
        const { options } = visibility();
        return sendJson(res, 200, getFacets(db, options));
      }

      if (pathname.startsWith('/api/')) {
        return sendError(res, 404, lang, 'error.notFound');
      }

      let decoded;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return sendError(res, 404, lang, 'error.notFound');
      }

      const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
      const filePath = path.resolve(rootDir, relative);
      if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
        return sendError(res, 404, lang, 'error.notFound');
      }

      const ext = path.extname(filePath).toLowerCase();
      let data;
      try {
        data = await readFile(filePath);
      } catch {
        return sendError(res, 404, lang, 'error.notFound');
      }
      if (ext === '.html') data = await withAssetVersions(data.toString('utf8'));

      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[ext] ?? 'application/octet-stream'
      });
      res.end(data);
    } catch (error) {
      sendError(
        res,
        error?.statusCode ?? 500,
        lang,
        error?.i18nKey ?? 'error.internal',
        error?.i18nParams ?? {}
      );
    }
  });
}

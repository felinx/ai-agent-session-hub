import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import {
  listSessions, getSession, getSessionCwd, getFacets, countVisibleSessions
} from './db.js';
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
  db, state, publicDir, config, systemLanguage = detectSystemLanguage()
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
          facets: getFacets(db, options)
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

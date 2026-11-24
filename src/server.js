import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  listSessions, getSession, getFacets, countVisibleSessions
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

      let data;
      try {
        data = await readFile(filePath);
      } catch {
        return sendError(res, 404, lang, 'error.notFound');
      }

      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
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

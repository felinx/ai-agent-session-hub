import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listSessions, getSession, getFacets, VISIBLE_SESSION_WHERE } from './db.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
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

export function createServer({ db, state, publicDir }) {
  const rootDir = path.resolve(publicDir);
  const countSessions = db.prepare(`SELECT count(*) AS c FROM sessions WHERE ${VISIBLE_SESSION_WHERE}`);

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      if (!isAllowedHost(req.headers.host)) {
        return sendJson(res, 403, { error: 'forbidden host' });
      }

      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          sessions: countSessions.get().c,
          scanning: !!state?.scanning,
          lastSyncAt: state?.lastSyncAt ?? null,
          warnings: state?.warnings ?? []
        });
      }

      if (pathname === '/api/sessions') {
        const params = url.searchParams;
        const rawLimit = Number(params.get('limit'));
        const rawSince = Number(params.get('since'));
        const includeHidden = params.get('includeHidden') === '1';
        const sessions = listSessions(db, {
          agent: params.get('agent') || undefined,
          chat: params.get('chat') || undefined,
          cwd: params.get('cwd') || undefined,
          q: params.get('q') || undefined,
          since: Number.isFinite(rawSince) && rawSince > 0 ? rawSince : undefined,
          limit: Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5000) : undefined,
          includeArchived: params.get('archived') !== '0',
          includeHidden
        });
        return sendJson(res, 200, { sessions, facets: getFacets(db, { includeHidden }) });
      }

      if (pathname === '/api/session') {
        const key = url.searchParams.get('key');
        if (!key) return sendJson(res, 400, { error: 'key required' });
        const detail = getSession(db, key);
        if (!detail) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, detail);
      }

      if (pathname === '/api/facets') {
        return sendJson(res, 200, getFacets(db));
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' });
      }

      let decoded;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return sendJson(res, 404, { error: 'not found' });
      }

      const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
      const filePath = path.resolve(rootDir, relative);
      if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
        return sendJson(res, 404, { error: 'not found' });
      }

      let data;
      try {
        data = await readFile(filePath);
      } catch {
        return sendJson(res, 404, { error: 'not found' });
      }

      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      });
      res.end(data);
    } catch {
      sendJson(res, 500, { error: 'internal error' });
    }
  });
}

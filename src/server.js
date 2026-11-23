import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listSessions, getSession, getFacets } from './db.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

export function createServer({ db, state, publicDir }) {
  const rootDir = path.resolve(publicDir);
  const countSessions = db.prepare('SELECT count(*) AS c FROM sessions');

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
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
        const sessions = listSessions(db, {
          agent: params.get('agent') || undefined,
          chat: params.get('chat') || undefined,
          cwd: params.get('cwd') || undefined,
          q: params.get('q') || undefined,
          limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
          includeArchived: params.get('archived') !== '0'
        });
        return sendJson(res, 200, { sessions, facets: getFacets(db) });
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
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch {
      sendJson(res, 500, { error: 'internal error' });
    }
  });
}

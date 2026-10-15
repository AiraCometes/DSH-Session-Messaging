import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ensure, TowerError } from '../core/validation.js';

const UI = new URL('./viewer.html', import.meta.url);
const SCRIPT = new URL('./viewer.js', import.meta.url);

async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    ensure(length <= 1024 * 1024, 'BODY_TOO_LARGE', 'Request body exceeds 1 MiB', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function authorized(req, token) {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Read-only observer API plus a separately authenticated webhook endpoint. */
export async function startServer(tower, { token, port = 3091, host = '127.0.0.1', github } = {}) {
  ensure(typeof token === 'string' && Buffer.byteLength(token) >= 24, 'INVALID_CONFIG', 'Viewer token must be at least 24 bytes');
  ensure(['127.0.0.1', '::1'].includes(host), 'INVALID_CONFIG', 'Bind to loopback; use an authenticated reverse proxy for remote access');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/viewer.js')) {
        const script = url.pathname === '/viewer.js';
        res.writeHead(200, { 'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
        res.end(await readFile(script ? SCRIPT : UI)); return;
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/github' && github) {
        const raw = await body(req);
        json(202, github.receive(raw, {
          signature: req.headers['x-hub-signature-256'],
          deliveryId: req.headers['x-github-delivery'],
          event: req.headers['x-github-event'],
        })); return;
      }
      ensure(authorized(req, token), 'UNAUTHORIZED', 'Viewer token is required', 401);
      // Browser requests with an Origin must be same-origin; API is intentionally read-only.
      ensure(!req.headers.origin || req.headers.origin === `http://${req.headers.host}`,
        'ORIGIN_DENIED', 'Cross-origin requests are not accepted', 403);
      if (req.method === 'GET' && url.pathname === '/api/snapshot') { json(200, tower.snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        json(200, { events: tower.events(Number(url.searchParams.get('after') ?? 0), Number(url.searchParams.get('limit') ?? 100)) }); return;
      }
      json(404, { error: 'NOT_FOUND' });
    } catch (error) {
      const status = error instanceof TowerError ? error.status : 500;
      json(status, { error: error.code ?? 'INTERNAL', message: status === 500 ? 'Internal error' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    server, url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}

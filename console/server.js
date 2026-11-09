/**
 * Nexora Console service — Node HTTP adapter (Render runs a long-lived Node process).
 * Bodies are read up to 4 MB; anything larger is refused before it is read.
 */
import { createServer } from 'node:http';
import app from './src/index.js';
import { ensureSchema } from './src/db.js';

const PORT = process.env.PORT || 3000;
const MAX = 4 * 1024 * 1024;

export const server = createServer(async (req, res) => {
  try {
    const len = parseInt(req.headers['content-length'] || '0', 10) || 0;
    if (len > MAX) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"TOO_LARGE"}'); req.resume(); return; }
    const chunks = [];
    let size = 0;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      for await (const c of req) { size += c.length; if (size > MAX) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"TOO_LARGE"}'); return; } chunks.push(c); }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const request = new Request('http://' + (req.headers.host || 'localhost') + req.url, {
      method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined
    });
    const r = await app.fetch(request);
    const out = {};
    r.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(r.status, out);
    res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"SERVER"}');
  }
});

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  server.listen(PORT, () => console.log('[console] listening on ' + PORT));
  /* 2026-11-09 — the console woke, so someone is opening it: wake every software at once (free services sleep
     after 15 idle minutes), instead of each waking only when its turn comes. Nothing is read, no key is sent. */
  import('./src/software.js').then(({ SOFTWARE, urlOf }) => SOFTWARE.forEach((s) => {
    const t = Date.now();
    fetch(urlOf(s.id) + '/health', { signal: AbortSignal.timeout(90000) })
      .then((r) => console.log('[console] woke ' + s.id + ' ' + r.status + ' in ' + Math.round((Date.now() - t) / 1000) + ' s'), () => console.log('[console] ' + s.id + ' did not answer'));
  }), () => {});
  if (process.env.DATABASE_URL) ensureSchema().then(() => console.log('[console] schema ready'), (e) => console.error('[console] schema', e.message));
}

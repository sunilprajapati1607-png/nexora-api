/**
 * Nexora API — Node HTTP adapter
 * ----------------------------------------------------------------------
 * The service itself is written as a single `fetch(Request) -> Response`
 * handler, which is what Neon Functions, Cloudflare Workers, Deno and
 * Vercel all speak natively. Render runs a long-lived Node process
 * instead, so this file is the only thing that differs between the two
 * deployments: it turns an incoming node:http request into a Request,
 * and the returned Response back into a node:http reply.
 *
 * Nothing else changes. The licence rules, the trial clock, the engine
 * and the admin console are byte-identical wherever this runs, which is
 * the point — the host is a deployment detail, not an architecture.
 */
import { createServer } from 'node:http';
import app from './src/index.js';
/* 4.71.0 — the Nexora AI day count is kept in the database as well as in memory (ai.js takeCounted) */
import { setUsageStore } from './src/ai.js';
import { aiUsageStore } from './src/db.js';
setUsageStore(aiUsageStore);

const PORT = process.env.PORT || 3000;

function toRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || 'localhost';
  const url = proto + '://' + host + req.url;
  const headers = new Headers();
  /* 4.23.0 — the connection's own address. Behind Render's proxy the
     client is in x-forwarded-for; with no proxy at all this is the only
     place it exists. Set FIRST so a client cannot supply it. */
  try { const ra = req.socket && req.socket.remoteAddress; if (ra) headers.set('x-nexora-remote', String(ra)); } catch (e) { /* no socket */ }
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === 'x-nexora-remote') continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });
  return new Promise((resolve, reject) => {
    const chunks = [];
    /* 4.67.17 — a request is at most 64 MB (a sync push of 200 records, or a minute of speech and four photos, is well under it):
       a larger one is refused before it is held in memory */
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; req.pause(); reject(Object.assign(new Error('too big'), { tooBig: true })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Request(url, { method, headers, body: Buffer.concat(chunks) })));
    req.on('error', reject);
  });
}

const MAX_BODY = 64 * 1024 * 1024;

createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const response = await app.fetch(request);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    const body = Buffer.from(await response.arrayBuffer());
    res.end(body);
  } catch (e) {
    if (e && e.tooBig) {
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: 'TOO_LARGE', message: 'That is too much to send at once.' }));   /* 4.71.0 — the name every route answers with */
      try { req.destroy(); } catch (x) { /* gone */ }
      return;
    }
    /* Rule #35 again: never a bare 500. */
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'SERVER_ERROR',
      message: 'The licence service could not complete that request. Your work is safe on this computer; try again shortly.'
    }));
  }
}).listen(PORT, () => {
  console.log('Nexora API listening on ' + PORT);
});

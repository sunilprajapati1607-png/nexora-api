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
import app, { bodyLimit, needsToken, OPEN_BODY_LIMIT, logFailure, API_HEADERS, CORS } from './src/index.js';
import { readToken, tokenSecretOk, MISCONFIGURED } from './src/licence.js';
/* 4.71.0 — the Nexora AI day count is kept in the database as well as in memory (ai.js takeCounted) */
import { setUsageStore } from './src/ai.js';
import { aiUsageStore } from './src/db.js';
setUsageStore(aiUsageStore);

const PORT = process.env.PORT || 3000;

/* 4.72.0 (audit 8, 88) — HOW MUCH OF A BODY IS READ, DECIDED BEFORE ANY OF
   IT IS. Until now every request that was not a GET was read whole, up to
   64 MB, and only then did src/index.js look at where it was going — so a
   few large posts to an open route (an enquiry, a problem report,
   registering) could fill this instance's memory before any check had run.
   The route's own limit (src/index.js bodyLimit — the same figure index.js
   holds the body to) is now chosen from the address first: a body that says
   it is larger is refused 413 without a byte of it being read, and one that
   grows past it while arriving (no length given) is cut off there.
   A route that needs a token, asked without a good one, is given no more
   than OPEN_BODY_LIMIT (256 KB): it would be refused 401 anyway, and a sync
   push or a question to Nexora AI is large only for a machine that has been
   let in. The token is checked here by its signature and its date alone —
   no database. */
export function routeOf(rawUrl) {
  /* the path exactly as src/index.js reads it from the same address */
  try { return new URL('http://x' + String(rawUrl || '/')).pathname.replace(/\/+$/, '') || '/'; } catch (e) { return '/'; }
}
export function bodyCap(req) {
  const path = routeOf(req.url);
  let cap = bodyLimit(path);
  if (cap > OPEN_BODY_LIMIT && needsToken(path)) {
    const auth = String((req.headers && req.headers.authorization) || '');
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    let good = false;
    try { good = !!readToken(token); } catch (e) { good = false; }
    if (!good) cap = OPEN_BODY_LIMIT;
  }
  return cap;
}
function tooBig() { return Object.assign(new Error('too big'), { tooBig: true }); }
/* 4.72.0 review — over OPEN_BODY_LIMIT only BECAUSE the token is missing or no longer good (a phone or a computer
   back after a day away, its token a day old): the answer is the one the route itself gives such a request —
   401 NOT_ACTIVATED (licence.js authorise), or 503 when the service has no token secret (index.js) — never 413.
   The phone takes a fresh token on NOT_ACTIVATED and asks again; told TOO_LARGE it showed "That is too much to
   send at once." for a spoken question or a big push that was never too big. Before 4.72.0 such a body was
   read whole and refused 401; it is still not read. */
function notSigned() { return Object.assign(new Error('no good token'), { tooBig: true, unsigned: true }); }
function earlyAnswer(e) {
  if (e && e.unsigned) {
    if (!tokenSecretOk()) return { status: 503, body: MISCONFIGURED };
    return { status: 401, body: { error: 'NOT_ACTIVATED', message: 'This installation needs to be activated again.' } };
  }
  return { status: 413, body: { error: 'TOO_LARGE', message: 'That is too much to send at once.' } };
}

/* THE 413, SO THAT IT ARRIVES. The whole answer goes at once, with its length, so the sender can read it
   straight away. But the answer is only ENDED once the rest of the body has been read and DROPPED (never
   kept) — or LINGER_MS / LINGER_BYTES have passed, when the connection is cut. Ending it at once would make
   Node close a connection the sender is still writing to, and the reset that follows can throw the 413
   away before the sender reads it: it would see a broken connection instead of "too much to send at once".
   By the time anything is cut off, the answer has long reached it.
   4.72.0 review — the same for the 401 above; both with the headers every JSON answer carries (index.js json:
   no-store, API_HEADERS, and CORS on the application's routes so a browser can read it). */
const LINGER_MS = 5000;
const LINGER_BYTES = 4 * 1024 * 1024;
function refuseTooBig(req, res, e) {
  const a = earlyAnswer(e);
  const msg = JSON.stringify(a.body);
  const path = routeOf(req.url);
  const admin = path === '/admin' || path.indexOf('/admin/') === 0;
  res.writeHead(a.status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, API_HEADERS,
    admin ? {} : CORS, { 'content-length': Buffer.byteLength(msg), connection: 'close' }));
  res.write(msg);
  let dropped = 0, timer = null, over = false;
  const finish = () => { if (over) return; over = true; clearTimeout(timer); try { res.end(); } catch (x) { /* gone */ } };
  const cut = () => { if (over) return; over = true; clearTimeout(timer); try { req.destroy(); } catch (x) { /* gone */ } };
  timer = setTimeout(cut, LINGER_MS);
  try {
    req.removeAllListeners('data');
    req.on('data', (c) => { dropped += c.length; if (dropped > LINGER_BYTES) cut(); });
    req.once('end', finish);
    req.once('close', () => { over = true; clearTimeout(timer); });
    if (req.complete || req.readableEnded) finish();
    else req.resume();
  } catch (x) { cut(); }
}

function toRequest(req, signal) {
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
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers, signal });
  /* 4.72.0 (audit 8, 88) — the route's limit, before the first byte (bodyCap). 4.72.0 review — over the route's
     own limit: 413, as always; over it only for want of a good token: what the route answers that (notSigned) */
  const cap = bodyCap(req);
  const full = bodyLimit(routeOf(req.url));
  const over = () => (cap < full ? notSigned() : tooBig());
  const said = Number(req.headers['content-length']);
  if (said > full) return Promise.reject(tooBig());
  if (said > cap) return Promise.reject(over());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { chunks.length = 0; req.pause(); reject(over()); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new Request(url, { method, headers, body: Buffer.concat(chunks), signal })));
    req.on('error', reject);
  });
}

/** One request, start to finish. Exported for the suites (service4720-test.mjs), which serve it on a port of their own. */
export async function handle(req, res) {
  /* 4.72.0 (audit 10) — the request's signal aborts when this connection closes before it has been
     answered (the machine went away, the application closed): a long-poll (GET /v1/sync/wait) holding it
     is let go at once instead of sitting out its time (src/waiters.js) */
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const request = await toRequest(req, ac.signal);
    const response = await app.fetch(request);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    const body = Buffer.from(await response.arrayBuffer());
    res.end(body);
  } catch (e) {
    if (e && e.tooBig) {
      /* 4.71.0 — the name every route answers with. 4.72.0 — answered before the body is read (bodyCap); what
         is still arriving is dropped, briefly, and the connection then closed (refuseTooBig) — never held.
         4.72.0 review — 401 NOT_ACTIVATED instead when only the token was wanting (notSigned) */
      refuseTooBig(req, res, e);
      return;
    }
    /* 4.72.0 (audit 83) — a line in Render's log: the route and the error, never the body, a header or a
       token (src/index.js logFailure) */
    logFailure((req.method || '') + ' ' + routeOf(req.url), e);
    if (res.headersSent) { try { res.end(); } catch (x) { /* gone */ } return; }
    /* Rule #35 again: never a bare 500. */
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'SERVER_ERROR',
      message: 'The licence service could not complete that request. Your work is safe on this computer; try again shortly.'
    }));
  }
}

export const server = createServer(handle);

/* NEXORA_NO_LISTEN=1 only in the suites, which import this file and serve handle() themselves. On Render
   (and with `npm start`) it is never set, and the service starts exactly as before. */
if (process.env.NEXORA_NO_LISTEN !== '1') {
  /* 4.72.0 (audit 83) — WHAT ESCAPES EVERY HANDLER IS STILL WRITTEN DOWN.
     A promise that fails with nobody waiting on it (something fired and not
     awaited) is written to the log and the service carries on — every
     request has its own try/catch, and stopping every plant over one stray
     promise would be the larger harm. An exception that nothing caught
     leaves this process in a state nobody can vouch for: it is written to the
     log and the process ends, and Render starts a fresh one (what Node did
     anyway, now with a line saying where). */
  process.on('unhandledRejection', (e) => logFailure('unhandled promise', e));
  process.on('uncaughtException', (e) => { logFailure('uncaught exception', e); process.exit(1); });
  server.listen(PORT, () => {
    console.log('Nexora API listening on ' + PORT);
  });
}

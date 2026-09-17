/**
 * Nexora — the Supabase Edge Function entry
 * ======================================================================
 * `server.js` turns a node:http request into a Request and hands it to
 * `src/index.js`. This file does the same job for Deno, and nothing else:
 * the licence rules, the trial clock, the engine and the console are the
 * same source on both hosts. The host is a deployment detail.
 *
 * Four things differ here, and each one is a real difference, not taste:
 *
 *  1. THE ENVIRONMENT IS READ-ONLY. Supabase injects the connection
 *     string as SUPABASE_DB_URL, not DATABASE_URL. This file used to copy
 *     one to the other so that `db.js` would not have to change — and the
 *     Edge runtime REFUSES writes to process.env. The function booted in
 *     22 ms and then died on that single assignment with
 *     "NotSupported: The operation is not supported", leaving every route
 *     answering 500 with nothing in the body to say why. Node allows the
 *     write, so no test here could have caught it; edge-test.mjs now
 *     forbids it explicitly. `db.js` reads all three names instead.
 *
 *  2. THE PATH CARRIES THE FUNCTION'S NAME. A function is published at
 *     /functions/v1/<name>/…; the runtime removes /functions/v1 and
 *     hands the handler /<name>/… — measured on the runtime, not
 *     assumed. The service knows nothing of that segment and would
 *     answer 404 to every route carrying it. It is removed using
 *     SUPABASE_FUNCTION_SLUG, which the runtime sets to the function's
 *     own name, so the same bundle works under any name and no list of
 *     the service's routes has to be kept in step with it.
 *
 *  3. THE CALLER'S ADDRESS. `register.js` reads x-forwarded-for first,
 *     which Supabase's edge sets; behind that edge the socket address is
 *     0.0.0.0 and identifies nobody. x-nexora-remote is the no-proxy
 *     fallback, and — exactly as in server.js — whatever a client sent
 *     under that name is DROPPED first, so it can never supply its own.
 *
 *  4. Buffer is not a global in Deno. That is fixed where it is used
 *     (`import { Buffer } from 'node:buffer'` in licence.js, passcode.js
 *     and sync.js), not papered over here.
 */
import process from 'node:process';

/* Nothing in this file writes to process.env — see (1) above. `db.js`
   picks the connection string by reading, so a plain import is enough. */
import app from '../src/index.js';

/* The runtime's own name for this function. Both shapes are handled:
   /<slug>/… is what the handler actually receives in production, and
   /functions/v1/<slug>/… is what `supabase functions serve` gives
   locally. With no slug — which should not happen — fall back to
   removing the published prefix by shape, and leave anything else
   alone rather than guessing a segment away. */
const SLUG = (process.env.SUPABASE_FUNCTION_SLUG || '').trim();
const PREFIX = SLUG
  ? new RegExp('^(?:/functions/v1)?/' + SLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=/|$)')
  : /^\/functions\/v1\/[^/]+(?=\/|$)/;

/** `/nexora/v1/activate` -> `/v1/activate`. */
function stripFunctionPrefix(url) {
  const path = url.pathname.replace(PREFIX, '');
  if (path === url.pathname) return url;
  const stripped = new URL(url.href);
  stripped.pathname = path || '/';
  return stripped;
}

Deno.serve(async (request, info) => {
  try {
    const url = stripFunctionPrefix(new URL(request.url));

    const headers = new Headers(request.headers);
    headers.delete('x-nexora-remote');
    try {
      const ra = String((info && info.remoteAddr && info.remoteAddr.hostname) || '');
      /* Behind the edge this is 0.0.0.0 — an address that identifies
         nobody. Recording it would be worse than recording nothing,
         because it would look like an answer. */
      if (ra && ra !== '0.0.0.0' && ra !== '::' && ra !== '::1') headers.set('x-nexora-remote', ra);
    } catch (e) { /* no connection information; x-forwarded-for still applies */ }

    const init = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();

    return await app.fetch(new Request(url.href, init));
  } catch (e) {
    /* Rule #35: never a bare 500. The same words server.js uses. */
    return new Response(JSON.stringify({
      error: 'SERVER_ERROR',
      message: 'The licence service could not complete that request. Your work is safe on this computer; try again shortly.'
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});

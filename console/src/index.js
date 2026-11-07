/**
 * Nexora Console service (nexora-console-api) — 2026-11-07
 * ----------------------------------------------------------------------
 * Owner: "console service alag krvi hoy to jethi baki tamam software service aema link kri sakay" → "kri do".
 *
 * One door for the web console, the desktop console and the phone console. They send ONE key — the
 * console key, CONSOLE_ADMIN_KEY (16+ characters) — and nothing else changes for them but the address:
 *
 *  - What spans the softwares is answered here: every software's companies side by side (products),
 *    the actions on Fabric Stock / MSME ERP / Nexora Consult companies and the links between them,
 *    the payments ledger, plans and demo rules of each software, and the Activity list.
 *  - Everything that is Sales & Costing's own (its licences, companies, users, enquiries, feedback,
 *    broadcasts, phone-app releases, the console page itself …) is passed on to nexora-api as it is,
 *    with Sales & Costing's own key (WEIGHT_KEY). The console key itself never leaves this service.
 */
import { ensureSchema, q, logEvent } from './db.js';
import { softwareCall } from './software.js';
import { listProducts, remoteAction, consoleLinks, listRules, setRules, listPlans, planAction } from './products.js';
import { listPayments, paymentAction } from './payments.js';
import { REMOTE_IDS } from './software.js';
import { timingSafeEqual, createHash } from 'node:crypto';

export const KEY_MIN = 16;
const HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
export function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, HEADERS) });
}

/* ---- the console key ---- */
const consoleKey = () => String(process.env.CONSOLE_ADMIN_KEY || '');
const hash = (s) => createHash('sha256').update(String(s)).digest();
function keyGood(request) {
  const want = consoleKey();
  if (want.length < KEY_MIN) return false;
  return timingSafeEqual(hash(request.headers.get('x-admin-key') || ''), hash(want));
}
export function ipOf(request) {
  const f = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return (request.headers.get('cf-connecting-ip') || f || '-').slice(0, 64);
}
function caller(request) {
  const ua = String(request.headers.get('user-agent') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
  const said = String(request.headers.get('x-console') || '').trim().toLowerCase();
  const app = ['android', 'web', 'desktop'].includes(said) ? said : /okhttp|dalvik|android/i.test(ua) ? 'android' : /electron/i.test(ua) ? 'desktop' : 'web';
  return { app, ip: ipOf(request) };
}
/* wrong keys: 10 from one address in 15 minutes → that address waits; at most 200 written to the log a quarter-hour */
const MISSES = new Map();
const LOCK_MS = 15 * 60000, TRIES = 10;
let logged = { since: 0, n: 0 };
async function gate(request) {
  if (consoleKey().length < KEY_MIN) return json({ error: 'NOT_SET_UP', message: 'Set CONSOLE_ADMIN_KEY (16 or more characters) on nexora-console-api.' }, 503);
  const ip = ipOf(request), now = Date.now();
  const s = MISSES.get(ip);
  if (s && s.until > now) return json({ error: 'TOO_MANY', retryAfter: Math.ceil((s.until - now) / 1000), message: 'Too many wrong console keys from this address — try again in ' + Math.ceil((s.until - now) / 60000) + ' minutes.' }, 429);
  if (keyGood(request)) { if (s) MISSES.delete(ip); return null; }
  const m = s && now - s.first < LOCK_MS ? s : { first: now, n: 0, until: 0 };
  m.n++;
  if (m.n >= TRIES) m.until = now + LOCK_MS;
  MISSES.set(ip, m);
  if (now - logged.since > LOCK_MS) logged = { since: now, n: 0 };
  if (logged.n++ < 200) await logEvent('CONSOLE_KEY_WRONG', caller(request));
  return json({ error: 'BAD_KEY', message: 'Wrong console key.' }, 401);
}

/* ---- Sales & Costing's own calls, passed on as they are ---- */
const PASS_HEADERS = ['content-type', 'x-console', 'user-agent', 'accept'];
async function passOn(request, path, search, tweak) {
  const headers = {};
  PASS_HEADERS.forEach((h) => { const v = request.headers.get(h); if (v) headers[h] = v; });
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
  const r = await softwareCall('weight', request.method, path + (search || ''), body, { raw: true, headers });
  if (!r.response) return json(r.body, r.status);
  const res = r.response;
  const type = res.headers.get('content-type') || 'application/octet-stream';
  let data = new Uint8Array(await res.arrayBuffer());
  if (tweak && /text\/html/.test(type)) data = new TextEncoder().encode(tweak(new TextDecoder().decode(data)));
  const out = Object.assign({ 'content-type': type, 'cache-control': res.headers.get('cache-control') || 'no-store' }, HEADERS);
  const csp = res.headers.get('content-security-policy');
  if (csp) out['content-security-policy'] = csp;
  if (/text\/html/.test(type)) delete out['x-frame-options'];
  return new Response(request.method === 'HEAD' ? null : data, { status: res.status, headers: out });
}
/* the page says which key to type here */
const pageWords = (html) => html.split('NEXORA_ADMIN_KEY on the service').join('CONSOLE_ADMIN_KEY on nexora-console-api');

/* ---- the Activity list: Sales & Costing's own events and the console's, newest first ---- */
async function events(request, url) {
  const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit'), 10) || 200));
  if (url.searchParams.get('deviceId')) return passOn(request, url.pathname, url.search);
  const [w, mine] = await Promise.all([
    softwareCall('weight', 'GET', '/admin/api/events' + url.search, undefined, { headers: { 'x-console': request.headers.get('x-console') || '' } }),
    q(`SELECT at, event, detail FROM console.events ORDER BY id DESC LIMIT $1`, [limit]).catch(() => [])
  ]);
  const theirs = w.status === 200 && Array.isArray(w.body.events) ? w.body.events : [];
  const ours = mine.map((e) => ({ at: e.at instanceof Date ? e.at.toISOString() : e.at, event: e.event, device_id: null,
    detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail, source: 'console' }));
  const all = theirs.concat(ours).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
  return json(Object.assign({ events: all }, w.status === 200 ? {} : { warning: w.body.message || 'Sales & Costing’s events could not be read.' }));
}

async function readJson(request) {
  try { const t = await request.text(); return t ? JSON.parse(t) : {}; } catch (e) { return {}; }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;
    try {
      if (path === '/health') return json({ ok: true, service: 'nexora-console-api' });
      if (path === '/' && method === 'GET') return Response.redirect(url.origin + '/admin', 302);
      if (path === '/console/links' && method === 'GET') return json(await consoleLinks());
      if ((path === '/admin' || path === '/logo.png') && (method === 'GET' || method === 'HEAD')) return passOn(request, path, url.search, path === '/admin' ? pageWords : null);
      if (!path.startsWith('/admin/api/')) return json({ error: 'NOT_FOUND' }, 404);

      const shut = await gate(request);
      if (shut) return shut;
      const who = caller(request).app;
      const own = async (fn) => { await ensureSchema(); return fn(); };

      if (path === '/admin/api/products' && method === 'GET') return json(await own(listProducts));
      if (method === 'POST' && REMOTE_IDS.indexOf(path.slice('/admin/api/'.length)) >= 0) {
        const b = await readJson(request);
        const o = await own(() => remoteAction(path.slice('/admin/api/'.length), b, who));
        return json(o.body, o.httpStatus);
      }
      if (path === '/admin/api/software-settings' && method === 'GET') return json(await listRules());
      if (path === '/admin/api/software-settings' && method === 'POST') { const b = await readJson(request); const o = await own(() => setRules(b, who)); return json(o.body, o.httpStatus); }
      if (path === '/admin/api/plans' && method === 'GET') return json(await listPlans());
      if (path === '/admin/api/plans' && method === 'POST') { const b = await readJson(request); const o = await own(() => planAction(b, who)); return json(o.body, o.httpStatus); }
      if (path === '/admin/api/payments' && method === 'GET') return json(await own(() => listPayments(Object.fromEntries(url.searchParams.entries()))));
      if (path === '/admin/api/payments' && method === 'POST') { const b = await readJson(request); const o = await own(() => paymentAction(b, who)); return json(o.body, o.httpStatus); }
      if (path === '/admin/api/events' && method === 'GET') { await ensureSchema().catch(() => {}); return events(request, url); }
      /* Sales & Costing's own console calls */
      return passOn(request, path, url.search);
    } catch (e) {
      console.error('[console]', path, e && e.message);
      return json({ error: 'CONSOLE_FAILED', message: 'The console service could not do that: ' + String((e && e.message) || e).slice(0, 200) }, 503);
    }
  }
};

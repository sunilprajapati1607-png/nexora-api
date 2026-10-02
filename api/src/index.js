/**
 * Nexora — licence, trial and costing service
 * ======================================================================
 * One Neon Function serving three audiences:
 *
 *   the app        /v1/activate  /v1/heartbeat  /v1/bom
 *   the owner      /admin  (a page)  + /admin/api/*
 *   anyone         /health
 *
 * Every protected route re-reads the licence row. A token proves WHO is
 * asking; only the row — and the server's own clock — decides what they
 * may do. That is the difference between a trial you can move the PC's
 * date past and one you cannot.
 */
import { ensureSchema, q, dbAlive, consoleCall } from './db.js';
import { activate, authorise, touch, issueToken, reportUsage, companyUsage, describe, tokenSecretOk, MISCONFIGURED, handOverDeviceKey, forgetCompanies } from './licence.js';
import { runBom, missingRates } from './engine.js';
import { adminGate, listLicences, licenceAction, companyAction, saveSettings, recentEvents, ADMIN_HTML,
  consoleCaller, dbStatus, purgeArchivedSoon } from './admin.js';
import { login, listUsers, userAction, pull, push, describeUser, userCap, setCompanyPasscode, releaseSession, maxSeq, listDevices, deviceAction, canSeeCost, PRICE_MASTER,
  hasRight, listRecycle, restoreRecycled } from './sync.js';
import { secretState as backupSecretState, setSecret as setBackupSecret, showSecret as showBackupSecret } from './backupSecret.js';
import { waitFor, wakeCompany, wakeChat, endSessionOn, WAIT_MS } from './waiters.js';
import { calcForm, calcWeigh, calcNumbers, enquiryNumber, plantForm } from './weigh.js';
import { quoteForm, quoteSheet } from './quoteSheet.js';
import { checkBom as aiCheckBom, planRoute as aiPlanRoute, fillCalc as aiFillCalc, editBom as aiEditBom, quoteLetter as aiQuoteLetter, help as aiHelp, chat as aiChat, assist as aiAssist, speak as aiSpeak, pickLang, aiStatus, withKey as aiWithKey, checkKey as aiCheckKey,
  enquiryPaste as aiEnquiryPaste } from './ai.js';
import { companyAi, keyInfo as aiKeyInfo, setKey as aiSetKey, clearKey as aiClearKey, canKeep as aiCanKeep } from './aikey.js';
import { send as chatSend, since as chatSince, remove as chatRemove, clearBy as chatClearBy, listBroadcasts, broadcastAction } from './chat.js';
import { ensureInkSchema, getModel, listModels, train as inkTrain, estimate as inkEstimate, reset as inkReset, restore as inkRestore } from './inkstore.js';
import { register, gstAction, remoteIp } from './register.js';
import { listInquiries, inquiryAction, publicInquiry } from './inquiry.js';
import { listFeedback, feedbackShot, feedbackAction, publicFeedback, MAX_SHOT } from './feedback.js';
import { latestRelease, listReleases, releaseAction } from './appupdate.js';
import { logoResponse } from './brand.js';
import { customerCheck, sourcesOf } from './marketing.js';

/* exported for server.js, whose early answers (a body over its limit) carry the same headers */
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-admin-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
};

/* 4.72.0 (audit 42) — WHAT EVERY JSON ANSWER SAYS ABOUT ITSELF (/health
   included): it is JSON and nothing else (nosniff), it is never shown inside
   another site's frame, a browser that opens it as a page runs nothing and
   loads nothing from it, and no address is passed on from it. None of this
   changes what the application, the phone, the website or the consoles
   read: they fetch these answers, and a page's rules apply only to a page. */
export const API_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
};

function json(body, status, noCors) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    /* 4.58.1 — no-store. A figure in the console is "now" or it is wrong;
       without this a browser or a proxy is free to hand back the answer it
       got last time, and Refresh appears to do nothing.
       4.72.0 (audit 42) — and API_HEADERS: an answer is JSON and is never read as anything else. */
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, API_HEADERS, noCors ? {} : CORS)
  });
}
/* 4.72.0 (audit 9, 35) — THE CONSOLE'S ROUTES ANSWER WITHOUT CORS. The web console
   is served from this same address and the phone console is an app, so neither
   needs another site to be allowed in; with 'access-control-allow-origin: *' and
   x-admin-key allowed, any web page a visitor opened could send console calls
   from that visitor's browser — guessing the key from thousands of addresses at
   once, past the per-address lock. Without it a browser refuses to send them.
   Every other route (the application, the phone, the website) keeps CORS. */
const isAdminPath = (p) => p === '/admin' || p.indexOf('/admin/') === 0;
function adminJson(body, status) { return json(body, status, true); }

/* 4.72.0 (audit 42) — THE CONSOLE PAGE'S OWN RULES. The page holds the admin
   key, so the browser is told what it may do: run only its own scripts and
   styles (inline ones, which the page is made of — its buttons use
   onclick), talk only to this service, show only its own pictures and the
   data: screenshots of problem reports, never be put inside another site's
   frame, never send a form anywhere, and send no address on when a link is
   followed. Nothing on the page loads from anywhere else, so nothing it
   does is refused. */
export const ADMIN_PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, must-revalidate',
  'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
};

/* 4.72.0 (audit 83) — WHAT A FAILURE LEAVES IN RENDER'S LOG. Until now a
   request that failed was answered SERVER_ERROR and nothing was written
   anywhere, so the log held no trace of what broke. One line now: the
   route (method and path, never the query or the body), the error's code
   and name, its message with anything in quotes taken out (a database error
   can quote a value it was sent), and the first few places in the code.
   Never a header, a token, a key or a body. */
export function logFailure(where, e) {
  try {
    const code = String((e && (e.code || e.name)) || 'Error').slice(0, 40);
    const msg = String((e && e.message) || e || '').replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').replace(/\s+/g, ' ').slice(0, 240);
    const at = String((e && e.stack) || '').split('\n').slice(1, 5).map((s) => s.trim()).filter(Boolean).join(' | ');
    console.error('[nexora] ' + String(where || '').slice(0, 120) + ' failed: ' + code + ' — ' + msg + (at ? ' @ ' + at : ''));
  } catch (x) { /* logging never fails a request */ }
}

/* 4.72.0 (C11, audit 43) — THE PHONE CONSOLE'S QUARTER-HOURLY LOOK. It used
   to pull the whole licence listing (every company, every machine, every
   person) to find out whether anything was new. This is the same question
   in one statement of five counts: how many companies and installations
   there are, and how many enquiries, problem reports and self-registrations
   came in since `since` (an ISO time; the last 24 hours when it is missing
   or not a time; a time still to come counts from now).
   One clock: `at` is the DATABASE's now, taken in the same statement as the
   counts (the moment they were counted at, not this process's clock, which
   is another machine's), and an item counts when it came in strictly AFTER
   `since` — so the phone, sending this `at` back as its next `since`,
   never counts one item twice. `at` is cut to the millisecond downwards: an
   item in that last part-millisecond is counted again rather than missed.
   4.72.0 (audit 40) — a company the console deleted (archived for 30 days) is
   counted nowhere, and neither are its installations, exactly as the listing
   leaves them out. */
export async function adminSummary(sinceParam) {
  let since = sinceParam ? new Date(String(sinceParam)) : null;
  if (since && isNaN(since.getTime())) since = null;
  const r = (await q(
    `WITH t AS (SELECT now() AS at,
                       CASE WHEN $1::text IS NULL THEN now() - interval '24 hours'
                            ELSE LEAST($1::timestamptz, now()) END AS since)
     SELECT FLOOR(EXTRACT(EPOCH FROM t.at) * 1000)::bigint AS at_ms,
            FLOOR(EXTRACT(EPOCH FROM t.since) * 1000)::bigint AS since_ms,
            (SELECT COUNT(*)::int FROM companies WHERE deleted_at IS NULL) AS companies,
            (SELECT COUNT(*)::int FROM licences l LEFT JOIN companies c ON c.id = l.company_id WHERE c.deleted_at IS NULL) AS licences,
            (SELECT COUNT(*)::int FROM inquiries WHERE created_at > t.since) AS enquiries,
            (SELECT COUNT(*)::int FROM feedback WHERE created_at > t.since) AS feedback,
            (SELECT COUNT(*)::int FROM companies WHERE self_registered = true AND deleted_at IS NULL AND created_at > t.since) AS registrations
       FROM t`,
    [since ? since.toISOString() : null]))[0] || {};
  return {
    at: new Date(Number(r.at_ms)).toISOString(),
    companies: Number(r.companies) || 0,
    licences: Number(r.licences) || 0,
    newEnquiries: Number(r.enquiries) || 0,
    newFeedback: Number(r.feedback) || 0,
    newRegistrations: Number(r.registrations) || 0,
    since: new Date(Number(r.since_ms)).toISOString()
  };
}
/* 4.67.17 — "costs and prices (Rs)": canSeeCost (sync.js since 4.71.0, where the price master is held back by the
   same rule) */
/* 4.67.18 — a company that has put its own Google Gemini key in Settings has its Nexora AI questions asked
   with it (aikey.js keeps it locked; ai.js never shows it) */
async function runAi(a, fn) {
  const c = a && a.companyId ? await companyAi(a.companyId) : { key: '', limit: 0 };
  return aiWithKey(c.key, fn, c.limit);   /* 4.67.21 — and the company's day, set in the console */
}
/* 4.71.0 (audit) — HOW MUCH ONE REQUEST MAY CARRY. server.js stops anything
   over 64 MB before it is held; each route now has its own, far smaller,
   limit, and a body over it is answered 413 { error: 'TOO_LARGE' } instead
   of being read. The routes anyone can reach without a token — an
   enquiry, registering, activating, signing in — carry a few fields and
   get 256 KB. A problem report carries one picture of the screen, so it
   gets what feedback.js allows a picture plus room for the words. A sync
   push is up to 200 records (a calculation with its trace is ~50 KB) and
   gets 32 MB; Nexora AI a minute of speech or a few photos (ai.js caps
   those at 8 MB) and gets 12 MB; everything else 8 MB. */
/* 4.72.0 (audit 8, 88) — server.js now applies these BEFORE it reads a
   byte (it imports bodyLimit), so a body over its route's limit is never
   held in memory at all; and a route of the app that is not signed with a
   good token gets no more than OPEN_BODY_LIMIT there, whatever its own
   limit, because authorise() would refuse it anyway. The console's routes
   carry a few fields (256 KB). A path that is none of these — nothing
   takes a body there — gets 64 KB. */
const KB = 1024, MB = 1024 * 1024;
export const OPEN_BODY_LIMIT = 256 * KB;
const BODY_LIMITS = { '/enquiry': 256 * KB, '/v1/register': 256 * KB, '/v1/activate': 256 * KB, '/v1/login': 256 * KB,
  '/feedback': MAX_SHOT + 256 * KB, '/v1/sync/push': 32 * MB };
export function bodyLimit(path) {
  if (BODY_LIMITS[path]) return BODY_LIMITS[path];
  if (path.indexOf('/v1/ai/') === 0) return 12 * MB;
  if (path.indexOf('/v1/') === 0) return 8 * MB;
  if (path.indexOf('/admin/api/') === 0) return 256 * KB;
  return 64 * KB;
}
/** Does this path need a good token, so that server.js may hold an unsigned body to OPEN_BODY_LIMIT? Every /v1/
 *  route but the two that issue tokens (activate, register — already 256 KB). /feedback is open and keeps its own. */
export function needsToken(path) {
  return path.indexOf('/v1/') === 0 && path !== '/v1/activate' && path !== '/v1/register';
}
const TOO_LARGE = { error: 'TOO_LARGE', message: 'That is too much to send at once.' };
let healthLogged = 0;
function tooLarge() { return Object.assign(new Error('too large'), { tooLarge: true }); }
async function readJson(request, limit) {
  const cap = limit || 8 * MB;
  const said = parseInt(request.headers.get('content-length'), 10);
  if (said > cap) throw tooLarge();
  let buf;
  try { buf = await request.arrayBuffer(); } catch (e) { return {}; }
  if (buf.byteLength > cap) throw tooLarge();
  /* 4.67.17 — a body of null, a number or a list is read as an empty object, never a crash */
  try { const v = JSON.parse(new TextDecoder().decode(buf)); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    /* 4.72.0 (audit 9, 35) — a browser asking leave to send console calls from another site is not given it */
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: isAdminPath(path) ? {} : CORS });
    const readBody = () => readJson(request, bodyLimit(path));

    try {
      /* 4.71.0 (audit) — a body that says it is over the route's limit is refused before it is read */
      if (method === 'POST' && parseInt(request.headers.get('content-length'), 10) > bodyLimit(path)) return json(TOO_LARGE, 413, isAdminPath(path));
      /* 4.71.0 (audit) — no token secret, no tokens: every route that issues or reads one says so plainly
         (licence.js tokenSecretOk) instead of signing with an empty key */
      if (path.indexOf('/v1/') === 0 && !tokenSecretOk()) return json(MISCONFIGURED, 503);
      /* ---- open ---------------------------------------------------- */
      /* 4.45.0 — a report from Help → Nexora Contact. Open, like an
         enquiry, so a machine that has not activated can still speak;
         signed when the application has a token, which is what puts the
         row against its company. A bad or stale token is not a reason
         to lose the report — it is simply kept unsigned. */
      if (path === '/feedback' && method === 'POST') {
        await ensureSchema();
        let auth = null;
        if (request.headers.get('authorization')) {
          try { const a = await authorise(request); if (a && a.ok) auth = a; } catch (e) { auth = null; }
        }
        /* 4.71.0 (audit) — the address Cloudflare saw, not one the sender wrote (register.js remoteIp) */
        const out = await publicFeedback(await readBody(), remoteIp(request), auth);
        /* 4.72.0 — BUSY (the day's reports with no good token are used up) is 503: the desktop keeps the report and
           sends it later; a 4xx would make it let the report go */
        return json(out, out.ok ? 200 : (out.error === 'TOO_MANY' ? 429 : out.error === 'BUSY' ? 503 : 400));
      }
      if (path === '/health' || path === '/') {
        /* 4.71.0 (audit) — and whether the DATABASE answers: a cheap SELECT 1 with a two-second limit of its
           own. Until now /health said ok whenever this process was up, so a service that could reach no data
           at all still looked healthy. 503 { ok: false, db: 'down' } when it cannot. */
        let db = false;
        try {
          let t = null;
          await Promise.race([ensureSchema(), new Promise((resolve, reject) => { t = setTimeout(() => reject(new Error('slow')), 15000); })]).finally(() => clearTimeout(t));
          db = await dbAlive(2000);
        } catch (e) { db = false; }
        /* ai: whether Nexora AI is switched on and which model — never the key */
        const about = { service: 'nexora-api', version: '1.0.0', time: new Date().toISOString(), ai: Object.assign(aiStatus(), { ownKeys: aiCanKeep() }) };   /* 4.67.18 — ownKeys: a company's own Gemini key can be kept here (never a key) */
        /* 4.72.0 (audit 83) — a database that does not answer is written in the log too, at most once a minute */
        if (!db && Date.now() - healthLogged > 60000) { healthLogged = Date.now(); console.error('[nexora] /health: the database is not answering'); }
        /* 4.72.0 (audit 40, 89) — the health check is what keeps this service awake in working hours, so it is
           also what erases a company deleted more than 30 days ago (at most every six hours, never waited for) */
        if (db) purgeArchivedSoon();
        return db ? json(Object.assign({ ok: true, db: 'ok' }, about)) : json(Object.assign({ ok: false, db: 'down' }, about), 503);
      }

      /* 4.42.0 — the website's contact and demo forms. Open by necessity:
         a visitor has no key and is not going to be given one. It can only
         ever INSERT one lead, it carries a honeypot and a per-address
         throttle, and it answers 200 whatever it decides, so a robot
         learns nothing from the reply. */
      if (path === '/enquiry' && method === 'POST') {
        await ensureSchema();
        const body = await readBody();
        /* 4.73.0 — C17: the website's form 2 missing a required field is told so (400 MISSING); all else as before */
        const out = await publicInquiry(body, remoteIp(request));
        return out && out.httpStatus ? json(out.body, out.httpStatus) : json(out);
      }

      /* ---- the app ------------------------------------------------- */
      if (path === '/v1/activate' && method === 'POST') {
        await ensureSchema();
        const body = await readBody();
        /* 4.72.0 (audit 97) — and the Authorization header, read only to see whether it carries this very device's
           current token (licence.js provesDevice) */
        const out = await activate(body, { authorization: request.headers.get('authorization') });
        return json(out.body, out.httpStatus);
      }
      /* 4.23.0 — a plant registers itself. Open like activate, because it
         is how a company comes to exist; everything it creates is a demo
         until the owner licenses it in the console. */
      if (path === '/v1/register' && method === 'POST') {
        await ensureSchema();
        const body = await readBody();
        const out = await register(body, request);
        return json(out.body, out.httpStatus);
      }

      if (path === '/v1/heartbeat' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const body = await readBody();
        await touch(a.row.device_id, body.appVersion);
        /* 4.72.0 (audit 97) — A ROW WITH NO DEVICE KEY YET TAKES THE ONE SENT HERE. The token this heartbeat carries
           is proof that it is this machine, which the open /v1/activate hand-over cannot have. An app that hears
           licence.device.keyHeld === false sends { deviceKey } with its next heartbeat; a row that holds a key, or
           is withdrawn, is left exactly as it is (licence.js handOverDeviceKey). The licence answered says so. */
        let licNow = a.licence;
        if (body.deviceKey && !a.row.device_key_hash && await handOverDeviceKey(a.row, body.deviceKey)) {
          licNow = describe(a.row, a.company, a.settings, a.usage);
        }

        /* 4.3.0 — the heartbeat is where a machine reports what it has
           committed. Counts only: no calculation, material or price ever
           leaves the plant.

           The licence is then RE-DESCRIBED against the figures just
           written, so a machine that reaches its limit is told on the
           same call rather than being allowed one more transaction than
           it is entitled to. */
        /* 4.8.0 — the re-issued token keeps the signed-in person, and the
           answer carries their current role and scope so an admin's change
           reaches the seat at the next heartbeat. */
        const uid = a.user ? a.user.id : null;
        /* 4.43.0 — if this person signed in somewhere else, the machine is
           told here, in words it can show, and signs itself out. The token
           is re-issued WITHOUT them, so nothing further is done in their
           name even if the client ignores the notice. */
        const ended = a.superseded ? { sessionEnded: a.superseded } : null;
        /* 4.72.0 (audit 7) — counts are taken only from a machine with a person signed in on it. A token with
           nobody on it is only a device id re-activated, and a device id is no secret: it could raise a company's
           count until a limited licence went read-only. (licence.js also caps how far one report can raise it.)
           A machine at its sign-in screen reports again once somebody signs in — the count is a running total. */
        if (body.usage && a.user) {
          await reportUsage(a.row.device_id, body.usage);
          const fresh = await companyUsage(a.row.company_id || null);
          const lic = describe(a.row, a.company, a.settings, fresh);
          return json({ token: issueToken(a.row, uid), licence: lic, usage: fresh, user: describeUser(a.user), ...ended });
        }
        return json({ token: issueToken(a.row, uid), licence: licNow, usage: a.usage, user: describeUser(a.user), ...ended });
      }

      /* ---- 4.8.0 — people and company-wide sync ---------------------- */
      if (path === '/v1/login' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const body = await readBody();
        const out = await login(a.companyId, body, a.row.device_id);
        if (out.httpStatus !== 200) return json(out.body, out.httpStatus);
        /* 4.66.6 — the machine this person left is told now, not at its
           next heartbeat: "another one is logout after 1 min but this
           should be quick". */
        if (out.displacedDevice) {
          endSessionOn(a.companyId, out.body.user.id, out.displacedDevice,
            { name: out.body.user.name, at: new Date().toISOString(), where: a.row.device_name || 'another computer' });
        }
        /* 4.71.0 — an administrator who signs in on a computer that was waiting approves it (sync.js login) */
        const lic = out.approvedNow && a.licence ? Object.assign({}, a.licence, { device: Object.assign({}, a.licence.device, { approved: true }) }) : a.licence;
        return json({ token: issueToken(a.row, out.body.user.id), user: out.body.user, licence: lic,
          company: a.company ? { id: a.company.id, name: a.company.name } : null });
      }
      /* Nexora Mobile — the company's devices, and approving or removing a phone: the company's own
         administrator, from the desktop (Settings → Users) or the phone. */
      if (path === '/v1/devices' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user || a.user.role !== 'ADMIN') return json({ error: 'ADMIN_ONLY', message: 'Only your Nexora administrator can see the devices.' }, 403);
        return json({ devices: await listDevices(a.companyId) });
      }
      if ((path === '/v1/devices/approve' || path === '/v1/devices/remove') && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user || a.user.role !== 'ADMIN') return json({ error: 'ADMIN_ONLY', message: 'Only your Nexora administrator can approve or remove a phone or a computer.' }, 403);
        const body = await readBody();
        /* 4.71.0 — computers too: one that joined an existing company waits here as a phone does */
        const out = await deviceAction(a.companyId, a.user.name, path.endsWith('approve') ? 'approve' : 'remove', body.deviceId, a.row.device_id);
        if (out.signedOut) {
          const what = out.platform === 'mobile' ? 'phone' : 'computer';
          try { endSessionOn(a.companyId, out.signedOut.id, out.deviceId, { name: out.signedOut.name, at: new Date().toISOString(), where: 'no other ' + what + ' \u2014 the administrator removed this ' + what, signedOut: true }); } catch (e) { /* told at its next call */ }
        }
        return json(out.body, out.httpStatus);
      }
      /* 4.44.0 — the company's own conversation. Scoped by the device
         row's company like every other read here, and refused outright
         to a machine with nobody signed in: a message has to have a
         name against it or it is not a conversation. */
      if (path === '/v1/chat' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to read the company conversation.' }, 401);
        const u = new URL(request.url);
        const out = await chatSince(a.companyId, u.searchParams.get('since'), u.searchParams.get('limit'));
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/chat/send' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        /* 4.66.3 — and says nothing new in the room: the conversation can be read */
        if (!a.licence.canCalculate) return json({ error: 'LICENCE_REQUIRED', licence: a.licence, message: a.licence.message || 'This licence has ended — the conversation can be read, not written to.' }, 402);
        const out = await chatSend(a.companyId, a.user, await readBody());
        /* Nexora Mobile — the phones waiting on the company hear it at once */
        if (out.httpStatus === 200) wakeChat(a.companyId, a.row.device_id);
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/chat/delete' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const b2 = await readBody();
        const out = await chatRemove(a.companyId, a.user, b2 && b2.id);
        return json(out.body, out.httpStatus);
      }
      /* 4.49.0 — everything one person said, taken back at once. */
      if (path === '/v1/chat/clear' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const b3 = await readBody();
        const out = await chatClearBy(a.companyId, a.user, b3 && b3.userId);
        return json(out.body, out.httpStatus);
      }

      if (path === '/v1/logout' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        /* 4.43.0 — signing out here releases the person, so their next
           sign-in anywhere displaces nobody. Only if they are still bound
           to THIS machine: a person who has already moved on must not have
           their new session cleared by the old machine catching up. */
        /* 4.71.0 (audit) — the person the TOKEN names, not only one authorise() still counted as signed in
           here (somebody since switched off, say): whoever it is, a binding that is still this machine's is let
           go, so a token left on a closed computer stops acting as them. The desktop sends this at start-up
           when its last session was never ended. releaseSession touches only a binding to THIS machine. */
        const leaving = a.user ? a.user.id : a.tokenUser;
        if (leaving) {
          await releaseSession(leaving, a.row.device_id);
        }
        return json({ token: issueToken(a.row, null), licence: a.licence });
      }
      if (path === '/v1/users' && (method === 'GET' || method === 'POST')) {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to see the company\'s users.' }, 401);
        if (method === 'GET') {
          /* 4.29.0 — the allowance travels with the list, so the window can
             say '3 of 10' and grey Add before the service has to refuse. */
          const cap = await userCap(a.companyId);
          /* 4.72.0 (audit 7) — the viewer: where a colleague is signed in (a device id) goes only to an
             administrator and to the person themself (sync.js listUsers) */
          return json({ users: await listUsers(a.companyId, a.user), me: describeUser(a.user), maxUsers: cap.max, count: cap.count });
        }
        /* 4.72.0 (audit 38, 95) — and the machine asking, so a person changing their own PIN stays signed in on it
           while every other place they are signed in is ended (sync.js userAction) */
        const out = await userAction(a.companyId, a.user, await readBody(), a.row.device_id);
        return json(out.body, out.httpStatus);
      }
      /* 4.42.0 — an administrator sets a new company passcode from inside
         the plant. The role is checked in setCompanyPasscode, not here:
         one rule, one place. */
      if (path === '/v1/company/passcode' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to change the company passcode.' }, 401);
        const out = await setCompanyPasscode(a.companyId, a.user, await readBody());
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/sync/pull' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to synchronise.' }, 401);
        return json(await pull(a.companyId, a.user, url.searchParams.get('since'), url.searchParams.get('limit')));
      }
      if (path === '/v1/sync/push' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to synchronise.' }, 401);
        /* 4.66.3 — a read-only company cannot push. A demo or licence that has ended is read-only on the service
           too: saved work still comes down (pull), nothing new goes up. */
        if (!a.licence.canCalculate) return json({ error: 'LICENCE_REQUIRED', licence: a.licence, message: a.licence.message || 'This licence has ended — saved work can be opened and printed, but nothing new is saved to the company.' }, 402);
        const body = await readBody();
        const pushed = await push(a.companyId, a.user, body.records);
        /* 4.66.6 — every other machine of the company pulls now */
        if (pushed && pushed.applied && pushed.applied.length) wakeCompany(a.companyId, a.row.device_id);
        return json(pushed);
      }
      /* 4.73.0 — C15: THE RECYCLE BIN, for the company's administrator. GET: every deleted calculation, BOM,
         quotation, enquiry and customer still kept (RECYCLE_KEEP_DAYS) — kind, id, number/name, who, when, when it
         goes — never a body. POST restore {binId}: that one written back as a fresh change (sync.js). */
      if ((path === '/v1/recycle' && method === 'GET') || (path === '/v1/recycle/restore' && method === 'POST')) {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to open the recycle bin.' }, 401);
        if (a.user.role !== 'ADMIN') return json({ error: 'ADMIN_ONLY', message: 'Only your Nexora administrator can open the recycle bin.' }, 403);
        if (!a.companyId) return json({ error: 'NO_COMPANY', message: 'Only a licensed company has a recycle bin.' }, 400);
        if (method === 'GET') return json(await listRecycle(a.companyId));
        /* putting a record back is a save: a licence that has ended keeps its records as they are */
        if (!a.licence.canCalculate) return json({ error: 'LICENCE_REQUIRED', licence: a.licence, message: a.licence.message || 'This licence has ended — nothing can be put back until it is renewed.' }, 402);
        const body = await readBody();
        const out = await restoreRecycled(a.companyId, a.user, body.binId);
        return json(out.body, out.httpStatus);
      }
      /* 4.73.0 — C19: THE BACKUP PASSWORD (backupSecret.js). state: anybody signed in; set and show: the
         administrator, show (and replacing one) after their PIN, checked and locked exactly as a sign-in. */
      if ((path === '/v1/backup/secret/state' && method === 'GET') ||
          ((path === '/v1/backup/secret/set' || path === '/v1/backup/secret/show') && method === 'POST')) {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in first.' }, 401);
        if (!a.companyId) return json({ error: 'NO_COMPANY', message: 'Only a licensed company keeps a backup password.' }, 400);
        if (method === 'GET') { const st = await backupSecretState(a.companyId); return json(st.body, st.httpStatus); }
        const body = await readBody();
        const out = path.endsWith('/set') ? await setBackupSecret(a.companyId, a.user, body) : await showBackupSecret(a.companyId, a.user, body);
        return json(out.body, out.httpStatus);
      }
      /* 4.68.0 — Marketing: is this customer already with somebody? Names only who, and on what it matched. */
      /* 4.68.2 — Nexora Mobile: the next enquiry number (the computers find it from their own stubs) */
      if (path === '/v1/marketing/number' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to make an enquiry.' }, 401);
        const out = await enquiryNumber(a.companyId);
        out.body.sources = await sourcesOf(a.companyId);   /* and the sources a new enquiry may be booked under */
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/marketing/customer-check' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to check a customer.' }, 401);
        return json(await customerCheck(a.companyId, a.user, await readBody()));
      }
      /* Nexora Mobile — a calculation made on the phone: the form (constructions and fields, the
         company's own), and the bag weighed by the desktop's own engine on the service (weigh.js).
         Saving is the ordinary /v1/sync/push, exactly as a computer saves. */
      if (path === '/v1/calc/form' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to make a calculation.' }, 401);
        const out = await calcForm(a.companyId);
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/calc/weigh' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to make a calculation.' }, 401);
        if (!a.licence.canCalculate) return json({ error: 'LICENCE_REQUIRED', licence: a.licence, message: a.licence.message || 'This licence has ended — saved work can be opened, but new calculations need a licence.' }, 402);
        const body = await readBody();
        /* C8 — weight in, GSM out: "solveGsm": true travels in the calculation, or beside it (lifted in);
           without it the calculation goes through exactly as before */
        const calc = body.solveGsm === true && body.calc && typeof body.calc === 'object' ? Object.assign({}, body.calc, { solveGsm: true }) : body.calc;
        const out = await calcWeigh(a.companyId, calc);
        return json(out.body, out.httpStatus);
      }
      /* 4.67.14 — the next number in the company's own series, for a calculation saved on the phone */
      /* 4.67.16 — a quotation made on the phone: what its form offers, and its number, totals and page */
      if (path === '/v1/quote/form' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to make a quotation.' }, 401);
        const out = await quoteForm(a.companyId);
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/quote/sheet' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to make a quotation.' }, 401);
        if (!a.licence.canCalculate) return json({ error: 'LICENCE_REQUIRED', licence: a.licence, message: a.licence.message || 'This licence has ended — saved quotations can be opened, but new ones need a licence.' }, 402);
        const body = await readBody();
        const out = await quoteSheet(a.companyId, a.user, body.quote);
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/calc/numbers' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to make a calculation.' }, 401);
        const out = await calcNumbers(a.companyId);
        return json(out.body, out.httpStatus);
      }
      /* 4.67.18 — the company's own Google Gemini key ("if someone whant to use its own gemini api key then
         add this option in setting"). GET: whether there is one, its last four characters and when it was set
         — never the key. POST {action:'set', key}: checked with Google first, then kept locked. POST {action:'remove'}:
         back to Nexora's key (POST, as every other call: the service's CORS lets GET and POST through).
         Setting and removing it is for an administrator. */
      if (path === '/v1/ai/key' && (method === 'GET' || method === 'POST')) {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in first.' }, 401);
        if (!a.companyId) return json({ error: 'NO_COMPANY', message: 'Only a licensed company can use its own Gemini key.' }, 400);
        const admin = a.user.role === 'ADMIN';
        if (method === 'GET') return json(Object.assign({ ok: true, admin: admin }, await aiKeyInfo(a.companyId)));
        if (!admin) return json({ error: 'ADMIN_ONLY', message: 'Only an administrator can change the Gemini key.' }, 403);
        const body = await readBody();
        if (body.action === 'remove') { await aiClearKey(a.companyId); return json(Object.assign({ ok: true, admin: true }, await aiKeyInfo(a.companyId))); }
        if (body.action !== 'set') return json({ error: 'BAD_ACTION', message: 'Say set or remove.' }, 400);
        if (!aiCanKeep()) return json({ error: 'AI_KEY_UNAVAILABLE', message: 'The Nexora service cannot keep a key just now — ask Nexora.' }, 503);
        const chk = await aiCheckKey(body.key);
        if (!chk.ok) return json({ error: 'AI_KEY_BAD', message: chk.message }, chk.why === 'unreachable' || chk.why === 'http' ? 502 : 400);
        await aiSetKey(a.companyId, String(body.key).trim());
        return json(Object.assign({ ok: true, admin: true }, await aiKeyInfo(a.companyId)));
      }
      /* Nexora AI, phase 1 — the shape of a BOM checked in plain words.
         Signed-in people only; ai.js keeps only the technical fields and
         counts each company's checks. */
      if (path === '/v1/ai/check-bom' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        const out = await runAi(a, () => aiCheckBom(a.companyId || a.row.device_id, body.bom, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* Nexora AI — a BOM changed by what is said, the quotation letter, and the helper */
      if (path === '/v1/ai/edit-bom' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        const out = await runAi(a, () => aiEditBom(a.companyId || a.row.device_id, body.edit, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/ai/quote-letter' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        const out = await runAi(a, () => aiQuoteLetter(a.companyId || a.row.device_id, body.quote, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/ai/chat' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        /* 4.72.0 — C14: whether this person may see costs, and the company's current price list — read (sync.js) only
           for a phone question about rates, prices or costs from a person who may.
           4.74.0 — C21: "caps": ["query"] beside "chat" (or inside it) — the phone runs queries (ai.js capsOf) */
        const out = await runAi(a, () => aiChat(a.companyId || a.row.device_id, body.chat, pickLang(body.lang), undefined,
          { canCost: canSeeCost(a.user), loadRates: async () => (a.companyId ? (await import('./sync.js')).currentPriceList(a.companyId) : []), caps: body.caps }));
        return json(out.body, out.httpStatus);
      }
      /* 4.67.3 — one Nexora AI on every window: an answer, and the steps to run */
      if (path === '/v1/ai/assist' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        /* 4.74.0 — C21: "caps": ["query"] beside "assist" (or inside it) — the computer runs queries (ai.js capsOf) */
        const out = await runAi(a, () => aiAssist(a.companyId || a.row.device_id, body.assist, pickLang(body.lang), undefined, { canCost: canSeeCost(a.user), caps: body.caps }));
        return json(out.body, out.httpStatus);
      }
      /* 4.67.8 — an answer read aloud (Gujarati, when this computer has no Gujarati voice) */
      if (path === '/v1/ai/speak' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        const out = await runAi(a, () => aiSpeak(a.companyId || a.row.device_id, body.speak, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/ai/help' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        const out = await runAi(a, () => aiHelp(a.companyId || a.row.device_id, body.help, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* Nexora AI, phase 3 — the bag's specification, spoken or typed */
      if (path === '/v1/ai/fill-calc' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        const out = await runAi(a, () => aiFillCalc(a.companyId || a.row.device_id, body.fill, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* 4.73.0 — C16 (audit 55): AN ENQUIRY PASTED FROM WHATSAPP OR AN E-MAIL, read into the enquiry and its bag
         sizes (ai.js enquiryPaste). For a person who may make enquiries (MKT_SAVE, read as the applications read
         it; an administrator always); one Nexora AI question of the company's day. The plant's constructions,
         fields and units (as the phone's form has them) and its enquiry sources are read here, on the service;
         private names arrive as [C1]-style codes (C9) and go back as they came. Nothing is saved here. */
      if (path === '/v1/ai/enquiry-paste' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        if (!hasRight(a.user, 'MKT_SAVE')) {
          return json({ error: 'NO_RIGHT', right: 'MKT_SAVE', message: 'You may not make enquiries — your administrator gives that right (Settings → Users & access).' }, 403);
        }
        const body = await readBody();
        const out = await runAi(a, () => aiEnquiryPaste(a.companyId || a.row.device_id, body, pickLang(body.lang), undefined,
          { loadPlant: async () => {
            const form = a.companyId ? await plantForm(a.companyId) : null;
            return { constructions: form ? form.constructions : [], fields: form ? form.fields : [], units: form ? form.units : null,
              sources: a.companyId ? await sourcesOf(a.companyId) : [] };
          } }));
        return json(out.body, out.httpStatus);
      }
      /* Nexora AI, phase 2 — a route or a saved workflow proposed from plain words */
      if (path === '/v1/ai/plan-route' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readBody();
        const out = await runAi(a, () => aiPlanRoute(a.companyId || a.row.device_id, body.plan, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* 4.66.6 — "within 5 second ma sync thai javu joiye". A signed-in
         machine keeps this one request open; it is answered the moment
         another machine pushes, or this person signs in elsewhere, or
         after WAIT_MS with nothing to say. Nothing waits on the database. */
      if (path === '/v1/sync/wait' && method === 'GET') {
        await ensureSchema();
        /* 4.72.0 (audit 10) — the light form: the company row may be ten seconds old and the licence's usage is not
           counted (a wait answers neither); the device row and the person are read afresh as always */
        const a = await authorise(request, { light: true });
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) {
          if (a.superseded) return json({ sessionEnded: a.superseded });
          return json({ error: 'SIGN_IN', message: 'Sign in to synchronise.' }, 401);
        }
        const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
        /* Nexora Mobile: a phone also says the last chat message it holds, and is answered at once when there
           is a newer one — so nothing said between two waits is missed */
        const chatParam = url.searchParams.get('chat');
        const wantsChat = chatParam !== null && chatParam !== '';
        if (wantsChat) {
          /* 4.72.0 (audit 10) — the newest change and the newest message in ONE statement (they were two) */
          const t = (await q(`SELECT (SELECT COALESCE(MAX(seq), 0) FROM sync_records WHERE company_id = $1) AS s,
                                     (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE company_id = $1) AS m`, [a.companyId]))[0] || {};
          const top = Number(t.s) || 0;
          if (top > since) return json({ changed: true, seq: top });
          if (Number(t.m) > (parseInt(chatParam, 10) || 0)) return json({ changed: true, chat: true });
        } else {
          const top = await maxSeq(a.companyId);
          if (top > since) return json({ changed: true, seq: top });
        }
        const ms = parseInt(url.searchParams.get('ms'), 10) || WAIT_MS;
        /* 4.72.0 (audit 10) — let go the moment this machine's connection closes (server.js aborts the signal),
           and at most a few open at once per machine, person and company (waiters.js) */
        const heard = await waitFor(a.companyId, a.user.id, a.row.device_id, ms, { chat: wantsChat, signal: request.signal });
        if (heard.ended) return json({ sessionEnded: heard.ended });
        return json({ changed: !!heard.changed, chat: !!heard.chat });
      }

      /* ---- 4.16.0 BETA — the ink assumption -------------------------
         The artwork is measured on the computer and never leaves it; what
         arrives here is coverage. The engine — substrates, physics, the
         fitting — lives on this service and is not shipped in the EXE.
         Gated by the licence exactly as costing is. */
      if (path.indexOf('/v1/ink') === 0) {
        await ensureSchema();
        await ensureInkSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.licence.canCalculate) {
          return json({ error: 'LICENCE_REQUIRED', licence: a.licence, message: a.licence.message }, 402);
        }
        const companyId = a.companyId || null;
        const userId = a.user ? a.user.id : null;

        if (path === '/v1/ink/model' && method === 'GET') {
          const sub = url.searchParams.get('substrate');
          if (sub) return json(await getModel(companyId, sub));
          return json({ models: await listModels(companyId) });
        }
        if (path === '/v1/ink/predict' && method === 'POST') {
          const out = await inkEstimate(companyId, await readBody());
          return json(out.body, out.httpStatus);
        }
        /* 4.72.0 (audit 7, 100) — the company's model is changed only by a person: training needs somebody signed
           in (401 SIGN_IN, before the samples are even read), and resetting or restoring it needs an administrator
           (403 ADMIN_ONLY, inkstore.js). Every train, reset and restore keeps the model it replaces, so the last
           change can be undone (/v1/ink/restore). */
        if (path === '/v1/ink/train' && method === 'POST') {
          if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to train the company’s ink model.' }, 401);
          const out = await inkTrain(companyId, userId, await readBody());
          return json(out.body, out.httpStatus);
        }
        if (path === '/v1/ink/reset' && method === 'POST') {
          if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in as your Nexora administrator to reset the company’s ink model.' }, 401);
          const body = await readBody();
          const out = await inkReset(companyId, body.substrate, a.user || null);
          return json(out.body, out.httpStatus);
        }
        if (path === '/v1/ink/restore' && method === 'POST') {
          if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in as your Nexora administrator to restore the company’s ink model.' }, 401);
          const body = await readBody();
          const out = await inkRestore(companyId, body.substrate, a.user || null);
          return json(out.body, out.httpStatus);
        }
        return json({ error: 'NOT_FOUND', message: 'No such ink route.' }, 404);
      }

      if (path === '/v1/bom' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);

        /* THE GATE. 402 Payment Required is the honest status here, and
           the client shows the licence message rather than an error. */
        if (!a.licence.canCalculate) {
          return json({ error: 'LICENCE_REQUIRED', licence: a.licence, message: a.licence.message }, 402);
        }

        const payload = await readBody();
        /* 4.71.0 (audit, C2) — a person who may not see costs has no prices on their computer, so their rates
           arrive empty: each one missing is taken from the company's own price master, by the desktop's own
           rule (engine.js currentRateFrom). Read only when something is missing.
           ONLY FOR A PERSON SIGNED IN HERE (a.user: active, and this machine holds their place). A token
           with nobody on it is just a device id re-activated — and a device id is not a secret — so filling
           for it handed the whole price list to anyone who had one. Nobody signed in: the payload's own
           rates or none, as before 4.71.0. And a person who may not see costs gets the cost, not the rates
           it was costed with (engine.js hideFilledRates). */
        let book = null;
        if (a.companyId && a.user && missingRates(payload).length) {
          const pr = (await q(`SELECT body FROM sync_records WHERE company_id = $1 AND kind = 'master' AND id = $2 AND deleted = false`, [a.companyId, PRICE_MASTER]))[0];
          book = pr && pr.body && typeof pr.body === 'object' ? pr.body : null;
        }
        let out;
        try {
          out = runBom(payload, book, { hideFilled: !!book && !canSeeCost(a.user) });
        } catch (e) {
          return json({ error: 'ENGINE_ERROR',
            message: 'The route could not be costed. ' + (e && e.message ? e.message : '') }, 400);
        }
        return json({ licence: a.licence, ...out });
      }

      /* 4.44.0 — the mark, so the console carries its own logo rather than
         borrowing one from a website that may not be reachable. */
      if (path === '/logo.png' && (method === 'GET' || method === 'HEAD')) {
        return logoResponse();
      }

      /* ---- the owner ----------------------------------------------- */
      if (path === '/admin') {
        /* 4.44.0 — ALWAYS THE PAGE THAT WAS JUST DEPLOYED.

           The console is one HTML string that changes with every release,
           and a browser told nothing will happily keep the copy it got a
           week ago — so a card added on Tuesday is simply missing on
           Wednesday and nobody can see why. no-store settles it: the page
           is re-fetched every time, which for a page one person opens a
           few times a day costs nothing worth counting. */
        /* 4.72.0 (audit 42) — with the page's own rules (ADMIN_PAGE_HEADERS) */
        return new Response(ADMIN_HTML, { status: 200, headers: Object.assign({}, ADMIN_PAGE_HEADERS) });
      }
      if (path.startsWith('/admin/api/')) {
        await ensureSchema();
        /* 4.71.0 (audit) — compared in constant time, and five wrong keys from one address shut it out for
           fifteen minutes (admin.js adminGate); 4.72.0 — fifty from every address together shut it for all */
        const ip = remoteIp(request);
        const gate = await adminGate(request, ip);
        if (!gate.ok) return adminJson(gate.body, gate.httpStatus);
        /* 4.72.0 (audit 40) — a company deleted more than 30 days ago is erased (at most every six hours) */
        purgeArchivedSoon();
        /* 4.72.0 (audit 39) — everything below runs knowing which console called, from where (db.js consoleCall):
           every event it logs carries detail.via = { ip, app, ua } */
        return await consoleCall.run(consoleCaller(request, ip), async () => {
          /* 4.72.0 (audit 10) — anything the console changes may change a company: the copies kept for the waits
             (licence.js companyOf) are dropped, so no wait goes on with the old one */
          if (method === 'POST') forgetCompanies();
          /* 4.72.0 (C11) — the phone console's quarter-hourly look: a few counts, not the whole listing */
          if (path === '/admin/api/summary' && method === 'GET') return adminJson(await adminSummary(url.searchParams.get('since')));

          if (path === '/admin/api/licences' && method === 'GET') return adminJson(await listLicences());
          if (path === '/admin/api/licence' && method === 'POST') return adminJson(await licenceAction(await readBody()));
          if (path === '/admin/api/gst' && method === 'POST') { const out = await gstAction(await readBody()); return adminJson(out.body, out.httpStatus); }
          if (path === '/admin/api/company' && method === 'POST') return adminJson(await companyAction(await readBody()));
          if (path === '/admin/api/settings' && method === 'POST') return adminJson(await saveSettings(await readBody()));
          /* 4.72.0 (audit 39) — ?admin=1: only what was done from the console (the Activity list); ?limit= up to 500 */
          if (path === '/admin/api/events' && method === 'GET') {
            const adminOnly = /^(1|true|yes)$/i.test(url.searchParams.get('admin') || '');
            return adminJson({ events: await recentEvents(url.searchParams.get('deviceId'), { admin: adminOnly, limit: url.searchParams.get('limit') }) });
          }
          /* 4.72.0 (audit 87) — how full the database is (asked for by Service settings only) */
          if (path === '/admin/api/db' && method === 'GET') return adminJson(await dbStatus());
          /* 4.42.0 — enquiries: the leads, before they are customers. */
          if (path === '/admin/api/inquiries' && method === 'GET') return adminJson(await listInquiries());
          if (path === '/admin/api/inquiry' && method === 'POST') return adminJson(await inquiryAction(await readBody()));
          /* 4.45.0 — feedback and problem reports from the application. */
          if (path === '/admin/api/feedback' && method === 'GET') return adminJson(await listFeedback());
          if (path === '/admin/api/feedback/shot' && method === 'GET') return adminJson(await feedbackShot(url.searchParams.get('id')));
          if (path === '/admin/api/feedback' && method === 'POST') return adminJson(await feedbackAction(await readBody()));
          /* 4.47.1 — Nexora speaks in every plant's room. */
          if (path === '/admin/api/broadcast' && method === 'GET') return adminJson(await listBroadcasts());
          if (path === '/admin/api/broadcast' && method === 'POST') return adminJson(await broadcastAction(await readBody()));
          /* 4.44.0 — the phone console's own releases. */
          if (path === '/admin/api/app' && method === 'GET') return adminJson(await listReleases());
          if (path === '/admin/api/app' && method === 'POST') return adminJson(await releaseAction(await readBody()));
          /* What a phone asks on every check. Behind the admin key like
             everything else here: only the owner runs this application, and
             an unlisted build is not an advertisement. */
          if (path === '/admin/api/app/latest' && method === 'GET') return adminJson(await latestRelease());
          return adminJson({ error: 'NOT_FOUND' }, 404);
        });
      }

      return json({ error: 'NOT_FOUND', path }, 404);
    } catch (e) {
      /* 4.72.0 (audit 9, 35) — a console route's failure is answered without CORS too */
      const answer = isAdminPath(path) ? adminJson : json;
      if (e && e.tooLarge) return answer(TOO_LARGE, 413);
      if (e && e.misconfigured) return answer(MISCONFIGURED, 503);
      /* 4.72.0 (audit 83) — and a line in the log: the route and the error, never the body */
      logFailure(method + ' ' + path, e);
      /* Rule #35: an error a person can read, and never a bare 500.
         4.72.0 review (audit 83) — the error's own words (`detail`: a database message names tables, columns and
         the values it choked on; a connection failure, the database's host or user) go to the owner's console
         only. Every other route answers with the readable message alone — the line above has the rest in
         Render's log. No application reads `detail`. */
      return answer(Object.assign({
        error: 'SERVER_ERROR',
        message: 'The licence service could not complete that request. Your work is safe on this computer; try again shortly.'
      }, isAdminPath(path) && e && e.message ? { detail: String(e.message).slice(0, 300) } : {}), 500);
    }
  }
};

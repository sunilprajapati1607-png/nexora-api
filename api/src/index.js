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
import { ensureSchema, q } from './db.js';
import { activate, authorise, touch, issueToken, reportUsage, companyUsage, describe } from './licence.js';
import { runBom } from './engine.js';
import { adminAuthorised, listLicences, licenceAction, companyAction, saveSettings, recentEvents, ADMIN_HTML } from './admin.js';
import { login, listUsers, userAction, pull, push, describeUser, userCap, setCompanyPasscode, releaseSession, maxSeq, listDevices, deviceAction } from './sync.js';
import { waitFor, wakeCompany, wakeChat, endSessionOn, WAIT_MS } from './waiters.js';
import { calcForm, calcWeigh, calcNumbers } from './weigh.js';
import { quoteForm, quoteSheet } from './quoteSheet.js';
import { checkBom as aiCheckBom, planRoute as aiPlanRoute, fillCalc as aiFillCalc, editBom as aiEditBom, quoteLetter as aiQuoteLetter, help as aiHelp, chat as aiChat, assist as aiAssist, speak as aiSpeak, pickLang, aiStatus, withKey as aiWithKey, checkKey as aiCheckKey } from './ai.js';
import { companyAi, keyInfo as aiKeyInfo, setKey as aiSetKey, clearKey as aiClearKey, canKeep as aiCanKeep } from './aikey.js';
import { send as chatSend, since as chatSince, remove as chatRemove, clearBy as chatClearBy, listBroadcasts, broadcastAction } from './chat.js';
import { ensureInkSchema, getModel, listModels, train as inkTrain, estimate as inkEstimate, reset as inkReset } from './inkstore.js';
import { register, gstAction, remoteIp } from './register.js';
import { listInquiries, inquiryAction, publicInquiry } from './inquiry.js';
import { listFeedback, feedbackShot, feedbackAction, publicFeedback } from './feedback.js';
import { latestRelease, listReleases, releaseAction } from './appupdate.js';
import { logoResponse } from './brand.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-admin-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    /* 4.58.1 — no-store. A figure in the console is "now" or it is wrong;
       without this a browser or a proxy is free to hand back the answer it
       got last time, and Refresh appears to do nothing. */
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS)
  });
}
/* 4.67.17 — "costs and prices (Rs)": the administrator, and whoever the administrator gave VIEW_COST (the same rule as the application) */
function canSeeCost(u) {
  if (!u) return false;
  if (u.role === 'ADMIN') return true;
  let p = u.permissions;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
  return !!(p && typeof p === 'object' && p.VIEW_COST === true);
}
/* 4.67.18 — a company that has put its own Google Gemini key in Settings has its Nexora AI questions asked
   with it (aikey.js keeps it locked; ai.js never shows it) */
async function runAi(a, fn) {
  const c = a && a.companyId ? await companyAi(a.companyId) : { key: '', limit: 0 };
  return aiWithKey(c.key, fn, c.limit);   /* 4.67.21 — and the company's day, set in the console */
}
async function readJson(request) {
  /* 4.67.17 — a body of null, a number or a list is read as an empty object, never a crash */
  try { const v = await request.json(); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
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
        const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || null;
        const out = await publicFeedback(await readJson(request), ip ? String(ip).split(',')[0].trim() : null, auth);
        return json(out, out.ok ? 200 : (out.error === 'TOO_MANY' ? 429 : 400));
      }
      if (path === '/health' || path === '/') {
        await ensureSchema();
        /* ai: whether Nexora AI is switched on and which model — never the key */
        return json({ ok: true, service: 'nexora-api', version: '1.0.0', time: new Date().toISOString(), ai: Object.assign(aiStatus(), { ownKeys: aiCanKeep() }) });   /* 4.67.18 — ownKeys: a company's own Gemini key can be kept here (never a key) */
      }

      /* 4.42.0 — the website's contact and demo forms. Open by necessity:
         a visitor has no key and is not going to be given one. It can only
         ever INSERT one lead, it carries a honeypot and a per-address
         throttle, and it answers 200 whatever it decides, so a robot
         learns nothing from the reply. */
      if (path === '/enquiry' && method === 'POST') {
        await ensureSchema();
        const body = await readJson(request);
        return json(await publicInquiry(body, remoteIp(request)));
      }

      /* ---- the app ------------------------------------------------- */
      if (path === '/v1/activate' && method === 'POST') {
        await ensureSchema();
        const body = await readJson(request);
        const out = await activate(body);
        return json(out.body, out.httpStatus);
      }
      /* 4.23.0 — a plant registers itself. Open like activate, because it
         is how a company comes to exist; everything it creates is a demo
         until the owner licenses it in the console. */
      if (path === '/v1/register' && method === 'POST') {
        await ensureSchema();
        const body = await readJson(request);
        const out = await register(body, request);
        return json(out.body, out.httpStatus);
      }

      if (path === '/v1/heartbeat' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const body = await readJson(request);
        await touch(a.row.device_id, body.appVersion);

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
        if (body.usage) {
          await reportUsage(a.row.device_id, body.usage);
          const fresh = await companyUsage(a.row.company_id || null);
          const lic = describe(a.row, a.company, a.settings, fresh);
          return json({ token: issueToken(a.row, uid), licence: lic, usage: fresh, user: describeUser(a.user), ...ended });
        }
        return json({ token: issueToken(a.row, uid), licence: a.licence, usage: a.usage, user: describeUser(a.user), ...ended });
      }

      /* ---- 4.8.0 — people and company-wide sync ---------------------- */
      if (path === '/v1/login' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const body = await readJson(request);
        const out = await login(a.companyId, body, a.row.device_id);
        if (out.httpStatus !== 200) return json(out.body, out.httpStatus);
        /* 4.66.6 — the machine this person left is told now, not at its
           next heartbeat: "another one is logout after 1 min but this
           should be quick". */
        if (out.displacedDevice) {
          endSessionOn(a.companyId, out.body.user.id, out.displacedDevice,
            { name: out.body.user.name, at: new Date().toISOString(), where: a.row.device_name || 'another computer' });
        }
        return json({ token: issueToken(a.row, out.body.user.id), user: out.body.user, licence: a.licence,
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
        if (!a.user || a.user.role !== 'ADMIN') return json({ error: 'ADMIN_ONLY', message: 'Only your Nexora administrator can approve or remove a phone.' }, 403);
        const body = await readJson(request);
        const out = await deviceAction(a.companyId, a.user.name, path.endsWith('approve') ? 'approve' : 'remove', body.deviceId);
        if (out.signedOut) {
          try { endSessionOn(a.companyId, out.signedOut.id, out.deviceId, { name: out.signedOut.name, at: new Date().toISOString(), where: 'no other phone \u2014 the administrator removed this phone', signedOut: true }); } catch (e) { /* told at its next call */ }
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
        const out = await chatSend(a.companyId, a.user, await readJson(request));
        /* Nexora Mobile — the phones waiting on the company hear it at once */
        if (out.httpStatus === 200) wakeChat(a.companyId, a.row.device_id);
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/chat/delete' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const b2 = await readJson(request);
        const out = await chatRemove(a.companyId, a.user, b2 && b2.id);
        return json(out.body, out.httpStatus);
      }
      /* 4.49.0 — everything one person said, taken back at once. */
      if (path === '/v1/chat/clear' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        const b3 = await readJson(request);
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
        if (a.user) {
          await releaseSession(a.user.id, a.row.device_id);
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
          return json({ users: await listUsers(a.companyId), me: describeUser(a.user), maxUsers: cap.max, count: cap.count });
        }
        const out = await userAction(a.companyId, a.user, await readJson(request));
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
        const out = await setCompanyPasscode(a.companyId, a.user, await readJson(request));
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
        const body = await readJson(request);
        const pushed = await push(a.companyId, a.user, body.records);
        /* 4.66.6 — every other machine of the company pulls now */
        if (pushed && pushed.applied && pushed.applied.length) wakeCompany(a.companyId, a.row.device_id);
        return json(pushed);
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
        const body = await readJson(request);
        const out = await calcWeigh(a.companyId, body.calc);
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
        const body = await readJson(request);
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
        const body = await readJson(request);
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
        const body = await readJson(request);
        const out = await runAi(a, () => aiCheckBom(a.companyId || a.row.device_id, body.bom, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* Nexora AI — a BOM changed by what is said, the quotation letter, and the helper */
      if (path === '/v1/ai/edit-bom' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiEditBom(a.companyId || a.row.device_id, body.edit, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/ai/quote-letter' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiQuoteLetter(a.companyId || a.row.device_id, body.quote, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/ai/chat' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiChat(a.companyId || a.row.device_id, body.chat, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* 4.67.3 — one Nexora AI on every window: an answer, and the steps to run */
      if (path === '/v1/ai/assist' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiAssist(a.companyId || a.row.device_id, body.assist, pickLang(body.lang), undefined, { canCost: canSeeCost(a.user) }));
        return json(out.body, out.httpStatus);
      }
      /* 4.67.8 — an answer read aloud (Gujarati, when this computer has no Gujarati voice) */
      if (path === '/v1/ai/speak' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiSpeak(a.companyId || a.row.device_id, body.speak, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      if (path === '/v1/ai/help' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiHelp(a.companyId || a.row.device_id, body.help, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* Nexora AI, phase 3 — the bag's specification, spoken or typed */
      if (path === '/v1/ai/fill-calc' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiFillCalc(a.companyId || a.row.device_id, body.fill, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* Nexora AI, phase 2 — a route or a saved workflow proposed from plain words */
      if (path === '/v1/ai/plan-route' && method === 'POST') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) return json({ error: 'SIGN_IN', message: 'Sign in to use Nexora AI.' }, 401);
        const body = await readJson(request);
        const out = await runAi(a, () => aiPlanRoute(a.companyId || a.row.device_id, body.plan, pickLang(body.lang)));
        return json(out.body, out.httpStatus);
      }
      /* 4.66.6 — "within 5 second ma sync thai javu joiye". A signed-in
         machine keeps this one request open; it is answered the moment
         another machine pushes, or this person signs in elsewhere, or
         after WAIT_MS with nothing to say. Nothing waits on the database. */
      if (path === '/v1/sync/wait' && method === 'GET') {
        await ensureSchema();
        const a = await authorise(request);
        if (!a.ok) return json(a.error, a.httpStatus);
        if (!a.user) {
          if (a.superseded) return json({ sessionEnded: a.superseded });
          return json({ error: 'SIGN_IN', message: 'Sign in to synchronise.' }, 401);
        }
        const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
        const top = await maxSeq(a.companyId);
        if (top > since) return json({ changed: true, seq: top });
        /* Nexora Mobile: a phone also says the last chat message it holds, and is answered at once when there
           is a newer one — so nothing said between two waits is missed */
        const chatParam = url.searchParams.get('chat');
        const wantsChat = chatParam !== null && chatParam !== '';
        if (wantsChat) {
          const c = await q(`SELECT COALESCE(MAX(id), 0) AS m FROM chat_messages WHERE company_id = $1`, [a.companyId]);
          if (Number(c[0] && c[0].m) > (parseInt(chatParam, 10) || 0)) return json({ changed: true, chat: true });
        }
        const ms = parseInt(url.searchParams.get('ms'), 10) || WAIT_MS;
        const heard = await waitFor(a.companyId, a.user.id, a.row.device_id, ms, { chat: wantsChat });
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
          const out = await inkEstimate(companyId, await readJson(request));
          return json(out.body, out.httpStatus);
        }
        if (path === '/v1/ink/train' && method === 'POST') {
          const out = await inkTrain(companyId, userId, await readJson(request));
          return json(out.body, out.httpStatus);
        }
        if (path === '/v1/ink/reset' && method === 'POST') {
          const body = await readJson(request);
          const out = await inkReset(companyId, body.substrate);
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

        const payload = await readJson(request);
        let out;
        try {
          out = runBom(payload);
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
        return new Response(ADMIN_HTML, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, must-revalidate'
          }
        });
      }
      if (path.startsWith('/admin/api/')) {
        await ensureSchema();
        if (!adminAuthorised(request)) return json({ error: 'UNAUTHORISED' }, 401);

        if (path === '/admin/api/licences' && method === 'GET') return json(await listLicences());
        if (path === '/admin/api/licence' && method === 'POST') return json(await licenceAction(await readJson(request)));
        if (path === '/admin/api/gst' && method === 'POST') { const out = await gstAction(await readJson(request)); return json(out.body, out.httpStatus); }
        if (path === '/admin/api/company' && method === 'POST') return json(await companyAction(await readJson(request)));
        if (path === '/admin/api/settings' && method === 'POST') return json(await saveSettings(await readJson(request)));
        if (path === '/admin/api/events' && method === 'GET') return json({ events: await recentEvents(url.searchParams.get('deviceId')) });
        /* 4.42.0 — enquiries: the leads, before they are customers. */
        if (path === '/admin/api/inquiries' && method === 'GET') return json(await listInquiries());
        if (path === '/admin/api/inquiry' && method === 'POST') return json(await inquiryAction(await readJson(request)));
        /* 4.45.0 — feedback and problem reports from the application. */
        if (path === '/admin/api/feedback' && method === 'GET') return json(await listFeedback());
        if (path === '/admin/api/feedback/shot' && method === 'GET') return json(await feedbackShot(url.searchParams.get('id')));
        if (path === '/admin/api/feedback' && method === 'POST') return json(await feedbackAction(await readJson(request)));
        /* 4.47.1 — Nexora speaks in every plant's room. */
        if (path === '/admin/api/broadcast' && method === 'GET') return json(await listBroadcasts());
        if (path === '/admin/api/broadcast' && method === 'POST') return json(await broadcastAction(await readJson(request)));
        /* 4.44.0 — the phone console's own releases. */
        if (path === '/admin/api/app' && method === 'GET') return json(await listReleases());
        if (path === '/admin/api/app' && method === 'POST') return json(await releaseAction(await readJson(request)));
        /* What a phone asks on every check. Behind the admin key like
           everything else here: only the owner runs this application, and
           an unlisted build is not an advertisement. */
        if (path === '/admin/api/app/latest' && method === 'GET') return json(await latestRelease());
        return json({ error: 'NOT_FOUND' }, 404);
      }

      return json({ error: 'NOT_FOUND', path }, 404);
    } catch (e) {
      /* Rule #35: an error a person can read, and never a bare 500. */
      return json({
        error: 'SERVER_ERROR',
        message: 'The licence service could not complete that request. Your work is safe on this computer; try again shortly.',
        detail: (e && e.message) ? String(e.message).slice(0, 300) : undefined
      }, 500);
    }
  }
};

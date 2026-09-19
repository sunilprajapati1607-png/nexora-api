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
import { ensureSchema } from './db.js';
import { activate, authorise, touch, issueToken, reportUsage, companyUsage, describe } from './licence.js';
import { runBom } from './engine.js';
import { adminAuthorised, listLicences, licenceAction, companyAction, saveSettings, recentEvents, ADMIN_HTML } from './admin.js';
import { login, listUsers, userAction, pull, push, describeUser, userCap, setCompanyPasscode, releaseSession } from './sync.js';
import { send as chatSend, since as chatSince, remove as chatRemove } from './chat.js';
import { ensureInkSchema, getModel, listModels, train as inkTrain, estimate as inkEstimate, reset as inkReset } from './inkstore.js';
import { register, gstAction, remoteIp } from './register.js';
import { listInquiries, inquiryAction, publicInquiry } from './inquiry.js';
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
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS)
  });
}
async function readJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      /* ---- open ---------------------------------------------------- */
      if (path === '/health' || path === '/') {
        await ensureSchema();
        return json({ ok: true, service: 'nexora-api', version: '1.0.0', time: new Date().toISOString() });
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
        return json({ token: issueToken(a.row, out.body.user.id), user: out.body.user, licence: a.licence,
          company: a.company ? { id: a.company.id, name: a.company.name } : null });
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
        const out = await chatSend(a.companyId, a.user, await readJson(request));
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
        const body = await readJson(request);
        return json(await push(a.companyId, a.user, body.records));
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
        return new Response(ADMIN_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
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

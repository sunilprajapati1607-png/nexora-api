/**
 * Nexora API — company users and company-wide sync  (4.8.0)
 * ----------------------------------------------------------------------
 * "make master synchronise within one company: if company has more than
 *  one user all data will be synchronised across company, but admin of
 *  company has right to decide which user can see whole data and which
 *  can see only own."
 *
 * The decisions the owner made, and which this file implements:
 *
 *   1. PER-PERSON LOGIN. A seat is activated by its licence key as before;
 *      then a PERSON signs in with company + name + PIN. The company is
 *      never typed: it is the seat's company, read from the device row.
 *   2. THE FIRST ADMIN IS MADE IN THE LICENCE CONSOLE by the owner
 *      (admin.js, action 'adminuser'). Company admins then manage their
 *      own users from inside the application.
 *   3. MASTERS ARE SHARED; CALCULATIONS ARE OWNED. Every master record
 *      (materials, prices, processes, routes, recipes, workflows,
 *      constants, structures, the company details) reaches every seat.
 *      A calculation and its BOM belong to the person who saved them and
 *      reach other people only if the admin gave them scope ALL.
 *   4. LAST SAVE WINS, by the server's clock. A stale push of a MASTER
 *      is answered with the current copy so the client can merge item by
 *      item and push again; a calculation is simply overwritten.
 *   5. FULL CALCULATIONS ARE STORED, trace and all, as JSONB.
 *
 * Everything is scoped by company_id, and company_id ALWAYS comes from
 * the device row through authorise() — never from the token, never from
 * the body — exactly as the costing route has always been scoped.
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPasscode, validPasscode, PASSCODE_MIN } from './passcode.js';
import { q, logEvent } from './db.js';
import { takeAttempt, failedAttempt, clearAttempts, strangerAttempt, lockedBody } from './lockout.js';
import { PC_PENDING, revokedByNexora } from './licence.js';

/* ---- PINs ------------------------------------------------------------
   scrypt with a per-user salt. A PIN is short by nature (people type it
   many times a day), so the cost parameter is what stands between a
   leaked table and the PINs; the defaults are the sensible ones. */
export function hashPin(pin, salt) {
  const s = salt || randomBytes(16).toString('hex');
  const h = scryptSync(String(pin), s, 32).toString('hex');
  return s + '$' + h;
}
export function pinMatches(pin, stored) {
  if (!stored || stored.indexOf('$') < 0) return false;
  const salt = stored.split('$')[0];
  const a = Buffer.from(hashPin(pin, salt));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function validPin(pin) {
  const p = String(pin == null ? '' : pin);
  return p.length >= 4 && p.length <= 64;
}
export function nameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 4.42.0 — an address, or null. Deliberately forgiving: it checks that
 *  there is something either side of an @ and nothing more, because a
 *  stricter rule refuses real addresses and a plant is not going to argue
 *  with a form. An empty string is null, which is how a blank field means
 *  "leave it alone" rather than "erase it". */
export function cleanEmail(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s.slice(0, 160);
}

/** What the application is told about a person. Never the hash. */
export function describeUser(u) {
  if (!u) return null;
  return {
    id: Number(u.id), name: u.name,
    /* 4.42.0 — their own address, so a notice about a new version can reach
       the people who use the software and not only the plant's one
       registered inbox. Optional: most operators will not have one. */
    email: u.email || null,
    role: u.role === 'ADMIN' ? 'ADMIN' : 'USER',
    scope: u.scope === 'ALL' ? 'ALL' : 'OWN',
    permissions: (u.permissions && typeof u.permissions === 'object') ? u.permissions : null,
    active: u.active !== false,
    /* 4.43.0 — WHERE they are signed in, which is the first question asked
       when somebody rings to say they were signed out. */
    sessionDevice: u.session_device || null,
    sessionAt: u.session_at || null,
    lastLoginAt: u.last_login_at || null,
    /* 4.58.1 — the last time their software spoke to the service */
    lastSeenAt: u.last_seen_at || null,
    createdAt: u.created_at || null
  };
}

export async function userById(companyId, id) {
  if (!companyId || !id) return null;
  const rows = await q(`SELECT * FROM company_users WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows.length ? rows[0] : null;
}

/* ---- sign in ---------------------------------------------------------- */
export async function login(companyId, { name, pin }, deviceId) {
  if (!companyId) {
    return { httpStatus: 403, body: { error: 'NO_COMPANY',
      message: 'This installation is not on a company licence yet. Activate it with your licence key first.' } };
  }
  const key = nameKey(name);
  if (!key || !validPin(pin)) {
    return { httpStatus: 400, body: { error: 'BAD_LOGIN', message: 'Enter your name and your PIN.' } };
  }
  const rows = await q(`SELECT * FROM company_users WHERE company_id = $1 AND name_key = $2`, [companyId, key]);
  const u = rows[0];
  /* One refusal for "no such person" and "wrong PIN" alike: a login screen
     that tells you which half was wrong is telling a stranger who works
     here. */
  const badLogin = { httpStatus: 401, body: { error: 'BAD_LOGIN', message: 'That name and PIN do not match. Ask your Nexora administrator if you have forgotten your PIN.' } };
  /* 4.71.0 (audit, owner 2026-10-01) — THREE WRONG PINS LOCK THE PERSON FOR
     FIFTEEN MINUTES (HTTP 423 PIN_LOCKED, retryAfter in seconds), and while
     locked the right PIN is refused too. A name that is not there is
     counted the same way (lockout.js), so the lock gives away nothing the
     refusal did not. */
  if (!u) {
    await logEvent(null, 'LOGIN_REFUSED', { companyId, name: key });
    const s = strangerAttempt('pin|' + companyId + '|' + key);
    return s.locked ? { httpStatus: 423, body: lockedBody('pin', s.retryAfter) } : badLogin;
  }
  const turn = await takeAttempt('pin', u.id);
  if (!turn.ok) {
    await logEvent(null, 'LOGIN_LOCKED', { companyId, userId: u.id, deviceId: deviceId || null });
    return { httpStatus: 423, body: lockedBody('pin', turn.retryAfter) };
  }
  if (!pinMatches(pin, u.pin_hash)) {
    await logEvent(null, 'LOGIN_REFUSED', { companyId, name: key });
    const lockedFor = await failedAttempt('pin', u.id, turn.tries);
    if (lockedFor) {
      await logEvent(null, 'LOGIN_LOCKED', { companyId, userId: u.id, deviceId: deviceId || null });
      return { httpStatus: 423, body: lockedBody('pin', lockedFor) };
    }
    return badLogin;
  }
  await clearAttempts('pin', u.id);
  if (u.active === false) {
    return { httpStatus: 403, body: { error: 'USER_INACTIVE', message: 'This user has been switched off by your Nexora administrator.' } };
  }
  /* 4.43.0 — this machine becomes the one place this person is signed in.
     Whatever machine they were on before keeps working until its next
     heartbeat, which is when it learns it has been moved and signs itself
     out. Refusing the new sign-in instead would lock a person out of the
     machine in front of them because of one they walked away from. */
  /* Nexora Mobile — a phone has its own place: signing in on the phone moves only the phone slot, so
     the computer stays signed in (one computer and one phone per person, owner 2026-09-28) */
  const dev = deviceId ? (await q(`SELECT platform, approved_at FROM licences WHERE device_id = $1`, [deviceId]))[0] : null;
  const isPhone = !!(dev && dev.platform === 'mobile');
  /* 4.71.0 (audit, owner 2026-10-01) — a computer waiting for its administrator: the ADMINISTRATOR
     signing in on it is the approval ("or an admin signs in on it"); anybody else is refused, before
     their place is moved here, with the same answer every other call gets. */
  let approvedNow = false;
  if (dev && !isPhone && !dev.approved_at) {
    if (u.role !== 'ADMIN') {
      await logEvent(deviceId, 'LOGIN_PC_PENDING', { companyId, userId: u.id });
      return { httpStatus: 403, body: Object.assign({}, PC_PENDING) };
    }
    await q(`UPDATE licences SET approved_at = now(), approved_by = $2 WHERE device_id = $1 AND approved_at IS NULL`, [deviceId, u.name]);
    await logEvent(deviceId, 'PC_APPROVED', { companyId, by: u.name, how: 'the administrator signed in on it' });
    approvedNow = true;
  }
  const held = isPhone ? u.session_mobile : u.session_device;
  const displaced = held && deviceId && held !== deviceId ? held : null;
  if (isPhone) {
    await q(`UPDATE company_users SET last_login_at = now(), session_mobile = $2, session_mobile_at = now() WHERE id = $1`, [u.id, deviceId || null]);
  } else {
    await q(`UPDATE company_users SET last_login_at = now(), session_device = $2, session_at = now() WHERE id = $1`,
      [u.id, deviceId || null]);
  }
  await logEvent(null, 'LOGIN', { companyId, userId: u.id, deviceId: deviceId || null, displaced });
  /* 4.66.6 — displacedDevice stays on the service: index.js tells that
     machine at once (waiters.js) instead of at its next heartbeat. */
  return { httpStatus: 200, body: { user: describeUser(u), displaced: displaced ? true : false }, displacedDevice: displaced, approvedNow };
}

/** 4.66.6 — the newest change the company has, for /v1/sync/wait. */
export async function maxSeq(companyId) {
  const rows = await q(`SELECT COALESCE(MAX(seq), 0) AS s FROM sync_records WHERE company_id = $1`, [companyId]);
  return Number(rows[0] && rows[0].s) || 0;
}

/** 4.43.0 — signing out gives the person back. Bound to THIS machine
 *  only: a person who has already signed in elsewhere must not have that
 *  new session cleared by the machine they left catching up with a
 *  logout it owed. */
export async function releaseSession(userId, deviceId) {
  if (!userId || !deviceId) return;
  await q(`UPDATE company_users SET session_device = NULL, session_at = NULL
            WHERE id = $1 AND session_device = $2`, [userId, deviceId]);
  await q(`UPDATE company_users SET session_mobile = NULL, session_mobile_at = NULL
            WHERE id = $1 AND session_mobile = $2`, [userId, deviceId]);
}

/* ---- Nexora Mobile: the company's devices, for its administrator -------- */
/** Every installation of this company: computers and phones, who is signed in on each, and whether a
 *  phone is still waiting for approval. For the company's own administrator only. */
export async function listDevices(companyId) {
  const rows = await q(`SELECT l.device_id, l.device_name, l.platform, l.state, l.approved_at, l.approved_by, l.last_seen_at, l.seat_no, l.app_version,
                              l.revoked_by, u.id AS user_id, u.name AS user_name
                         FROM licences l
                         LEFT JOIN company_users u ON u.company_id = l.company_id AND (u.session_device = l.device_id OR u.session_mobile = l.device_id)
                        WHERE l.company_id = $1
                        ORDER BY (l.platform = 'mobile') DESC, l.last_seen_at DESC NULLS LAST`, [companyId]);
  /* 4.71.0 — a computer waits for approval as a phone does (licence.js activate), so approved and
     pending mean the same thing for both */
  return rows.map((r) => ({ id: r.device_id, name: r.device_name || '', platform: r.platform === 'mobile' ? 'mobile' : 'desktop',
    state: r.state, approved: !!r.approved_at, approvedBy: r.approved_by || null,
    pending: !r.approved_at && r.state !== 'REVOKED',
    /* 4.71.0 (audit) — who withdrew it: 'COMPANY' (this administrator removed it; C7: it comes back by joining
       again and waiting here — /v1/devices/approve answers 409 REJOIN_NEEDED) or 'NEXORA' (only Nexora can) */
    revokedBy: r.state === 'REVOKED' ? (revokedByNexora(r) ? 'NEXORA' : 'COMPANY') : null,
    lastSeen: r.last_seen_at || null, computerNo: r.seat_no || null, appVersion: r.app_version || null,
    signedIn: r.user_id ? { id: r.user_id, name: r.user_name } : null }));
}
/* revokedByNexora — who withdrew a machine — now lives in licence.js (C7: activate reads it too). */
/** Approve a phone or a computer, or take one away (it is refused at once and its person is signed out
 *  of it). 4.71.0 — computers too ("the admin approves/removes PCs through the same endpoints phones
 *  use"); `fromDevice` is the machine the administrator is asking from, which they cannot remove. */
export async function deviceAction(companyId, byName, action, deviceId, fromDevice) {
  const d = (await q(`SELECT * FROM licences WHERE device_id = $1 AND company_id = $2`, [String(deviceId || ''), companyId]))[0];
  if (!d) return { httpStatus: 404, body: { error: 'NO_DEVICE', message: 'That device is not on this company.' } };
  const isPhone = d.platform === 'mobile';
  if (action === 'approve') {
    if (revokedByNexora(d)) {
      return { httpStatus: 409, body: { error: 'REVOKED_BY_NEXORA', platform: isPhone ? 'mobile' : 'desktop',
        message: 'Nexora has withdrawn this ' + (isPhone ? 'phone' : 'computer') + ' — only Nexora can restore it. Contact Nexora.' } };
    }
    /* C7 — ONE THIS COMPANY REMOVED COMES BACK ONLY BY JOINING AGAIN. Removing it let its device key go
       ('remove' below), so approving it back from here would make it live and approved again holding NO
       key — and a row with no key takes the first key it is shown, or lets in a request that sends none:
       whoever knew its device id (no licence key, no passcode) could then activate as it and be handed an
       approved token, and the real machine, which keeps its token through its heartbeat and never asks
       again, would find itself shut out when it finally did. Joining again with the company's licence key,
       or its id and passcode, makes it a new device holding a key of its own and waiting here (licence.js
       activate); this administrator approves THAT. A device that is merely waiting is approved as before. */
    const rejoinNeeded = { httpStatus: 409, body: { error: 'REJOIN_NEEDED', platform: isPhone ? 'mobile' : 'desktop',
      message: 'Ask that ' + (isPhone ? 'phone' : 'computer') + ' to join again with the company’s licence key, or its company id and passcode; it will then wait here for your approval.' } };
    if (d.state === 'REVOKED') return rejoinNeeded;
    /* `AND state <> 'REVOKED'`: a removal that lands between the read above and this cannot be undone here either */
    const done = await q(`UPDATE licences SET approved_at = now(), approved_by = $2
                           WHERE device_id = $1 AND state <> 'REVOKED' RETURNING device_id`, [d.device_id, byName || null]);
    if (!done.length) return rejoinNeeded;
    await logEvent(d.device_id, isPhone ? 'PHONE_APPROVED' : 'PC_APPROVED', { companyId, by: byName || null });
    return { httpStatus: 200, body: { ok: true } };
  }
  if (action === 'remove') {
    if (fromDevice && String(fromDevice) === d.device_id) {
      return { httpStatus: 409, body: { error: 'THIS_DEVICE', message: 'This is the ' + (isPhone ? 'phone' : 'computer') + ' you are using — remove it from another one.' } };
    }
    const slot = isPhone ? 'session_mobile' : 'session_device';
    const slotAt = isPhone ? 'session_mobile_at' : 'session_at';
    const who = (await q(`SELECT id, name FROM company_users WHERE company_id = $1 AND ${slot} = $2`, [companyId, d.device_id]))[0] || null;
    /* marked as the company's own removal — the machine may join again and wait for this administrator
       (C7: not approved back from here, see 'approve') — unless Nexora had already revoked it, which stays
       Nexora's (a remove must not turn the console's revoke into one the company can give back) */
    /* C7 — and its device key is let go: whatever joins again with this id (the company's licence key, or
       its id and passcode) is a new device waiting for this administrator, holding a key of its own
       (licence.js activate). That is also how a reinstalled machine that lost its key gets back in. */
    await q(`UPDATE licences SET state = 'REVOKED', approved_at = NULL, revoked_by = $2, device_key_hash = NULL WHERE device_id = $1`,
      [d.device_id, revokedByNexora(d) ? 'NEXORA' : 'COMPANY']);
    await q(`UPDATE company_users SET ${slot} = NULL, ${slotAt} = NULL WHERE company_id = $1 AND ${slot} = $2`, [companyId, d.device_id]);
    await logEvent(d.device_id, isPhone ? 'PHONE_REMOVED' : 'PC_REMOVED', { companyId, by: byName || null });
    return { httpStatus: 200, body: { ok: true }, signedOut: who, deviceId: d.device_id, platform: isPhone ? 'mobile' : 'desktop' };
  }
  return { httpStatus: 400, body: { error: 'BAD_ACTION', message: 'approve or remove' } };
}

/* ---- users ------------------------------------------------------------- */
/** How many people this company may have, and how many it has.
    ONE SEAT = ONE PERSON (the owner's rule, 2026-09-17): a company with
    three seats may have three names, the administrator included. Every
    name counts, switched off or not. */
export async function userCap(companyId) {
  const co = await q(`SELECT seats FROM companies WHERE id = $1`, [companyId]);
  const n = await q(`SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1`, [companyId]);
  return { max: Number(co[0] && co[0].seats) || 1, count: Number(n[0] && n[0].n) || 0 };
}
export async function listUsers(companyId) {
  const rows = await q(
    `SELECT * FROM company_users WHERE company_id = $1 ORDER BY role DESC, name_key`, [companyId]);
  return rows.map(describeUser);
}

/** Create or reset the company's administrator — the owner's action from
 *  the licence console. An existing person of that name becomes the admin
 *  and gets the new PIN; nobody else is touched. */
export async function ensureAdmin(companyId, { name, pin, email }) {
  const key = nameKey(name);
  if (!key) return { error: 'A name is required.' };
  if (!validPin(pin)) return { error: 'A PIN of at least 4 characters is required.' };
  /* An address left blank leaves whatever they already had alone, rather
     than quietly erasing one because this form did not ask for it. */
  const mail = cleanEmail(email);
  const existing = await q(`SELECT * FROM company_users WHERE company_id = $1 AND name_key = $2`, [companyId, key]);
  if (existing.length) {
    await q(`UPDATE company_users SET pin_hash = $2, role = 'ADMIN', scope = 'ALL', active = true, name = $3,
                                      email = COALESCE($4, email)
              WHERE id = $1`, [existing[0].id, hashPin(pin), String(name).trim(), mail]);
    await logEvent(null, 'ADMIN_COMPANY_ADMINUSER', { companyId, userId: existing[0].id, reset: true });
    return { ok: true, user: describeUser((await userById(companyId, existing[0].id))), reset: true };
  }
  const rows = await q(
    `INSERT INTO company_users (company_id, name, name_key, pin_hash, role, scope, active, email)
     VALUES ($1, $2, $3, $4, 'ADMIN', 'ALL', true, $5) RETURNING *`,
    [companyId, String(name).trim(), key, hashPin(pin), mail]);
  await logEvent(null, 'ADMIN_COMPANY_ADMINUSER', { companyId, userId: rows[0].id, reset: false });
  return { ok: true, user: describeUser(rows[0]), reset: false };
}

/** What a signed-in person may do to the user list. An ADMIN manages
 *  everyone; anyone may change their own PIN and nothing else. */
/* 4.42.0 — THE COMPANY PASSCODE, CHANGED FROM INSIDE THE PLANT.

   The plant's administrator can set a new one without ringing Nexora.
   Three things are true of it and all three are enforced here rather
   than in the window, because a rule the client enforces alone is a
   suggestion:

     \u00b7 only an administrator of THAT company may do it;
     \u00b7 only a company that registered itself has a passcode at all \u2014 a
       company Nexora issued a key to joins with the key;
     \u00b7 the old one is never checked, because it is never known. It is a
       scrypt hash. Somebody already signed in AS an administrator has
       proved who they are; asking for a secret nobody can read would
       prove nothing further.

   Written to the event log, because changing the way into a company is
   exactly the sort of thing that should be answerable for afterwards.
   The passcode itself is never written there. */
export async function setCompanyPasscode(companyId, actor, body) {
  if (!actor || actor.role !== 'ADMIN') {
    return { httpStatus: 403, body: { error: 'ADMIN_ONLY',
      message: 'Only an administrator can change the company passcode.' } };
  }
  const co = (await q('SELECT id, name, login_id, self_registered FROM companies WHERE id = $1', [companyId]))[0];
  if (!co) return { httpStatus: 404, body: { error: 'NO_COMPANY', message: 'No such company.' } };
  if (!co.self_registered) {
    return { httpStatus: 409, body: { error: 'NOT_SELF_REGISTERED',
      message: co.name + ' joins with its licence key, not with a passcode.' } };
  }
  const passcode = body && body.passcode != null ? String(body.passcode) : '';
  if (!validPasscode(passcode)) {
    return { httpStatus: 400, body: { error: 'BAD_PASSCODE',
      message: 'A company passcode needs at least ' + PASSCODE_MIN + ' characters.' } };
  }
  await q('UPDATE companies SET passcode_hash = $2 WHERE id = $1', [companyId, hashPasscode(passcode)]);
  await logEvent(null, 'COMPANY_PASSCODE_SET', { companyId, by: actor.id, name: co.name });
  return { httpStatus: 200, body: { ok: true, loginId: co.login_id } };
}

/* 4.71.0 (audit, owner 2026-10-01) — A NEW PERSON STARTS WITH THE LEAST.
   A person created without a list of rights used to be stored with none
   (NULL), which every reader takes for "the ordinary rights" — and which
   left what a new name could do to whatever each reader decided NULL
   meant. A new person is now written with an explicit list: the day's
   work, but no costs or prices (VIEW_COST, EDIT_RM_PRICE), no deleting
   (DELETE_CALC, BOM_DELETE, MKT_DELETE), no managing people (MANAGE_USERS), and no mobile
   screenshots (only ever given). The administrator ticks more. Every
   person who already exists keeps exactly what they have — a stored NULL
   is never rewritten.
   The keys are the desktop's (app/src/ui/app.js FUNCTION_KEYS — change both
   together); a key the application reads that is missing here counts as
   not given, or as what it was split from (app.js PERM_INHERITS). */
export const FUNCTION_KEYS = [
  'NEW_CALC', 'OPEN_CALC', 'SAVE_CALC', 'DELETE_CALC',
  'VIEW_HISTORY', 'PRINT_PREVIEW', 'EXPORT_EXCEL', 'EXPORT_PDF',
  'VIEW_STRUCTURES', 'EDIT_STRUCTURE',
  'EDIT_CONSTANTS', 'ADD_CONSTANT', 'LINK_CONSTANT',
  'VIEW_ACTIVITY_LOG', 'MANAGE_USERS', 'BOM_ACCESS', 'CALCULATOR_TOOL',
  'VIEW_MASTERS', 'EDIT_RM', 'EDIT_RM_PRICE', 'EDIT_ROUTE',
  'BOM_SAVE', 'BOM_DELETE', 'QUOTE_ACCESS', 'QUOTE_SAVE', 'VIEW_CONSTANTS',
  'VIEW_COST',
  'EDIT_PROCESS', 'EDIT_WORKFLOW',
  'MKT_ACCESS', 'MKT_SAVE', 'MKT_DELETE',
  'MOBILE_SCREENSHOT'
];
const NOT_BY_DEFAULT = { VIEW_COST: 1, EDIT_RM_PRICE: 1, MANAGE_USERS: 1, MOBILE_SCREENSHOT: 1 };
export function defaultPermissions() {
  const p = {};
  FUNCTION_KEYS.forEach((k) => { p[k] = !(NOT_BY_DEFAULT[k] || /DELETE/.test(k)); });   /* DELETE_CALC, BOM_DELETE, MKT_DELETE */
  return p;
}

export async function userAction(companyId, actor, body) {
  const action = String(body.action || '');
  const isAdmin = actor && actor.role === 'ADMIN';

  if (action === 'create') {
    if (!isAdmin) return { httpStatus: 403, body: { error: 'ADMIN_ONLY', message: 'Only a Nexora administrator can add users.' } };
    const name = String(body.name || '').trim();
    const key = nameKey(name);
    if (!key) return { httpStatus: 400, body: { error: 'BAD_NAME', message: 'A name is required.' } };
    if (!validPin(body.pin)) return { httpStatus: 400, body: { error: 'BAD_PIN', message: 'A PIN of at least 4 characters is required.' } };
    const dup = await q(`SELECT id FROM company_users WHERE company_id = $1 AND name_key = $2`, [companyId, key]);
    if (dup.length) return { httpStatus: 409, body: { error: 'NAME_TAKEN', message: 'There is already a user called ' + name + '.' } };
    /* One seat, one person. Enforced here and not only in the window,
       because a limit the client enforces alone is a suggestion. People
       switched off still count: they are names that can be switched
       back on. */
    const cap = await userCap(companyId);
    if (cap.count >= cap.max) {
      return { httpStatus: 409, body: { error: 'USER_LIMIT',
        message: 'Your licence has ' + cap.max + ' ' + (cap.max === 1 ? 'seat' : 'seats') + ' and one person per seat — ' + cap.count +
          (cap.count === 1 ? ' is' : ' are') + ' already on it. Ask Nexora for more seats, or remove someone who has left.',
        maxUsers: cap.max, count: cap.count } };
    }
    const rows = await q(
      `INSERT INTO company_users (company_id, name, name_key, pin_hash, role, scope, permissions, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
      [companyId, name, key, hashPin(body.pin),
       body.role === 'ADMIN' ? 'ADMIN' : 'USER',
       body.scope === 'ALL' ? 'ALL' : 'OWN',
       body.permissions && typeof body.permissions === 'object' && !Array.isArray(body.permissions) ? JSON.stringify(body.permissions)
         /* an administrator has every right whatever the list says: left as it always was */
         : body.role === 'ADMIN' ? null : JSON.stringify(defaultPermissions())]);
    await logEvent(null, 'USER_CREATE', { companyId, by: actor.id, userId: rows[0].id });
    return { httpStatus: 200, body: { ok: true, user: describeUser(rows[0]) } };
  }

  const id = parseInt(body.id, 10);
  const target = await userById(companyId, id);
  if (!target) return { httpStatus: 404, body: { error: 'NO_USER', message: 'That user is not on this company.' } };
  const self = actor && Number(actor.id) === Number(target.id);

  if (action === 'pin') {
    if (!isAdmin && !self) return { httpStatus: 403, body: { error: 'ADMIN_ONLY', message: 'Only a Nexora administrator can reset another person\'s PIN.' } };
    if (!validPin(body.pin)) return { httpStatus: 400, body: { error: 'BAD_PIN', message: 'A PIN of at least 4 characters is required.' } };
    /* A person changing their OWN pin proves the old one first. */
    if (self && !isAdmin && !pinMatches(body.oldPin, target.pin_hash)) {
      return { httpStatus: 401, body: { error: 'BAD_LOGIN', message: 'Your current PIN was not right.' } };
    }
    await q(`UPDATE company_users SET pin_hash = $2 WHERE id = $1`, [id, hashPin(body.pin)]);
    await logEvent(null, 'USER_PIN', { companyId, by: actor.id, userId: id });
    return { httpStatus: 200, body: { ok: true } };
  }

  if (!isAdmin) return { httpStatus: 403, body: { error: 'ADMIN_ONLY', message: 'Only a Nexora administrator can change users.' } };

  if (action === 'remove') {
    /* 4.30.0 - frees the seat. Switching off keeps it (a name that can be
       switched back on); removing deletes the name. Never oneself, never
       the last administrator. Their records stay with the company. */
    if (self) return { httpStatus: 409, body: { error: 'SELF', message: 'You cannot remove yourself. Ask another administrator.' } };
    if (target.role === 'ADMIN') {
      const admins = await q(`SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1 AND role = 'ADMIN' AND active = true AND id <> $2`, [companyId, id]);
      if (!Number(admins[0].n)) return { httpStatus: 409, body: { error: 'LAST_ADMIN', message: 'This is the only administrator and cannot be removed.' } };
    }
    await q(`DELETE FROM company_users WHERE id = $1 AND company_id = $2`, [id, companyId]);
    await logEvent(null, 'USER_REMOVE', { companyId, by: actor.id, userId: id, name: target.name });
    const cap = await userCap(companyId);
    return { httpStatus: 200, body: { ok: true, removed: { id: Number(id), name: target.name }, maxUsers: cap.max, count: cap.count } };
  }
  if (action === 'scope') {
    await q(`UPDATE company_users SET scope = $2 WHERE id = $1`, [id, body.scope === 'ALL' ? 'ALL' : 'OWN']);
  } else if (action === 'role') {
    /* The last administrator cannot demote themself — a company with no
       admin has nobody left who can make one. */
    if (body.role !== 'ADMIN') {
      const admins = await q(`SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1 AND role = 'ADMIN' AND active = true AND id <> $2`, [companyId, id]);
      if (!Number(admins[0].n)) return { httpStatus: 409, body: { error: 'LAST_ADMIN', message: 'This is the only administrator. Make somebody else an administrator first.' } };
    }
    await q(`UPDATE company_users SET role = $2, scope = CASE WHEN $2 = 'ADMIN' THEN 'ALL' ELSE scope END WHERE id = $1`,
      [id, body.role === 'ADMIN' ? 'ADMIN' : 'USER']);
  } else if (action === 'active') {
    if (body.active === false || body.active === 'false') {
      const admins = await q(`SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1 AND role = 'ADMIN' AND active = true AND id <> $2`, [companyId, id]);
      if (target.role === 'ADMIN' && !Number(admins[0].n)) return { httpStatus: 409, body: { error: 'LAST_ADMIN', message: 'This is the only administrator and cannot be switched off.' } };
    }
    await q(`UPDATE company_users SET active = $2 WHERE id = $1`, [id, !(body.active === false || body.active === 'false')]);
  } else if (action === 'permissions') {
    await q(`UPDATE company_users SET permissions = $2 WHERE id = $1`,
      [id, body.permissions && typeof body.permissions === 'object' ? JSON.stringify(body.permissions) : null]);
  } else if (action === 'rename') {
    const name = String(body.name || '').trim();
    const key = nameKey(name);
    if (!key) return { httpStatus: 400, body: { error: 'BAD_NAME', message: 'A name is required.' } };
    const dup = await q(`SELECT id FROM company_users WHERE company_id = $1 AND name_key = $2 AND id <> $3`, [companyId, key, id]);
    if (dup.length) return { httpStatus: 409, body: { error: 'NAME_TAKEN', message: 'There is already a user called ' + name + '.' } };
    await q(`UPDATE company_users SET name = $2, name_key = $3 WHERE id = $1`, [id, name, key]);
  } else {
    return { httpStatus: 400, body: { error: 'BAD_ACTION', message: 'Unknown action: ' + action } };
  }
  await logEvent(null, 'USER_' + action.toUpperCase(), { companyId, by: actor.id, userId: id });
  const after = await userById(companyId, id);
  /* 4.71.0 (C2) — given costs just now: the prices they were sent empty come again */
  if (!canSeeCost(target) && canSeeCost(after)) await resendPrices(companyId);
  return { httpStatus: 200, body: { ok: true, user: describeUser(after) } };
}

/** 4.71.0 (C2) — somebody who could not see costs now can: the price master
 *  is given a fresh seq, so their next pull carries it — in full this time.
 *  Their computer had it EMPTY at the seq it already holds, and would
 *  otherwise wait for the next price change to be sent it. Nothing in it
 *  changes; everybody else simply receives the same copy once more. */
export async function resendPrices(companyId) {
  await q(`UPDATE sync_records SET seq = nextval(pg_get_serial_sequence('sync_records', 'seq'))
            WHERE company_id = $1 AND kind = 'master' AND id = $2 AND deleted = false`, [companyId, PRICE_MASTER]);
}

/* ---- the records ------------------------------------------------------
   Three kinds:
     master   id = the application's storage key (e.g. nexora.rm.master.v1),
              body = that key's whole value. Shared by everyone.
     calc     id = the calculation's id, body = the record. Owned.
     bom      id = the calculation's id, body = the saved BOM. Owned with
              its calculation.
     quote    (4.66.0) id = the quotation's key (its calculation's id, or
              'quote:<uuid>' for one made without a calculation), body =
              the saved quotation. Owned, by the same rules as calc and
              bom: scope OWN sees its own, scope ALL (every admin) sees
              everyone's, and another person's arrives as a STUB.
   Every write takes a fresh seq, so "everything since seq N" is exact. */
/* 4.66.3 — masters only an administrator may write (see push) */
const ADMIN_ONLY_MASTERS = { 'nexora.rm.price.v1': 1, 'nexora.constants.v1': 1, 'nexora.constants.custom.v1': 1, 'nexora.docseries.v1': 1, 'nexora.units.v1': 1, 'nexora.meshunit.v1': 1, 'nexora.quote.terms.v1': 1,
  'nexora.constants.links.v1': 1, 'nexora.org.v1': 1, 'nexora.mkt.sources.v1': 1, 'nexora.mkt.targets.v1': 1 };
/* 4.68.0 — MARKETING: enquiry (the lead and the enquiry are one record) and customer. Owned like a quotation, but
   who is SENT one is wider: the owner, the person it is assigned to (an enquiry's assignedTo), an administrator or
   scope ALL, and anyone the administrator let see that person's marketing (permissions MKT_SEE_ALL, MKT_SEE:<id>) —
   "admin can give permision to marketing manager to see all user data or can select several user data". */
const KINDS = { master: true, calc: true, bom: true, quote: true, enquiry: true, customer: true };
const MKT_KINDS = { enquiry: true, customer: true };
/* 4.70.4 — the records a stale push is answered for (see the push below) */
const STALE_KINDS = { quote: true, enquiry: true, customer: true };
const PAGE = 200;
const MAX_BODY = 4 * 1024 * 1024;   // one record; a calculation with its trace is ~50 KB

/* 4.71.0 (audit, C3) — THE MASTERS THE SERVICE KEEPS: exactly the desktop's list
   (app/src/api/syncClient.js MASTER_KEYS — change both together). A push of
   any other id is refused (UNKNOWN_MASTER): every computer writes what it
   pulls straight into its own settings, so an id somebody made up would
   otherwise travel from one seat's push into every other seat. */
export const MASTER_KEYS = [
  'nexora.rm.master.v1', 'nexora.rm.price.v1', 'nexora.rm.group.v1', 'nexora.rm.seeded.v1',
  'nexora.route.master.v1', 'nexora.routes.seeded.v1', 'nexora.process.master.v1',
  'nexora.process.recipe.v1', 'nexora.resource.master.v1', 'nexora.material.state.v1',
  'nexora.bom.recipe.v1', 'nexora.bom.basis.v1', 'nexora.bom.linemap.v1', 'nexora.bom.workflow.v1',
  'nexora.constants.v1', 'nexora.constants.custom.v1', 'nexora.constants.links.v1', 'nexora.structures.v1',
  'nexora.org.v1', 'nexora.table.columns.v1',
  'nexora.resource.types.v1', 'nexora.approvals.v1', 'nexora.master.owner.v1',
  'nexora.docseries.v1',
  'nexora.units.v1', 'nexora.meshunit.v1',
  'nexora.quote.terms.v1',
  'nexora.mkt.sources.v1',
  'nexora.mkt.targets.v1',
  'nexora.ai.wrote.v1', 'nexora.ai.rules.v1'
];
const IS_MASTER = {};
MASTER_KEYS.forEach((k) => { IS_MASTER[k] = true; });

/* 4.71.0 (audit, C2) — THE PRICES GO ONLY TO WHOEVER MAY SEE THEM. */
export const PRICE_MASTER = 'nexora.rm.price.v1';
/* 4.67.17 — "costs and prices (Rs)": the administrator, and whoever the administrator gave VIEW_COST (the same
   rule as the application). 4.71.0 — moved here from index.js so the AI and the sync answer to one rule. */
export function canSeeCost(u) {
  if (!u) return false;
  if (u.role === 'ADMIN') return true;
  let p = u.permissions;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
  return !!(p && typeof p === 'object' && p.VIEW_COST === true);
}

function canSee(user, row) {
  if (row.kind === 'master') return true;
  if (MKT_KINDS[row.kind]) return mktCanSee(user, row);
  if (user.scope === 'ALL') return true;
  return row.owner_id == null || Number(row.owner_id) === Number(user.id);
}
function permsOf(user) {
  let p = user && user.permissions;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
  return p && typeof p === 'object' ? p : {};
}
/** 4.68.0 — may this person be given the marketing records of person `id`? Their own, always. */
export function mktSeesPerson(user, id) {
  if (id == null) return true;
  if (Number(id) === Number(user.id)) return true;
  if (user.role === 'ADMIN' || user.scope === 'ALL') return true;
  const p = permsOf(user);
  return p.MKT_SEE_ALL === true || p['MKT_SEE:' + Number(id)] === true;
}
function mktCanSee(user, row) {
  if (mktSeesPerson(user, row.owner_id)) return true;
  const b = row.body || {};
  return row.kind === 'enquiry' && b.assignedTo != null && b.assignedTo !== '' && mktSeesPerson(user, b.assignedTo);
}

/** A calculation another person owns is sent as a STUB — number, code and
 *  owner only — so a seat with scope OWN can still avoid minting a
 *  calculation number that is already taken. The application hides stubs
 *  from every list. */
function stubOf(row) {
  const b = row.body || {};
  return { id: row.id, stub: true, calcNumber: b.calcNumber || null, itemCode: b.itemCode || null,
    revision: b.revision || null, ownerId: row.owner_id == null ? null : Number(row.owner_id), createdBy: b.createdBy || null };
}
/** 4.66.0 — the same for a quotation: its number and owner, never the
 *  buyer, the rates or the cost it was quoted at. The number is what a
 *  seat with scope OWN needs so its next quotation number is free. */
function quoteStubOf(row) {
  const b = row.body || {};
  return { calcId: row.id, stub: true, quoteNumber: b.quoteNumber || null,
    ownerId: row.owner_id == null ? null : Number(row.owner_id) };
}
/** 4.68.0 — an enquiry's number and owner (so the numbering stays free across the company), and a customer's id
 *  and owner only: never the buyer's name, phone, GSTIN, requirement or follow-ups. A stub also replaces a copy
 *  someone may no longer see after the administrator takes the grant back. */
function enquiryStubOf(row) {
  const b = row.body || {};
  return { id: row.id, stub: true, enquiryNumber: b.enquiryNumber || null, ownerId: row.owner_id == null ? null : Number(row.owner_id) };
}
function customerStubOf(row) {
  return { id: row.id, stub: true, ownerId: row.owner_id == null ? null : Number(row.owner_id) };
}
const STUBS = { calc: stubOf, quote: quoteStubOf, enquiry: enquiryStubOf, customer: customerStubOf };

export async function pull(companyId, user, since, limit) {
  const from = Math.max(0, parseInt(since, 10) || 0);
  const lim = Math.min(PAGE, Math.max(1, parseInt(limit, 10) || PAGE));
  const rows = await q(
    `SELECT seq, kind, id, body, owner_id, deleted, updated_at, updated_by
       FROM sync_records WHERE company_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [companyId, from, lim + 1]);
  const more = rows.length > lim;
  const page = rows.slice(0, lim);
  /* 4.71.0 (audit, C2) — "prices to VIEW_COST only": somebody who may not see costs is sent the price
     master EMPTY and marked stripped — its seq still moves, so the application knows it is there and that it
     was held back, but not one rate leaves the service. Their costings are filled in by the service itself
     (/v1/bom, from the company's own copy). */
  const pricesHidden = !canSeeCost(user);
  const records = page.map((r) => {
    if (pricesHidden && r.kind === 'master' && r.id === PRICE_MASTER && !r.deleted) {
      return { seq: Number(r.seq), kind: 'master', id: r.id, deleted: false, ownerId: null,
        updatedAt: r.updated_at, updatedBy: r.updated_by == null ? null : Number(r.updated_by),
        body: {}, stub: false, stripped: true };
    }
    const visible = canSee(user, r);
    const stubbed = !visible && !r.deleted && !!STUBS[r.kind];
    return {
      seq: Number(r.seq), kind: r.kind, id: r.id, deleted: r.deleted === true,
      ownerId: r.owner_id == null ? null : Number(r.owner_id),
      updatedAt: r.updated_at, updatedBy: r.updated_by == null ? null : Number(r.updated_by),
      body: r.deleted ? null : (visible ? r.body : (stubbed ? STUBS[r.kind](r) : null)),
      stub: stubbed
    };
  }).filter((r) => r.body !== null || r.deleted);
  const next = page.length ? Number(page[page.length - 1].seq) : from;
  return { records, next, more, me: describeUser(user) };
}

function calcNumberOf(body) {
  return body && typeof body === 'object' && body.calcNumber ? String(body.calcNumber) : null;
}

/** 4.68.0 — the next free number after a taken one, whatever the series looks like (ENQ-2026-000012,
 *  E/26/0012-A …): the last run of digits is the counter, the rest must match. */
async function suggestNext(companyId, kind, field, taken) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(String(taken || ''));
  if (!m) return null;
  const head = m[1], width = m[2].length, tail = m[3];
  const rows = await q(
    `SELECT body->>'${field}' AS n FROM sync_records WHERE company_id = $1 AND kind = $2 AND deleted = false AND body->>'${field}' LIKE $3`,
    [companyId, kind, head.replace(/[\\%_]/g, (c) => '\\' + c) + '%']);
  let max = 0;
  rows.forEach((r) => {
    const x = String(r.n || '');
    if (x.slice(0, head.length) !== head) return;
    const d = /^(\d+)(\D*)$/.exec(x.slice(head.length));
    if (d && d[2] === tail) { const k = parseInt(d[1], 10); if (k > max) max = k; }
  });
  return head + String(max + 1).padStart(width, '0') + tail;
}

/** Next free calculation number for the year the taken one was in. */
async function suggestNumber(companyId, taken) {
  const m = /^CAL-(\d{4})-(\d+)$/.exec(taken || '');
  if (!m) return null;
  const rows = await q(
    `SELECT body->>'calcNumber' AS n FROM sync_records
      WHERE company_id = $1 AND kind = 'calc' AND deleted = false AND body->>'calcNumber' LIKE $2`,
    [companyId, 'CAL-' + m[1] + '-%']);
  let max = 0;
  rows.forEach((r) => { const k = parseInt(String(r.n || '').split('-')[2], 10); if (k > max) max = k; });
  return 'CAL-' + m[1] + '-' + String(max + 1).padStart(6, '0');
}

/* ---- 4.71.0 (audit, C4) — THE APPROVALS AND WHO-MADE-WHAT ------------------
   "constant ane price admin j change kre … change mate admin ne chat ma
    approval mokli ne approve kravi sake" (4.66.0). The request list and the
   list of who made each route / process / workflow are shared masters, so
   until now anybody's push replaced them whole: a person could approve
   their own request (decidedBy, phoneApproved), take somebody else's away,
   or write themselves in as the maker of a route so as to change it without
   asking. The application never did any of that — the service now makes
   sure nothing else can either.

   For anybody but an administrator the company's stored copy is the base,
   and only two things are taken from what they sent:
     approvals  a NEW request, made by them (by.id), still PENDING, carrying
                no answer (phoneApproved, decidedBy …); and taking back one
                of their OWN that is still PENDING;
     owners     a NEW entry — an id nobody is recorded as the maker of —
                naming themselves.
   Every other difference is left out, and what is stored is the company's
   copy plus those. An administrator's push is taken as it is. */
const APPROVALS_MASTER = 'nexora.approvals.v1';
const OWNERS_MASTER = 'nexora.master.owner.v1';
const ANSWER_FIELDS = ['phoneApproved', 'decidedBy', 'decidedAt', 'decision', 'approved', 'approvedBy', 'approvedAt', 'rejectedBy', 'rejectedAt'];
const NOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function plainObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
/** The application writes a person as 'u:<id>' (app.js getActiveUser, the phone's "u:$myId"). */
function isMe(user, v) {
  const s = String(v == null ? '' : v);
  return s !== '' && (s === 'u:' + Number(user.id) || s === String(Number(user.id)));
}
function byOf(r) { return r && r.by && typeof r.by === 'object' ? r.by.id : (r ? r.by : null); }
/** JSON with every object's keys in one order, so two copies of the same thing compare equal. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

export function limitApprovals(user, stored, sent) {
  const was = plainObject(stored) || {};
  const now = plainObject(sent) || {};
  const out = JSON.parse(JSON.stringify(was));
  Object.keys(now).forEach((k) => {
    if (NOT_KEYS.has(k) || own(was, k)) return;
    const r = plainObject(now[k]);
    if (!r || String(r.id) !== k || r.status !== 'PENDING' || !isMe(user, byOf(r))) return;
    if (ANSWER_FIELDS.some((f) => r[f] !== undefined && r[f] !== null)) return;
    out[k] = r;
  });
  Object.keys(was).forEach((k) => {
    if (own(now, k)) return;
    const r = plainObject(was[k]);
    if (r && r.status === 'PENDING' && isMe(user, byOf(r))) delete out[k];
  });
  return out;
}
export function limitOwners(user, stored, sent) {
  const was = plainObject(stored) || {};
  const now = plainObject(sent) || {};
  const out = JSON.parse(JSON.stringify(was));
  Object.keys(now).forEach((kind) => {
    if (NOT_KEYS.has(kind) || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(kind)) return;
    const add = plainObject(now[kind]);
    if (!add) return;
    if (own(out, kind) && !plainObject(out[kind])) return;
    const had = plainObject(was[kind]) || {};
    Object.keys(add).forEach((id) => {
      if (NOT_KEYS.has(id) || own(had, id) || !isMe(user, add[id])) return;
      if (!plainObject(out[kind])) out[kind] = {};
      out[kind][id] = add[id];
    });
  });
  return out;
}
const LIMITED_MASTERS = { [APPROVALS_MASTER]: limitApprovals, [OWNERS_MASTER]: limitOwners };

export async function push(companyId, user, records) {
  const list = Array.isArray(records) ? records.slice(0, PAGE) : [];
  const applied = [], conflicts = [], refused = [];
  for (const rec of list) {
    if (!rec || !KINDS[rec.kind] || !rec.id || String(rec.id).length > 300) { refused.push({ id: rec && rec.id, kind: rec && rec.kind, reason: 'BAD_RECORD' }); continue; }
    const kind = rec.kind, id = String(rec.id);
    /* 4.71.0 (audit, C3) — only the masters the application has */
    if (kind === 'master' && !IS_MASTER[id]) { refused.push({ id, kind: 'master', reason: 'UNKNOWN_MASTER' }); continue; }
    let bodyText = rec.deleted ? null : JSON.stringify(rec.body == null ? null : rec.body);
    if (bodyText && bodyText.length > MAX_BODY) { refused.push({ id, kind, reason: 'TOO_LARGE' }); continue; }

    const cur = (await q(`SELECT seq, body, owner_id, deleted FROM sync_records WHERE company_id = $1 AND kind = $2 AND id = $3`,
      [companyId, kind, id]))[0] || null;
    let deleted = rec.deleted === true, trimmed = false;

    /* 4.66.3 — prices, constants and the company details are changed by an
       ADMINISTRATOR; anybody else asks through an approval. The application
       has always held these back from other people's pushes — the service
       now refuses them too, so the rule does not rest on the client. */
    if (kind === 'master' && ADMIN_ONLY_MASTERS[id] && user.role !== 'ADMIN') { refused.push({ id, kind, reason: 'ADMIN_ONLY' }); continue; }
    if (kind === 'master') {
      /* A stale push — the client last saw seq N, the server is past it,
         and the bodies differ — comes back as a conflict carrying the
         current copy. The client merges and pushes again. An identical
         body is not a conflict, whatever the seqs say. */
      const base = rec.baseSeq == null ? null : Number(rec.baseSeq);
      if (cur && base != null && Number(cur.seq) > base && !cur.deleted && JSON.stringify(cur.body) !== bodyText) {
        conflicts.push({ kind, id, seq: Number(cur.seq), body: cur.body, reason: 'STALE' });
        continue;
      }
      /* 4.71.0 (audit, C4) — the approvals and who-made-what, for anybody but an administrator: the
         company's copy plus what they may add (see limitApprovals). Taking the whole list away is read as
         taking back their own waiting requests and nothing else. What is stored is written with a fresh seq
         even when nothing they sent was kept, so their own computer pulls the company's copy back. */
      if (LIMITED_MASTERS[id] && user.role !== 'ADMIN') {
        const stored = cur && !cur.deleted ? cur.body : null;
        const sentBody = rec.deleted ? {} : rec.body;
        const kept = LIMITED_MASTERS[id](user, stored, sentBody);
        /* compared key-order-blind: the stored copy comes back from JSONB with its keys re-ordered */
        if (canon(kept) !== canon(sentBody)) trimmed = true;
        bodyText = JSON.stringify(kept);
        deleted = false;
      }
    } else if (MKT_KINDS[kind]) {
      /* 4.68.0 — marketing. Whoever is given an enquiry may work on it (a follow-up by the person it is assigned
         to, the manager's note); only its owner, an administrator or scope ALL may delete it. */
      if (cur && !cur.deleted && cur.owner_id != null && Number(cur.owner_id) !== Number(user.id)) {
        const may = rec.deleted ? (user.role === 'ADMIN' || user.scope === 'ALL') : mktCanSee(user, { kind, owner_id: cur.owner_id, body: cur.body });
        if (!may) { refused.push({ id, kind, reason: 'NOT_YOURS' }); continue; }
      }
      if (kind === 'enquiry' && !rec.deleted && rec.body && rec.body.enquiryNumber) {
        const n = String(rec.body.enquiryNumber);
        const clash = await q(
          `SELECT id FROM sync_records WHERE company_id = $1 AND kind = 'enquiry' AND deleted = false
             AND id <> $2 AND body->>'enquiryNumber' = $3 LIMIT 1`, [companyId, id, n]);
        if (clash.length) {
          conflicts.push({ kind, id, reason: 'NUMBER_TAKEN', enquiryNumber: n, suggested: await suggestNext(companyId, 'enquiry', 'enquiryNumber', n) });
          continue;
        }
      }
    } else {
      /* Owned records. Someone with scope OWN cannot touch what another
         person owns; someone with scope ALL can (last save wins). */
      if (cur && cur.owner_id != null && Number(cur.owner_id) !== Number(user.id) && user.scope !== 'ALL') {
        refused.push({ id, kind, reason: 'NOT_YOURS' }); continue;
      }
      if (kind === 'calc' && !rec.deleted) {
        const n = calcNumberOf(rec.body);
        if (n) {
          const clash = await q(
            `SELECT id FROM sync_records WHERE company_id = $1 AND kind = 'calc' AND deleted = false
               AND id <> $2 AND body->>'calcNumber' = $3 LIMIT 1`, [companyId, id, n]);
          if (clash.length) {
            conflicts.push({ kind, id, reason: 'NUMBER_TAKEN', calcNumber: n, suggested: await suggestNumber(companyId, n) });
            continue;
          }
        }
      }
    }

    /* 4.70.4 — "keep version" (owner 2026-09-30): a quotation, an enquiry or a customer pushed against the seq this
       client last saw (baseSeq), when the company's copy has moved on since and differs, comes back as a STALE conflict
       carrying the current copy. The client folds the two sets of changes together and keeps the other side's differing
       values as a version, so a change made on a phone and one made on a computer at the same time are both kept.
       A push without baseSeq (an older client) is taken as before: the last save wins. */
    if (STALE_KINDS[kind] && !rec.deleted && cur && !cur.deleted && rec.baseSeq != null &&
        Number(cur.seq) > Number(rec.baseSeq) && JSON.stringify(cur.body) !== bodyText) {
      conflicts.push({ kind, id, seq: Number(cur.seq), body: cur.body, reason: 'STALE' });
      continue;
    }

    const owner = kind === 'master' ? null : (cur && cur.owner_id != null ? cur.owner_id : user.id);
    const rows = await q(
      `INSERT INTO sync_records (company_id, kind, id, body, owner_id, deleted, updated_at, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now(), $7)
       ON CONFLICT (company_id, kind, id) DO UPDATE
         SET body = EXCLUDED.body, deleted = EXCLUDED.deleted, updated_at = now(), updated_by = EXCLUDED.updated_by,
             owner_id = COALESCE(sync_records.owner_id, EXCLUDED.owner_id),
             seq = nextval(pg_get_serial_sequence('sync_records', 'seq'))
       RETURNING seq, owner_id`,
      [companyId, kind, id, bodyText, owner, deleted, user.id]);
    const done = { kind, id, seq: Number(rows[0].seq), ownerId: rows[0].owner_id == null ? null : Number(rows[0].owner_id) };
    /* 4.71.0 — part of what was sent was left out (C4): the next pull brings the company's copy */
    if (trimmed) done.trimmed = true;
    applied.push(done);
  }
  return { applied, conflicts, refused, me: describeUser(user) };
}

/** For the console: how many people, and who the admins are. */
export async function usersSummary(companyId) {
  const rows = await q(
    `SELECT COUNT(*)::int AS n,
            COALESCE(string_agg(CASE WHEN role = 'ADMIN' THEN name END, ', ' ORDER BY name_key), '') AS admins,
            /* 4.42.0 — the addresses of the people who are switched on, so
               a circular can be built from the company list alone instead
               of asking the service once per company. */
            COALESCE(string_agg(email, ', ' ORDER BY name_key) FILTER (WHERE email IS NOT NULL), '') AS emails
       FROM company_users WHERE company_id = $1 AND active = true`, [companyId]);
  return {
    count: Number(rows[0].n) || 0,
    admins: rows[0].admins || '',
    emails: rows[0].emails || ''
  };
}

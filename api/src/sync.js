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
import { q, logEvent } from './db.js';

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
function validPin(pin) {
  const p = String(pin == null ? '' : pin);
  return p.length >= 4 && p.length <= 64;
}
export function nameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** What the application is told about a person. Never the hash. */
export function describeUser(u) {
  if (!u) return null;
  return {
    id: Number(u.id), name: u.name,
    role: u.role === 'ADMIN' ? 'ADMIN' : 'USER',
    scope: u.scope === 'ALL' ? 'ALL' : 'OWN',
    permissions: (u.permissions && typeof u.permissions === 'object') ? u.permissions : null,
    active: u.active !== false,
    lastLoginAt: u.last_login_at || null,
    createdAt: u.created_at || null
  };
}

export async function userById(companyId, id) {
  if (!companyId || !id) return null;
  const rows = await q(`SELECT * FROM company_users WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows.length ? rows[0] : null;
}

/* ---- sign in ---------------------------------------------------------- */
export async function login(companyId, { name, pin }) {
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
  if (!u || !pinMatches(pin, u.pin_hash)) {
    await logEvent(null, 'LOGIN_REFUSED', { companyId, name: key });
    return { httpStatus: 401, body: { error: 'BAD_LOGIN', message: 'That name and PIN do not match. Ask your Nexora administrator if you have forgotten your PIN.' } };
  }
  if (u.active === false) {
    return { httpStatus: 403, body: { error: 'USER_INACTIVE', message: 'This user has been switched off by your Nexora administrator.' } };
  }
  await q(`UPDATE company_users SET last_login_at = now() WHERE id = $1`, [u.id]);
  await logEvent(null, 'LOGIN', { companyId, userId: u.id });
  return { httpStatus: 200, body: { user: describeUser(u) } };
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
export async function ensureAdmin(companyId, { name, pin }) {
  const key = nameKey(name);
  if (!key) return { error: 'A name is required.' };
  if (!validPin(pin)) return { error: 'A PIN of at least 4 characters is required.' };
  const existing = await q(`SELECT * FROM company_users WHERE company_id = $1 AND name_key = $2`, [companyId, key]);
  if (existing.length) {
    await q(`UPDATE company_users SET pin_hash = $2, role = 'ADMIN', scope = 'ALL', active = true, name = $3
              WHERE id = $1`, [existing[0].id, hashPin(pin), String(name).trim()]);
    await logEvent(null, 'ADMIN_COMPANY_ADMINUSER', { companyId, userId: existing[0].id, reset: true });
    return { ok: true, user: describeUser((await userById(companyId, existing[0].id))), reset: true };
  }
  const rows = await q(
    `INSERT INTO company_users (company_id, name, name_key, pin_hash, role, scope, active)
     VALUES ($1, $2, $3, $4, 'ADMIN', 'ALL', true) RETURNING *`,
    [companyId, String(name).trim(), key, hashPin(pin)]);
  await logEvent(null, 'ADMIN_COMPANY_ADMINUSER', { companyId, userId: rows[0].id, reset: false });
  return { ok: true, user: describeUser(rows[0]), reset: false };
}

/** What a signed-in person may do to the user list. An ADMIN manages
 *  everyone; anyone may change their own PIN and nothing else. */
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
       body.permissions && typeof body.permissions === 'object' ? JSON.stringify(body.permissions) : null]);
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
  return { httpStatus: 200, body: { ok: true, user: describeUser(await userById(companyId, id)) } };
}

/* ---- the records ------------------------------------------------------
   Three kinds:
     master   id = the application's storage key (e.g. nexora.rm.master.v1),
              body = that key's whole value. Shared by everyone.
     calc     id = the calculation's id, body = the record. Owned.
     bom      id = the calculation's id, body = the saved BOM. Owned with
              its calculation.
   Every write takes a fresh seq, so "everything since seq N" is exact. */
const KINDS = { master: true, calc: true, bom: true };
const PAGE = 200;
const MAX_BODY = 4 * 1024 * 1024;   // one record; a calculation with its trace is ~50 KB

function canSee(user, row) {
  if (row.kind === 'master') return true;
  if (user.scope === 'ALL') return true;
  return row.owner_id == null || Number(row.owner_id) === Number(user.id);
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

export async function pull(companyId, user, since, limit) {
  const from = Math.max(0, parseInt(since, 10) || 0);
  const lim = Math.min(PAGE, Math.max(1, parseInt(limit, 10) || PAGE));
  const rows = await q(
    `SELECT seq, kind, id, body, owner_id, deleted, updated_at, updated_by
       FROM sync_records WHERE company_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [companyId, from, lim + 1]);
  const more = rows.length > lim;
  const page = rows.slice(0, lim);
  const records = page.map((r) => {
    const visible = canSee(user, r);
    return {
      seq: Number(r.seq), kind: r.kind, id: r.id, deleted: r.deleted === true,
      ownerId: r.owner_id == null ? null : Number(r.owner_id),
      updatedAt: r.updated_at, updatedBy: r.updated_by == null ? null : Number(r.updated_by),
      body: r.deleted ? null : (visible ? r.body : (r.kind === 'calc' ? stubOf(r) : null)),
      stub: !visible && !r.deleted && r.kind === 'calc'
    };
  }).filter((r) => r.body !== null || r.deleted);
  const next = page.length ? Number(page[page.length - 1].seq) : from;
  return { records, next, more, me: describeUser(user) };
}

function calcNumberOf(body) {
  return body && typeof body === 'object' && body.calcNumber ? String(body.calcNumber) : null;
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

export async function push(companyId, user, records) {
  const list = Array.isArray(records) ? records.slice(0, PAGE) : [];
  const applied = [], conflicts = [], refused = [];
  for (const rec of list) {
    if (!rec || !KINDS[rec.kind] || !rec.id || String(rec.id).length > 300) { refused.push({ id: rec && rec.id, kind: rec && rec.kind, reason: 'BAD_RECORD' }); continue; }
    const kind = rec.kind, id = String(rec.id);
    const bodyText = rec.deleted ? null : JSON.stringify(rec.body == null ? null : rec.body);
    if (bodyText && bodyText.length > MAX_BODY) { refused.push({ id, kind, reason: 'TOO_LARGE' }); continue; }

    const cur = (await q(`SELECT seq, body, owner_id, deleted FROM sync_records WHERE company_id = $1 AND kind = $2 AND id = $3`,
      [companyId, kind, id]))[0] || null;

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

    const owner = kind === 'master' ? null : (cur && cur.owner_id != null ? cur.owner_id : user.id);
    const rows = await q(
      `INSERT INTO sync_records (company_id, kind, id, body, owner_id, deleted, updated_at, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now(), $7)
       ON CONFLICT (company_id, kind, id) DO UPDATE
         SET body = EXCLUDED.body, deleted = EXCLUDED.deleted, updated_at = now(), updated_by = EXCLUDED.updated_by,
             owner_id = COALESCE(sync_records.owner_id, EXCLUDED.owner_id),
             seq = nextval(pg_get_serial_sequence('sync_records', 'seq'))
       RETURNING seq, owner_id`,
      [companyId, kind, id, bodyText, owner, rec.deleted === true, user.id]);
    applied.push({ kind, id, seq: Number(rows[0].seq), ownerId: rows[0].owner_id == null ? null : Number(rows[0].owner_id) });
  }
  return { applied, conflicts, refused, me: describeUser(user) };
}

/** For the console: how many people, and who the admins are. */
export async function usersSummary(companyId) {
  const rows = await q(
    `SELECT COUNT(*)::int AS n,
            COALESCE(string_agg(CASE WHEN role = 'ADMIN' THEN name END, ', ' ORDER BY name_key), '') AS admins
       FROM company_users WHERE company_id = $1 AND active = true`, [companyId]);
  return { count: Number(rows[0].n) || 0, admins: rows[0].admins || '' };
}

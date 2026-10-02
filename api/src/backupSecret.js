/**
 * Nexora API — the company's backup password  (4.73.0, C19)
 * ----------------------------------------------------------------------
 * Owner 2026-10-02: a separate backup password; "admin can get that
 * passward from software also only admin".
 *
 * The administrator's computer makes the password (crypto random), shows it
 * once to be written down, encrypts the evening backup with it, and keeps it
 * HERE so that it can be read again — by an administrator, after their PIN:
 *
 *   POST /v1/backup/secret/set   {secret, pin?}  administrator only; replacing
 *                                one that is already kept needs {pin}
 *                                → {ok, setAt}
 *   POST /v1/backup/secret/show  {pin}           administrator only, the PIN
 *                                checked exactly as a sign-in checks it, with
 *                                the same lockout (lockout.js: three wrong and
 *                                the person is locked fifteen minutes — for
 *                                signing in too) → {secret, setAt}
 *   GET  /v1/backup/secret/state                 anybody signed in → {set, setAt}
 *
 * Kept LOCKED: AES-256-GCM under a key derived (HKDF-SHA256, info
 * 'nexora-backup-secret-v1') from the secret the service already signs its
 * tokens with (licence.js serviceKey) — so nothing new is set on Render, and
 * a copy of the database alone (a backup of it) gives no password away. The
 * company's id is bound in as the cipher's additional data, so a sealed
 * password moved to another company's row does not open. Without the token
 * secret nothing can be kept or read: 503 NOT_CONFIGURED.
 *
 * Never logged, never in a pull, a heartbeat, the console's listing or
 * /health: it lives in a table of its own (db.js backup_secrets) that only
 * this file reads, and the event log says only that it was set or shown, by
 * whom. A company erased takes it with it (admin.js PURGE_SQL).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { q, logEvent } from './db.js';
import { serviceKey } from './licence.js';
import { pinMatches, validPin } from './sync.js';
import { takeAttempt, failedAttempt, clearAttempts, lockedBody, attemptClock } from './lockout.js';

export const BACKUP_KEY_INFO = 'nexora-backup-secret-v1';
export const SECRET_MIN = 12;
export const SECRET_MAX = 200;

const NOT_CONFIGURED = { httpStatus: 503, body: { error: 'NOT_CONFIGURED',
  message: 'The Nexora service cannot keep a backup password just now — Nexora has been told. Keep the password you wrote down safe.' } };
const ADMIN_ONLY = { httpStatus: 403, body: { error: 'ADMIN_ONLY',
  message: 'Only your Nexora administrator can set or see the backup password.' } };

const keyOf = () => serviceKey(BACKUP_KEY_INFO);
const aad = (companyId) => Buffer.from('nexora-backup-secret|company:' + Number(companyId), 'utf8');
const isoOf = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());

/** The password locked for this company: 'v1.' iv . tag . ciphertext (base64), or null without a key. */
export function sealSecret(companyId, secret) {
  const key = keyOf();
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(companyId));
  const enc = Buffer.concat([c.update(String(secret), 'utf8'), c.final()]);
  return 'v1.' + iv.toString('base64') + '.' + c.getAuthTag().toString('base64') + '.' + enc.toString('base64');
}
/** The password back, or null (no key, another company's, altered, or locked under another token secret). */
export function openSecret(companyId, sealed) {
  try {
    const key = keyOf();
    const p = String(sealed || '').split('.');
    if (!key || p.length !== 4 || p[0] !== 'v1') return null;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(p[1], 'base64'));
    d.setAAD(aad(companyId));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

/** A password as the desktop makes it: text of SECRET_MIN..SECRET_MAX characters, no control characters, no
 *  space at either end. Kept exactly as sent — a backup is opened with exactly what it was locked with. */
export function validSecret(s) {
  return typeof s === 'string' && s.length >= SECRET_MIN && s.length <= SECRET_MAX && s === s.trim() && !/[\u0000-\u001f\u007f]/.test(s);
}

/** The administrator's own PIN, checked as a sign-in checks it (sync.js login) and counted against the same lock.
 *  → null when right, else the refusal to send. */
async function pinRefused(companyId, user, pin, why) {
  if (!validPin(pin)) {
    return { httpStatus: 400, body: { error: 'PIN_REQUIRED', message: why === 'replace'
      ? 'A backup password is already kept — enter your PIN to replace it.' : 'Enter your PIN.' } };
  }
  const u = (await q(`SELECT id, pin_hash FROM company_users WHERE id = $1 AND company_id = $2`, [user.id, companyId]))[0];
  if (!u) return ADMIN_ONLY;
  const clock = attemptClock();
  const turn = await takeAttempt('pin', u.id);
  if (!turn.ok) {
    await logEvent(null, 'BACKUP_SECRET_LOCKED', { companyId, userId: Number(u.id), why });
    return { httpStatus: 423, body: lockedBody('pin', turn.retryAfter) };
  }
  const right = pinMatches(pin, u.pin_hash);
  clock();
  if (!right) {
    await logEvent(null, 'BACKUP_SECRET_PIN_REFUSED', { companyId, userId: Number(u.id), why });
    const lockedFor = await failedAttempt('pin', u.id, turn.tries);
    if (lockedFor) {
      await logEvent(null, 'BACKUP_SECRET_LOCKED', { companyId, userId: Number(u.id), why });
      return { httpStatus: 423, body: lockedBody('pin', lockedFor) };
    }
    return { httpStatus: 401, body: { error: 'BAD_PIN', message: 'That PIN is not right. Three wrong PINs lock your sign-in for fifteen minutes.' } };
  }
  await clearAttempts('pin', u.id);
  return null;
}

/** GET /v1/backup/secret/state — anybody signed in: is one kept, and since when. */
export async function secretState(companyId) {
  const row = (await q(`SELECT FLOOR(EXTRACT(EPOCH FROM set_at) * 1000)::bigint AS ms FROM backup_secrets WHERE company_id = $1`, [companyId]))[0];
  return { httpStatus: 200, body: { set: !!row, setAt: row ? isoOf(row.ms) : null } };
}

/** POST /v1/backup/secret/set {secret, pin?} */
export async function setSecret(companyId, user, body) {
  if (!user || user.role !== 'ADMIN') return ADMIN_ONLY;
  if (!keyOf()) return NOT_CONFIGURED;
  const b = body && typeof body === 'object' ? body : {};
  if (!validSecret(b.secret)) {
    return { httpStatus: 400, body: { error: 'BAD_SECRET',
      message: 'The backup password must be ' + SECRET_MIN + ' to ' + SECRET_MAX + ' characters, with no spaces at either end.' } };
  }
  const had = (await q(`SELECT 1 FROM backup_secrets WHERE company_id = $1`, [companyId])).length > 0;
  if (had) {
    const refused = await pinRefused(companyId, user, b.pin, 'replace');
    if (refused) return refused;
  }
  const sealed = sealSecret(companyId, b.secret);
  if (!sealed) return NOT_CONFIGURED;
  /* the first one is only ever INSERTED: two first ones at the same moment cannot replace each other without a PIN */
  const rows = had
    ? await q(`INSERT INTO backup_secrets (company_id, secret_enc, set_at, set_by) VALUES ($1, $2, now(), $3)
               ON CONFLICT (company_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, set_at = now(), set_by = EXCLUDED.set_by
               RETURNING FLOOR(EXTRACT(EPOCH FROM set_at) * 1000)::bigint AS ms`, [companyId, sealed, user.id])
    : await q(`INSERT INTO backup_secrets (company_id, secret_enc, set_at, set_by) VALUES ($1, $2, now(), $3)
               ON CONFLICT (company_id) DO NOTHING
               RETURNING FLOOR(EXTRACT(EPOCH FROM set_at) * 1000)::bigint AS ms`, [companyId, sealed, user.id]);
  if (!rows.length) {
    return { httpStatus: 400, body: { error: 'PIN_REQUIRED', message: 'A backup password was kept a moment ago — enter your PIN to replace it.' } };
  }
  await logEvent(null, 'BACKUP_SECRET_SET', { companyId, by: Number(user.id), replaced: had });
  return { httpStatus: 200, body: { ok: true, setAt: isoOf(rows[0].ms) } };
}

/** POST /v1/backup/secret/show {pin} */
export async function showSecret(companyId, user, body) {
  if (!user || user.role !== 'ADMIN') return ADMIN_ONLY;
  if (!keyOf()) return NOT_CONFIGURED;
  const row = (await q(`SELECT secret_enc, FLOOR(EXTRACT(EPOCH FROM set_at) * 1000)::bigint AS ms FROM backup_secrets WHERE company_id = $1`, [companyId]))[0];
  if (!row) return { httpStatus: 404, body: { error: 'NO_SECRET', message: 'No backup password is kept for this company yet — set one up first.' } };
  const refused = await pinRefused(companyId, user, (body && typeof body === 'object') ? body.pin : undefined, 'show');
  if (refused) return refused;
  const secret = openSecret(companyId, row.secret_enc);
  if (secret == null) {
    return { httpStatus: 409, body: { error: 'UNREADABLE',
      message: 'The backup password kept for this company can no longer be read (the service’s key has changed). Use the one you wrote down, and set up a new one.' } };
  }
  await logEvent(null, 'BACKUP_SECRET_SHOWN', { companyId, by: Number(user.id) });
  return { httpStatus: 200, body: { secret, setAt: isoOf(row.ms) } };
}

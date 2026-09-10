/**
 * Nexora API — the trial clock and the token
 * ----------------------------------------------------------------------
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *   The clock is the SERVER'S clock. Nothing the client says about time
 *   is ever believed, and nothing about a licence is ever computed from
 *   a date the client sent.
 *
 * That is what makes the three classic attacks pointless:
 *
 *   set the PC's date back    the PC's date is never read
 *   delete AppData, reinstall the device is already in the table, so it
 *                             gets its ORIGINAL expiry back, not a new one
 *   run it on a fresh VM      a new device, which is a new signup — rate
 *                             limited, visible in the admin console, and
 *                             closable with signups_open = no
 *
 * The token is a compact signed statement, not a session: it says who the
 * device is and when the statement stops being trustworthy. It is short
 * lived on purpose — a stolen token is worth 24 hours, and every call that
 * matters re-reads the licence row anyway.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { q, getSettings, logEvent } from './db.js';

const SECRET = process.env.NEXORA_TOKEN_SECRET || '';
const TOKEN_TTL_SEC = 24 * 60 * 60;

/* ---- token ---------------------------------------------------------- */
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sign(payloadB64) {
  return b64u(createHmac('sha256', SECRET).update(payloadB64).digest());
}

export function issueToken(lic) {
  const body = {
    d: lic.device_id,
    s: lic.state,
    x: Math.floor(new Date(lic.expires_at).getTime() / 1000),  // licence expiry
    e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC           // token expiry
  };
  const p = b64u(JSON.stringify(body));
  return p + '.' + sign(p);
}

export function readToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const expect = Buffer.from(sign(p));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  let body;
  try { body = JSON.parse(unb64u(p).toString('utf8')); } catch (e) { return null; }
  if (!body || !body.d) return null;
  if (Math.floor(Date.now() / 1000) > Number(body.e || 0)) return null;   // token stale
  return body;
}

/* ---- licence state -------------------------------------------------- */
/** The single place a licence turns into an answer. Always derived from
 *  the row and the server's own now() — never from anything sent in. */
export function describe(row, settings) {
  const now = Date.now();
  const exp = new Date(row.expires_at).getTime();
  const msLeft = exp - now;
  const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));

  let state = row.state;
  if (state === 'REVOKED') {
    return { state: 'REVOKED', canCalculate: false, daysLeft: 0, mode: 'HARDSTOP',
      expiresAt: row.expires_at,
      message: 'This installation has been withdrawn. Contact Nexora to restore access.' };
  }
  if (state === 'LICENSED') {
    /* A licence can also carry an end date (an annual subscription). Past
       it, it behaves like an expired trial rather than silently lapsing. */
    if (msLeft <= 0) {
      return { state: 'EXPIRED', wasLicensed: true, canCalculate: false, daysLeft: 0,
        mode: settings.expiredMode, expiresAt: row.expires_at,
        message: 'Your licence period has ended. Renew to continue calculating.' };
    }
    return { state: 'LICENSED', canCalculate: true, daysLeft, mode: 'FULL',
      expiresAt: row.expires_at, message: null };
  }
  // TRIAL
  if (msLeft <= 0) {
    return { state: 'EXPIRED', canCalculate: false, daysLeft: 0, mode: settings.expiredMode,
      expiresAt: row.expires_at,
      message: settings.expiredMode === 'READONLY'
        ? 'Your 7-day trial has ended. You can still open and print saved calculations — new calculations need a licence.'
        : 'Your 7-day trial has ended. Contact Nexora for a licence to continue.' };
  }
  return { state: 'TRIAL', canCalculate: true, daysLeft, mode: 'FULL',
    expiresAt: row.expires_at,
    message: daysLeft <= 2
      ? 'Your trial ends in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
      : null };
}

/* ---- activation ----------------------------------------------------- */
const DEVICE_RE = /^[a-f0-9]{16,64}$/i;

export async function activate({ deviceId, deviceName, company, email, appVersion }) {
  if (!DEVICE_RE.test(String(deviceId || ''))) {
    return { httpStatus: 400, body: { error: 'BAD_DEVICE_ID',
      message: 'This installation could not identify the computer it is running on.' } };
  }
  const settings = await getSettings();

  const existing = await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]);
  if (existing.length) {
    /* THE REINSTALL RULE. The row already exists, so the original expiry
       stands. Details are refreshed; the clock is not. */
    const row = existing[0];
    await q(`UPDATE licences
               SET last_seen_at = now(), seen_count = seen_count + 1,
                   app_version  = COALESCE($2, app_version),
                   device_name  = COALESCE(NULLIF($3,''), device_name),
                   company      = COALESCE(NULLIF($4,''), company),
                   email        = COALESCE(NULLIF($5,''), email)
             WHERE device_id = $1`,
      [deviceId, appVersion || null, deviceName || '', company || '', email || '']);
    await logEvent(deviceId, 'REACTIVATE', { appVersion });
    const fresh = (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];
    const lic = describe(fresh, settings);
    return { httpStatus: 200, body: { token: issueToken(fresh), licence: lic, returning: true } };
  }

  if (!settings.signupsOpen) {
    return { httpStatus: 403, body: { error: 'SIGNUPS_CLOSED',
      message: 'New trials are not being issued at the moment. Please contact Nexora.' } };
  }

  const rows = await q(
    `INSERT INTO licences (device_id, device_name, company, email, state,
                           trial_started_at, expires_at, app_version, last_seen_at, seen_count)
     VALUES ($1,$2,$3,$4,'TRIAL', now(), now() + make_interval(days => $5::int), $6, now(), 1)
     ON CONFLICT (device_id) DO NOTHING
     RETURNING *`,
    [deviceId, deviceName || null, company || null, email || null, settings.trialDays, appVersion || null]);

  /* A race on first launch could lose the INSERT; read the winner. */
  const row = rows.length ? rows[0]
    : (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];

  await logEvent(deviceId, 'ACTIVATE', { company, email, appVersion, trialDays: settings.trialDays });
  return { httpStatus: 200, body: { token: issueToken(row), licence: describe(row, settings), returning: false } };
}

/** Every protected call goes through here. Re-reads the row every time —
 *  a token says who you are, the row says what you may do. */
export async function authorise(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const body = readToken(token);
  if (!body) {
    return { ok: false, httpStatus: 401,
      error: { error: 'NOT_ACTIVATED', message: 'This installation needs to be activated again.' } };
  }
  const rows = await q(`SELECT * FROM licences WHERE device_id = $1`, [body.d]);
  if (!rows.length) {
    return { ok: false, httpStatus: 401,
      error: { error: 'UNKNOWN_DEVICE', message: 'This installation is no longer registered.' } };
  }
  const settings = await getSettings();
  const lic = describe(rows[0], settings);
  return { ok: true, row: rows[0], licence: lic, settings };
}

export async function touch(deviceId, appVersion) {
  try {
    await q(`UPDATE licences SET last_seen_at = now(), seen_count = seen_count + 1,
                                 app_version = COALESCE($2, app_version)
             WHERE device_id = $1`, [deviceId, appVersion || null]);
  } catch (e) { /* never fail a request over a counter */ }
}

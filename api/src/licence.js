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
import { createHmac, timingSafeEqual, randomInt } from 'node:crypto';
import { q, getSettings, logEvent } from './db.js';

const SECRET = process.env.NEXORA_TOKEN_SECRET || '';
const TOKEN_TTL_SEC = 24 * 60 * 60;

/* ---- licence keys ----------------------------------------------------
   NEX-4K2M-9QTX-7BWH. Read over the phone, typed by a plant clerk, so the
   alphabet leaves out every pair that gets confused by eye or by ear:
   no O/0, no I/1/L, no S/5, no B/8, no U/V. */
const KEY_ALPHABET = 'ACDEFGHJKMNPQRTWXY34679';

export function newLicenceKey() {
  const block = () => Array.from({ length: 4 },
    () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join('');
  return 'NEX-' + block() + '-' + block() + '-' + block();
}

/** Accepts anything a human might type — spaces, lower case, no hyphens,
 *  a pasted key with a stray newline — and returns the canonical form.
 *  Returns '' when it cannot possibly be a key. */
export function normaliseKey(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  const body = s.startsWith('NEX') ? s.slice(3) : s;
  if (body.length !== 12) return '';
  return 'NEX-' + body.slice(0, 4) + '-' + body.slice(4, 8) + '-' + body.slice(8, 12);
}

/** What the app is allowed to display. The full key is what lets another
 *  machine take a seat, so it is never echoed back to a device. */
function maskKey(k) {
  const s = String(k || '');
  return s.length > 8 ? s.slice(0, 8) + '-****-****' : s;
}

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
    c: lic.company_id || null,                                 // 4.0.0 — who this device belongs to
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

/* ---- companies -------------------------------------------------------
   4.0.0. THE COMPANY IS THE LICENCE. A device row is now only "which
   machine, which seat"; how long and whether at all is the company's
   answer. That is what makes several machines behave as one licence:
   extend the company and all five extend, suspend it and all five stop,
   with no per-device bookkeeping to get out of step.

   Devices created before 4.0.0 have no company. They are given a private
   one on their next call, carrying THEIR OWN existing expiry across, so
   nobody's clock moves (rule #28, #29). */

export async function companyOf(row) {
  if (!row || !row.company_id) return null;
  const rows = await q(`SELECT * FROM companies WHERE id = $1`, [row.company_id]);
  return rows.length ? rows[0] : null;
}

async function seatsUsed(companyId) {
  const rows = await q(
    `SELECT COUNT(*)::int AS n FROM licences WHERE company_id = $1 AND state <> 'REVOKED'`,
    [companyId]);
  return rows.length ? Number(rows[0].n) : 0;
}

async function nextSeat(companyId) {
  const rows = await q(
    `SELECT COALESCE(MAX(seat_no), 0)::int AS m FROM licences WHERE company_id = $1`, [companyId]);
  return (rows.length ? Number(rows[0].m) : 0) + 1;
}

/* ---- 4.3.0 — USAGE ---------------------------------------------------
   Each machine reports what IT has committed; the licence's figure is the
   SUM across its seats. Computed on read rather than kept as a running
   total on the company, so it can never disagree with the rows it is made
   of — which is the failure that makes a dashboard figure worse than no
   figure at all.

   The report is MONOTONIC per device: GREATEST(stored, reported). A count
   that could go down would make the limit meaningless, because
   reinstalling would clear it. A reinstalled machine reporting 0
   therefore keeps the count the server already holds. */
export async function reportUsage(deviceId, usage) {
  if (!deviceId || !usage) return;
  const txn = Math.max(0, Math.floor(Number(usage.txnCount) || 0));
  const mins = Math.max(0, Math.floor(Number(usage.usageMinutes) || 0));
  if (!txn && !mins) return;
  try {
    await q(`UPDATE licences
                SET txn_count     = GREATEST(txn_count, $2),
                    usage_minutes = GREATEST(usage_minutes, $3)
              WHERE device_id = $1`, [deviceId, txn, mins]);
  } catch (e) { /* never fail a request over a counter */ }
}

/** What this LICENCE has used, across every seat on it. */
export async function companyUsage(companyId) {
  if (!companyId) return { txnUsed: 0, usageMinutes: 0, seatsReporting: 0 };
  try {
    const rows = await q(
      `SELECT COALESCE(SUM(txn_count), 0)::int     AS txns,
              COALESCE(SUM(usage_minutes), 0)::int AS mins,
              COUNT(*) FILTER (WHERE txn_count > 0)::int AS reporting
         FROM licences WHERE company_id = $1`, [companyId]);
    const r = rows.length ? rows[0] : {};
    return {
      txnUsed: Number(r.txns) || 0,
      usageMinutes: Number(r.mins) || 0,
      seatsReporting: Number(r.reporting) || 0
    };
  } catch (e) {
    return { txnUsed: 0, usageMinutes: 0, seatsReporting: 0 };
  }
}

/** A private one-seat company for a demo, or for an older device being
 *  brought forward. `expiresAt` is passed in when carrying an existing
 *  clock across so that migration never grants or removes a single day. */
async function createDemoCompany({ name, email, trialDays, graceDays, expiresAt }) {
  /* A key collision is astronomically unlikely (23^12) but a UNIQUE
     violation would surface as a 500 on someone's first launch, so retry
     rather than gamble. */
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = newLicenceKey();
    try {
      const rows = await q(
        `INSERT INTO companies (name, licence_key, email, state, seats, grace_days, is_demo, expires_at)
         VALUES ($1, $2, $3, 'DEMO', 1, $4, true,
                 COALESCE($6::timestamptz, now() + make_interval(days => $5::int)))
         RETURNING *`,
        [name || 'Demo', key, email || null, graceDays, trialDays, expiresAt || null]);
      if (rows.length) return rows[0];
    } catch (e) {
      if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error('Could not allocate a licence key.');
}

/** Backfill for a pre-4.0.0 device: its own expiry becomes its company's,
 *  so the migration is invisible to whoever is using it. */
async function adoptOrphan(row) {
  const settings = await getSettings();
  const co = await createDemoCompany({
    name: row.company || row.device_name || 'Nexora user',
    email: row.email,
    trialDays: settings.trialDays,
    graceDays: settings.demoGraceDays,
    expiresAt: row.expires_at
  });
  if (row.state === 'LICENSED') {
    await q(`UPDATE companies SET state = 'LICENSED', is_demo = false WHERE id = $1`, [co.id]);
    co.state = 'LICENSED'; co.is_demo = false;
  }
  await q(`UPDATE licences SET company_id = $2, seat_no = 1 WHERE device_id = $1`, [row.device_id, co.id]);
  await logEvent(row.device_id, 'COMPANY_BACKFILL', { companyId: co.id, key: co.licence_key });
  row.company_id = co.id;
  row.seat_no = 1;
  return co;
}

/* ---- licence state --------------------------------------------------- */
/**
 * The single place a licence turns into an answer. Always derived from
 * the rows and the server's own now() — never from anything sent in.
 *
 * `offlineMinutes` is 4.0.0's replacement for the client's old local
 * graceDays setting. It is how long the app may keep working on this
 * answer without being able to ask again, and it is decided HERE:
 *
 *   grace_days > 0   a licensed customer with a plant that loses its line
 *   grace_days = 0   the default, and every demo — the answer is good for
 *                    one working window (caching, not grace), then the
 *                    app stops until it can ask again.
 */
/* 4.3.0 — the transaction limit, applied to whatever describeState()
   decided. It is a WRAPPER rather than another branch inside the state
   machine for two reasons:

     · every return path goes through it, so a state added later cannot
       accidentally slip past the limit;
     · it can only ever make the answer NARROWER. If the licence is
       already refused — revoked, suspended, expired — that refusal stands
       and its message is kept, because "your licence was withdrawn" is
       the useful thing to say, not "you are out of transactions".

   With no limit sold (txn_limit 0, the default) it adds three figures for
   the dashboard and changes no decision at all. */
function applyTxnLimit(res, company, usage) {
  const limit = company ? Math.max(0, Number(company.txn_limit) || 0) : 0;
  const used = usage ? Math.max(0, Number(usage.txnUsed) || 0) : 0;
  const out = {
    ...res,
    txnLimit: limit,
    txnUsed: used,
    txnRemaining: limit > 0 ? Math.max(0, limit - used) : null,
    usageMinutes: usage ? Math.max(0, Number(usage.usageMinutes) || 0) : 0
  };
  if (!out.canCalculate) return out;            // already refused, for a better reason
  if (limit <= 0 || used < limit) return out;   // no limit, or inside it

  /* READONLY, not HARDSTOP. Reaching a transaction limit is a commercial
     event, not a withdrawal: everything already saved must still open,
     read and print. Only NEW committed records stop. */
  return {
    ...out,
    canCalculate: false,
    mode: 'READONLY',
    limitReached: true,
    message: 'This licence has used all ' + limit + ' of its transactions. ' +
             'Saved calculations can still be opened and printed — contact Nexora to raise the limit.'
  };
}

export function describe(row, company, settings, usage) {
  return applyTxnLimit(describeState(row, company, settings), company, usage);
}

function describeState(row, company, settings) {
  const now = Date.now();
  const co = company || null;

  /* The company's clock wins where there is one. */
  const expiresAt = co ? co.expires_at : row.expires_at;
  const msLeft = new Date(expiresAt).getTime() - now;
  const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));

  const graceDays = co ? Math.max(0, Number(co.grace_days) || 0) : settings.demoGraceDays;
  const offlineMinutes = graceDays > 0 ? graceDays * 1440 : settings.sessionMinutes;

  const profile = co ? {
    name: co.name,
    gstin: co.gstin || '',
    key: maskKey(co.licence_key),
    seats: Number(co.seats) || 1,
    seatNo: Number(row.seat_no) || null,
    isDemo: co.is_demo === true,
    graceDays
  } : null;

  const base = { expiresAt, offlineMinutes, company: profile };

  /* Order matters: the narrowest refusal is checked first, so a revoked
     device inside a healthy company is still refused. */
  if (row.state === 'REVOKED') {
    return { ...base, state: 'REVOKED', canCalculate: false, daysLeft: 0, mode: 'HARDSTOP',
      message: 'This installation has been withdrawn. Contact Nexora to restore access.' };
  }
  if (co && co.state === 'SUSPENDED') {
    return { ...base, state: 'SUSPENDED', canCalculate: false, daysLeft: 0, mode: 'HARDSTOP',
      message: 'The licence for ' + co.name + ' has been suspended. Contact Nexora to restore it.' };
  }

  const licensed = co ? (co.state === 'LICENSED') : (row.state === 'LICENSED');

  if (licensed) {
    if (msLeft <= 0) {
      return { ...base, state: 'EXPIRED', wasLicensed: true, canCalculate: false, daysLeft: 0,
        mode: settings.expiredMode,
        message: 'Your licence period has ended. Renew to continue calculating.' };
    }
    return { ...base, state: 'LICENSED', canCalculate: true, daysLeft, mode: 'FULL',
      message: daysLeft <= 14
        ? 'Your licence renews in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
        : null };
  }

  // DEMO / TRIAL
  if (msLeft <= 0) {
    return { ...base, state: 'EXPIRED', canCalculate: false, daysLeft: 0, mode: settings.expiredMode,
      message: settings.expiredMode === 'READONLY'
        ? 'Your ' + settings.trialDays + '-day demo has ended. You can still open and print what you saved — new calculations need a licence.'
        : 'Your ' + settings.trialDays + '-day demo has ended. Contact Nexora for a licence to continue.' };
  }
  return { ...base, state: 'TRIAL', canCalculate: true, daysLeft, mode: 'FULL',
    message: daysLeft <= 2
      ? 'Your demo ends in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
      : null };
}

/* ---- activation ----------------------------------------------------- */
const DEVICE_RE = /^[a-f0-9]{16,64}$/i;

export async function activate({ deviceId, deviceName, company, email, appVersion, licenceKey }) {
  if (!DEVICE_RE.test(String(deviceId || ''))) {
    return { httpStatus: 400, body: { error: 'BAD_DEVICE_ID',
      message: 'This installation could not identify the computer it is running on.' } };
  }
  const settings = await getSettings();

  /* A key was typed. Resolve it BEFORE anything else, so a wrong key is a
     clear refusal rather than a silent demo. */
  let keyed = null;
  const wanted = normaliseKey(licenceKey);
  if (String(licenceKey || '').trim() && !wanted) {
    return { httpStatus: 400, body: { error: 'BAD_KEY',
      message: 'That does not look like a Nexora licence key. It has the form NEX-XXXX-XXXX-XXXX.' } };
  }
  if (wanted) {
    const found = await q(`SELECT * FROM companies WHERE licence_key = $1`, [wanted]);
    if (!found.length) {
      await logEvent(deviceId, 'KEY_REJECTED', { key: wanted });
      return { httpStatus: 404, body: { error: 'UNKNOWN_KEY',
        message: 'That licence key is not recognised. Check it and try again, or contact Nexora.' } };
    }
    keyed = found[0];
    if (keyed.state === 'SUSPENDED') {
      return { httpStatus: 403, body: { error: 'COMPANY_SUSPENDED',
        message: 'The licence for ' + keyed.name + ' has been suspended. Contact Nexora to restore it.' } };
    }
  }

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
    let row2 = (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];

    /* MOVING A MACHINE ONTO A REAL LICENCE. A demo user who buys types the
       key into the same installation — it must take a seat in the real
       company and keep everything it already has. Seats are checked here
       too, or a customer with 5 seats could quietly activate 50. */
    if (keyed && Number(row2.company_id) !== Number(keyed.id)) {
      const used = await seatsUsed(keyed.id);
      if (used >= (Number(keyed.seats) || 1)) {
        return { httpStatus: 409, body: { error: 'NO_SEATS_LEFT',
          message: 'All ' + keyed.seats + ' licence' + (keyed.seats === 1 ? '' : 's') + ' for ' +
                   keyed.name + ' are already in use. Free one in the Nexora licence console, or ask for another.',
          seats: Number(keyed.seats) || 1, seatsUsed: used } };
      }
      const seat = await nextSeat(keyed.id);
      await q(`UPDATE licences SET company_id = $2, seat_no = $3, state = 'TRIAL' WHERE device_id = $1`,
        [deviceId, keyed.id, seat]);
      await logEvent(deviceId, 'JOIN_COMPANY', { companyId: keyed.id, seat, from: row2.company_id || null });
      row2 = (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];
    }

    let co = await companyOf(row2);
    if (!co) { co = await adoptOrphan(row2); row2 = (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0]; }

    await logEvent(deviceId, 'REACTIVATE', { appVersion, companyId: row2.company_id });
    /* 4.3.0 — activation reports the licence's usage too, so a machine
       that has hit the limit is told at activation rather than at its
       first save. */
    const usage2 = await companyUsage(row2.company_id || null);
    return { httpStatus: 200,
      body: { token: issueToken(row2), licence: describe(row2, co, settings, usage2), returning: true } };
  }

  /* ---- a machine seen for the first time ---------------------------- */
  let co = keyed;
  let seat = 1;

  if (co) {
    const used = await seatsUsed(co.id);
    if (used >= (Number(co.seats) || 1)) {
      return { httpStatus: 409, body: { error: 'NO_SEATS_LEFT',
        message: 'All ' + co.seats + ' licence' + (co.seats === 1 ? '' : 's') + ' for ' + co.name +
                 ' are already in use. Free one in the Nexora licence console, or ask for another.',
        seats: Number(co.seats) || 1, seatsUsed: used } };
    }
    seat = await nextSeat(co.id);
  } else {
    /* No key — the website demo. signups_open only ever gates THIS path,
       so closing it never locks out a paying customer adding a machine. */
    if (!settings.signupsOpen) {
      return { httpStatus: 403, body: { error: 'SIGNUPS_CLOSED',
        message: 'New demos are not being issued at the moment. Please contact Nexora.' } };
    }
    co = await createDemoCompany({
      name: company || deviceName || 'Demo',
      email,
      trialDays: settings.trialDays,
      graceDays: settings.demoGraceDays
    });
  }

  const rows = await q(
    `INSERT INTO licences (device_id, device_name, company, email, state,
                           trial_started_at, expires_at, app_version, last_seen_at, seen_count,
                           company_id, seat_no)
     VALUES ($1,$2,$3,$4,'TRIAL', now(), $6::timestamptz, $5, now(), 1, $7, $8)
     ON CONFLICT (device_id) DO NOTHING
     RETURNING *`,
    [deviceId, deviceName || null, company || null, email || null,
     appVersion || null, co.expires_at, co.id, seat]);

  /* A race on first launch could lose the INSERT; read the winner. */
  const row = rows.length ? rows[0]
    : (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];

  await logEvent(deviceId, 'ACTIVATE',
    { company, email, appVersion, companyId: co.id, seat, keyed: !!keyed });
  const usageNew = await companyUsage(row.company_id || null);
  return { httpStatus: 200,
    body: { token: issueToken(row), licence: describe(row, co, settings, usageNew), returning: false } };
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
  let row = rows[0];

  /* THE COMPANY IS READ FROM THE ROW, NEVER FROM THE TOKEN.
     The token carries a company id for logging and for cheap scoping, but
     an authorisation that trusted it would let a device keep the reach of
     a company it has since been moved out of. So the row decides, every
     call, exactly as the licence state does. */
  let co = await companyOf(row);
  if (!co) { co = await adoptOrphan(row); row = (await q(`SELECT * FROM licences WHERE device_id = $1`, [row.device_id]))[0]; }

  /* 4.3.0 — the licence's usage, read from the rows on every call for the
     same reason its state is: a figure the client sends cannot be trusted
     to decide whether the client may continue. */
  const usage = await companyUsage(row.company_id || null);

  const lic = describe(row, co, settings, usage);
  return {
    ok: true, row, company: co, licence: lic, settings, usage,
    /* Every data route must filter on this and nothing else. It comes
       from the database, so a client cannot ask for another company's
       rows by editing anything it holds. */
    companyId: row.company_id || null
  };
}

export async function touch(deviceId, appVersion) {
  try {
    await q(`UPDATE licences SET last_seen_at = now(), seen_count = seen_count + 1,
                                 app_version = COALESCE($2, app_version)
             WHERE device_id = $1`, [deviceId, appVersion || null]);
  } catch (e) { /* never fail a request over a counter */ }
}

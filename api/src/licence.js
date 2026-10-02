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
import { createHmac, createHash, timingSafeEqual, randomInt } from 'node:crypto';
import { q, getSettings, logEvent } from './db.js';
import { cleanPlan, featuresFor } from './plans.js';

const SECRET = process.env.NEXORA_TOKEN_SECRET || '';
const TOKEN_TTL_SEC = 24 * 60 * 60;
/* 4.71.0 (audit) — FAIL CLOSED. With NEXORA_TOKEN_SECRET missing the
   tokens used to be signed with an EMPTY key, and anybody who knew that
   could write themselves one. A secret that is missing or shorter than
   sixteen characters now signs nothing and accepts nothing: every route
   that needs a token answers 503 SERVICE_MISCONFIGURED until it is set
   on Render.
   (Lead's change before release: only a MISSING secret refuses. A short
   one still works — the live service's secret length cannot be read from
   here, and refusing it would stop every plant on the deploy — but it is
   reported loudly on every start so it gets lengthened on Render.) */
export const TOKEN_SECRET_MIN = 16;
export function tokenSecretOk() { return SECRET.length > 0; }
if (SECRET.length > 0 && SECRET.length < TOKEN_SECRET_MIN) {
  console.error('[nexora] NEXORA_TOKEN_SECRET is shorter than ' + TOKEN_SECRET_MIN + ' characters — lengthen it on Render (tokens stay valid until then)');
}
/* 4.72.0 (audit 83) — and said once at start when it is missing: every route that needs a token then answers 503 */
if (!SECRET.length) console.error('[nexora] NEXORA_TOKEN_SECRET is not set — every route that issues or reads a token answers 503 SERVICE_MISCONFIGURED until it is');
export const MISCONFIGURED = { error: 'SERVICE_MISCONFIGURED',
  message: 'The Nexora service is not set up correctly just now. Your work is safe on this computer — Nexora has been told; try again later.' };

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
export function maskKey(k) {
  const s = String(k || '');
  return s.length > 8 ? s.slice(0, 8) + '-****-****' : s;
}

/* 4.72.0 (audit 40) — A COMPANY NEXORA DELETES IS KEPT FOR THIS MANY DAYS.
   The console's Delete no longer erases a company on the spot: it is
   suspended and marked (companies.deleted_at), every computer and phone of it
   stops at its next check, and for these days the console can put it back
   exactly as it was. After them it is erased for good (admin.js
   purgeArchived). */
export const DELETED_KEEP_DAYS = 30;
/** A day as the plant reads it (India time), e.g. "2 Nov 2026". */
export function istDate(d) {
  const t = new Date(d);
  try { return t.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return t.toISOString().slice(0, 10); }
}
/** The day a deleted company is erased for good. */
export function purgeDayOf(deletedAt) {
  return new Date(new Date(deletedAt).getTime() + DELETED_KEEP_DAYS * 86400000);
}
/** What a machine is told when it tries to join a company that is suspended — or deleted. */
function suspendedJoin(co) {
  if (co.deleted_at) {
    return { httpStatus: 403, body: { error: 'COMPANY_DELETED',
      message: 'The licence for ' + co.name + ' was deleted by Nexora. Contact Nexora to restore it.' } };
  }
  return { httpStatus: 403, body: { error: 'COMPANY_SUSPENDED',
    message: 'The licence for ' + co.name + ' has been suspended. Contact Nexora to restore it.' } };
}

/* ---- token ---------------------------------------------------------- */
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sign(payloadB64) {
  if (!tokenSecretOk()) throw Object.assign(new Error('NEXORA_TOKEN_SECRET is not set'), { misconfigured: true });
  return b64u(createHmac('sha256', SECRET).update(payloadB64).digest());
}

export function issueToken(lic, userId) {
  const body = {
    d: lic.device_id,
    s: lic.state,
    c: lic.company_id || null,                                 // 4.0.0 — who this device belongs to
    u: userId ? Number(userId) : null,                         // 4.8.0 — the person signed in on it
    x: Math.floor(new Date(lic.expires_at).getTime() / 1000),  // licence expiry
    e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC           // token expiry
  };
  const p = b64u(JSON.stringify(body));
  return p + '.' + sign(p);
}

export function readToken(token) {
  if (!tokenSecretOk()) return null;
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

/* 4.72.0 (audit 10) — THE COMPANY ROW, KEPT TEN SECONDS FOR THE WAIT ONLY.
   Every machine holds /v1/sync/wait open and asks again every 25 s, and each
   of those used to read the company row afresh. A wait needs the row only to
   know whether a phone's plan still carries Nexora Mobile, so authorise() in
   its light form (index.js /v1/sync/wait) may use a copy up to ten seconds
   old. Every other call reads the row afresh, as it always has, and leaves
   that copy here for the waits. index.js forgets them all after any change
   made from the licence console (forgetCompanies). */
const CO_CACHE_MS = 10 * 1000;
const coCache = new Map();
export function forgetCompanies(id) {
  if (id === undefined || id === null) coCache.clear();
  else coCache.delete(Number(id));
}
export async function companyOf(row, opts) {
  if (!row || !row.company_id) return null;
  const id = Number(row.company_id);
  if (opts && opts.cached) {
    const hit = coCache.get(id);
    if (hit && Date.now() - hit.at < CO_CACHE_MS) return hit.co;
  }
  const rows = await q(`SELECT * FROM companies WHERE id = $1`, [row.company_id]);
  const co = rows.length ? rows[0] : null;
  if (co) {
    if (coCache.size > 2000) coCache.clear();
    coCache.set(id, { co, at: Date.now() });
  } else coCache.delete(id);
  return co;
}

/* 4.42.0 — A SEAT IS A PERSON. A COMPUTER IS NOT.

     "so now company is not seat only user are seat"

   Until now a seat was a MACHINE: joining a company took one, and the
   sixth computer of a five-seat licence was refused. That made sense
   while a machine could work on its own. It cannot any more — 4.42.0
   made a computer with nobody signed in read-only — so counting
   machines counts the wrong thing twice over: it charges a plant for a
   spare terminal in the weaving shed that can do nothing, and it lets
   five machines be shared by fifty people.

   So what is counted is the company's PEOPLE, which is what the plant
   is actually buying and what userCap() in sync.js has always enforced
   when a name is created. Machines are now merely numbered, so that a
   row in the console can be told from its neighbour. */
async function peopleOn(companyId) {
  const rows = await q(
    `SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1`, [companyId]);
  return rows.length ? Number(rows[0].n) : 0;
}

/** The next machine's number on this licence — an identifier, not a
 *  ration. Nothing is refused for running out of these. */
async function nextComputerNo(companyId) {
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
   therefore keeps the count the server already holds.

   4.72.0 (audit 7) — AND IT CLIMBS AT MOST SO FAR AT A TIME. One report used
   to be able to set any figure at all: a single heartbeat saying
   txnCount 1,000,000 put a company with a transaction limit straight into
   read-only. A report now raises the count by at most USAGE_STEP_TXN and
   the minutes by at most USAGE_STEP_MIN (a day). A machine really that far
   ahead — offline for days — catches up over its next few heartbeats.
   (index.js takes a report only from a machine with a person signed in.) */
export const USAGE_STEP_TXN = 500;
export const USAGE_STEP_MIN = 24 * 60;
export async function reportUsage(deviceId, usage) {
  if (!deviceId || !usage) return;
  const txn = Math.max(0, Math.floor(Number(usage.txnCount) || 0));
  const mins = Math.max(0, Math.floor(Number(usage.usageMinutes) || 0));
  if (!txn && !mins) return;
  try {
    await q(`UPDATE licences
                SET txn_count     = LEAST(GREATEST(txn_count, $2::int), txn_count + $4::int),
                    usage_minutes = LEAST(GREATEST(usage_minutes, $3::int), usage_minutes + $5::int)
              WHERE device_id = $1`, [deviceId, Math.min(txn, 2000000000), Math.min(mins, 2000000000), USAGE_STEP_TXN, USAGE_STEP_MIN]);
  } catch (e) { /* never fail a request over a counter */ }
}

/** What this LICENCE has used, across every seat on it. */
export async function companyUsage(companyId) {
  if (!companyId) return { txnUsed: 0, usageMinutes: 0, seatsReporting: 0, people: 0 };
  try {
    /* 4.6.0 — net of any owner reset (count − base), never below zero.
       4.72.0 (audit 10) — and the people counted in the same statement: one round trip, not two. */
    const rows = await q(
      `SELECT COALESCE(SUM(GREATEST(0, txn_count - txn_base)), 0)::int         AS txns,
              COALESCE(SUM(GREATEST(0, usage_minutes - usage_base)), 0)::int  AS mins,
              COUNT(*) FILTER (WHERE txn_count - txn_base > 0)::int            AS reporting,
              (SELECT COUNT(*)::int FROM company_users WHERE company_id = $1)   AS people
         FROM licences WHERE company_id = $1`, [companyId]);
    const r = rows.length ? rows[0] : {};
    return {
      txnUsed: Number(r.txns) || 0,
      usageMinutes: Number(r.mins) || 0,
      seatsReporting: Number(r.reporting) || 0,
      /* 4.42.0 — how many of the seats are taken, seats being people. */
      people: Number(r.people) || 0
    };
  } catch (e) {
    return { txnUsed: 0, usageMinutes: 0, seatsReporting: 0, people: 0 };
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
                 nexora_eod(COALESCE($6::timestamptz, now() + make_interval(days => $5::int))))
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
  /* 4.71.0 — the only computer of the company just made for it: nobody else could approve it */
  await q(`UPDATE licences SET company_id = $2, seat_no = 1,
                               approved_at = CASE WHEN platform = 'mobile' THEN approved_at ELSE COALESCE(approved_at, now()) END
            WHERE device_id = $1`, [row.device_id, co.id]);
  await logEvent(row.device_id, 'COMPANY_BACKFILL', { companyId: co.id, key: co.licence_key });
  row.company_id = co.id;
  row.seat_no = 1;
  if (row.platform !== 'mobile' && !row.approved_at) row.approved_at = new Date();
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
  const out = applyTxnLimit(describeState(row, company, settings), company, usage);
  /* 4.42.0 — the seat figure the licence card shows is PEOPLE, and the
     machine's own number is called what it is. seatNo is left in place
     as well, because a 4.41.0 installation in the field still reads it
     and would otherwise show a dash where its number used to be. */
  if (out && out.company) {
    out.company.seatsUsed = usage && usage.people != null ? Number(usage.people) : null;
    out.company.computerNo = out.company.seatNo || null;
  }
  return out;
}

function describeState(row, company, settings) {
  const now = Date.now();
  const co = company || null;

  /* The company's clock wins where there is one. */
  const expiresAt = co ? co.expires_at : row.expires_at;
  const msLeft = new Date(expiresAt).getTime() - now;
  /* 4.23.1 — TO THE NEAREST SECOND FIRST.
     expires_at is computed by the DATABASE's clock; `now` is this
     process's. On the live service those are two different machines, so
     the difference between them is a whole number of days give or take a
     little skew — and a bare ceil() turns "seven days and one
     millisecond" into EIGHT. A customer activating a 7-day demo was told
     8 while the licence console said 7, because the console does its
     arithmetic entirely in SQL, one clock throughout.
     Rounding to the nearest second absorbs the skew and leaves the
     meaning alone: part of a day still counts as a day, which is why
     this is ceil and not round. */
  /* 4.31.0 — CALENDAR DAYS, Indian time. Expiry now lands at 23:59:59 IST,
     so "days left" is the expiry day minus today (IST): a 7-day demo made
     at 11:50 says 7, not 8; the last day says 0 and is still usable until
     midnight ("ends tonight"). Whether it HAS expired is msLeft, never
     the count. IST is +05:30 with no daylight saving. */
  const istDay = (ms) => Math.floor((ms + 19800000) / 86400000);
  const daysLeft = Math.max(0, istDay(new Date(expiresAt).getTime()) - istDay(now));

  const graceDays = co ? Math.max(0, Number(co.grace_days) || 0) : settings.demoGraceDays;
  const offlineMinutes = graceDays > 0 ? graceDays * 1440 : settings.sessionMinutes;

  const profile = co ? {
    name: co.name,
    gstin: co.gstin || '',
    /* 4.72.0 (owner 2026-10-02: "Company login id" never showed under Settings → Licence & service) — the
       company id a computer or phone joins with (with the passcode), on every answer that carries the
       licence: activate, register, heartbeat, sign-in. '' for a company that has none. Never the passcode. */
    loginId: co.login_id || '',
    key: maskKey(co.licence_key),
    seats: Number(co.seats) || 1,
    maxUsers: Number(co.seats) || 1,   /* one seat = one person (4.42.0: and only a person) */
    seatNo: Number(row.seat_no) || null,
    isDemo: co.is_demo === true,
    graceDays,
    /* 4.48.0 — the plan, and the features it resolves to. A demo is
       always PRO with everything on. Seats are set per company by Nexora
       and have nothing to do with the plan (4.48.1). */
    plan: co.is_demo === true ? 'PRO' : cleanPlan(co.plan),
    features: featuresFor(co.plan, settings, co.is_demo === true)
  } : null;

  /* 4.57.0 — WHEN IT STARTED, not only when it ends.

       "licence ke demo kai date thi start thayo ane kyare patese"

     The company's CURRENT stretch where there is a company — renewed
     last Tuesday means Tuesday, not the day the customer first
     downloaded a demo. Where there is no company yet, the machine's own
     trial_started_at, which is the same fact for a device that has not
     been adopted. periodDays counts the stretch in IST calendar days,
     exactly as daysLeft counts what is left of it, so the application
     and the console can never disagree by a day. */
  const startedAt = (co && (co.period_started_at || co.created_at)) || row.trial_started_at || null;
  const periodDays = startedAt
    ? Math.max(0, istDay(new Date(expiresAt).getTime()) - istDay(new Date(startedAt).getTime()))
    : null;
  const base = { expiresAt, startedAt, periodDays, offlineMinutes, company: profile,
    /* Nexora Mobile — what this installation is, and whether a phone has been approved.
       4.71.0 — a computer too: one that joined an existing company waits for its administrator. */
    device: { platform: row.platform === 'mobile' ? 'mobile' : 'desktop', approved: !!row.approved_at } };
  /* C7 — whether this installation's row holds a device key yet: a yes or a no, never the hash. A row
     takes the first key it is shown, and a running app shows its key only when it joins — which one in
     daily use may not do for months (its heartbeat keeps its token fresh). So every computer and phone
     from before 4.71.0, and every one the console restored (its key was let go when it was revoked),
     would sit with no key, and whoever knew its id could hand it one first. Told keyHeld === false at
     its heartbeat, the app joins quietly once (/v1/activate { deviceId, deviceKey, rejoinOnly: true })
     and its row takes its own key. Left out on a withdrawn row: that takes no key whatever is sent
     (settleDeviceKey), so there is nothing for the app to do but be let back in. */
  if (row.state !== 'REVOKED') base.device.keyHeld = !!row.device_key_hash;

  /* Order matters: the narrowest refusal is checked first, so a revoked
     device inside a healthy company is still refused. */
  if (row.state === 'REVOKED') {
    return { ...base, state: 'REVOKED', canCalculate: false, daysLeft: 0, mode: 'HARDSTOP',
      message: 'This installation has been withdrawn. Contact Nexora to restore access.' };
  }
  /* 4.72.0 (audit 40) — a company Nexora deleted is suspended and kept DELETED_KEEP_DAYS: the machine is told
     so, and until when it can still be put back. `deleted` is new and additive; state stays SUSPENDED, which
     every client already stops on. 4.72.0 review — read from deleted_at alone, whatever `state` holds, exactly
     as authorise() refuses it: the two can never disagree (a working licence at the heartbeat while every
     other call is refused). */
  if (co && co.deleted_at) {
    return { ...base, state: 'SUSPENDED', deleted: true, canCalculate: false, daysLeft: 0, mode: 'HARDSTOP',
      message: 'The licence for ' + co.name + ' was deleted by Nexora. Contact Nexora before ' + istDate(purgeDayOf(co.deleted_at)) +
        ' to restore it — after that its records are erased.' };
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
      message: daysLeft === 0 ? 'Your licence ends tonight. Renew to keep calculating tomorrow.'
        : daysLeft <= 14 ? 'Your licence renews in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
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
    message: daysLeft === 0 ? 'Your demo ends tonight.'
      : daysLeft <= 2 ? 'Your demo ends in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
      : null };
}

/* ---- activation ----------------------------------------------------- */
import { passcodeMatches } from './passcode.js';
import { takeAttempt, failedAttempt, clearAttempts, strangerAttempt, lockedBody, attemptClock, strangerPause } from './lockout.js';
const DEVICE_RE = /^[a-f0-9]{16,64}$/i;

/* 4.72.0 (audit 4) — A COMPANY ID THAT DOES NOT EXIST COSTS THE SAME TIME AS
   ONE THAT DOES. The passcode is checked with scrypt, which takes a
   noticeable moment; an id that is not there used to be answered without
   it, so how long the refusal took said which ids are real even though the
   words are the same. 4.72.0 review — a made-up id now WAITS as long as a real
   attempt takes (lockout.js strangerPause) instead of running a scrypt of its
   own: an open route that spends a scrypt on every made-up id is a way for
   anybody to keep the processor busy (lockout.js). */

/** 4.71.0 — does this company already have a working computer its administrator let in? */
async function hasApprovedPc(companyId, exceptDevice) {
  const rows = await q(`SELECT 1 FROM licences
                         WHERE company_id = $1 AND device_id <> $2 AND (platform IS NULL OR platform <> 'mobile')
                           AND approved_at IS NOT NULL AND state <> 'REVOKED' LIMIT 1`, [companyId, String(exceptDevice || '')]);
  return rows.length > 0;
}

/** 4.71.0 (audit) — the refusal a computer that is waiting for its administrator gets on every call but the
 *  heartbeat, sign-out and sign-in: the phone's own (PHONE_PENDING, 403), so one answer means "ask your
 *  administrator" on both; `platform` says which. */
export const PC_PENDING = { error: 'PHONE_PENDING', platform: 'desktop', pending: true,
  message: 'Your Nexora administrator has to approve this computer first — ask them to approve it in Settings → Users → Devices, or to sign in on it once.' };

/** 4.71.0 (audit) — a machine the Nexora console revoked (admin.js 'revoke'). Only the console restores it:
 *  until now /v1/devices/approve turned ANY revoked row back to TRIAL, so once computers were let through
 *  there a company administrator could undo Nexora's withdrawal of one. A row revoked before revoked_by
 *  existed says nothing: a computer then could only have been revoked by the console (that route refused
 *  computers), so it is Nexora's; a phone could have been either, and keeps what it always had.
 *  (Kept here rather than in sync.js since C7: activate reads it too, and sync.js already imports from here.) */
export function revokedByNexora(d) {
  if (!d || d.state !== 'REVOKED') return false;
  if (d.revoked_by) return d.revoked_by === 'NEXORA';
  return d.platform !== 'mobile';
}

/* ---- C7 — THE DEVICE KEY (owner 2026-10-01) ----------------------------
     "દરેક PC/phone ને ગુપ્ત key"
   A device id is not a secret: it is in the console, in a report, on a
   screen somebody photographed. Until now knowing an approved computer's
   id was enough to activate ANOTHER machine as that computer and be handed
   its token. So every installation makes one random key of its own (32
   bytes from a cryptographic generator, 64 hex characters), keeps it, never
   shows it, and sends it with every join and re-join (/v1/activate,
   /v1/register). The service keeps only sha256 of it (device_key_hash),
   which no route ever lists or returns.

     a new row                         takes the key it was made with
     a row with no key yet             takes the first key it is shown — every
       (made before this release)      row from before 4.71.0, until its app
                                       upgrades; no key and none sent is let
                                       through as before
     a row with a key                  the key sent must be that one; a wrong
                                       key, or none, is DEVICE_KEY_MISMATCH
     removed by the company            the key is cleared, and the machine that
       (/v1/devices/remove)            joins again with the company's licence
                                       key or id + passcode is a NEW device:
                                       waiting for the administrator, holding
                                       its own new key — the ONLY way back:
                                       the administrator cannot approve a
                                       removed one back (409 REJOIN_NEEDED,
                                       sync.js), which would leave it live
                                       with no key
     revoked by Nexora (console)       the key is cleared; the machine stays
                                       refused until the console restores it

   Only joining is guarded. A token, the heartbeat, signing in — none of
   them carries the key or is changed by it: a token is already proof that
   this installation joined. But the licence every one of them is told says
   whether the row holds a key yet (licence.device.keyHeld, yes or no, never
   the hash), so a running app whose row has none — from before 4.71.0, or
   restored by the console — joins quietly once and its row takes its key. */
const DEVICE_KEY_RE = /^[0-9a-f]{64}$/;
export const DEVICE_KEY_MISMATCH = { error: 'DEVICE_KEY_MISMATCH',
  message: 'This computer or phone does not match the one your company approved. Ask your administrator to remove it under Settings → Users & access → Computers & phones, then join again.' };

/** The key an installation sent, as read here: its 64 hex characters, or '' for none. An older app sends
 *  none; anything not of that shape cannot have been made by a Nexora app and is read as none too — which
 *  a row that holds a key refuses exactly as it refuses a wrong one. */
function cleanDeviceKey(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return DEVICE_KEY_RE.test(s) ? s : '';
}
/** What is kept: sha256 of the key (hex), never the key. null when none was sent. */
export function deviceKeyHash(raw) {
  const k = cleanDeviceKey(raw);
  return k ? createHash('sha256').update(k, 'utf8').digest('hex') : null;
}
/** Constant time over the two hashes. A row that holds no key matches anything (see the table above). */
function deviceKeyMatches(heldHash, sentHash) {
  if (!heldHash) return true;
  if (!sentHash) return false;
  const a = Buffer.from(String(heldHash), 'utf8');
  const b = Buffer.from(String(sentHash), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
/** The refusal, logged — whether a key came at all, never any of it. */
export async function deviceKeyRefused(deviceId, via, sentHash, companyId) {
  await logEvent(deviceId, 'DEVICE_KEY_MISMATCH', { via, keySent: !!sentHash, companyId: companyId || null });
  return { httpStatus: 401, body: Object.assign({}, DEVICE_KEY_MISMATCH) };
}
/** The last word on `row`'s key before a token is issued for it: a row with no key takes the one sent, and
 *  then what the row holds must match what was sent. Both halves are read from the DATABASE, never from
 *  the copy of the row the caller holds — that copy may be a moment old, and two installations racing for
 *  one row (two re-joins of a removed machine, two first launches) would each find their own key in their
 *  own copy and both be handed a token. Here the take is one conditional UPDATE (the second to arrive
 *  waits on the first's row lock and then finds the key taken), and the comparison is against what the
 *  row holds after it: the loser finds the winner's key and is refused. A WITHDRAWN row takes no key: it
 *  stays withdrawn whatever is sent, and taking one would only let whoever knew its id shut out the real
 *  machine when its company lets it join again. `row.device_key_hash` is brought up to date for the
 *  caller (describe reads it). */
export async function settleDeviceKey(row, sentHash) {
  if (!row || !row.device_id) return false;
  if (sentHash) {
    await q(`UPDATE licences SET device_key_hash = $2
              WHERE device_id = $1 AND device_key_hash IS NULL AND state <> 'REVOKED'`, [row.device_id, sentHash]);
  }
  const now = (await q(`SELECT device_key_hash FROM licences WHERE device_id = $1`, [row.device_id]))[0];
  if (!now) return false;
  row.device_key_hash = now.device_key_hash || null;
  return deviceKeyMatches(row.device_key_hash, sentHash);
}

/* ---- 4.72.0 (audit 97) — A ROW WITH NO KEY YET ----------------------------
   Until every computer and phone has handed its key over, a row with none
   takes the first key it is shown, and a re-join that sends no key is let
   in (the table above) — so whoever knows such a row's device id can still
   activate as it. Three things narrow that, none of which can shut out a
   machine that is working today:

   1. THE HEARTBEAT TAKES A KEY (handOverDeviceKey, index.js). A heartbeat
      carries the machine's own unexpired token, which only that machine
      holds: proof that the key it sends is that machine's. An app that
      sends { deviceKey } with its heartbeat when it hears keyHeld: false
      never needs the unauthenticated /v1/activate hand-over at all.
   2. A RE-JOIN IS TOLD APART. A /v1/activate for a keyless row that carries
      that machine's current token (Authorization: Bearer …, as the phone
      always sends) is PROVEN; one without is logged KEYLESS_REJOIN, and a
      key taken is logged DEVICE_KEY_SET with how it came — so the owner can
      see who joined as what.
   3. THE OWNER CAN CLOSE THE DOOR. With NEXORA_DEVICE_KEY_REQUIRED=1 set on
      Render, a keyless (not withdrawn) row is no longer re-joined without
      that proof: 409 REJOIN_NEEDED — the administrator removes it and it
      joins again with the company's key or id and passcode, as a new device
      holding a key of its own. Off unless set: computers on 4.71.0 hand
      their key over WITHOUT their token and would be shut out. Set it once
      the console shows no device without a key. */
export function keylessRefused() {
  return /^(1|true|yes|on|required)$/i.test(String(process.env.NEXORA_DEVICE_KEY_REQUIRED || '').trim());
}
/** Does the request's Authorization header carry a current token for this very device? */
export function provesDevice(authHeader, deviceId) {
  const auth = String(authHeader || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return false;
  let t = null;
  try { t = readToken(token); } catch (e) { t = null; }
  return !!(t && String(t.d) === String(deviceId || ''));
}
function rejoinNeeded(phone) {
  const what = phone ? 'phone' : 'computer';
  return { httpStatus: 409, body: { error: 'REJOIN_NEEDED', platform: phone ? 'mobile' : 'desktop',
    message: 'This ' + what + ' has to join your company again. Ask your Nexora administrator to remove it under Settings → Users & access → Computers & phones, then join with the company’s licence key, or its company id and passcode.' } };
}
/** 1. — the heartbeat's hand-over. `row` is the caller's own row (authorise() read it for a good token). A row
 *  that holds no key and is not withdrawn takes this one; anything else is left exactly as it is (a row that
 *  holds a key keeps it — a heartbeat never changes or tests a key). Returns true when the key was taken. */
export async function handOverDeviceKey(row, rawKey) {
  const hash = deviceKeyHash(rawKey);
  if (!row || !row.device_id || !hash || row.device_key_hash || row.state === 'REVOKED') return false;
  const took = await q(`UPDATE licences SET device_key_hash = $2
                         WHERE device_id = $1 AND device_key_hash IS NULL AND state <> 'REVOKED' RETURNING device_id`, [row.device_id, hash]);
  if (!took.length) return false;
  row.device_key_hash = hash;
  await logEvent(row.device_id, 'DEVICE_KEY_SET', { via: 'heartbeat', proven: true, companyId: row.company_id || null });
  return true;
}

/** `ctx` (4.72.0, audit 97) — { authorization }: the request's Authorization header (index.js), read only to see
 *  whether it carries this very device's current token (provesDevice). */
export async function activate({ deviceId, deviceName, company, email, appVersion, licenceKey, loginId, passcode, platform, rejoinOnly, deviceKey }, ctx) {
  const phone = String(platform || '').toLowerCase() === 'mobile';
  if (!DEVICE_RE.test(String(deviceId || ''))) {
    return { httpStatus: 400, body: { error: 'BAD_DEVICE_ID',
      message: 'This installation could not identify the computer it is running on.' } };
  }
  const settings = await getSettings();

  /* C7 — THE DEVICE KEY FIRST. A machine whose row holds a key and that does
     not send it is refused before anything else is looked at: before a
     licence key or a passcode is tried (so nobody spends a company's
     passcode tries through somebody else's device id), and before a phone's
     company is looked up from its row (whose refusals name the company). */
  const sentKeyHash = deviceKeyHash(deviceKey);
  const held = (await q(`SELECT device_key_hash, company_id, state FROM licences WHERE device_id = $1`, [deviceId]))[0];
  if (held && !deviceKeyMatches(held.device_key_hash, sentKeyHash)) {
    return deviceKeyRefused(deviceId, 'activate', sentKeyHash, held.company_id);
  }
  /* 4.72.0 (audit 97) — a row that holds no key yet: does this request carry that machine's own current token?
     With NEXORA_DEVICE_KEY_REQUIRED set, one that does not is refused here, as early as a wrong key (see
     keylessRefused). A withdrawn row is not: it comes back only by joining again, which the code below handles. */
  const proven = provesDevice(ctx && ctx.authorization, deviceId);
  if (held && !held.device_key_hash && held.state !== 'REVOKED' && !proven && keylessRefused()) {
    await logEvent(deviceId, 'KEYLESS_REFUSED', { companyId: held.company_id || null, keySent: !!sentKeyHash });
    return rejoinNeeded(phone);
  }

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
    /* 4.72.0 (audit 40) — or deleted (kept for DELETED_KEEP_DAYS, suspended meanwhile): said as such */
    if (keyed.state === 'SUSPENDED') return suspendedJoin(keyed);
  }

  /* 4.23.0 — a company that registered itself has no key to type; its
     other machines join with the company login id and passcode. Resolved
     exactly like a key: a wrong one is a clear refusal, and one refusal
     covers "no such id" and "wrong passcode" alike, so a stranger learns
     nothing about which half was wrong. */
  const lid = String(loginId || '').trim().toLowerCase();
  if (!keyed && lid) {
    const found = await q(`SELECT * FROM companies WHERE login_id = $1`, [lid]);
    const badPasscode = { httpStatus: 401, body: { error: 'BAD_PASSCODE',
      message: 'That company id and passcode do not match. Check them with the person who registered your company.' } };
    /* 4.71.0 (audit) — three wrong passcodes and the company's join is shut
       for fifteen minutes, the right passcode included (lockout.js). An id
       that does not exist is counted too, so the lock never tells a
       stranger which ids are real. */
    if (!found.length) {
      const s = strangerAttempt('passcode|' + lid);
      /* 4.72.0 (audit 4) — as long as a real id takes: on every attempt a real id would compare (the one that
         starts its lock included), and not while it would already be locked (a real one is then refused before
         any compare). 4.72.0 review — waited, not a scrypt (lockout.js strangerPause). */
      if (!s.locked || s.started) await strangerPause();
      await logEvent(deviceId, 'PASSCODE_REJECTED', { loginId: lid });
      return s.locked ? { httpStatus: 423, body: lockedBody('passcode', s.retryAfter) } : badPasscode;
    }
    const clock = attemptClock();
    const turn = await takeAttempt('passcode', found[0].id);
    if (!turn.ok) {
      await logEvent(deviceId, 'PASSCODE_LOCKED', { loginId: lid, companyId: found[0].id });
      return { httpStatus: 423, body: lockedBody('passcode', turn.retryAfter) };
    }
    const passcodeRight = passcodeMatches(passcode, found[0].passcode_hash);
    clock();   /* what a real attempt took — what an unknown id waits */
    if (!passcodeRight) {
      await logEvent(deviceId, 'PASSCODE_REJECTED', { loginId: lid });
      const lockedFor = await failedAttempt('passcode', found[0].id, turn.tries);
      if (lockedFor) {
        await logEvent(deviceId, 'PASSCODE_LOCKED', { loginId: lid, companyId: found[0].id });
        return { httpStatus: 423, body: lockedBody('passcode', lockedFor) };
      }
      return badPasscode;
    }
    await clearAttempts('passcode', found[0].id);
    keyed = found[0];
    if (keyed.state === 'SUSPENDED') return suspendedJoin(keyed);
  }

  /* C7 — the company whose licence key, or id and passcode, was actually TYPED. A phone below also finds
     its company from its own row when nothing was typed; that is not a credential, and only a credential
     lets a machine its company removed join again. */
  const typedCo = keyed;

  /* Nexora Mobile — a phone joins a company that already exists (its licence key, or its company id
     and passcode), never makes a demo of its own, and only on a plan that carries Nexora Mobile */
  if (phone) {
    if (!keyed) {
      const had = (await q(`SELECT company_id FROM licences WHERE device_id = $1 AND platform = 'mobile'`, [deviceId]))[0];
      if (had && had.company_id) keyed = (await q(`SELECT * FROM companies WHERE id = $1`, [had.company_id]))[0] || null;
    }
    if (!keyed) {
      return { httpStatus: 400, body: { error: 'MOBILE_NEEDS_COMPANY',
        message: 'Enter your company\u2019s licence key, or its company id and passcode \u2014 ask your Nexora administrator.' } };
    }
    const feats = featuresFor(keyed.plan, settings, keyed.is_demo === true);
    if (!feats.mobile) {
      return { httpStatus: 403, body: { error: 'MOBILE_NOT_IN_PLAN',
        message: 'Nexora Mobile is part of the PRO plan. Ask Nexora to move ' + keyed.name + ' to PRO.' } };
    }
  }

  const existing = await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]);
  if (existing.length) {
    /* THE REINSTALL RULE. The row already exists, so the original expiry
       stands. Details are refreshed; the clock is not. */
    const row = existing[0];
    /* 4.71.0 (audit) — A MACHINE ON ANOTHER COMPANY STAYS THERE.
       A device id is not a secret — it is in the console, in a report, on
       a screen somebody photographed — and until now typing any company's
       key with it MOVED that machine into the company whose key was typed:
       a stranger's licence key and a plant's device id were enough to pull
       the plant's computer, and whatever it then saved, into the stranger's
       company. A machine that belongs to a company leaves it only once that
       company (its administrator, or Nexora) has removed it — REVOKED. */
    if (keyed && row.company_id && Number(row.company_id) !== Number(keyed.id) && row.state !== 'REVOKED') {
      await logEvent(deviceId, 'MOVE_REFUSED', { from: row.company_id, to: keyed.id });
      return { httpStatus: 409, body: { error: 'DEVICE_IN_OTHER_COMPANY',
        message: 'This ' + (phone ? 'phone' : 'computer') + ' is already on another company’s Nexora licence. ' +
                 'Ask that company’s administrator (or Nexora) to remove it there first, then try again.' } };
    }
    /* C7 — A MACHINE ITS COMPANY REMOVED, JOINING THAT COMPANY AGAIN with its licence key or its id and
       passcode, is a NEW device: waiting for the administrator (never approved here, not even as the only
       computer — an administrator who signs in on it approves it), holding the key it sent now. Its old key
       was cleared when it was removed, which is how a reinstalled machine that lost its key gets back in:
       "ask your administrator to remove it, then join again". One Nexora revoked stays refused (as before);
       only the console gives that back.
       Only the request that actually turns the row from REVOKED wins it: the UPDATE is conditional on that
       (and on the row still being this company's, and not Nexora's) and says whether it changed a row. Two
       re-joins of the same removed machine both read REVOKED a moment ago; the second's UPDATE finds the
       row already taken, changes nothing, and the key check below refuses it unless it holds the very key
       the first one set — before it has written anything. */
    if (typedCo && row.state === 'REVOKED' && row.company_id && Number(row.company_id) === Number(typedCo.id) && !revokedByNexora(row)) {
      const won = await q(`UPDATE licences SET state = 'TRIAL', approved_at = NULL, approved_by = NULL, revoked_by = NULL,
                                               device_key_hash = $2
                            WHERE device_id = $1 AND state = 'REVOKED' AND company_id = $3
                              AND revoked_by IS DISTINCT FROM 'NEXORA'
                        RETURNING device_id`, [deviceId, sentKeyHash, typedCo.id]);
      if (won.length) await logEvent(deviceId, 'REJOIN_PENDING', { companyId: typedCo.id, platform: phone ? 'mobile' : 'desktop', keySent: !!sentKeyHash });
    }

    /* C7 — THE KEY IS SETTLED BEFORE ANYTHING ELSE IS WRITTEN: a row with no key yet takes this one, and the
       row, as the database holds it now, must hold the key sent. A request refused here has changed nothing
       — not the machine's name or company details, not a computer turned into a phone (which takes its
       approval), not its company. (The check at the top already refused a plain wrong key; this one catches
       whoever lost a race for the row since.) */
    const hadKey = !!row.device_key_hash;
    if (!(await settleDeviceKey(row, sentKeyHash))) return deviceKeyRefused(deviceId, 'activate', sentKeyHash, row.company_id);
    /* 4.72.0 (audit 97) — a keyless row re-joined: whether it took a key, and whether the request proved it was
       that machine (its own current token), go in the event log */
    if (!hadKey && row.device_key_hash) await logEvent(deviceId, 'DEVICE_KEY_SET', { via: 'activate', proven, companyId: row.company_id || null });
    else if (!hadKey && !proven) await logEvent(deviceId, 'KEYLESS_REJOIN', { companyId: row.company_id || null, platform: phone ? 'mobile' : 'desktop' });
    let row2 = (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];

    /* MOVING A MACHINE ONTO A REAL LICENCE. A demo user who buys types the
       key into the same installation — it must take a seat in the real
       company and keep everything it already has. Seats are checked here
       too, or a customer with 5 seats could quietly activate 50. */
    if (keyed && Number(row2.company_id) !== Number(keyed.id)) {
      /* 4.42.0 — no seat check here any more: the machine takes no seat.
         What it can DO is decided when a person signs in on it, and that
         is where the count is kept (sync.js userCap). */
      const seat = phone ? null : await nextComputerNo(keyed.id);
      /* 4.71.0 — an approval given by the company it left does not come along: a computer waits for this
         company's administrator, unless it is the company's first */
      const firstPc = !phone && !(await hasApprovedPc(keyed.id, deviceId));
      /* C7 — and it carries the key it sent into its new company (a removed or revoked machine's was
         cleared; a row with none yet takes it; one it already held was checked above). Only while the row
         still holds no key or this one: a machine that raced this request onto the row with a key of its
         own keeps it, and this request is refused having moved nothing. */
      const moved = await q(`UPDATE licences SET company_id = $2, seat_no = $3, state = 'TRIAL',
                                   approved_at = CASE WHEN $4::bool THEN now() ELSE NULL END,
                                   approved_by = CASE WHEN $4::bool THEN 'first computer of the company' ELSE NULL END,
                                   revoked_by = NULL,
                                   device_key_hash = COALESCE(device_key_hash, $5)
                WHERE device_id = $1 AND (device_key_hash IS NULL OR device_key_hash = $5)
            RETURNING device_id`,
        [deviceId, keyed.id, seat, firstPc, sentKeyHash]);
      if (!moved.length) return deviceKeyRefused(deviceId, 'activate', sentKeyHash, row2.company_id);
      await logEvent(deviceId, 'JOIN_COMPANY', { companyId: keyed.id, seat, from: row2.company_id || null, approved: firstPc });
    }

    await q(`UPDATE licences
               SET last_seen_at = now(), seen_count = seen_count + 1,
                   app_version  = COALESCE($2, app_version),
                   device_name  = COALESCE(NULLIF($3,''), device_name),
                   company      = COALESCE(NULLIF($4,''), company),
                   email        = COALESCE(NULLIF($5,''), email)
             WHERE device_id = $1`,
      [deviceId, appVersion || null, deviceName || '', company || '', email || '']);
    if (phone && row2.platform !== 'mobile') {
      /* 4.71.0 — a computer's approval is not a phone's: the phone waits for its own */
      await q(`UPDATE licences SET platform = 'mobile', approved_at = NULL, approved_by = NULL WHERE device_id = $1`, [deviceId]);
    }
    row2 = (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];

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
  /* 4.71.0 (audit) — a QUIET RE-JOIN (the desktop lost its token and asks again with only its device id) is
     answered only for a machine already known: it never turns into a new company or a demo. */
  if (rejoinOnly === true && !keyed && !lid) {
    return { httpStatus: 404, body: { error: 'NOT_REGISTERED',
      message: 'This computer is not known to the Nexora service. Open Licence & service to activate it.' } };
  }
  let co = keyed;
  let seat = 1;
  /* 4.71.0 (audit, owner 2026-10-01) — A COMPUTER JOINING AN EXISTING
     COMPANY WAITS FOR ITS ADMINISTRATOR, exactly as a phone always has. A
     licence key or a company passcode that has been passed round is then no
     longer enough to put a new computer onto the plant's data: the
     administrator approves it (Settings → Users → Devices, the same
     /v1/devices the phones use), or signs in on it once. The company's
     FIRST computer is approved as it joins — there is nobody yet to ask. */
  let approvePc = !phone;

  if (co) {
    /* 4.42.0 — a new machine on a known licence is simply numbered (a phone is not a computer). */
    seat = phone ? null : await nextComputerNo(co.id);
    if (!phone) approvePc = !(await hasApprovedPc(co.id, deviceId));
  } else {
    /* 4.23.1 — NO KEY AND NO COMPANY ID.
       Until 4.23.0 this created a company out of whatever name was typed:
       the website demo. Registration replaced it, and leaving both doors
       open meant a stranger refused at Register — duplicate GSTIN, email
       or device — could take the other one and be in with nothing checked
       at all. So the anonymous demo is now a switch the owner holds, and
       it is off unless they open it.
       This gates ONLY this path. A customer with a key, a machine joining
       with the company id and passcode, and every installation that
       already exists are all untouched. */
    if (!settings.demoSignup) {
      return { httpStatus: 403, body: { error: 'NOT_REGISTERED',
        message: 'This computer is not registered yet. Use "Register your company" to start your 7-day demo — ' +
                 'it takes your company name, GSTIN, email and mobile. If your company already uses Nexora, ' +
                 'enter its licence key, or its company id and passcode.' } };
    }
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

  /* C7 — a new row is made holding the key it was made with (none from an older app) */
  const rows = await q(
    `INSERT INTO licences (device_id, device_name, company, email, state,
                           trial_started_at, expires_at, app_version, last_seen_at, seen_count,
                           company_id, seat_no, platform, approved_at, approved_by, device_key_hash)
     VALUES ($1,$2,$3,$4,'TRIAL', now(), $6::timestamptz, $5, now(), 1, $7, $8, $9,
             CASE WHEN $10::bool THEN now() ELSE NULL END, CASE WHEN $10::bool THEN 'first computer of the company' ELSE NULL END, $11)
     ON CONFLICT (device_id) DO NOTHING
     RETURNING *`,
    [deviceId, deviceName || null, company || null, email || null,
     appVersion || null, co.expires_at, co.id, seat, phone ? 'mobile' : null, approvePc, sentKeyHash]);

  /* A race on first launch could lose the INSERT; read the winner. */
  const row = rows.length ? rows[0]
    : (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];
  /* C7 — and the winner of such a race is somebody else's unless it holds this key */
  if (!rows.length && !(await settleDeviceKey(row, sentKeyHash))) return deviceKeyRefused(deviceId, 'activate', sentKeyHash, row && row.company_id);

  await logEvent(deviceId, 'ACTIVATE',
    { company, email, appVersion, companyId: co.id, seat, keyed: !!keyed, approved: !!row.approved_at });
  const usageNew = await companyUsage(row.company_id || null);
  return { httpStatus: 200,
    body: { token: issueToken(row), licence: describe(row, co, settings, usageNew), returning: false } };
}

/** Every protected call goes through here. Re-reads the row every time —
 *  a token says who you are, the row says what you may do.
 *  opts.light (4.72.0, audit 10) — for /v1/sync/wait only, which every signed-in machine asks every 25 s and
 *  which answers nothing about the licence: the company row may be up to ten seconds old (companyOf), and the
 *  licence's usage is not counted (a.usage is null; a.licence then carries no usage figures). The device row and
 *  the person are read afresh exactly as for every other call. */
export async function authorise(request, opts) {
  const light = !!(opts && opts.light);
  if (!tokenSecretOk()) return { ok: false, httpStatus: 503, error: MISCONFIGURED };
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
  let co = await companyOf(row, { cached: light });
  if (!co) { co = await adoptOrphan(row); row = (await q(`SELECT * FROM licences WHERE device_id = $1`, [row.device_id]))[0]; }

  /* 4.3.0 — the licence's usage, read from the rows on every call for the
     same reason its state is: a figure the client sends cannot be trusted
     to decide whether the client may continue. (Not for a wait: it decides nothing there.) */
  const usage = light ? null : await companyUsage(row.company_id || null);

  /* 4.8.0 — the person, if the token names one. Re-read from the table
     like everything else: a user switched off by their admin, or moved
     to scope OWN, is refused or narrowed on the very next call, whatever
     the token still says. A user row that no longer matches the seat's
     company is treated as signed out. */
  let user = null;
  /* 4.43.0 — and only if they are signed in HERE. One person, one place:
     signing in on another machine moves the binding, and this one finds
     out on its very next call rather than going on working as somebody
     who has walked away. Not a refusal of the whole request — the licence
     is still this machine's, and it must be told plainly what happened
     rather than being handed a 401 it would read as "activate again". */
  let superseded = null;
  if (body.u && row.company_id) {
    /* 4.72.0 (audit 10) — and whether "last active" is due, read in the same statement: on most calls it is
       not (it was written less than a minute ago), and the UPDATE below — a round trip to the database on
       every call until now — is then not sent at all */
    const urows = await q(`SELECT *, (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute') AS nexora_seen_due
                             FROM company_users WHERE id = $1 AND company_id = $2`, [body.u, row.company_id]);
    const seenDue = urows.length ? urows[0].nexora_seen_due !== false : false;
    if (urows.length) delete urows[0].nexora_seen_due;
    if (urows.length && urows[0].active !== false) {
      const u = urows[0];
      /* a computer holds the person in session_device, a phone in session_mobile (Nexora Mobile) */
      const slot = row.platform === 'mobile' ? u.session_mobile : u.session_device;
      const slotAt = row.platform === 'mobile' ? u.session_mobile_at : u.session_at;
      if (slot && slot !== row.device_id) {
        const on = (await q(`SELECT device_name FROM licences WHERE device_id = $1`, [slot]))[0];
        superseded = { name: u.name, at: slotAt || null,
          where: (on && on.device_name) || (row.platform === 'mobile' ? 'another phone' : 'another computer') };
      } else if (!slot) {
        /* 2026-09-28 — SECURITY: an EMPTY binding is not "signed in here". It is what the console's
           "sign out", or a sign-out on this machine, leaves — and until now the machine went on
           working as that person. */
        superseded = { name: u.name, at: null, where: 'no other computer \u2014 this account was signed out', signedOut: true };
      } else {
        user = u;
        /* 4.58.1 — "last active": at most once a minute, and never allowed
           to fail the call it rides on */
        if (seenDue) {
          try {
            await q(`UPDATE company_users SET last_seen_at = now()
                      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`, [u.id]);
          } catch (e) { /* a counter never fails a request */ }
        }
      }
    }
  }

  const lic = describe(row, co, settings, usage);
  /* 2026-09-28 — SECURITY: a withdrawn (REVOKED) installation could still pull the company's data.
     It is told at its heartbeat (and may sign out) — every other route is refused. The same holds
     for a phone that is not approved yet, or whose company's plan has no Nexora Mobile. */
  let pth = '';
  try { pth = new URL(request.url, 'http://x').pathname; } catch (e) { pth = ''; }
  const OPEN = pth === '/v1/heartbeat' || pth === '/v1/logout';
  if (row.state === 'REVOKED' && !OPEN) {
    return { ok: false, httpStatus: 402, error: { error: 'REVOKED', message: lic.message || 'This installation has been withdrawn.', licence: lic } };   /* the shape a refused calculation always had */
  }
  /* 4.72.0 (audit 40) — A COMPANY NEXORA DELETED. It is kept for DELETED_KEEP_DAYS so the console can put it
     back, but nothing of it is used meanwhile: its machines hear why at their heartbeat (describe: SUSPENDED,
     deleted, HARDSTOP) and may sign out; every other call — signing in, syncing, chat, costing — is refused in
     the same shape a withdrawn machine gets. Until 4.72.0 a deletion took the rows at once, and these calls
     were answered 401 UNKNOWN_DEVICE; they are again once the company is erased. */
  if (co && co.deleted_at && !OPEN) {
    return { ok: false, httpStatus: 402, error: { error: 'COMPANY_DELETED', message: lic.message, licence: lic } };
  }
  if (row.platform === 'mobile' && !OPEN) {
    const feats = (lic.company && lic.company.features) || {};
    if (!feats.mobile) return { ok: false, httpStatus: 403, error: { error: 'MOBILE_NOT_IN_PLAN', message: 'Nexora Mobile is part of the PRO plan.' } };
    if (!row.approved_at) return { ok: false, httpStatus: 403, error: { error: 'PHONE_PENDING', message: 'Your Nexora administrator has to approve this phone first.' } };
  }
  /* 4.71.0 (audit) — a computer waiting for its administrator: the heartbeat (which says so, in
     licence.device.approved), signing out, and SIGNING IN — an administrator who signs in on it approves
     it (sync.js login); anybody else is refused there with this same answer. */
  if (row.platform !== 'mobile' && !row.approved_at && !OPEN && pth !== '/v1/login') {
    return { ok: false, httpStatus: 403, error: Object.assign({}, PC_PENDING) };
  }
  return {
    ok: true, row, company: co, licence: lic, settings, usage, user, superseded,
    /* 4.71.0 — the person the token names, signed in here or not, so /v1/logout can let go of a binding
       that is still this machine's (sync.js releaseSession checks that it is) */
    tokenUser: body.u ? Number(body.u) : null,
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

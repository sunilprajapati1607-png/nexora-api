/**
 * Nexora API — the admin console
 * ----------------------------------------------------------------------
 * "which can be handled by me". This is that: one page, served by the
 * same function, listing every installation with its state and clock, and
 * the four things an owner actually needs to do — extend a trial, turn a
 * trial into a licence, revoke one, and stop issuing new trials.
 *
 * Guarded by a single admin key sent as a header. That is deliberately
 * modest security for a deliberately modest tool: it exposes no customer
 * data beyond what the owner already has, and it can be replaced with
 * real accounts the day there is more than one operator.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { endSessionOn, wakeCompany } from './waiters.js';
import { q, getSettings, forgetSettings, logEvent } from './db.js';
import { cleanPlan, cleanPlanFeatures, PLAN_FEATURES } from './plans.js';
import { hashPasscode, validPasscode, PASSCODE_MIN } from './passcode.js';
import { newLicenceKey, maskKey, keylessRefused, forgetCompanies, DELETED_KEEP_DAYS, istDate, purgeDayOf } from './licence.js';
import { aiUsedTodayAll, aiDefaultDaily } from './ai.js';
import { forget as aiForget } from './aikey.js';
import { ensureAdmin, usersSummary, userCap, listUsers, hashPin, validPin, nameKey, cleanEmail, defaultPermissions, resendPrices,
  signOutEverywhere, masterHistory, restoreMaster, purgeRecycleBin, RECYCLE_KEEP_DAYS } from './sync.js';
import { ensureInkSchema } from './inkstore.js';

const ADMIN_KEY = process.env.NEXORA_ADMIN_KEY || '';
/* 4.72.0 (audit 9, 35) — a console key shorter than this is easy to guess; the service says so in its log
   (once, never the key) and the console shows a warning on Service settings */
export const ADMIN_KEY_MIN = 32;
export function adminKeyShort() { return !!ADMIN_KEY && ADMIN_KEY.length < ADMIN_KEY_MIN; }

/* 4.71.0 (audit) — compared in constant time. `===` stops at the first
   character that differs, so how long a wrong key took to refuse said how
   much of it was right. Both sides are hashed first, so even the LENGTH of
   the real key is never measured. */
const digestOf = (s) => createHash('sha256').update(String(s)).digest();
export function adminAuthorised(request) {
  const k = request.headers.get('x-admin-key') || '';
  if (!ADMIN_KEY || !k) return false;
  return timingSafeEqual(digestOf(k), digestOf(ADMIN_KEY));
}

/* 4.71.0 (audit) — FIVE WRONG KEYS FROM ONE ADDRESS AND IT IS SHUT OUT FOR
   FIFTEEN MINUTES: every /admin/api call from it is refused (the right key
   too), and the event log says so. One person runs this console, from a
   handful of places; a sixth wrong key in a row is not that person. Kept in
   memory: a restart forgives, which costs an attacker a restart they cannot
   cause. The address is register.js remoteIp — Cloudflare's, never the
   client's own x-forwarded-for. */
const ADMIN_TRIES = 5;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_MISSES = new Map();
/* 4.72.0 (audit 9, 35) — AND FIFTY WRONG KEYS FROM EVERY ADDRESS TOGETHER, within
   fifteen minutes, shut the console for everybody for fifteen minutes (the right
   key too), logged once. Five per address stops one machine guessing; it does not
   stop a thousand machines guessing five each. In memory, like the per-address count.
   4.72.0 review — BUT ONLY WHILE THE KEY IS SHORT (adminKeyShort). A lock for
   everybody is also a lever for anybody: fifty wrong keys from a handful of
   addresses (one home connection's IPv6 range has more than enough) would keep the
   owner out of his own console, again every quarter of an hour, for as long as
   somebody cared to. Against a key of ADMIN_KEY_MIN random characters or more,
   guessing is hopeless however many machines guess, so there the lock would buy
   nothing and only that lever is left: with a long key there is no lock for
   everybody — the per-address lock stays — and the log says once a quarter-hour
   that many were tried (ADMIN_KEY_MANY_WRONG). With a short key the lock stays as
   it was, and the service keeps saying the key should be longer. */
const ADMIN_ALL_TRIES = 50;
const ADMIN_ALL = { n: 0, since: 0, until: 0, logged: 0, said: false };
/* 4.72.0 review — HOW MUCH A FLOOD OF WRONG KEYS MAY WRITE OR HOLD. Without the lock for everybody, many
   addresses could each write their five wrong keys into the event log (the free database is 500 MB): the log
   takes ADMIN_LOG_MAX of them (and the per-address locks) in a quarter-hour, from every address together, and
   counts the rest. The per-address counts are at most ADMIN_MISSES_MAX: past that the oldest are forgotten. */
export const ADMIN_LOG_MAX = 50;
export const ADMIN_MISSES_MAX = 10000;
let keyLengthSaid = false;
/** For the suites: how many addresses' wrong-key counts are held. */
export function adminMissesSize() { return ADMIN_MISSES.size; }

/** 4.72.0 (audit 39) — where a console call comes from, for the event log (db.js consoleCall): the address
 *  Cloudflare saw (register.js remoteIp, passed in), which console ('android' when the phone console says so in
 *  x-console or its HTTP client names itself; otherwise 'web'), and the first 120 characters of its user-agent.
 *  Never the key. */
export function consoleCaller(request, ip) {
  const ua = String(request.headers.get('user-agent') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
  const said = String(request.headers.get('x-console') || '').trim().toLowerCase();
  const app = said === 'android' || said === 'web' ? said : (/okhttp|dalvik|android/i.test(ua) ? 'android' : 'web');
  return { ip: ip || '-', app, ua };
}

export async function adminGate(request, ip) {
  if (!keyLengthSaid) {
    keyLengthSaid = true;
    if (adminKeyShort()) console.warn('[nexora] the console key NEXORA_ADMIN_KEY is shorter than ' + ADMIN_KEY_MIN + ' characters - set a longer random one on Render');
  }
  const who = ip || '-';
  const now = Date.now();
  const s = ADMIN_MISSES.get(who);
  const shut = (until, all) => {
    const sec = Math.max(1, Math.ceil((until - now) / 1000));
    const m = Math.max(1, Math.ceil(sec / 60));
    return { ok: false, httpStatus: 429, body: { error: 'TOO_MANY', retryAfter: sec,
      message: (all ? 'Too many wrong admin keys from many addresses — the console is shut for everybody; try again in '
                    : 'Too many wrong admin keys from this address — try again in ') + m + ' minute' + (m === 1 ? '' : 's') + '.' } };
  };
  if (ADMIN_ALL.until > now) return shut(ADMIN_ALL.until, true);
  if (s && s.until > now) return shut(s.until);
  if (adminAuthorised(request)) { if (s) ADMIN_MISSES.delete(who); return { ok: true }; }
  /* 4.72.0 (audit 39) — every wrong key is in the event log, with where it came from (never what was typed) —
     4.72.0 review: up to ADMIN_LOG_MAX of them (with the per-address locks) a quarter-hour from every address
     together, so a flood from many addresses cannot fill the database */
  if (now - ADMIN_ALL.since > ADMIN_LOCK_MS) { ADMIN_ALL.since = now; ADMIN_ALL.n = 0; ADMIN_ALL.logged = 0; ADMIN_ALL.said = false; }
  ADMIN_ALL.n++;
  const mayLog = () => ADMIN_ALL.logged < ADMIN_LOG_MAX && ++ADMIN_ALL.logged > 0;
  const from = consoleCaller(request, who);
  if (mayLog()) await logEvent(null, 'ADMIN_KEY_WRONG', { ip: who, app: from.app, ua: from.ua });
  if (ADMIN_ALL.n >= ADMIN_ALL_TRIES) {
    if (adminKeyShort()) {
      ADMIN_ALL.until = now + ADMIN_LOCK_MS;
      await logEvent(null, 'ADMIN_KEY_LOCKED_ALL', { tries: ADMIN_ALL.n, last: who });
      ADMIN_ALL.n = 0; ADMIN_ALL.since = now; ADMIN_ALL.logged = 0; ADMIN_ALL.said = false;
      return shut(ADMIN_ALL.until, true);
    }
    /* 4.72.0 review — a long key: nobody is shut out; the log says it once this quarter-hour */
    if (!ADMIN_ALL.said) {
      ADMIN_ALL.said = true;
      await logEvent(null, 'ADMIN_KEY_MANY_WRONG', { tries: ADMIN_ALL.n, last: who, locked: false });
    }
  }
  const n = (s && !s.until ? s.n : 0) + 1;
  if (n >= ADMIN_TRIES) {
    const until = now + ADMIN_LOCK_MS;
    ADMIN_MISSES.delete(who);
    ADMIN_MISSES.set(who, { n: 0, until });
    if (mayLog()) await logEvent(null, 'ADMIN_KEY_LOCKED', { ip: who, tries: n });
    trimMisses(now);
    return shut(until);
  }
  ADMIN_MISSES.set(who, { n, until: 0 });
  trimMisses(now);
  return { ok: false, httpStatus: 401, body: { error: 'UNAUTHORISED' } };
}
/** 4.72.0 review — the per-address counts kept within ADMIN_MISSES_MAX: those no longer locked go first (as
 *  before, from 5000), then the oldest (a Map keeps the order they were set in; a lock is set anew). */
function trimMisses(now) {
  if (ADMIN_MISSES.size <= 5000) return;
  for (const [k, v] of ADMIN_MISSES) if (!(v.until > now)) ADMIN_MISSES.delete(k);
  if (ADMIN_MISSES.size <= ADMIN_MISSES_MAX) return;
  for (const k of ADMIN_MISSES.keys()) {
    if (ADMIN_MISSES.size <= ADMIN_MISSES_MAX) break;
    ADMIN_MISSES.delete(k);
  }
}
/** For the suites only: forget every wrong-key count (per address and in all). */
export function forgetAdminMisses() {
  ADMIN_MISSES.clear(); ADMIN_ALL.n = 0; ADMIN_ALL.since = 0; ADMIN_ALL.until = 0; ADMIN_ALL.logged = 0; ADMIN_ALL.said = false;
}

export async function listLicences() {
  /* Joined to companies so one screen answers the question that matters:
     which customer is this machine, and how many of their seats are gone.
     LEFT JOIN, and COALESCE on the expiry, so a pre-4.0.0 row that has not
     been adopted yet still lists correctly instead of vanishing. */
  const rows = await q(`
    SELECT l.device_id, l.device_name, l.company, l.email, l.state, l.trial_started_at,
           l.created_at, l.last_seen_at, l.seen_count, l.app_version, l.notes,
           l.company_id, l.seat_no, l.platform, l.approved_at,
           /* 4.6.0 — net of any owner reset, the same figure the licence
              is judged on. The raw report stays in the row. */
           GREATEST(0, l.txn_count - l.txn_base)::int         AS txn_count,
           GREATEST(0, l.usage_minutes - l.usage_base)::int  AS usage_minutes,
           l.usage_reset_at,
           c.name AS co_name, c.licence_key AS co_key, c.state AS co_state,
           c.seats AS co_seats, c.is_demo AS co_is_demo,
           COALESCE(c.expires_at, l.expires_at) AS expires_at,
           GREATEST(0, ((COALESCE(c.expires_at, l.expires_at) AT TIME ZONE INTERVAL '+05:30')::date
                        - (now() AT TIME ZONE INTERVAL '+05:30')::date))::int AS days_left,
           (COALESCE(c.expires_at, l.expires_at) < now()) AS expired,
           /* 4.43.0 — who is signed in ON THIS MACHINE, now. One person is
              signed in at one place at a time, so there is at most one, and
              a machine with nobody on it can do nothing but show its
              sign-in screen — which is worth seeing from here when a plant
              rings to say "it is not working". */
           u.name AS on_user, u.session_at AS on_since,
           /* 4.72.0 (audit 97) — whether the row holds its device key yet: a yes or a no, never the hash */
           (l.device_key_hash IS NOT NULL) AS key_held
      FROM licences l
      LEFT JOIN companies c ON c.id = l.company_id
      LEFT JOIN company_users u ON (u.session_device = l.device_id OR u.session_mobile = l.device_id)
     /* 4.72.0 (audit 40) — a deleted company's machines go with it, as they did when a deletion erased them */
     WHERE c.deleted_at IS NULL
     ORDER BY l.created_at DESC
     LIMIT 500`);
  const settings = await getSettings();
  /* 4.72.0 (audit 97) — computers and phones in use whose row holds no device key yet. While there are any,
     a device id alone still re-joins as that device (licence.js activate); once this is 0, NEXORA_DEVICE_KEY_REQUIRED=1
     on Render closes that for good. `required` — whether it is already set. */
  const kl = (await q(`SELECT COUNT(*)::int AS n FROM licences l LEFT JOIN companies c ON c.id = l.company_id
                        WHERE l.state <> 'REVOKED' AND l.device_key_hash IS NULL AND c.deleted_at IS NULL`))[0];
  return { licences: rows, companies: await listCompanies(), settings, aiDefaultDaily: aiDefaultDaily(),
    /* 4.72.0 — additive: what Delete has archived (restorable), the keyless count, and whether the console key is short */
    archived: await listArchived(),
    keyless: { devices: Number(kl && kl.n) || 0, required: keylessRefused() },
    adminKeyShort: adminKeyShort() };
}

/** 4.72.0 (audit 40) — the companies Delete has archived: kept DELETED_KEEP_DAYS, restorable until then
 *  (companyAction 'undelete'), erased after (purgeArchived). Newest first. */
export async function listArchived() {
  const rows = await q(`
    SELECT c.id, c.name, c.email, c.phone, c.gstin, c.login_id, c.is_demo, c.plan, c.seats,
           c.deleted_at, c.deleted_state,
           c.deleted_at + make_interval(days => $1::int) AS purge_at,
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (c.deleted_at + make_interval(days => $1::int) - now())) / 86400))::int AS days_to_purge,
           (SELECT COUNT(*)::int FROM licences l WHERE l.company_id = c.id) AS machines,
           (SELECT COUNT(*)::int FROM company_users u WHERE u.company_id = c.id) AS people,
           (SELECT COUNT(*)::int FROM sync_records s WHERE s.company_id = c.id) AS records
      FROM companies c
     WHERE c.deleted_at IS NOT NULL
     ORDER BY c.deleted_at DESC
     LIMIT 200`, [DELETED_KEEP_DAYS]);
  return rows;
}

/* ---- companies (4.0.0) -----------------------------------------------
   The company IS the licence: one key, N seats, one clock, one state.
   Everything here acts on the company, so a customer's five machines are
   extended, suspended and restored together and can never drift apart. */

export async function listCompanies() {
  const rows = await q(`
    SELECT c.id, c.name, c.licence_key, c.email, c.phone, c.state, c.seats, c.gstin,
           c.grace_days, c.is_demo, c.expires_at, c.created_at, c.notes, c.txn_limit, c.plan, c.ai_daily_limit,
           /* 4.57.0 - when THIS stretch began, and how long it is. Both
              in SQL, in IST like days_left, so the console and the
              Android app cannot disagree with each other by a day. */
           COALESCE(c.period_started_at, c.created_at) AS period_started_at,
           GREATEST(0, ((c.expires_at AT TIME ZONE INTERVAL '+05:30')::date
                        - (COALESCE(c.period_started_at, c.created_at) AT TIME ZONE INTERVAL '+05:30')::date))::int AS period_days,
           /* 4.23.0 — self-registration: who registered, from where, and
              what the GST check said. The passcode hash is never listed. */
           c.login_id, c.self_registered, c.registered_ip, c.registered_device, c.registered_at,
           c.gst_status, c.gst_checked_at, c.gst_note,
           /* 4.31.0 — calendar days in IST; expired is the instant, not the count */
           GREATEST(0, ((c.expires_at AT TIME ZONE INTERVAL '+05:30')::date
                        - (now() AT TIME ZONE INTERVAL '+05:30')::date))::int AS days_left,
           (c.expires_at < now()) AS expired,
           /* 4.42.0 — a seat is a PERSON, so this is the people count.
              The machines are counted beside it under its own name, because
              the owner still wants to know how many are out there — they
              simply are not what the company is paying for. */
           (SELECT COUNT(*)::int FROM company_users u
             WHERE u.company_id = c.id) AS seats_used,
           (SELECT COUNT(*)::int FROM licences l
             WHERE l.company_id = c.id AND l.state <> 'REVOKED') AS machines_used,
           /* 4.3.0 — what this licence has used, summed across its seats.
              Computed here rather than stored, so it cannot disagree with
              the device rows it is made of. */
           (SELECT COALESCE(SUM(GREATEST(0, l.txn_count - l.txn_base)), 0)::int FROM licences l
             WHERE l.company_id = c.id) AS txn_used,
           (SELECT COALESCE(SUM(GREATEST(0, l.usage_minutes - l.usage_base)), 0)::int FROM licences l
             WHERE l.company_id = c.id) AS usage_minutes,
           /* 4.72.0 (audit 90) — a paying licence that ends within 30 days (IST calendar days, like days_left)
              and has not ended yet: the plants to ring about renewing. Demos run out by design and are not in it. */
           (NOT c.is_demo AND c.state = 'LICENSED' AND c.expires_at >= now()
            AND ((c.expires_at AT TIME ZONE INTERVAL '+05:30')::date - (now() AT TIME ZONE INTERVAL '+05:30')::date) <= 30) AS ending_soon
      FROM companies c
     /* 4.72.0 (audit 40) — a deleted (archived) company is listed apart (listArchived), as if it were gone */
     WHERE c.deleted_at IS NULL
     ORDER BY c.is_demo ASC, c.created_at DESC
     LIMIT 500`);
  /* 4.8.0 — who can sign in on this company's seats. */
  for (const c of rows) {
    const u = await usersSummary(c.id);
    c.users_count = u.count;
    c.admin_names = u.admins;
    /* 4.42.0 — whom a circular would actually reach at this company. */
    c.user_emails = u.emails;
    /* One seat = one person. Every name counts, switched off or not;
       users_count stays the ACTIVE number the page always showed. */
    c.users_total = (await userCap(c.id)).count;
    /* 4.67.21 — Nexora AI questions asked today on Nexora's key (this service's count) */
    c.ai_used_today = await aiUsedTodayAll(c.id);   /* 4.71.0 — the higher of memory and the database */
  }
  return rows;
}

/* 4.71.0 (C6, owner 2026-10-01) — the offline allowance a company gets when the owner licenses it
   (companyAction 'create' and 'licence', and licenceAction 'licence', which licenses the machine's company) */
export const LICENSED_GRACE_DAYS = 3;

export async function companyAction(body) {
  const action = String(body.action || '');
  const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 365));

  /* CREATE is the only action without an id. Everything else names one. */
  if (action === 'create') {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'A company name is required.' };
    /* 4.48.0 — the plan. Seats are the owner's to set on either plan (4.48.1). */
    const plan = cleanPlan(body.plan);
    const seats = Math.max(1, Math.min(500, parseInt(body.seats, 10) || 1));
    /* 4.71.0 (C6, owner 2026-10-01) — a licensed customer may work three days without the line (a demo or a
       plant that registered itself stays at none). A company made here IS licensed, so none becomes three;
       the owner can still set none afterwards (Offline days…). */
    const grace = Math.max(0, Math.min(365, parseInt(body.graceDays, 10) || 0)) || LICENSED_GRACE_DAYS;
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = newLicenceKey();
      try {
        const rows = await q(
          `INSERT INTO companies (name, licence_key, email, phone, state, seats, grace_days,
                                  is_demo, expires_at, notes, gstin, plan)
           VALUES ($1,$2,$3,$4,'LICENSED',$5,$6,false, nexora_eod(now() + make_interval(days => $7::int)), $8, $9, $10)
           RETURNING *`,
          [name, key, body.email || null, body.phone || null, seats, grace, days, body.notes || null,
           (String(body.gstin || '').trim().toUpperCase() || null), plan]);
        if (rows.length) {
          await logEvent(null, 'ADMIN_COMPANY_CREATE', { id: rows[0].id, name, seats, days, grace, plan });
          return { ok: true, company: rows[0] };
        }
      } catch (e) {
        if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
      }
    }
    return { error: 'Could not allocate a licence key. Try again.' };
  }

  const id = parseInt(body.id, 10);
  if (!id) return { error: 'A company is required.' };

  /* 4.72.0 (audit 40) — a deleted company (archived for DELETED_KEEP_DAYS) takes nothing but being put back:
     no extending, licensing, new people or PINs for a company that is on its way out. 'delete' says so itself. */
  if (action !== 'undelete' && action !== 'delete') {
    const gone = (await q(`SELECT name, deleted_at FROM companies WHERE id = $1 AND deleted_at IS NOT NULL`, [id]))[0];
    if (gone) {
      return { error: gone.name + ' is deleted. Restore it first (Companies → Deleted) — it can be restored until ' +
        istDate(purgeDayOf(gone.deleted_at)) + '.' };
    }
  }

  if (action === 'extend') {
    /* From whichever is later, so extending a live licence adds time
       rather than shortening it.

       4.57.0 — and the stretch starts again TODAY, because that is the
       honest answer to "when did this start": a licence extended on
       Tuesday began on Tuesday, not on the day the customer first
       downloaded a demo. */
    await q(`UPDATE companies
                SET expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int)),
                    period_started_at = now()
              WHERE id = $1`, [id, days]);
    await logEvent(null, 'ADMIN_COMPANY_EXTEND', { id, days });

  } else if (action === 'licence') {
    /* 4.71.0 (C6) — and a demo turning into a customer gets the customer's offline allowance: none becomes
       three days. One the owner already set is left as it is. */
    await q(`UPDATE companies
                SET state = 'LICENSED', is_demo = false,
                    expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int)),
                    period_started_at = now(),
                    grace_days = CASE WHEN grace_days = 0 THEN $3::int ELSE grace_days END
              WHERE id = $1`, [id, days, LICENSED_GRACE_DAYS]);
    await logEvent(null, 'ADMIN_COMPANY_LICENCE', { id, days });

  } else if (action === 'seats') {
    const seats = Math.max(1, Math.min(500, parseInt(body.seats, 10) || 1));
    /* Reducing below what is in use is ALLOWED and stops nothing. Silently
       revoking somebody's PC to satisfy a number is exactly the kind of
       data loss rule #29 forbids — so it warns and leaves them running. */
    const used = (await q(
      `SELECT COUNT(*)::int AS n FROM licences WHERE company_id = $1 AND state <> 'REVOKED'`, [id]))[0];
    await q(`UPDATE companies SET seats = $2 WHERE id = $1`, [id, seats]);
    const people = (await q(`SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1`, [id]))[0];
    await logEvent(null, 'ADMIN_COMPANY_SEATS', { id, seats, inUse: Number(used.n), people: Number(people.n) });
    /* 4.42.0 — a seat is a person and nothing else. Machines are not
       rationed any more, so their number is no longer a warning: a plant
       may put Nexora on every terminal it owns and still pay for the
       three people who actually use it. Going below the people already
       created stops nobody; the application refuses the NEXT person. */
    const warn = [];
    if (Number(people.n) > seats) warn.push(people.n + ' people are on this company, which is more than the ' + seats +
      ' seats now allowed. Nobody was removed — the application refuses the next person until seats are raised.');
    if (warn.length) return { ok: true, warning: 'Saved. ' + warn.join(' ') };

  } else if (action === 'plan') {
    /* 4.48.0 — STANDARD or PRO. Seats are untouched: they are the owner's
       to set on either plan (4.48.1). */
    const plan = cleanPlan(body.plan);
    await q(`UPDATE companies SET plan = $2 WHERE id = $1`, [id, plan]);
    await logEvent(null, 'ADMIN_COMPANY_PLAN', { id, plan });
  } else if (action === 'grace') {
    const grace = Math.max(0, Math.min(365, parseInt(body.graceDays, 10) || 0));
    await q(`UPDATE companies SET grace_days = $2 WHERE id = $1`, [id, grace]);
    await logEvent(null, 'ADMIN_COMPANY_GRACE', { id, grace });

  } else if (action === 'suspend') {
    await q(`UPDATE companies SET state = 'SUSPENDED' WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_COMPANY_SUSPEND', { id });

  } else if (action === 'restore') {
    await q(`UPDATE companies SET state = CASE WHEN is_demo THEN 'DEMO' ELSE 'LICENSED' END WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_COMPANY_RESTORE', { id });

  } else if (action === 'rename') {
    /* 4.72.0 (audit 39) — and the log says what it was called before */
    const was = (await q(`SELECT name FROM companies WHERE id = $1`, [id]))[0];
    const to = String(body.name || '').trim() || 'Unnamed';
    await q(`UPDATE companies SET name = $2 WHERE id = $1`, [id, to]);
    await logEvent(null, 'ADMIN_COMPANY_RENAME', { id, from: was ? was.name : null, to });

  } else if (action === 'gstin') {
    /* Stored exactly as given, upper-cased only. The shape is checked in
       the app; the server does not second-guess a legal identifier. */
    await q(`UPDATE companies SET gstin = $2 WHERE id = $1`,
      [id, String(body.gstin || '').trim().toUpperCase() || null]);
    await logEvent(null, 'ADMIN_COMPANY_GSTIN', { id });

  } else if (action === 'ailimit') {
    /* 4.67.21 — "want to limit ai call as per company per day from console and from console android app":
       Nexora AI questions a day on Nexora's key. 0 (or empty) = the service's own number. A company with its
       own Gemini key is Google's to limit, not this. */
    const lim = Math.max(0, Math.min(100000, parseInt(body.aiDailyLimit, 10) || 0));
    await q(`UPDATE companies SET ai_daily_limit = $2 WHERE id = $1`, [id, lim || null]);
    aiForget(id);
    await logEvent(null, 'ADMIN_COMPANY_AILIMIT', { id, aiDailyLimit: lim });

  } else if (action === 'txnlimit') {
    /* 4.3.0 — how many transactions this licence may commit.
       0 means NO LIMIT and is the default, so a company nobody sets this
       on behaves exactly as it did before the column existed.

       Lowering it below what is already used is ALLOWED and destroys
       nothing — the same principle as reducing seats. It stops NEW
       transactions; every saved calculation still opens, reads and
       prints. The warning says so, because an owner who lowers a limit by
       accident should learn it here rather than from the customer. */
    const lim = Math.max(0, Math.min(10000000, parseInt(body.txnLimit, 10) || 0));
    await q(`UPDATE companies SET txn_limit = $2 WHERE id = $1`, [id, lim]);
    const u = (await q(
      `SELECT COALESCE(SUM(GREATEST(0, txn_count - txn_base)), 0)::int AS n FROM licences WHERE company_id = $1`, [id]))[0];
    const used = Number(u && u.n) || 0;
    await logEvent(null, 'ADMIN_COMPANY_TXNLIMIT', { id, txnLimit: lim, used });
    if (lim > 0 && used >= lim) {
      return { ok: true, warning: 'Saved. This licence has already committed ' + used +
        ' transactions, which is at or over the new limit of ' + lim +
        '. Nothing saved was touched, but its machines cannot commit anything new until the limit is raised.' };
    }

  } else if (action === 'resetusage') {
    /* 4.6.0 — start this licence's count and hours again from zero, on
       every seat. The machines' own reports are not altered (they are
       monotonic by design); the point they stood at is recorded and
       everything is read as count − base from here on. A limit that was
       reached is therefore no longer reached, on the very next heartbeat. */
    await q(`UPDATE licences
                SET txn_base = txn_count, usage_base = usage_minutes, usage_reset_at = now()
              WHERE company_id = $1`, [id]);
    await logEvent(null, 'ADMIN_COMPANY_RESETUSAGE', { id });

  } else if (action === 'users') {
    /* 4.39.0 — THE PEOPLE ON A COMPANY, FROM THE OWNER'S SIDE.

         "company console ma thi user delete ane create kri sakay ane
          tamam user ane passcode joi sakay"

       A company runs its own people from inside the application, and
       that stays true. But when a plant telephones — the administrator
       has left, nobody can sign in, a leaver is still holding the only
       seat — the owner had no way to see who is on a company, let alone
       do anything about it. This is that way.

       WHAT IS NOT HERE, AND WILL NOT BE: the PINs. They are scrypt
       hashes, exactly like the company passcode, so there is nothing to
       show — not to the plant, not to the owner, not to anyone who ever
       gets hold of the database. That is the whole point of storing them
       that way, and it is worth far more than the convenience of reading
       one back. When somebody has forgotten theirs, SET a new one and
       tell them: 'userpin' below, and 'passcode' for the company's own.
       Every bank in the world answers a forgotten password the same
       way, for the same reason. */
    const list = await listUsers(id);
    const cap = await userCap(id);
    /* 4.43.0 — a device id is sixteen characters of hex and means
       nothing to the person reading it. Name the machine. */
    const machines = await q(`SELECT device_id, device_name FROM licences WHERE company_id = $1`, [id]);
    const nameOf = {};
    machines.forEach((m) => { nameOf[m.device_id] = m.device_name || null; });
    list.forEach((u) => { u.sessionDeviceName = u.sessionDevice ? (nameOf[u.sessionDevice] || null) : null; });
    return { ok: true, users: list, cap: cap };

  } else if (action === 'usersignout') {
    /* 4.43.0 — SIGN SOMEBODY OUT FROM HERE.

       One person is signed in at one place at a time, and a session ends
       when the application closes. That leaves one case the plant cannot
       fix for itself: the machine is gone — stolen, wiped, or sitting
       switched off in a shed — and it will never close tidily. The name
       stays bound to it, and the person cannot get on anywhere because
       they would displace a machine that is not there to be displaced.

       This releases the binding. It does not change the PIN and it does
       not remove anybody: the very next sign-in, anywhere, simply works. */
    const u = (await q(`SELECT id, name, session_device, session_mobile FROM company_users WHERE id = $1 AND company_id = $2`,
      [body.userId, id]))[0];
    if (!u) return { error: 'No such person on this company.' };
    if (!u.session_device && !u.session_mobile) return { ok: true, warning: u.name + ' is not signed in anywhere.' };
    await q(`UPDATE company_users SET session_device = NULL, session_at = NULL, session_mobile = NULL, session_mobile_at = NULL WHERE id = $1`, [u.id]);
    await logEvent(null, 'ADMIN_USER_SIGNOUT', { companyId: id, userId: u.id, was: u.session_device, phone: u.session_mobile || null });
    /* 2026-09-28 — the machine and the phone are told NOW (a waiting /v1/sync/wait answers), and
       authorise() no longer takes an empty binding for "signed in here" */
    const ended = { name: u.name, at: new Date().toISOString(), where: 'no other computer \u2014 the administrator signed this account out', signedOut: true };
    [u.session_device, u.session_mobile].filter(Boolean).forEach((d) => { try { endSessionOn(id, u.id, d, ended); } catch (e) { /* told at the next call instead */ } });
    return { ok: true, warning: u.name + ' has been signed out. The machine they were on finds out at its next ' +
      'check and shows the sign-in screen; they can sign in anywhere now.' };

  } else if (action === 'useradd') {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'A name is required.' };
    if (!validPin(body.pin)) return { error: 'A PIN of at least 4 characters is required.' };
    const key = nameKey(name);
    const dup = await q(`SELECT id FROM company_users WHERE company_id = $1 AND name_key = $2`, [id, key]);
    if (dup.length) return { error: 'There is already a user called ' + name + ' on this company.' };
    /* The seat limit is the licence, and the owner is not exempt from it:
       a seat given here is a seat the company is not paying for. Raise
       the seats first if that is what is meant. */
    const cap = await userCap(id);
    if (cap.count >= cap.max) {
      return { error: 'This company has ' + cap.max + ' seat(s) and ' + cap.count +
        ' person(s) on them. Give it more seats first, or remove someone who has left.' };
    }
    /* 4.71.0 (audit) — an ordinary user starts with the least (sync.js defaultPermissions): no costs, no
       prices, no deleting, no managing people. Their administrator ticks more inside the application. */
    const rows = await q(
      `INSERT INTO company_users (company_id, name, name_key, pin_hash, role, scope, active, email, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8) RETURNING *`,
      [id, name, key, hashPin(body.pin), body.role === 'ADMIN' ? 'ADMIN' : 'USER',
       body.scope === 'ALL' ? 'ALL' : 'OWN', cleanEmail(body.email),
       body.role === 'ADMIN' ? null : JSON.stringify(defaultPermissions())]);
    await logEvent(null, 'ADMIN_USER_CREATE', { companyId: id, userId: rows[0].id, name });
    return { ok: true, warning: name + ' can now sign in. Tell them the PIN directly \u2014 it is not shown again.' };

  } else if (action === 'useremail') {
    /* 4.42.0 \u2014 a person's own address, set or cleared. Blank clears it,
       which is the only way to take somebody off the distribution list who
       still runs the software. */
    const u = (await q(`SELECT id, name FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    const raw = String(body.email == null ? '' : body.email).trim();
    const mail = cleanEmail(raw);
    if (raw && !mail) return { error: 'That does not look like an email address.' };
    await q(`UPDATE company_users SET email = $3 WHERE company_id = $1 AND id = $2`, [id, u.id, mail]);
    await logEvent(null, 'ADMIN_USER_EMAIL', { companyId: id, userId: u.id, name: u.name, set: !!mail });
    return { ok: true, warning: mail
      ? u.name + ' will be written to at ' + mail + '.'
      : 'The address for ' + u.name + ' has been taken off.' };

  } else if (action === 'userrole') {
    /* 4.39.0 — what a person IS on their company. An administrator adds
       and removes people and sees everyone's work; an ordinary user does
       neither. The plant changes this itself from inside the
       application; this is for the call where the only administrator has
       left and nobody inside can promote anyone. */
    const want = body.role === 'ADMIN' ? 'ADMIN' : 'USER';
    const u = (await q(`SELECT id, name, role FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    if (u.role === want) return { ok: true, warning: u.name + ' is already ' + (want === 'ADMIN' ? 'an administrator' : 'an ordinary user') + '.' };
    if (u.role === 'ADMIN' && want === 'USER') {
      const admins = await q(
        `SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1 AND role = 'ADMIN' AND active = true`, [id]);
      if ((Number(admins[0].n) || 0) <= 1) {
        return { error: u.name + ' is the only administrator. Make somebody else one first \u2014 a company with none cannot add anybody.' };
      }
    }
    /* An administrator sees the company's work, which is what the role is
       for; stepping down puts that back to their own unless somebody has
       deliberately widened it. */
    await q(`UPDATE company_users SET role = $3, scope = CASE WHEN $3 = 'ADMIN' THEN 'ALL' ELSE scope END
              WHERE company_id = $1 AND id = $2`, [id, u.id, want]);
    await logEvent(null, 'ADMIN_USER_ROLE', { companyId: id, userId: u.id, name: u.name, role: want });
    /* 4.71.0 (C2) — an administrator sees costs: the prices they were sent empty come again */
    if (want === 'ADMIN') await resendPrices(id);
    else {
      /* 4.72.0 (audit 38, 95) — stepping down ends their sessions everywhere: whatever they hold from being an
         administrator (prices, every request) must not go on working on a machine they are signed in on. What
         is sent to them depends on who they are, so it is sent again (sync.js resendPrices). */
      await signOutEverywhere(id, u.id, { why: 'CONSOLE_DEMOTED',
        where: 'no other computer — Nexora made this account an ordinary user; sign in again' });
      await resendPrices(id);
    }
    return { ok: true, warning: u.name + ' is now ' + (want === 'ADMIN' ? 'an administrator.'
      : 'an ordinary user, and is signed out everywhere so the change holds at once.') };

  } else if (action === 'userpin') {
    if (!validPin(body.pin)) return { error: 'A PIN of at least 4 characters is required.' };
    const u = (await q(`SELECT id, name FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    /* 4.72.0 \u2014 and the wrong-PIN lock is lifted: the tries counted against the OLD PIN say nothing about the new
       one, and a person locked out is the commonest reason for this reset */
    await q(`UPDATE company_users SET pin_hash = $3, pin_fails = 0, pin_locked_until = NULL WHERE company_id = $1 AND id = $2`,
      [id, u.id, hashPin(body.pin)]);
    /* 4.72.0 (audit 38) \u2014 A NEW PIN ENDS THE SESSIONS THE OLD ONE OPENED. The usual reason for this reset is a
       leaver, or a PIN somebody else learned; the computer or phone already signed in as them used to go on
       working with full access. Now every place they are signed in is signed out at once (sync.js). */
    const out = await signOutEverywhere(id, u.id, { why: 'CONSOLE_PIN_RESET',
      where: 'no other computer \u2014 Nexora set a new PIN for this account; sign in with the new PIN' });
    await logEvent(null, 'ADMIN_USER_PIN', { companyId: id, userId: u.id, name: u.name, signedOut: out.ended.length });
    return { ok: true, signedOut: out.ended.length, warning: 'The PIN for ' + u.name + ' has been set, and they are signed out everywhere' +
      (out.ended.length ? '' : ' (they were not signed in anywhere)') + '. Tell them the new PIN directly \u2014 it is not shown again.' };

  } else if (action === 'userdel') {
    const u = (await q(`SELECT id, name, role FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    /* A company with nobody who can add anyone is a company nobody can
       get back into, so the last administrator does not go this way.
       Make somebody else an administrator first. */
    if (u.role === 'ADMIN') {
      const admins = await q(
        `SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1 AND role = 'ADMIN' AND active = true`, [id]);
      if ((Number(admins[0].n) || 0) <= 1) {
        return { error: u.name + ' is the only administrator. Set another one first \u2014 a company with none cannot add anybody.' };
      }
    }
    /* 4.72.0 (audit 38, 95) — signed out everywhere first, so a machine they are on hears it now rather than
       finding a person who no longer exists at its next call */
    await signOutEverywhere(id, u.id, { why: 'CONSOLE_REMOVED', where: 'no other computer — Nexora removed this account' });
    /* What they saved stays with the company: it is the company's work,
       and a leaver must not take the plant's costings with them. */
    await q(`DELETE FROM company_users WHERE company_id = $1 AND id = $2`, [id, u.id]);
    await logEvent(null, 'ADMIN_USER_DELETE', { companyId: id, userId: u.id, name: u.name });
    return { ok: true, warning: u.name + ' has been removed and signed out everywhere, and their seat is free. Everything they saved stays with the company.' };

  } else if (action === 'passcode') {
    /* 4.39.0 — SET A NEW COMPANY PASSCODE.

       The passcode is scrypt-hashed (passcode.js), so it cannot be read
       back by anyone, including whoever is reading this. That is right —
       and it left a plant that forgot theirs with no way onto another
       computer at all, because the id and passcode are how a
       self-registered company joins its next seat.

       So the owner can set a new one, and tell the customer. It is
       deliberately SET, never shown: there is nothing to show. The login
       id can be corrected at the same time, because a company that
       cannot remember the passcode often cannot remember the id either,
       and a login needs both halves to be right.

       Only a company that registered itself has either; a company Nexora
       issued a licence key to joins with the key and is told so rather
       than being given a passcode it will never use. */
    const co = (await q(`SELECT id, name, login_id, self_registered FROM companies WHERE id = $1`, [id]))[0];
    if (!co) return { error: 'No such company.' };
    if (!co.self_registered) {
      return { error: co.name + ' did not register itself — it joins with its licence key, not with a passcode.' };
    }
    const passcode = body.passcode == null ? '' : String(body.passcode);
    if (!validPasscode(passcode)) {
      return { error: 'A company passcode needs at least ' + PASSCODE_MIN + ' characters.' };
    }
    let loginId = body.loginId == null ? '' : String(body.loginId).trim().toLowerCase();
    if (loginId && loginId !== co.login_id) {
      const taken = await q(`SELECT id FROM companies WHERE login_id = $1 AND id <> $2 LIMIT 1`, [loginId, id]);
      if (taken.length) return { error: 'Another company already uses the login id "' + loginId + '".' };
    } else {
      loginId = co.login_id;
    }
    await q(`UPDATE companies SET login_id = $2, passcode_hash = $3 WHERE id = $1`,
      [id, loginId, hashPasscode(passcode)]);
    /* Recorded, because changing the way into a company is exactly the
       kind of thing that should be answerable for afterwards. The
       passcode itself is never written down. */
    await logEvent(null, 'ADMIN_COMPANY_PASSCODE', { id, name: co.name, loginId });
    return { ok: true, warning: 'The login for ' + co.name + ' is now id "' + loginId +
      '" with the new passcode. Tell them directly \u2014 it is not shown again.' };

  } else if (action === 'adminuser') {
    /* 4.8.0 — the owner creates (or resets the PIN of) the company's
       administrator. Everything else about users happens inside the
       application, by that administrator. */
    const out = await ensureAdmin(id, { name: body.name, pin: body.pin, email: body.email });
    if (out.error) return { error: out.error };
    return { ok: true, user: out.user, warning: out.reset
      ? 'The PIN for ' + out.user.name + ' was reset and they are the administrator.'
      : out.user.name + ' can now sign in as the administrator on any of this company\'s seats.' };

  } else if (action === 'delete') {
    /* 4.72.0 (audit 40) — DELETE NOW ARCHIVES FOR 30 DAYS (DELETED_KEEP_DAYS).
       It used to take the company and everything that hangs off it at once,
       with no way back but last night's whole-database backup. Now the company
       is suspended and marked deleted: every computer and phone of it stops at
       its next check (licence.js describe/authorise refuse it everywhere), it
       leaves the console's lists, and nothing is erased. 'undelete' puts it
       back exactly as it was until DELETED_KEEP_DAYS have passed; after that
       purgeArchived erases it with its machines, people, synced records, master
       history, ink models, chat and problem reports (audit 89). The owner still
       types the company's name to confirm; an id in a button is not a decision,
       a name typed out is. The answer keeps every field it had (removed, name —
       `removed` now counts what will be erased) and says what happened. */
    const co = (await q(`SELECT id, name, state, deleted_at FROM companies WHERE id = $1`, [id]))[0];
    if (!co) return { error: 'No such company.' };
    if (co.deleted_at) {
      return { error: co.name + ' is already deleted. It can be restored until ' + istDate(purgeDayOf(co.deleted_at)) + ' (Companies → Deleted).' };
    }
    if (String(body.confirmName || '').trim() !== String(co.name).trim()) {
      return { error: 'Type the company name exactly — ' + co.name + ' — to delete it.' };
    }
    await ensureInkSchema();
    const counted = (await q(`SELECT
        (SELECT COUNT(*)::int FROM licences WHERE company_id = $1) AS installations,
        (SELECT COUNT(*)::int FROM company_users WHERE company_id = $1) AS users,
        (SELECT COUNT(*)::int FROM sync_records WHERE company_id = $1) AS records,
        (SELECT COUNT(*)::int FROM ink_models WHERE company_id = $1) AS ink_models,
        (SELECT COUNT(*)::int FROM chat_messages WHERE company_id = $1) AS chats,
        (SELECT COUNT(*)::int FROM feedback WHERE company_id = $1) AS reports`, [id]))[0];
    const removed = { installations: counted.installations, users: counted.users, records: counted.records,
      inkModels: counted.ink_models, chats: counted.chats, reports: counted.reports };
    const done = (await q(`UPDATE companies SET deleted_at = now(), deleted_state = state, state = 'SUSPENDED'
                            WHERE id = $1 AND deleted_at IS NULL RETURNING deleted_at`, [id]))[0];
    if (!done) return { error: co.name + ' is already deleted.' };
    const purgeAt = purgeDayOf(done.deleted_at);
    /* every machine of it hears at once: the waits answer now, and their next call is refused */
    forgetCompanies(id);
    try { wakeCompany(id, null); } catch (e) { /* they find out at their next call */ }
    await logEvent(null, 'ADMIN_COMPANY_DELETE', { id, name: co.name, removed, archived: true, was: co.state, purgeAt: purgeAt.toISOString() });
    return { ok: true, removed, name: co.name, archived: true, deletedAt: done.deleted_at, purgeAt: purgeAt.toISOString(),
      restoreDays: DELETED_KEEP_DAYS,
      warning: co.name + ' is deleted: its computers and phones stop at their next check and nobody can sign in. It is kept for ' +
        DELETED_KEEP_DAYS + ' days — Restore (Companies → Deleted) puts it back exactly as it was until ' + istDate(purgeAt) +
        '. After that the company and everything it synced are erased for good.' };

  } else if (action === 'undelete') {
    /* 4.72.0 (audit 40) — PUT A DELETED COMPANY BACK, within DELETED_KEEP_DAYS: the state it had when it was
       deleted (licensed, demo or suspended), its machines, people and records exactly as they were. The
       machines find out at their next check and carry on; nobody has to join or sign in again. */
    const co = (await q(`SELECT id, name, is_demo, deleted_at, deleted_state FROM companies WHERE id = $1`, [id]))[0];
    if (!co) return { error: 'No such company — a deleted company is erased ' + DELETED_KEEP_DAYS + ' days after it was deleted.' };
    if (!co.deleted_at) return { ok: true, name: co.name, warning: co.name + ' is not deleted.' };
    const back = (await q(`UPDATE companies
                              SET state = COALESCE(NULLIF(deleted_state, ''), CASE WHEN is_demo THEN 'DEMO' ELSE 'LICENSED' END),
                                  deleted_at = NULL, deleted_state = NULL
                            WHERE id = $1 AND deleted_at IS NOT NULL RETURNING state`, [id]))[0];
    if (!back) return { error: 'No such company — a deleted company is erased ' + DELETED_KEEP_DAYS + ' days after it was deleted.' };
    forgetCompanies(id);
    try { wakeCompany(id, null); } catch (e) { /* they find out at their next call */ }
    await logEvent(null, 'ADMIN_COMPANY_UNDELETE', { id, name: co.name, state: back.state });
    return { ok: true, name: co.name, state: back.state,
      warning: co.name + ' is back as it was (' + String(back.state).toLowerCase() + '). Its computers and phones work again at their next check.' };

  } else if (action === 'rekey') {
    /* 4.72.0 (audit 96) — A NEW LICENCE KEY. A key that a leaver knows used to add a computer to the plant for
       ever: nothing could change it. Now the owner issues a new one. The old key stops adding computers and phones
       at once (licence.js activate: an unknown key); every computer and phone already on the company keeps
       working, because none of them sends the key again (they re-join with their device id and device key). A
       company that registered itself also joins with its id and passcode: 'passcode' sets a new one. The key is
       answered here, once, for the owner to pass on; the event log keeps only its first part. */
    const co = (await q(`SELECT id, name, licence_key FROM companies WHERE id = $1`, [id]))[0];
    if (!co) return { error: 'No such company.' };
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = newLicenceKey();
      try {
        const rows = await q(`UPDATE companies SET licence_key = $2 WHERE id = $1 RETURNING id`, [id, key]);
        if (!rows.length) return { error: 'No such company.' };
        await logEvent(null, 'ADMIN_COMPANY_REKEY', { id, name: co.name, was: maskKey(co.licence_key), now: maskKey(key) });
        return { ok: true, name: co.name, key,
          warning: 'The new licence key for ' + co.name + ' is ' + key + '. The old key no longer adds a computer or a phone; ' +
            'every computer and phone already on the company keeps working, with nothing to type. Give the new key only to whoever adds the next one.' };
      } catch (e) {
        if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
      }
    }
    return { error: 'Could not allocate a new licence key. Try again.' };

  } else if (action === 'masterHistory') {
    /* 4.72.0 (audit 3, C12) — the earlier copies kept of this company's masters (sync.js keepHistory), newest
       first, without their bodies; masterId narrows it to one master */
    const masterId = body.masterId == null ? '' : String(body.masterId).trim();
    return { ok: true, history: await masterHistory(id, masterId || null) };

  } else if (action === 'restoreMaster') {
    /* 4.72.0 (C12) — {id, historyId}: one kept copy written back with a fresh seq; every computer and phone of
       the company takes it at its next sync, and the copy it replaces is kept in turn (sync.js restoreMaster) */
    if (!(parseInt(body.historyId, 10) > 0)) return { error: 'Which earlier copy? (historyId)' };
    return restoreMaster(id, body.historyId);

  } else if (action === 'note') {
    await q(`UPDATE companies SET notes = $2 WHERE id = $1`, [id, String(body.notes || '')]);
    /* 4.72.0 (audit 39) — logged: its length, never its words (a note may name a person) */
    await logEvent(null, 'ADMIN_COMPANY_NOTE', { id, chars: String(body.notes || '').length });

  } else {
    return { error: 'Unknown action: ' + action };
  }
  return { ok: true };
}

export async function licenceAction(body) {
  const deviceId = String(body.deviceId || '');
  const action = String(body.action || '');
  const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 7));
  if (!deviceId) return { error: 'deviceId is required' };

  /* 4.72.0 review (audit 40) — A MACHINE OF A DELETED COMPANY IS LEFT AS IT IS, exactly as companyAction leaves
     the company: 'licence' or 'extend' would have changed the deleted company's state and expiry (its machines
     then heard a working licence at their heartbeat while every other call was refused, and Restore put back
     the old state but kept the new expiry), and 'delete' would have erased a machine Restore promises to give
     back. The console no longer lists these machines; a stale list (the phone console's) is refused here. */
  const gone = (await q(`SELECT c.name, c.deleted_at FROM licences l JOIN companies c ON c.id = l.company_id
                          WHERE l.device_id = $1 AND c.deleted_at IS NOT NULL`, [deviceId]))[0];
  if (gone) {
    return { error: 'This machine belongs to ' + gone.name + ', which is deleted. Restore the company first (Companies → Deleted) — it can be restored until ' +
      istDate(purgeDayOf(gone.deleted_at)) + '.' };
  }

  /* 4.0.0 — THE CLOCK MOVED TO THE COMPANY. These two actions used to
     write the device's own expires_at, which describe() no longer reads
     once a device has a company. Left as they were they would appear to
     work and change nothing, which is worse than an error. So they now
     act on the company the device belongs to, and say so. */
  if (action === 'extend' || action === 'licence') {
    const rows = await q(`SELECT company_id FROM licences WHERE device_id = $1`, [deviceId]);
    const companyId = rows.length ? rows[0].company_id : null;
    if (!companyId) {
      /* Not adopted yet — write the device row, exactly as before. */
      await q(`UPDATE licences
                  SET expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int)),
                      state = CASE WHEN $3::bool THEN 'LICENSED'
                                   WHEN state = 'EXPIRED' THEN 'TRIAL' ELSE state END
                WHERE device_id = $1`, [deviceId, days, action === 'licence']);
      await logEvent(deviceId, action === 'licence' ? 'ADMIN_LICENCE' : 'ADMIN_EXTEND', { days, scope: 'device' });
      return { ok: true, scope: 'device' };
    }
    await q(`UPDATE companies
                SET expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int)),
                    period_started_at = now()
                  ${action === 'licence' ? ", state = 'LICENSED', is_demo = false, grace_days = CASE WHEN grace_days = 0 THEN " + LICENSED_GRACE_DAYS + " ELSE grace_days END" : ''}
              WHERE id = $1`, [companyId, days]);
    await logEvent(deviceId, action === 'licence' ? 'ADMIN_LICENCE' : 'ADMIN_EXTEND',
      { days, scope: 'company', companyId });
    return { ok: true, scope: 'company', companyId,
      warning: 'This applied to the whole company — every machine on that licence.' };

  } else if (action === 'resetusage') {
    /* 4.6.0 — one machine's count and hours, from zero. Same base
       mechanism as the company-wide reset; the report itself is untouched. */
    await q(`UPDATE licences SET txn_base = txn_count, usage_base = usage_minutes, usage_reset_at = now()
              WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_RESETUSAGE', {});

  } else if (action === 'approve') {
    /* Nexora Mobile — a phone waiting for its company's yes, given here by Nexora (the company's own
       administrator gives it from the desktop or another phone through /v1/devices/approve) */
    /* 4.71.0 — and a computer waiting for its company's yes (licence.js activate) */
    const row = (await q(`SELECT platform FROM licences WHERE device_id = $1`, [deviceId]))[0];
    if (!row) return { error: 'No such installation.' };
    await q(`UPDATE licences SET approved_at = COALESCE(approved_at, now()), approved_by = COALESCE(approved_by, 'Nexora (console)')
              WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, row.platform === 'mobile' ? 'ADMIN_PHONE_APPROVE' : 'ADMIN_PC_APPROVE', {});
  } else if (action === 'revoke') {
    /* 4.71.0 (audit) — marked as Nexora's: a company administrator takes a
       machine away and gives it back through /v1/devices, but one the
       console revoked stays revoked until the console restores it */
    /* C7 — and its device key is let go (licence.js): it stays refused until the console restores it, and
       the machine that joins after that holds a key of its own */
    await q(`UPDATE licences SET state = 'REVOKED', revoked_by = 'NEXORA', device_key_hash = NULL WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_REVOKE', {});
  } else if (action === 'restore') {
    /* 4.42.0 — no seat check: a machine takes no seat, so bringing one
       back cannot take one. What it may DO is decided when a person signs
       in on it, and the people are counted where they are created. */
    const rows = await q(`SELECT company_id FROM licences WHERE device_id = $1`, [deviceId]);
    const companyId = rows.length ? rows[0].company_id : null;
    /* C7 — it comes back holding no device key (the revoke let it go), so it takes the first one it is
       shown. The real machine kept its token through its heartbeat, and that heartbeat now tells it
       licence.device.keyHeld = false (licence.js describe): it joins quietly once with its own key at its
       next heartbeat, before anybody who merely knows its id is likely to. */
    await q(`UPDATE licences SET state = 'TRIAL', revoked_by = NULL WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_RESTORE', { companyId });
  } else if (action === 'delete') {
    /* 4.23.1 — one installation, removed outright. The company-level
       delete cannot reach a device row with no company: the three test
       machines from before 4.0.0 are exactly that, and Revoke only marks
       them. This is the only way to be rid of such a row.
       It does NOT touch the company: a live machine deleted here frees
       its seat and can activate again, which is the difference between
       this and revoking. */
    const row = (await q(`SELECT device_id, device_name, company, company_id FROM licences WHERE device_id = $1`, [deviceId]))[0];
    if (!row) return { error: 'No such installation.' };
    await q(`DELETE FROM licences WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_INSTALL_DELETE', { company: row.company, companyId: row.company_id, deviceName: row.device_name });
    return { ok: true, deleted: deviceId, orphan: !row.company_id };

  } else if (action === 'note') {
    await q(`UPDATE licences SET notes = $2 WHERE device_id = $1`, [deviceId, String(body.notes || '')]);
    /* 4.72.0 (audit 39) — logged: its length, never its words */
    await logEvent(deviceId, 'ADMIN_LICENCE_NOTE', { chars: String(body.notes || '').length });
  } else {
    return { error: 'Unknown action: ' + action };
  }
  return { ok: true };
}

export async function saveSettings(body) {
  const pairs = [];
  if (body.trialDays !== undefined) pairs.push(['trial_days', String(Math.max(1, parseInt(body.trialDays, 10) || 7))]);
  if (body.expiredMode !== undefined) pairs.push(['expired_mode', body.expiredMode === 'HARDSTOP' ? 'HARDSTOP' : 'READONLY']);
  if (body.signupsOpen !== undefined) pairs.push(['signups_open', body.signupsOpen ? 'yes' : 'no']);
  if (body.demoSignup !== undefined) pairs.push(['demo_signup', body.demoSignup ? 'yes' : 'no']);
  if (body.demoGraceDays !== undefined) pairs.push(['demo_grace_days', String(Math.max(0, Math.min(365, parseInt(body.demoGraceDays, 10) || 0)))]);
  if (body.sessionMinutes !== undefined) pairs.push(['session_minutes', String(Math.min(720, Math.max(5, parseInt(body.sessionMinutes, 10) || 30)))]);
  /* 4.48.0 — which features each plan carries. */
  if (body.planFeatures !== undefined) pairs.push(['plan_features', JSON.stringify(cleanPlanFeatures(body.planFeatures))]);
  /* 4.72.0 (audit 39) — what the settings were, so the log can say what changed */
  const before = await getSettings();
  for (const [k, v] of pairs) {
    await q(`INSERT INTO settings (key, value) VALUES ($1,$2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
  }
  forgetSettings();
  const after = await getSettings();
  /* 4.72.0 (audit 39) — EVERY CHANGE TO THE SERVICE'S SETTINGS IS LOGGED, before and after: the demo length,
     what happens when a licence ends (READONLY / HARDSTOP), sign-ups, anonymous demos, the working window, and
     each plan feature switched on or off. Nothing is logged when nothing changed. */
  const was = {}, now = {};
  ['trialDays', 'expiredMode', 'signupsOpen', 'demoSignup', 'demoGraceDays', 'sessionMinutes'].forEach((k) => {
    if (before[k] !== after[k]) { was[k] = before[k]; now[k] = after[k]; }
  });
  const features = [];
  const pb = before.planFeatures || {}, pa = after.planFeatures || {};
  Object.keys(Object.assign({}, pb, pa)).forEach((plan) => {
    const fb = pb[plan] || {}, fa = pa[plan] || {};
    Object.keys(Object.assign({}, fb, fa)).forEach((f) => {
      if (!!fb[f] !== !!fa[f]) features.push(plan + '.' + f + ': ' + (fb[f] ? 'on' : 'off') + ' → ' + (fa[f] ? 'on' : 'off'));
    });
  });
  if (Object.keys(now).length || features.length) {
    await logEvent(null, 'ADMIN_SETTINGS', Object.assign({ before: was, after: now }, features.length ? { features } : {}));
  }
  return { ok: true, settings: after };
}

/** The event log, newest first. `deviceId` — one installation's; opts.admin — 4.72.0 (audit 39): only what was
 *  done FROM THE CONSOLE (every ADMIN_ event, and anything else logged during a console call, which carries
 *  detail.via) — the console's Activity list; opts.limit — up to 500 (100 when not given). */
export async function recentEvents(deviceId, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(500, parseInt(o.limit, 10) || 100));
  return q(`SELECT at, event, device_id, detail FROM activation_log
             WHERE ($1::text IS NULL OR device_id = $1)
               AND ($2::bool IS NOT TRUE OR left(event, 6) = 'ADMIN_' OR (detail -> 'via') IS NOT NULL)
             ORDER BY at DESC, id DESC LIMIT ${limit}`, [deviceId || null, o.admin === true]);
}

/* ---- 4.72.0 (audit 87) — HOW FULL THE DATABASE IS -------------------------
   Supabase's free plan stops writing at 500 MB, and every save in every plant
   would then fail at once. Nothing watched it. This is the console's view: the
   database's size against that limit (a warning from 80 %), and each table's
   size with its exact row count, largest first. Asked for only when the
   Service settings tab is opened, never by the background checks. */
export const DB_LIMIT_BYTES = 500 * 1024 * 1024;
export const DB_WARN_SHARE = 0.8;
export async function dbStatus() {
  const top = (await q(`SELECT pg_database_size(current_database())::bigint AS bytes, now() AS at`))[0];
  const tables = await q(`SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
                            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
                           ORDER BY pg_total_relation_size(c.oid) DESC, c.relname
                           LIMIT 25`);
  /* exact counts, in one statement; a table name is only ever one the catalogue gave, and only plain ones */
  const plain = tables.filter((t) => /^[a-z_][a-z0-9_]*$/.test(t.name));
  const counts = plain.length
    ? (await q('SELECT ' + plain.map((t, i) => '(SELECT COUNT(*) FROM "' + t.name + '")::bigint AS c' + i).join(', ')))[0]
    : {};
  const bytes = Number(top && top.bytes) || 0;
  const share = bytes / DB_LIMIT_BYTES;
  return {
    at: top && top.at, bytes, limitBytes: DB_LIMIT_BYTES,
    usedPct: Math.round(share * 1000) / 10, warnPct: DB_WARN_SHARE * 100, warn: share >= DB_WARN_SHARE,
    tables: tables.map((t) => {
      const i = plain.indexOf(t);
      return { name: t.name, bytes: Number(t.bytes) || 0, rows: i >= 0 ? Number(counts['c' + i]) || 0 : null };
    })
  };
}

/* ---- 4.72.0 (audit 40, 89) — A DELETED COMPANY IS ERASED AFTER 30 DAYS -------
   Everything that belongs to it goes, in one statement, so it is all or
   nothing: its machines, people, synced records and the earlier copies of its
   masters, its ink models and their history, its company chat, its problem
   reports and its Nexora AI day counts; an enquiry that led to it is kept (it
   is Nexora's own lead) but no longer points at it. The company row is locked
   first and must still be due — one put back a moment ago is left alone. Run
   at most every six hours, from /health and the console (index.js); never on a
   company the console can still restore. */
const PURGE_SQL = `
  WITH due AS (SELECT id FROM companies
                WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $2::int)
                FOR UPDATE),
       l  AS (DELETE FROM licences          WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       u  AS (DELETE FROM company_users     WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       s  AS (DELETE FROM sync_records      WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       h  AS (DELETE FROM sync_history      WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       i  AS (DELETE FROM ink_models        WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       ih AS (DELETE FROM ink_model_history WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       ch AS (DELETE FROM chat_messages     WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       fb AS (DELETE FROM feedback          WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       ai AS (DELETE FROM ai_usage          WHERE company_id IN (SELECT id::text FROM due) RETURNING 1),
       rb AS (DELETE FROM recycle_bin       WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       bs AS (DELETE FROM backup_secrets    WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       pl AS (DELETE FROM product_links     WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       iq AS (UPDATE inquiries SET company_id = NULL WHERE company_id IN (SELECT id FROM due) RETURNING 1),
       co AS (DELETE FROM companies         WHERE id IN (SELECT id FROM due) RETURNING 1)
  SELECT (SELECT COUNT(*) FROM co)::int AS companies, (SELECT COUNT(*) FROM l)::int AS installations,
         (SELECT COUNT(*) FROM u)::int AS users, (SELECT COUNT(*) FROM s)::int AS records,
         (SELECT COUNT(*) FROM h)::int AS "masterHistory", (SELECT COUNT(*) FROM i)::int AS "inkModels",
         (SELECT COUNT(*) FROM ih)::int AS "inkHistory", (SELECT COUNT(*) FROM ch)::int AS chats,
         (SELECT COUNT(*) FROM fb)::int AS reports, (SELECT COUNT(*) FROM ai)::int AS "aiDays",
         (SELECT COUNT(*) FROM rb)::int AS "recycleBin", (SELECT COUNT(*) FROM bs)::int AS "backupSecret",
         (SELECT COUNT(*) FROM iq)::int AS "enquiriesUnlinked"`;
/* 4.73.0 — C15: the same run erases every company's recycle-bin copies older than RECYCLE_KEEP_DAYS (sync.js),
   whether or not a company is due; `binErased` says how many went. C19: a company erased takes its backup
   password with it (bs above) — while it is only deleted (restorable) the password stays, as everything does. */
export async function purgeArchived() {
  const binErased = await purgeRecycleBin();
  if (binErased) await logEvent(null, 'RECYCLE_PURGE', { erased: binErased, keepDays: RECYCLE_KEEP_DAYS });
  const due = await q(`SELECT id, name FROM companies
                        WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $1::int)
                        ORDER BY deleted_at LIMIT 20`, [DELETED_KEEP_DAYS]);
  const purged = [];
  if (!due.length) return { purged, binErased };
  await ensureInkSchema();   /* ink_models / ink_model_history exist before they are named */
  for (const c of due) {
    const r = (await q(PURGE_SQL, [c.id, DELETED_KEEP_DAYS]))[0];
    if (r && r.companies) {
      const erased = Object.assign({}, r); delete erased.companies;
      await logEvent(null, 'ADMIN_COMPANY_PURGE', { id: Number(c.id), name: c.name, erased });
      purged.push({ id: Number(c.id), name: c.name, erased });
    }
  }
  return { purged, binErased };
}
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
let purgeLast = 0, purgeRunning = null;
/** Starts purgeArchived when it has not run for six hours; never waits for it and never fails the caller. */
export function purgeArchivedSoon() {
  if (purgeRunning || Date.now() - purgeLast < PURGE_EVERY_MS) return;
  purgeLast = Date.now();
  purgeRunning = purgeArchived()
    .catch((e) => {
      purgeLast = Date.now() - PURGE_EVERY_MS + 10 * 60 * 1000;   /* tried again in ten minutes, not on every call */
      console.error('[nexora] erasing deleted companies did not finish: ' + String((e && e.message) || e).replace(/"[^"]*"|'[^']*'/g, '"…"').slice(0, 200));
    })
    .finally(() => { purgeRunning = null; });
}

/* ------------------------------------------------------------------ */
export const ADMIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexora — Licence console</title>
<link rel="icon" type="image/png" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">
<style>
/* 4.39.0 — THE CONSOLE WEARS THE APPLICATION'S THEME.

     "make it reach same like app theme"

   It had the application's colours and none of its manners: no brand,
   no mode switch of its own, flat cards, flat buttons. Somebody who
   spends their day in Nexora and then opens this to answer a customer
   should not feel they have left the product.

   These are the application's OWN tokens, values and all \u2014 including the
   4.39.0 dark mode, where the quiet writing was lifted from 3.13:1 to
   4.82:1 against a card. The console is themed BY HAND rather than by
   the OS now, exactly as the app is: data-theme on the root, remembered
   between visits, starting from whatever the machine prefers. */
:root{
  --bg:#f4f6fb;--bg-elevated:#ffffff;--bg-sunken:#eceff5;--surface:#fff;--surface-hover:#f1f4fa;
  --border:#e1e5ee;--border-strong:#cbd2e1;
  --text:#1a2233;--muted:#667085;--faint:#98a2b3;
  --accent:#4f7cff;--accent-rgb:79,124,255;--accentbg:#eaf1fe;
  --ok:#16a34a;--warn:#d97706;--bad:#dc2626;--okbg:#e8f7ee;--warnbg:#fef3e2;--badbg:#fdeaea;
  --shadow-sm:0 1px 2px rgba(20,24,38,.06);
  --shadow:0 4px 16px rgba(20,24,38,.08);
  --shadow-lg:0 12px 32px rgba(20,24,38,.14);
  --radius:12px;--radius-sm:8px;
  --font:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
}
:root[data-theme=dark]{
  --bg:#12141c;--bg-elevated:#1b1e29;--bg-sunken:#0c0e14;--surface:#1b1e29;--surface-hover:#232735;
  --border:#333a4f;--border-strong:#464f6a;
  --text:#eef0f6;--muted:#a8b2ca;--faint:#7f8aa6;
  --accentbg:#1c2740;
  --ok:#34d399;--warn:#fbbf24;--bad:#f87171;--okbg:#12291f;--warnbg:#2c2410;--badbg:#2c1616;
  /* Depth in a dark room comes from the edge: a black shadow on a
     near-black page is invisible, so every raised surface carries a
     hairline of light along its top instead. */
  --shadow-sm:0 1px 2px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.035);
  --shadow:0 4px 20px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.045);
  --shadow-lg:0 16px 40px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);
}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 var(--font);background:var(--bg);color:var(--text);
     -webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0}
.sub{color:var(--muted);margin:0}
/* A card carries the accent down its left edge, painted INSIDE the
   border so the card is exactly the size it was \u2014 the application's
   own signature, and the thing that makes a page of them read as one
   product rather than as a table of boxes. */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:14px;
      box-shadow:var(--shadow-sm),inset 3px 0 0 rgba(var(--accent-rgb),.45);
      transition:box-shadow .16s ease,border-color .16s ease}
.card:hover{box-shadow:var(--shadow),inset 3px 0 0 rgba(var(--accent-rgb),.9)}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.top .grow{flex:1}
.kpis{display:flex;gap:8px;flex-wrap:wrap}
.kpi{background:var(--bg-sunken);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 15px;min-width:100px;
     position:relative;overflow:hidden}
/* the state bar every figure tile in the application wears */
.kpi::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:rgba(var(--accent-rgb),.55)}
.kpi b{display:block;font-size:21px;line-height:1.1;font-weight:800;letter-spacing:-.01em}
.kpi span{color:var(--muted);font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap;border:1px solid transparent}
.s-TRIAL,.s-DEMO{background:var(--okbg);color:var(--ok)}.s-LICENSED{background:var(--accentbg);color:var(--accent)}
.s-EXPIRED{background:var(--warnbg);color:var(--warn)}.s-REVOKED,.s-SUSPENDED,.s-FAILED{background:var(--badbg);color:var(--bad)}
.s-SELF{background:var(--accentbg);color:var(--accent)}.s-UNVERIFIED{background:var(--warnbg);color:var(--warn)}
.key{font:13px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.03em}
code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
button{font:inherit;font-weight:700;padding:7px 13px;border:1px solid var(--border);border-radius:var(--radius-sm);
       background:var(--surface);color:var(--text);cursor:pointer;
       transition:transform .12s cubic-bezier(.2,.8,.3,1),box-shadow .12s ease,border-color .12s ease,color .12s ease,background .12s ease}
button:hover{border-color:var(--accent);color:var(--accent);background:var(--surface-hover);transform:translateY(-1px);box-shadow:var(--shadow-sm)}
button:active{transform:translateY(0)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 2px 6px rgba(var(--accent-rgb),.35)}
button.primary:hover{color:#fff;background:var(--accent);box-shadow:0 4px 12px rgba(var(--accent-rgb),.5)}
button.danger{border-color:var(--bad);color:var(--bad)}button.danger:hover{background:var(--badbg);color:var(--bad)}
button.small{padding:4px 9px;font-size:12px;border-radius:7px}
input,select{font:inherit;padding:8px 10px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);
             background:var(--bg-sunken);color:var(--text);transition:border-color .12s ease,box-shadow .12s ease}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(var(--accent-rgb),.18)}
label{display:inline-flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
label input,label select{font-size:14px;color:var(--text)}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.msg{padding:10px 13px;border-radius:var(--radius-sm);margin:8px 0;font-weight:600;border:1px solid transparent}
.msg.err{background:var(--badbg);color:var(--bad)}.msg.warn{background:var(--warnbg);color:var(--warn)}.msg.ok{background:var(--okbg);color:var(--ok)}
.help{color:var(--muted);font-size:12.5px;margin:6px 0 0}
#gate{max-width:400px;margin:12vh auto}
/* companies */
.co{border:1px solid var(--border);border-radius:var(--radius);padding:15px 17px;margin-bottom:10px;background:var(--surface);
    box-shadow:var(--shadow-sm),inset 3px 0 0 rgba(var(--accent-rgb),.45);
    transition:box-shadow .16s ease,border-color .16s ease}
.co:hover{box-shadow:var(--shadow),inset 3px 0 0 rgba(var(--accent-rgb),.9)}
.co.suspended{border-color:var(--bad)}
.co-head{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
.co-name{font-size:16px;font-weight:700;margin-right:4px}
.co-meta{color:var(--muted);font-size:12.5px;display:flex;gap:14px;flex-wrap:wrap;margin-top:6px}
.co-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
.fact{border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 11px;background:var(--bg-sunken)}
.fact span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.fact b{font-size:15.5px;font-weight:800}
.fact small{color:var(--muted)}
.bar{display:block;height:5px;border-radius:3px;background:var(--border);margin-top:5px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}.bar.full i{background:var(--bad)}
.manage{margin-top:12px;border-top:1px dashed var(--border);padding-top:12px;display:none}
.manage.open{display:block}
.group{margin-bottom:10px}
.group h4{margin:0 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.acts .why{color:var(--muted);font-size:12px;margin-left:4px}
/* 4.45.0 — a row of doors to each section, with what is waiting in each,
   pinned under the title so a long page is one press from anywhere. */
.jump{position:sticky;top:0;z-index:5;display:flex;gap:6px;flex-wrap:wrap;align-items:center;
  padding:8px 0 10px;margin:0 0 6px;background:var(--bg)}
.jump a{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;
  border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);font-weight:700;
  font-size:12.5px;text-decoration:none;box-shadow:var(--shadow-sm)}
.jump a:hover{border-color:var(--accent);color:var(--accent)}
.jump a b{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--accentbg);
  color:var(--accent);font-size:11px;text-align:center;line-height:18px}
.jump a b.hot{background:var(--badbg);color:var(--bad)}
.jump a b.zero{background:var(--bg-sunken);color:var(--muted)}
/* 4.48.1 — the tabs */
.jump button.tab{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:999px;
  border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);font-weight:700;
  font-size:12.5px;cursor:pointer;box-shadow:var(--shadow-sm);font:inherit;font-weight:700}
.jump button.tab:hover{border-color:var(--accent);color:var(--accent)}
.jump button.tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
.jump button.tab.active b{background:rgba(255,255,255,.22);color:#fff}
.jump button.tab b{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--accentbg);
  color:var(--accent);font-size:11px;text-align:center;line-height:18px}
.jump button.tab b.hot{background:var(--badbg);color:var(--bad)}
.jump button.tab b.zero{background:var(--bg-sunken);color:var(--muted)}
.jump button.tab.active b.hot,.jump button.tab.active b.zero{background:rgba(255,255,255,.22);color:#fff}
#app>.card.sec{display:none}
#app>.card.sec.on{display:block}
.say{white-space:pre-wrap;max-width:380px;display:block;line-height:1.45}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:10px}
.legend div{background:var(--bg);border-radius:9px;padding:9px 11px;font-size:12.5px}
.legend b{display:block}
/* ---- the brand, as the application wears it ---- */
.brand{display:flex;align-items:center;gap:11px}
/* 4.44.0 — THE REAL MARK, not a letter in a blue box. The same logo the
   calculation software and the website wear, served by this service itself
   from /logo.png so the console does not depend on anything else being up.
   The dark mode gets a soft halo behind it, because a mark drawn for white
   paper needs a little light under it on a near-black page. */
.brand-mark{width:38px;height:38px;flex:0 0 auto;object-fit:contain;display:block;
  filter:drop-shadow(0 1px 2px rgba(10,14,28,.18))}
:root[data-theme=dark] .brand-mark{
  background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.10) 0%, rgba(255,255,255,0) 70%);
  border-radius:11px;
  filter:drop-shadow(0 0 10px rgba(var(--accent-rgb),.45))}
.brand h1{font-size:18px;letter-spacing:-.01em}
.brand .sub{font-size:11.5px}
/* ---- light and dark, the same switch the application has ---- */
.mode-switch{appearance:none;cursor:pointer;position:relative;width:50px;height:26px;padding:0;flex:0 0 auto;
  border:1px solid var(--border-strong);border-radius:999px;background:var(--bg-sunken);display:inline-flex;align-items:center;
  transition:background .2s ease,border-color .2s ease}
.mode-switch:hover{border-color:rgba(var(--accent-rgb),.75);transform:none;box-shadow:none}
.mode-switch .mode-mark{position:absolute;top:50%;transform:translateY(-50%);width:14px;height:14px;
  display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:11px;transition:opacity .2s ease}
.mode-switch .mode-sun{left:6px}.mode-switch .mode-moon{right:6px}
.mode-switch[aria-checked=false] .mode-sun{opacity:0}
.mode-switch[aria-checked=true] .mode-moon{opacity:0}
.mode-switch .mode-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:11px;
  background:linear-gradient(180deg,#fff 0%,#e6e9f2 100%);color:#d38b0c;
  box-shadow:0 1px 3px rgba(10,14,28,.45),inset 0 1px 0 rgba(255,255,255,.9);
  transition:transform .22s cubic-bezier(.2,.8,.3,1),background .2s ease,color .2s ease}
.mode-switch[aria-checked=true] .mode-knob{transform:translateX(24px);
  background:linear-gradient(180deg,#39415c 0%,#232a3d 100%);color:#cfe0ff}
@media(prefers-reduced-motion:reduce){.mode-switch .mode-knob{transition:none}button{transition:none}}
/* The people panel is a sunken surface, the way the application makes
   a panel that belongs INSIDE a card \u2014 and it takes its colours from
   the tokens rather than from a hard-coded grey, so it follows the
   theme instead of fighting it. */
.users-panel{margin:8px 0 4px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);
             background:var(--bg-sunken);width:100%}
.users-panel table.users{width:100%;border-collapse:collapse;margin:6px 0}
.users-panel table.users th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.7;padding:4px 8px 4px 0}
.users-panel table.users td{padding:7px 10px 7px 0;border-top:1px solid var(--border);font-size:13px}
.users-panel tr.off{opacity:.55}
/* 4.67.21 — "androud app and console ui are still not good, make them more flexi like weight calcuation android
   app" · "in software and every where all fond will be in proper format like capital first then later as proper".
   The console dressed like Nexora Mobile: the head on the logo's sweep, each figure in its own colour, cards
   rounder and softer, a company edged in its state's colour (licensed blue, demo teal, expired amber,
   suspended red), the tabs as pills. Labels and headings in Proper Case; what anyone typed keeps its letters. */
:root{--k-blue:#0A66E0;--k-blue-bg:#E3EEFF;--k-teal:#0B8F7E;--k-teal-bg:#D9F4EF;--k-orange:#D9730D;--k-orange-bg:#FFEDDA;
  --k-violet:#6D3FF5;--k-violet-bg:#EDE6FF;--k-green:#15803D;--k-green-bg:#DDF5E5;--k-red:#DC2626;--k-red-bg:#FDEAEA;
  --k-amber:#B45309;--k-amber-bg:#FEF3C7;--radius:16px}
:root[data-theme=dark]{--k-blue:#5AB0FF;--k-blue-bg:#12294A;--k-teal:#3FD6BE;--k-teal-bg:#0D332E;--k-orange:#FFB066;--k-orange-bg:#3A2613;
  --k-violet:#B39BFF;--k-violet-bg:#281F48;--k-green:#4ADE80;--k-green-bg:#113222;--k-red:#F87171;--k-red-bg:#2C1616;
  --k-amber:#FBBF24;--k-amber-bg:#33290F}
#app>.top{background:linear-gradient(120deg,#002D86 0%,#0A66E0 55%,#1EA0FF 100%);color:#fff;border-radius:20px;padding:16px 18px;
  position:relative;overflow:hidden;box-shadow:0 10px 28px rgba(10,102,224,.28)}
#app>.top::after{content:'';position:absolute;right:-40px;top:-60px;width:180px;height:180px;border-radius:50%;background:rgba(255,255,255,.10);pointer-events:none}
#app>.top h1,#app>.top .sub{color:#fff}#app>.top .sub{opacity:.88}
#app>.top .brand-mark{background:#fff;border-radius:50%;padding:4px}
#app>.top button{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.35);color:#fff}
#app>.top button:hover{background:rgba(255,255,255,.24);color:#fff;border-color:#fff}
#app>.top .mode-switch{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.4)}
#app>.top .kpis{gap:10px}
#app>.top .kpi{border:0;border-radius:14px;min-width:112px;padding:10px 14px;background:var(--k-blue-bg);box-shadow:0 2px 8px rgba(0,0,0,.08)}
#app>.top .kpi::before{display:none}
#app>.top .kpi b{font-size:22px;color:var(--k-blue)}
#app>.top .kpi span{color:var(--text);text-transform:capitalize;letter-spacing:0;font-weight:700}
#app>.top .kpi:nth-child(2){background:var(--k-teal-bg)}#app>.top .kpi:nth-child(2) b{color:var(--k-teal)}
#app>.top .kpi:nth-child(3){background:var(--k-orange-bg)}#app>.top .kpi:nth-child(3) b{color:var(--k-orange)}
#app>.top .kpi:nth-child(4){background:var(--k-green-bg)}#app>.top .kpi:nth-child(4) b{color:var(--k-green)}
#app>.top .kpi:nth-child(5){background:var(--k-violet-bg)}#app>.top .kpi:nth-child(5) b{color:var(--k-violet)}
.card{border-radius:var(--radius);box-shadow:var(--shadow-sm)}
.card:hover{box-shadow:var(--shadow)}
.co{border-radius:var(--radius);box-shadow:var(--shadow-sm),inset 5px 0 0 var(--k-blue);transition:transform .14s ease,box-shadow .16s ease}
.co:hover{transform:translateY(-1px);box-shadow:var(--shadow),inset 5px 0 0 var(--k-blue)}
.co:has(.pill.s-DEMO),.co:has(.pill.s-TRIAL){box-shadow:var(--shadow-sm),inset 5px 0 0 var(--k-teal);border-color:color-mix(in srgb,var(--k-teal) 30%,var(--border))}
.co:has(.pill.s-EXPIRED){box-shadow:var(--shadow-sm),inset 5px 0 0 var(--k-amber);border-color:color-mix(in srgb,var(--k-amber) 30%,var(--border))}
.co:has(.pill.s-SUSPENDED),.co:has(.pill.s-REVOKED),.co.suspended{box-shadow:var(--shadow-sm),inset 5px 0 0 var(--k-red);border-color:color-mix(in srgb,var(--k-red) 40%,var(--border))}
.fact{border-radius:12px;background:var(--bg-sunken)}
.pill{text-transform:capitalize}
/* 2026-10-07 (console) — every Nexora software in the one console: each software its own colour */
.pill.sw-weight{background:var(--k-blue-bg);color:var(--k-blue);border-color:color-mix(in srgb,var(--k-blue) 35%,transparent)}
.pill.sw-fabric{background:var(--k-violet-bg);color:var(--k-violet);border-color:color-mix(in srgb,var(--k-violet) 35%,transparent)}
.sw-cap{display:flex;align-items:center;gap:8px;margin:12px 0 6px;font-size:12px;font-weight:800;letter-spacing:.02em}
.sw-cap::after{content:'';flex:1;height:1px;background:var(--border)}
.sw-cap.sw-weight{color:var(--k-blue)}.sw-cap.sw-fabric{color:var(--k-violet)}
.co.fabric-only{box-shadow:var(--shadow-sm),inset 5px 0 0 var(--k-violet)}
.sw-off{border:1px dashed var(--border);border-radius:12px;padding:10px 12px;color:var(--muted);margin:6px 0}
.s-TRIAL,.s-DEMO{background:var(--k-teal-bg);color:var(--k-teal)}.s-LICENSED{background:var(--k-blue-bg);color:var(--k-blue)}
.s-EXPIRED{background:var(--k-amber-bg);color:var(--k-amber)}.s-REVOKED,.s-SUSPENDED,.s-FAILED{background:var(--k-red-bg);color:var(--k-red)}
.jump button.tab{border-radius:999px}
.jump button.tab.active{background:linear-gradient(120deg,#0A66E0,#1EA0FF);border-color:transparent;box-shadow:0 4px 12px rgba(10,102,224,.3)}
h2,h3,h4,th,.group h4,.fact span,.kpi span,label,.users-panel table.users th{text-transform:capitalize;letter-spacing:0}
input,select,textarea,option,code,.key{text-transform:none}
button.primary{background:linear-gradient(120deg,#0A66E0,#1EA0FF);border-color:transparent}
.fact b{display:block;margin-top:2px}
#app>.top h1 .sub{text-transform:capitalize}
#app>.top h1{white-space:nowrap}
</style></head><body>
<div class="wrap">
  <div id="gate" class="card">
    <div class="brand" style="margin-bottom:10px"><img class="brand-mark" src="/logo.png" alt="Nexora" width="38" height="38">
      <div><h1 style="margin:0">NEXORA</h1><p class="sub" style="margin:0">Licence console</p></div></div>
    <p class="sub" style="margin:4px 0 12px">Enter the admin key (NEXORA_ADMIN_KEY on the service).</p>
    <div id="gateErr"></div>
    <div class="row"><input id="key" type="password" placeholder="Admin key" style="flex:1" onkeydown="if(event.key==='Enter')load()"><button class="primary" onclick="load()">Open</button></div>
  </div>

  <div id="app" style="display:none">
    <div class="top">
      <div class="grow brand"><img class="brand-mark" src="/logo.png" alt="Nexora" width="38" height="38">
        <div><h1 style="margin:0">NEXORA <span class="sub" style="font-weight:600">Licence console</span></h1>
        <p class="sub" id="sub"></p></div></div>
      <div class="kpis" id="kpi"></div>
      <button class="mode-switch" id="mode-switch" role="switch" aria-checked="false" onclick="flipMode()" title="Light \u2014 click for dark">
        <span class="mode-mark mode-sun">\u2600</span><span class="mode-mark mode-moon">\u263e</span>
        <span class="mode-knob">\u2600</span></button>
      <button id="refreshBtn" onclick="refreshNow()">Refresh</button><span class="sub" id="refreshed" style="align-self:center"></span>
      <button data-sec="settings" onclick="showSec(this.dataset.sec)">Service settings</button>
      <button onclick="signOut()" title="Forget the key in this browser tab">Sign out</button>
    </div>
    <!-- 4.48.1 — TABS. "make tab in console its look still tricky": one
         section on screen at a time, the counts on the tabs, the last tab
         remembered in this browser. -->
    <nav class="jump tabs" id="jump">
      <!-- 4.72.0 — each tab hands its section over in data-sec (no onclick carries a quoted string) -->
      <button class="tab" data-sec="sec-companies" onclick="showSec(this.dataset.sec)">Companies <b id="jump-co">–</b></button>
      <button class="tab" data-sec="sec-plans" onclick="showSec(this.dataset.sec)">Plans</button>
      <button class="tab" data-sec="sec-inquiries" onclick="showSec(this.dataset.sec)">Enquiries <b id="jump-q">–</b></button>
      <button class="tab" data-sec="sec-feedback" onclick="showSec(this.dataset.sec)">Feedback &amp; problems <b id="jump-fb">–</b></button>
      <button class="tab" data-sec="sec-broadcast" onclick="showSec(this.dataset.sec)">Message plants</button>
      <button class="tab" data-sec="sec-installations" onclick="showSec(this.dataset.sec)">Installations <b id="jump-inst">–</b></button>
      <button class="tab" data-sec="appcard" onclick="showSec(this.dataset.sec)">Phone app</button>
      <button class="tab" data-sec="sec-activity" onclick="showSec(this.dataset.sec)">Activity</button>
      <button class="tab" data-sec="settings" onclick="showSec(this.dataset.sec)">Service settings</button>
    </nav>

    <div class="card" id="settings" style="display:none">
      <h2>Service settings <span class="sub" style="font-weight:400">— apply to every installation from its next check</span></h2>
      <div class="row" style="margin-top:10px">
        <label>Demo length, days<input id="sTrial" type="number" min="1" max="365" style="width:90px"></label>
        <label>Demo may work offline, days<input id="sGrace" type="number" min="0" max="365" style="width:90px"></label>
        <label>Working window, minutes<input id="sSession" type="number" min="5" max="720" style="width:90px"></label>
        <label>When a licence ends<select id="sMode"><option value="READONLY">Read-only — saved work still opens and prints</option><option value="HARDSTOP">Hard stop</option></select></label>
        <label style="flex-direction:row;align-items:center;gap:8px;color:var(--text)"><input id="sOpen" type="checkbox">Accept new registrations</label>
        <label style="flex-direction:row;align-items:center;gap:8px;color:var(--text)" title="A demo with no GSTIN, email or mobile — anyone who types a name gets one. Off unless you are handing a machine to a prospect yourself."><input id="sDemo" type="checkbox">Also allow anonymous demos</label>
        <button class="primary" onclick="saveSettings()">Save settings</button>
      </div>
      <p class="help"><b>Accept new registrations</b> is how a plant that downloads Nexora starts: company, GSTIN, email, mobile, a company id and passcode. <b>Anonymous demos</b> is the old way &mdash; a licence key left blank creates a company from whatever name is typed, with nothing to tell a real plant from a made-up one; leave it off unless you are demonstrating on a prospect&rsquo;s machine yourself. A demo with 0 offline days stops the moment it cannot reach this service. The working window is only how long a good answer is reused before the application asks again. Offline days for a paying customer are set on the company.</p>
      <!-- 4.72.0 (audit 9, 97) — the console key's length, and the computers and phones still without a device key -->
      <div id="keycard" style="margin-top:12px"></div>
      <!-- 4.72.0 (audit 87) — how full the free database is -->
      <h2 style="margin-top:16px">Database <span class="sub" style="font-weight:400">— Supabase free plan: 500 MB, then every save in every plant fails</span></h2>
      <div id="dbcard"><p class="help">Reading…</p></div>
    </div>

    <!-- 4.72.0 (audit 39) — WHAT WAS DONE FROM THE CONSOLES, read-only: every
         console action, with when and from which console and address, and every
         wrong key. -->
    <div class="card" id="sec-activity">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Activity <span class="sub" style="font-weight:400">— what was done from this console and the phone console, newest first</span></h2>
        <button onclick="loadActivity()">Refresh</button>
      </div>
      <div style="overflow-x:auto"><table id="acttbl">
        <thead><tr><th>When</th><th>What</th><th>Details</th><th>From</th></tr></thead><tbody></tbody></table></div>
      <p class="help">Read-only: nothing here can be changed or removed. <b>From</b> is the console (web or phone) and the address it called from; a wrong key is listed with the address it came from, never with what was typed. PINs, passcodes and licence keys are never written here — a new licence key appears only as its first part.</p>
    </div>

    <!-- 4.48.0 — "give this plan wise access things in console so i can
         control app feature from console as per plan". What each plan
         carries; a demo always gets everything. -->
    <div class="card" id="sec-plans">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Plans <span class="sub" style="font-weight:400">— what Standard and Pro carry; every installation reads this at its next check</span></h2>
        <button class="primary" onclick="savePlans()">Save plans</button>
      </div>
      <div style="overflow-x:auto"><table id="plantbl">
        <thead><tr><th>Feature</th><th>Standard</th><th>Pro</th><th>Demo</th></tr></thead><tbody></tbody></table></div>
      <div id="plMsg"></div>
      <p class="help">Calculation and costing are the product and are always on. A feature unticked for a plan disappears from every installation on that plan &mdash; its window, button and shortcut &mdash; and the application says it belongs to the other plan when somebody asks for it. Seats are separate from the plan: you decide how many people each company may have, on either plan. A <b>demo</b> always has everything, whatever its plan, so a prospect sees the whole application. Each company&rsquo;s plan is set on its card.</p>
    </div>

    <div class="card" id="sec-companies">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Companies</h2>
        <input id="cq" placeholder="Find a company, key, email, GSTIN…" oninput="renderCompanies()" style="min-width:240px">
        <button class="primary" data-target="newco" onclick="toggle(this)">New company</button>
      </div>
      <div id="newco" style="display:none;border:1px solid var(--border);border-radius:10px;padding:12px;margin:8px 0 12px">
        <div class="row">
          <label>Software<select id="nSoft"><option value="weight">Weight Calc</option><option value="fabric">Fabric Stock</option><option value="both">Both — each its own licence</option></select></label>
          <label>Company name<input id="nName" placeholder="Company name" style="min-width:220px"></label>
          <label>Plan (Weight Calc)<select id="nPlan"><option value="PRO">Pro — everything</option><option value="STANDARD">Standard — calculation &amp; costing</option></select></label>
          <label>Seats<input id="nSeats" type="number" min="1" max="500" value="1" style="width:80px"></label>
          <label>Licence days<input id="nDays" type="number" min="1" max="3650" value="365" style="width:90px"></label>
          <label>Offline days<input id="nGrace" type="number" min="0" max="365" value="3" style="width:90px"></label>
          <label>GSTIN<input id="nGst" placeholder="15 characters" maxlength="15" style="min-width:170px;text-transform:uppercase"></label>
          <label>Email<input id="nEmail" placeholder="address" style="min-width:170px"></label>
          <button class="primary" onclick="createCo()">Create licensed company</button>
          <button data-target="newco" onclick="toggle(this)">Cancel</button>
        </div>
        <p class="help">For a customer you set up yourself. A licence key is generated; every computer they install types the same key (the first is let in at once, each one after it waits for the company&rsquo;s administrator). Seats are the people who sign in. A plant that registers itself from the application appears here on its own, as a demo.</p>
      </div>
      <!-- 4.72.0 (audit 90, 40) — all, the paying licences that end within 30 days, and the deleted ones (restorable for 30 days) -->
      <div id="cofilters" class="acts" style="margin:8px 0"></div>
      <div id="coMsg"></div>
      <div id="colist"></div>
      <div class="legend">
        <div><b>Software</b>each Nexora software has its own licence: its own key, period, seats, people and rights. Weight Calc and Fabric Stock are shown together when they are the same company (the same GSTIN, or linked by hand); renewing, suspending or restoring one never touches the other.</div>
        <div><b>Plan</b>is Standard (calculation and costing) or Pro (everything ticked under Plans); seats are set separately. A demo has everything until it is made licensed.</div>
        <div><b>Suspend</b>stops every machine of the company at its next check. Nothing is deleted; Restore puts it all back. Use it when a customer has not paid.</div>
        <div><b>Revoke</b>(on one installation) stops that one machine. It frees no seat — seats are people, and a machine never held one. The company keeps running.</div>
        <div><b>Delete</b>stops the company at once and keeps it for 30 days with everything it had — <b>Restore</b> under <i>Deleted</i> puts it back exactly as it was. After 30 days it is erased for good: its machines, its people, everything they synced, its chat and its problem reports. The name must be typed to confirm.</div>
        <div><b>Transactions and hours</b>are what the company has used — saved records, and time in the application — summed over its machines. A limit of 0 means none.</div>
      </div>
    </div>

    <!-- 4.44.0 — THE PHONE CONSOLE'S RELEASES.

         The Android console is not on Play, so this is what tells it a new
         build exists. The APK is not stored here: the address points at
         wherever the file actually lives. -->
    <div class="card" id="appcard">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Phone app <span class="sub" style="font-weight:400" id="appsub"></span></h2>
        <button class="primary" data-target="newrel" onclick="toggle(this)">Publish a build</button>
      </div>
      <div id="newrel" style="display:none;border:1px solid var(--border);border-radius:10px;padding:12px;margin:8px 0 12px">
        <div class="row">
          <label>Version code<input id="rCode" type="number" min="1" step="1" style="width:120px" placeholder="4"></label>
          <label>Version name<input id="rName" style="width:140px" placeholder="1.3.0"></label>
          <label style="flex:1;min-width:280px">Download address (https)<input id="rUrl" placeholder="https://github.com/…/nexora-console-1.3.0.apk" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label style="flex:1">What changed<input id="rNotes" placeholder="Shown on the phone before it installs" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label>SHA-256 <span class="hint">required &mdash; the phone checks the download against it</span><input id="rSha" placeholder="64 characters: certutil -hashfile the.apk SHA256" style="min-width:260px"></label>
          <label style="flex-direction:row;align-items:center;gap:8px;color:var(--text)"><input id="rMust" type="checkbox">Must install</label>
          <button class="primary" onclick="publishRelease()">Publish</button>
        </div>
        <p class="help">The version code is the number Android compares, and it only ever goes up &mdash; it is <code>versionCode</code> in the app&rsquo;s build file. The address can point anywhere the phone can reach over https: a GitHub release asset, a file on the site, anywhere. Publishing the same code again replaces it.</p>
      </div>
      <!-- 4.44.0 — the repository publishes itself: one small JSON beside
           the APK, and pushing a build is all a new version needs. -->
      <div class="row" style="margin:6px 0 10px">
        <label style="flex:1;min-width:300px">Build repository <span class="hint">a version file the service reads; a push is then all it takes</span>
          <input id="rSource" placeholder="https://raw.githubusercontent.com/…/main/releases/latest.json" style="width:100%"></label>
        <button onclick="saveSource()">Save</button>
      </div>
      <div id="repoLine"></div>
      <div id="appMsg"></div>
      <div style="overflow-x:auto"><table id="apptbl">
        <thead><tr><th>Version</th><th>Code</th><th>Published</th><th>What changed</th><th>Address</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">Every phone running the console checks this and offers the newest build it finds &mdash; whichever is higher, the repository&rsquo;s file or a version published here. Withdrawing one makes the phones offer the version below it instead.</p>
    </div>

    <!-- 4.42.0 — THE ENQUIRIES.

         Everybody who has asked about the software and not yet bought it.
         The website's contact and demo forms post straight in; the ones
         that arrive by phone are typed in here. The phone console shows
         exactly this table from exactly this service, so the two are never
         out of step with each other. -->
    <div class="card" id="sec-inquiries">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Enquiries <span class="sub" style="font-weight:400" id="qsub"></span></h2>
        <input id="qq" placeholder="Find a name, plant, number, product…" oninput="renderInquiries()" style="min-width:240px">
        <button class="primary" data-target="newq" onclick="toggle(this)">New enquiry</button>
      </div>
      <div id="qstates" class="acts" style="margin:8px 0"></div>
      <div id="newq" style="display:none;border:1px solid var(--border);border-radius:10px;padding:12px;margin:8px 0 12px">
        <input type="hidden" id="qId" value="">
        <div class="row">
          <label>Name<input id="qName" placeholder="Who asked" style="min-width:180px"></label>
          <label>Company / plant<input id="qCompany" placeholder="Their plant" style="min-width:200px"></label>
          <label>Mobile<input id="qPhone" placeholder="WhatsApp / mobile" style="min-width:150px"></label>
          <label>Email<input id="qEmail" placeholder="address" style="min-width:180px"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label>Which software<select id="qProduct" style="min-width:230px"></select></label>
          <label>How it came<select id="qSource" style="min-width:150px"></select></label>
          <label>Where it has got to<select id="qState" style="min-width:150px"></select></label>
          <label>Follow up on<input id="qFollow" type="date" style="min-width:150px"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label style="flex:1">What they asked<input id="qMessage" placeholder="Constructions, volume, what they want" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label style="flex:1">Your note<input id="qNotes" placeholder="What you told them, what to do next" style="width:100%"></label>
          <button class="primary" onclick="saveInquiry()">Save enquiry</button>
          <button onclick="clearInquiryForm()">Clear</button>
        </div>
        <p class="help">For the ones that come by phone, on WhatsApp or at an exhibition. The website&rsquo;s own form fills this table by itself.</p>
      </div>
      <div id="qMsg"></div>
      <div style="overflow-x:auto"><table id="qtbl">
        <thead><tr><th>Who</th><th>Software</th><th>State</th><th>Came</th><th>Reach them</th><th>Asked</th><th>Follow up</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">An enquiry is not a customer. When one becomes a customer, create the company in the ordinary way above; the enquiry stays here as the record of where they came from.</p>
    </div>

    <!-- 4.47.1 — a message from Nexora into every plant's conversation:
         "pushed directly in chat so every user get and sender will be
         nexora with like update information". -->
    <div class="card" id="sec-broadcast">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Message every plant <span class="sub" style="font-weight:400">as “Nexora”, in each company&rsquo;s conversation</span></h2>
        <button onclick="loadBroadcasts()">Refresh</button>
      </div>
      <textarea id="bcText" rows="3" style="width:100%;box-sizing:border-box;font:inherit" placeholder="Nexora 4.47.1 is published — Settings → Help → Updates installs it. What changed: …"></textarea>
      <div class="acts" style="margin:8px 0">
        <input id="bcVersion" placeholder="Version it announces (optional), e.g. 4.47.1" style="min-width:280px">
        <button class="primary" onclick="sendBroadcast()">Send to every plant</button>
      </div>
      <div id="bcMsg"></div>
      <div style="overflow-x:auto"><table id="bctbl">
        <thead><tr><th>Sent</th><th>Says</th><th>Rooms</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">Appears in every company&rsquo;s conversation as <b>Nexora</b>, with the small popup and the unread count like any other message, and the application looks for an update the moment it arrives. A version named here becomes a tag that opens the plant&rsquo;s update window. Publishing a build sends one of these by itself. <b>Withdraw</b> takes a message back from every room (it stays as &ldquo;message removed&rdquo;).</p>
    </div>

    <!-- 4.45.0 — what the plants say from inside the application:
         Help → Nexora Contact → Send feedback / Report a problem. The
         phone console lists the same rows from the same service. -->
    <div class="card" id="sec-feedback">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Feedback &amp; problem reports <span class="sub" style="font-weight:400" id="fbsub"></span></h2>
        <input id="fq" placeholder="Find a plant, person, word…" oninput="renderFeedback()" style="min-width:240px">
        <button onclick="loadFeedback()">Refresh</button>
      </div>
      <div id="fbstates" class="acts" style="margin:8px 0"></div>
      <div id="fbMsg"></div>
      <div style="overflow-x:auto"><table id="fbtbl">
        <thead><tr><th>Kind</th><th>From</th><th>Says</th><th>Where</th><th>Screen</th><th>State</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">Sent from <b>Help &rarr; Nexora Contact</b> inside the application. A problem report carries a picture of the screen as it was when the person opened the menu &mdash; <b>View</b> opens it full size. <b>Note</b> is yours: it stays here and on the phone and is never sent back to the plant. Call-back numbers are the ones the plant typed, or its registered mobile.</p>
    </div>

    <div class="card" id="sec-installations">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Installations <span class="sub" style="font-weight:400" id="instsub"></span></h2>
        <input id="q" placeholder="Search company, key, email, device…" oninput="render()" style="min-width:240px">
        <button class="small" id="clearFilter" style="display:none" onclick="clearCompanyFilter()">Show all companies</button>
      </div>
      <div style="overflow-x:auto"><table id="tbl">
        <thead><tr><th>Company · machine</th><th>State</th><th>Email</th><th>Days left</th><th>Started</th><th>Last seen</th><th>Version</th><th>Transactions</th><th>Hours</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">The clock belongs to the company, not the machine. Machines take no seat — revoke one to stop that computer, suspend the company to stop all of them. Seats are the people, under Manage &rarr; People. <b>no device key yet</b> marks a computer or phone that has not handed its own key over (it does at its next heartbeat on 4.71.0 / Nexora Mobile 1.0.0 or later); the count is under Service settings.</p>
    </div>
  </div>
</div>
<script>
let KEY='', DATA={licences:[],companies:[],settings:{}}, OPEN=null, COFILTER=null;
/* Themed by hand and remembered, exactly as the application is: the
   machine's preference decides only where you START. */
function setMode(m){
  document.documentElement.setAttribute('data-theme',m);
  const s=document.getElementById('mode-switch');
  if(s){
    s.setAttribute('aria-checked',m==='dark'?'true':'false');
    s.title=m==='dark'?'Dark \u2014 click for light':'Light \u2014 click for dark';
    s.querySelector('.mode-knob').textContent=m==='dark'?'\u263e':'\u2600';
  }
  try{localStorage.setItem('nexora.console.mode',m)}catch(e){}
}
function flipMode(){setMode(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');}
(function(){
  let m=null;
  try{m=localStorage.getItem('nexora.console.mode')}catch(e){}
  if(m!=='dark'&&m!=='light'){
    m=(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light';
  }
  document.addEventListener('DOMContentLoaded',()=>setMode(m));
  document.documentElement.setAttribute('data-theme',m);
})();
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
/* 4.72.0 (audit 41) — a mail link is built from the address with every character
   that means something in a link (? & # = , and spaces) encoded, so an address
   typed as "x@y.com?bcc=someone" cannot add a hidden copy to the owner's reply.
   The @ is left as it is. The address SHOWN is still esc() of what was stored. */
function mailHref(e){return 'mailto:'+encodeURIComponent(String(e==null?'':e).trim()).replace(/%40/g,'@');}
function fmt(d){return d?new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'2-digit'}):'—'}
/* 4.58.1 — a DATE is not enough for "when did they last sign in": a
   sign-in at nine and one at four read the same all day. The time, and
   how long ago in words. */
function fmtTime(d){if(!d)return '—';const t=new Date(d);return t.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'2-digit'})+', '+t.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
function ago(d){if(!d)return '';const s=Math.max(0,Math.round((Date.now()-new Date(d).getTime())/1000));
  if(s<60)return 'just now';const m=Math.round(s/60);if(m<60)return m+' min ago';const h=Math.round(m/60);if(h<48)return h+' h ago';return Math.round(h/24)+' days ago';}
/* 4.58.1 — "refresh is not working proper". It worked, silently: nothing
   on the page said it had happened, and a failure (the service waking)
   was written onto the hidden key screen, so a press that failed looked
   exactly like a press that did nothing. Now the button says it is
   working, the time of the last good read stands beside it, and a
   failure is said where it can be seen. */
async function refreshNow(){
  const b=document.getElementById('refreshBtn');
  if(b){b.disabled=true;b.textContent='Refreshing…';}
  try{await load();}finally{if(b){b.disabled=false;b.textContent='Refresh';}}
}
function stampRefreshed(ok,msg){
  const n=document.getElementById('refreshed');if(!n)return;
  n.innerHTML=ok?('updated '+new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'}))
    :'<b style="color:var(--bad)">'+esc(msg||'could not refresh')+'</b>';
}
/* and the open company's people keep themselves current, every minute
   while this tab is in front */
setInterval(()=>{if(document.hidden||!KEY||!OPEN)return;const h=document.getElementById('users-'+OPEN);if(h&&h.style.display!=='none')coUsers({dataset:{id:OPEN}},true);},60000);
function toggle(btn){const id=typeof btn==='string'?btn:btn.dataset.target;const n=document.getElementById(id);n.style.display=n.style.display==='none'?'':'none';}
function say(html){document.getElementById('coMsg').innerHTML=html;if(html)setTimeout(()=>{if(document.getElementById('coMsg').innerHTML===html)say('')},6000);}
function signOut(){try{sessionStorage.removeItem('nexora_admin_key')}catch(e){}location.reload();}
async function api(path,opts){
  const r=await fetch(path,Object.assign({headers:{'x-admin-key':KEY,'content-type':'application/json'}},opts||{}));
  if(r.status===401)throw new Error('That admin key was not accepted.');
  let b={};try{b=await r.json()}catch(e){}
  /* 4.71.0 — five wrong keys from this address: shut for fifteen minutes, and said so */
  if(r.status===429)throw new Error(b.message||'Too many wrong admin keys from this address. Try again later.');
  if(!r.ok&&!b.error)throw new Error('Request failed ('+r.status+')');
  return b;
}
async function load(){
  KEY=KEY||document.getElementById('key').value.trim();
  const already=document.getElementById('app').style.display!=='none'&&!!DATA;
  try{
    DATA=await api('/admin/api/licences');
    stampRefreshed(true);
    try{sessionStorage.setItem('nexora_admin_key',KEY)}catch(e){}
    document.getElementById('gate').style.display='none';
    document.getElementById('app').style.display='';
    const s=DATA.settings;
    document.getElementById('sTrial').value=s.trialDays;
    document.getElementById('sGrace').value=s.demoGraceDays;
    document.getElementById('sSession').value=s.sessionMinutes;
    document.getElementById('sMode').value=s.expiredMode;
    document.getElementById('sOpen').checked=!!s.signupsOpen;
    document.getElementById('sDemo').checked=!!s.demoSignup;
    renderPlans();
    renderKeyNote();
    showSec(currentSec());
    renderCompanies();
    /* and the open company's people are read again with everything else */
    if(OPEN)coUsers({dataset:{id:OPEN}},true);
    render();
    /* 4.42.0 — the leads come with everything else, and never hold up the
       rest of the page if the service has not been deployed with them. */
    loadInquiries();
    loadReleases();
    loadFeedback();
    loadBroadcasts();
    loadProducts();
  }catch(e){
    /* signed in already: say it HERE and keep the key — the service may
       only be waking, and the next press will work */
    if(already){stampRefreshed(false,'could not refresh — '+e.message);return;}
    KEY='';
    document.getElementById('gateErr').innerHTML='<div class="msg err">'+esc(e.message)+'</div>';
  }
}
/* ---------- companies ---------- */
function gstPill(c){
  const s=c.gst_status||'UNVERIFIED';
  const title=(c.gst_note?esc(c.gst_note)+' · ':'')+(c.gst_checked_at?'checked '+new Date(c.gst_checked_at).toLocaleString():'never checked');
  return '<span class="pill s-'+(s==='VERIFIED'?'LICENSED':s)+'" title="'+title+'">'+
    (s==='VERIFIED'?'GST verified':s==='FAILED'?'GST failed':'GST not yet verified')+'</span>';
}
/* 4.42.0 — a company with no people cannot USE the software at all.

     "without user sign in app should not work ... means to run software
      both login is required, apply this rule in console also"

   The company login joins a computer; a person's sign-in is what lets
   anything be written. So a company with nobody on it is not merely
   untidy \u2014 every seat it has is read-only, and the plant will ring to
   ask why the software does nothing. The console says that here, in the
   words somebody answering the telephone needs. */
function usersCell(c){
  const n=+c.users_count||0;
  const max=+c.seats||1;   /* one seat = one person */
  const total=+c.users_total||n;
  if(!n&&!total)return '<b style="color:var(--bad)">nobody \u2014 every seat is read-only</b>'+
    '<small> \u2014 set an administrator under People; nothing can be saved until somebody signs in</small>';
  return '<b>'+total+' of '+max+'</b>'+(total>n?'<small> ('+n+' active)</small>':'')+(total>=max?'<small style="color:var(--warn)"> · full</small>':'')+(c.admin_names?'<small> · admin '+esc(c.admin_names)+'</small>':'<small style="color:var(--bad)"> · no administrator</small>');
}
function txnCell(used,limit){
  used=+used||0;limit=+limit||0;
  if(!limit)return '<b>'+used+'</b><small> · no limit</small>';
  const pct=Math.min(100,Math.round(used/limit*100));
  const col=used>=limit?'var(--bad)':(used>=limit*0.9?'var(--warn)':'var(--accent)');
  return '<b>'+used+'</b><small> of '+limit+'</small><span class="bar'+(used>=limit?' full':'')+'"><i style="width:'+pct+'%;background:'+col+'"></i></span>'+
    (used>=limit?'<small style="color:var(--bad)">limit reached — read-only</small>':'');
}
function hoursText(mins){mins=+mins||0;const h=Math.floor(mins/60),m=mins%60;return h?h+' h '+m+' m':m+' m';}
function renderCompanies(){
  /* 4.58.1 — THE PEOPLE SURVIVE A REDRAW. Every redraw of the list wrote
     "Reading…" into the open company's People panel, and only OPENING a
     company ever asked for the people — so after Refresh (or a search) the
     panel said Reading… for ever. What was on screen is kept here, and
     load() reads the people again. */
  const keptPeople=OPEN&&document.getElementById('users-'+OPEN)?document.getElementById('users-'+OPEN).innerHTML:null;
  renderCompanyList();
  if(keptPeople&&!/Reading/.test(keptPeople)){const h=document.getElementById('users-'+OPEN);if(h)h.innerHTML=keptPeople;}
}
/* 4.72.0 (audit 90, 40) — WHICH COMPANIES: all of them, the paying licences
   that end within 30 days (the plants to ring about renewing), or the ones
   Delete has archived, which can be restored for 30 days. */
let COVIEW='all';
function coView(v){COVIEW=['ending','deleted','weight','fabric'].indexOf(v)>=0?v:'all';renderCompanies();}
function renderCompanyList(){
  const term=(document.getElementById('cq').value||'').toLowerCase();
  const allCos=DATA.companies||[], arch=DATA.archived||[];
  const nEnd=allCos.filter(c=>c.ending_soon).length;
  const fl=document.getElementById('cofilters');
  if(fl)fl.innerHTML=
    '<button class="small'+(COVIEW==='all'?' primary':'')+'" data-view="all" onclick="coView(this.dataset.view)">All '+(allCos.length+fabricOnly().length)+'</button>'+
    '<button class="small'+(COVIEW==='weight'?' primary':'')+'" data-view="weight" onclick="coView(this.dataset.view)" title="Nexora Bag Weight Calculation">Weight Calc '+allCos.length+'</button>'+
    '<button class="small'+(COVIEW==='fabric'?' primary':'')+'" data-view="fabric" onclick="coView(this.dataset.view)" title="Nexora Loom &amp; Fabric Stock — its own licences">Fabric Stock '+(fabricProduct()&&fabricProduct().ok?fabricAll().length:'…')+'</button>'+
    '<button class="small'+(COVIEW==='ending'?' primary':'')+'" data-view="ending" onclick="coView(this.dataset.view)" title="Paying licences that end within 30 days — ring them to renew">Ending in 30 days '+nEnd+'</button>'+
    '<button class="small'+(COVIEW==='deleted'?' primary':'')+'" data-view="deleted" onclick="coView(this.dataset.view)" title="Deleted companies are kept for 30 days and can be restored until then">Deleted '+arch.length+'</button>';
  if(COVIEW==='deleted'){document.getElementById('colist').innerHTML=archivedHtml(arch,term);return;}
  const cos=allCos.filter(c=>(COVIEW!=='ending'||c.ending_soon)&&(COVIEW!=='fabric'||fabricOf(c.id))&&(!term||[c.name,c.licence_key,c.email,c.gstin,c.login_id,c.phone].some(v=>String(v||'').toLowerCase().includes(term))));
  if(COVIEW==='ending'&&!cos.length){document.getElementById('colist').innerHTML='<p class="help">No paying licence ends within the next 30 days.</p>';return;}
  const wcHtml=cos.map(c=>{
    const state=(c.expired&&c.state!=='SUSPENDED')?'EXPIRED':c.state;
    const used=c.seats_used, seats=c.seats, pct=Math.min(100,Math.round(used/Math.max(1,seats)*100));
    const open=OPEN===c.id;
    return '<div class="co'+(c.state==='SUSPENDED'?' suspended':'')+'" id="co-'+c.id+'">'+
      '<div class="co-head">'+
        '<div class="grow" style="flex:1">'+
          '<span class="co-name">'+esc(c.name)+'</span> '+
          '<span class="pill s-'+state+'">'+(state==='DEMO'?'demo':state.toLowerCase())+'</span> '+
          (c.is_demo?'':'<span class="pill s-'+(c.plan==='STANDARD'?'SELF':'LICENSED')+'" title="'+(c.plan==='STANDARD'?'Standard: calculation and costing':'Pro: everything')+'">'+(c.plan==='STANDARD'?'standard':'pro')+'</span> ')+
          swPills(c)+
          (c.self_registered?'<span class="pill s-SELF" title="Registered by the plant itself on '+esc(fmt(c.registered_at))+(c.registered_ip?' from '+esc(c.registered_ip):'')+'">self-registered</span> ':'')+
          (c.gstin?gstPill(c):'')+
          '<div class="co-meta">'+
            '<span>Key <span class="key">'+esc(c.licence_key)+'</span> <button class="small" data-key="'+esc(c.licence_key)+'" onclick="copyKey(this)">Copy</button></span>'+
            (c.gstin?'<span>GSTIN <code>'+esc(c.gstin)+'</code></span>':'')+
            (c.email?'<span><code>'+esc(c.email)+'</code></span>':'')+
            (c.phone?'<span><code>'+esc(c.phone)+'</code></span>':'')+
            (c.login_id?'<span>Login id <code>'+esc(c.login_id)+'</code></span>':'')+
            (c.registered_ip?'<span title="The address this company registered from">IP <code>'+esc(c.registered_ip)+'</code></span>':'')+
          '</div>'+
        '</div>'+
        '<div><button'+(open?' class="primary"':'')+' data-id="'+c.id+'" onclick="manage(this)">'+(open?'Close':'Manage')+'</button></div>'+
      '</div>'+
      '<div class="sw-cap sw-weight">Weight Calc</div>'+
      '<div class="co-facts">'+
        /* 4.42.0 — A SEAT IS A PERSON, and a plant asking for another one
           wants to know how many are LEFT, which 'seat 3 of 5' never said.
           Machines are counted underneath, and are not rationed: since a
           computer with nobody signed in can only read, charging for it
           would be charging for a locked door. */
        '<div class="fact"><span>Plan</span><b>'+(c.is_demo?'demo':(c.plan==='STANDARD'?'Standard':'Pro'))+'</b>'+
          '<small>'+(c.is_demo?'everything, while it is a demo':(c.plan==='STANDARD'?'calculation and costing':'every feature'))+'</small></div>'+
        '<div class="fact"><span>Seats (people)</span><b>'+used+' of '+seats+'</b>'+
          '<small>'+(seats-used>0?(seats-used)+' available':'none available')+'</small>'+
          '<span class="bar'+(used>=seats?' full':'')+'"><i style="width:'+pct+'%"></i></span></div>'+
        '<div class="fact"><span>Computers</span><b>'+(c.machines_used||0)+'</b>'+
          '<small>not counted against seats</small></div>'+
        /* 4.57.0 - WHEN IT STARTED, beside when it ends. "Days left 3"
           is a number with no scale: three of seven is a demo about to
           lapse, three of 365 is next year's conversation. */
        '<div class="fact"><span>'+(c.is_demo?'Demo started':'Licence started')+'</span><b>'+fmt(c.period_started_at)+'</b>'+
          '<small>'+(c.period_days?c.period_days+'-day '+(c.is_demo?'demo':'licence'):'\u2014')+'</small></div>'+
        /* 4.72.0 (audit 90) — a paying licence ending within 30 days says so, in the warning colour */
        '<div class="fact"'+(c.ending_soon?' style="border-color:var(--warn)" title="Ends within 30 days — ring them to renew"':'')+'><span>'+(state==='EXPIRED'?'Ended':state==='SUSPENDED'?'Suspended · ends':'Days left')+'</span><b'+(c.ending_soon?' style="color:var(--warn)"':'')+'>'+(state==='EXPIRED'||state==='SUSPENDED'?fmt(c.expires_at):(c.days_left===0?'today':c.days_left))+'</b>'+(state==='EXPIRED'||state==='SUSPENDED'?'':'<small>'+fmt(c.expires_at)+(c.ending_soon?' · <b style="color:var(--warn);display:inline;font-size:inherit">renew soon</b>':'')+'</small>')+'</div>'+
        '<div class="fact"><span>Offline allowed</span><b>'+(c.grace_days>0?c.grace_days+' days':'none')+'</b>'+(c.grace_days>0?'':'<small>stops when it cannot reach the service</small>')+'</div>'+
        '<div class="fact"><span>Transactions</span>'+txnCell(c.txn_used,c.txn_limit)+'</div>'+
        '<div class="fact"><span>Nexora AI today</span><b>'+(c.ai_used_today||0)+(c.ai_daily_limit?' of '+c.ai_daily_limit:(DATA.aiDefaultDaily&&DATA.aiDefaultDaily<100000?' of '+DATA.aiDefaultDaily:''))+'</b><small>'+(c.ai_daily_limit?'a day, set for this company':(DATA.aiDefaultDaily&&DATA.aiDefaultDaily<100000?'a day, the service\u2019s own number':'no daily limit'))+'</small></div>'+
        '<div class="fact"><span>Hours in use</span><b>'+hoursText(c.usage_minutes)+'</b></div>'+
        '<div class="fact"><span>People</span>'+usersCell(c)+'</div>'+
      '</div>'+
      (fabricOf(c.id)?'<div class="sw-cap sw-fabric">Fabric Stock</div>'+fabricFacts(fabricOf(c.id)):'')+
      '<div class="manage'+(open?' open':'')+'" id="mg-'+c.id+'">'+
        '<div class="sw-cap sw-weight">Weight Calc</div>'+
        '<div class="group"><h4>Licence</h4><div class="acts">'+
          (c.is_demo?'<button class="primary" data-id="'+c.id+'" data-action="licence" data-days="365" onclick="coAct(this)">Make licensed for 1 year</button><span class="why">turns this demo into a paying customer</span>':'')+
          '<button data-id="'+c.id+'" data-plan="'+esc(c.plan||'PRO')+'" onclick="coPlan(this)">Plan: '+(c.plan==='STANDARD'?'Standard':'Pro')+'…</button><span class="why">Standard = calculation and costing; Pro = everything ticked under Plans. Seats are set separately.</span>'+
          '<button data-id="'+c.id+'" onclick="coDays(this)">Add days…</button>'+
          '<button data-id="'+c.id+'" data-action="extend" data-days="365" onclick="coAct(this)">+1 year</button>'+
          /* 4.72.0 (audit 96) — a key somebody who left still knows */
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coRekey(this)">New licence key…</button><span class="why">the old key stops adding computers and phones; those already on keep working</span>'+
        '</div></div>'+
        '<div class="group"><h4>Machines</h4><div class="acts">'+
          '<button data-id="'+c.id+'" data-now="'+seats+'" onclick="coSeats(this)">Seats…</button><span class="why">how many people may sign in, one per seat &mdash; computers and phones are not counted</span>'+
          '<button data-id="'+c.id+'" data-now="'+c.grace_days+'" onclick="coGrace(this)">Offline days…</button>'+
          '<button data-id="'+c.id+'" onclick="showInstallations(this)">Show its installations</button>'+
          /* 4.72.0 (audit 96) — the company's computers and phones, right here */
          '<div class="users-panel">'+machinesHtml(c)+'</div>'+
        '</div></div>'+
        /* 4.72.0 (audit 3, C12) — the copies its masters had before they were changed or deleted */
        '<div class="group"><h4>Masters</h4><div class="acts">'+
          '<button data-id="'+c.id+'" onclick="coHistory(this)">Earlier copies…</button><span class="why">materials, routes, processes, recipes and the rest as they were before a change or a delete — any one can be put back</span>'+
          '<div id="hist-'+c.id+'" class="users-panel" style="display:none"></div>'+
        '</div></div>'+
        '<div class="group"><h4>People</h4><div class="acts">'+
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coAdmin(this)">Set administrator…</button><span class="why">the person who adds everyone else from inside the application</span>'+
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" data-login="'+esc(c.login_id||'')+'" onclick="coPasscode(this)">New company passcode…</button><span class="why">for a plant that has forgotten the one it chose; it cannot be read back</span>'+
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coUsers(this)">Refresh the list</button><span class="why">the plant adds and removes people too, from inside the application</span>'+
          /* 4.39.0 — the people are shown WITH the company, not behind
             another click. Opening a company to see who is on it is the
             commonest reason for opening one at all. */
          '<div id="users-'+c.id+'" class="users-panel"><p class="help">Reading…</p></div>'+
        '</div></div>'+
        (c.gstin?'<div class="group"><h4>GST</h4><div class="acts">'+
          '<button data-id="'+c.id+'" onclick="gstVerify(this)">Verify online</button><span class="why">asks the verification service, if one is configured</span>'+
          (c.gst_status!=='VERIFIED'?'<button data-id="'+c.id+'" data-status="VERIFIED" onclick="gstMark(this)">Mark checked by hand</button>':'<button data-id="'+c.id+'" data-status="UNVERIFIED" onclick="gstMark(this)">Take the verified mark off</button>')+
        '</div></div>':'')+
        '<div class="group"><h4>Usage</h4><div class="acts">'+
          '<button data-id="'+c.id+'" data-now="'+(c.txn_limit||0)+'" onclick="coLimit(this)">Transaction limit…</button>'+
          '<button data-id="'+c.id+'" data-now="'+(c.ai_daily_limit||0)+'" onclick="coAiLimit(this)">Nexora AI a day…</button>'+
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coReset(this)">Reset usage</button><span class="why">count and hours from zero; nothing saved is touched</span>'+
        '</div></div>'+
        '<div class="group"><h4>Stop</h4><div class="acts">'+
          (c.state==='SUSPENDED'
            ?'<button data-id="'+c.id+'" data-action="restore" data-days="0" onclick="coAct(this)">Restore</button><span class="why">every machine runs again</span>'
            :'<button class="danger" data-id="'+c.id+'" data-action="suspend" data-days="0" onclick="coAct(this)">Suspend</button><span class="why">every machine stops at its next check; nothing is deleted</span>')+
          '<button class="danger" data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coDelete(this)">Delete…</button><span class="why">stops it now and keeps it 30 days (Restore under Deleted); then it and everything that belongs to it are erased</span>'+
        '</div></div>'+
        '<div class="sw-cap sw-fabric">Fabric Stock</div>'+fabricManage(fabricOf(c.id),c)+
      '</div>'+
    '</div>';
  }).join('');
  const fsHtml=(COVIEW==='all'||COVIEW==='fabric')?fabricOnlyHtml(term):'';
  document.getElementById('colist').innerHTML=(fabricNote()+wcHtml+fsHtml)||'<p class="help">No companies yet. A plant that registers itself from the application appears here as a demo; a customer you set up yourself is created with New company.</p>';
}
function manage(btn){
  const id=+btn.dataset.id;
  OPEN=OPEN===id?null:id;
  renderCompanies();
  if(OPEN){
    document.getElementById('co-'+OPEN).scrollIntoView({block:'nearest'});
    /* The people come with the company. */
    coUsers({dataset:{id:OPEN}});
    const f=fabricOf(OPEN);if(f)fabricDetail(f.id);
  }
}
function copyKey(btn){const k=btn.dataset.key;try{navigator.clipboard.writeText(k);say('<div class="msg ok">Copied '+esc(k)+'</div>');}catch(e){prompt('Licence key',k);}}
/* 4.72.0 (audit 40) — the companies Delete has archived, each with Restore
   until it is erased 30 days after it was deleted. */
function archivedHtml(arch,term){
  const rows=arch.filter(c=>!term||[c.name,c.email,c.gstin,c.login_id,c.phone].some(v=>String(v||'').toLowerCase().includes(term)));
  if(!rows.length)return '<p class="help">No deleted companies. A company you delete is kept here for 30 days and can be restored until then; after that it is erased for good.</p>';
  return '<p class="help">A deleted company is kept for 30 days with everything it had, but its computers and phones are stopped and nobody can sign in. <b>Restore</b> puts it back exactly as it was. After 30 days it is erased for good — its machines, people, synced records, chat and problem reports.</p>'+
    rows.map(c=>'<div class="co suspended"><div class="co-head"><div class="grow" style="flex:1">'+
      '<span class="co-name">'+esc(c.name)+'</span> <span class="pill s-SUSPENDED">deleted</span>'+
      '<div class="co-meta"><span>Deleted '+esc(fmtTime(c.deleted_at))+'</span>'+
        '<span>Erased on <b>'+esc(fmt(c.purge_at))+'</b> ('+(+c.days_to_purge||0)+' day(s) left to restore)</span>'+
        '<span>'+(+c.machines||0)+' computer(s) and phone(s) · '+(+c.people||0)+' people · '+(+c.records||0)+' synced record(s)</span>'+
        (c.gstin?'<span>GSTIN <code>'+esc(c.gstin)+'</code></span>':'')+(c.email?'<span><code>'+esc(c.email)+'</code></span>':'')+'</div></div>'+
      '<div><button class="primary" data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coUndelete(this)">Restore</button></div>'+
    '</div></div>').join('');
}
async function coUndelete(btn){
  if(!confirm('Restore '+btn.dataset.name+'?\\n\\nIt comes back exactly as it was when it was deleted: its computers and phones work again at their next check, and nobody has to join or sign in again.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'undelete'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  COVIEW='all';
  await load();
  say('<div class="msg ok">'+esc(r.warning||'Restored.')+'</div>');
}
/* 4.72.0 (audit 96) — a new licence key, when somebody who knew the old one has left */
async function coRekey(btn){
  if(!confirm('Issue a NEW licence key for '+btn.dataset.name+'?\\n\\nThe old key stops adding computers and phones at once. Every computer and phone already on the company keeps working — nothing to type there. Use it when somebody who knew the key has left.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'rekey'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await load();
  say('<div class="msg ok">New licence key for <b>'+esc(r.name)+'</b>: <span class="key">'+esc(r.key)+'</span> — give it only to whoever adds the next computer or phone. It is also on the company&rsquo;s card.</div>');
}
/* 4.72.0 (audit 96) — the company's computers and phones, inside Manage: which
   are waiting for approval, which hold no device key yet, who is signed in. */
function machinesHtml(c){
  const ms=(DATA.licences||[]).filter(l=>+l.company_id===+c.id);
  if(!ms.length)return '<p class="help">No computer or phone has joined this company yet.</p>';
  return '<table class="users"><thead><tr><th>Computer / phone</th><th>State</th><th>Signed in</th><th>Last seen</th><th></th></tr></thead><tbody>'+
    ms.map(l=>{
      const phone=l.platform==='mobile', gone=l.state==='REVOKED', waiting=!l.approved_at&&!gone;
      return '<tr'+(gone?' class="off"':'')+'><td><b>'+esc(l.device_name||(phone?'phone':'computer'))+'</b> <code>'+(phone?'phone':(l.seat_no?'computer '+l.seat_no:'computer'))+'</code><br><code>'+esc(String(l.device_id).slice(0,12))+'…</code></td>'+
        '<td>'+(gone?'<span class="pill s-REVOKED">withdrawn</span>':waiting?'<span class="pill s-EXPIRED">waiting for approval</span>':'<span class="pill s-LICENSED">approved</span>')+
          (!gone&&l.key_held===false?'<br><span class="why">no device key yet</span>':'')+'</td>'+
        '<td>'+(l.on_user?esc(l.on_user):'<span class="why">nobody</span>')+'</td>'+
        '<td class="why">'+esc(fmtTime(l.last_seen_at))+(l.app_version?'<br>'+esc(l.app_version):'')+'</td>'+
        '<td><div class="acts">'+
          (waiting?'<button class="small primary" data-device="'+esc(l.device_id)+'" data-action="approve" onclick="act(this)">Approve</button>':'')+
          (gone?'<button class="small" data-device="'+esc(l.device_id)+'" data-action="restore" onclick="act(this)">Restore</button>'
               :'<button class="small danger" data-device="'+esc(l.device_id)+'" data-action="revoke" onclick="act(this)">Revoke</button>')+
        '</div></td></tr>';
    }).join('')+'</tbody></table>';
}
/* 4.72.0 (audit 3, C12) — the copies a company's masters had before somebody
   changed or deleted them (the last 20 of each), and putting one back. */
const MASTER_NAMES={'nexora.rm.master.v1':'Materials (RM master)','nexora.rm.price.v1':'RM prices','nexora.rm.group.v1':'RM groups','nexora.rm.seeded.v1':'RM starter list',
  'nexora.route.master.v1':'Routes','nexora.routes.seeded.v1':'Route starter list','nexora.process.master.v1':'Processes','nexora.process.recipe.v1':'Process recipes',
  'nexora.resource.master.v1':'Resources','nexora.material.state.v1':'Material states','nexora.bom.recipe.v1':'BOM recipes','nexora.bom.basis.v1':'BOM basis',
  'nexora.bom.linemap.v1':'BOM line map','nexora.bom.workflow.v1':'BOM workflows','nexora.constants.v1':'Constants','nexora.constants.custom.v1':'Own constants',
  'nexora.constants.links.v1':'Constant links','nexora.structures.v1':'Structures','nexora.org.v1':'Company details','nexora.table.columns.v1':'Table columns',
  'nexora.resource.types.v1':'Resource types','nexora.master.owner.v1':'Who made what','nexora.docseries.v1':'Document number series','nexora.units.v1':'Units',
  'nexora.meshunit.v1':'Mesh unit','nexora.quote.terms.v1':'Quotation terms','nexora.mkt.sources.v1':'Marketing sources','nexora.mkt.targets.v1':'Marketing targets',
  'nexora.ai.wrote.v1':'Nexora AI lessons','nexora.ai.rules.v1':'Nexora AI rules'};
function howWord(h){return h==='delete'?'deleted':h==='restore'?'put back from the console':'changed';}
function kbText(n){n=+n||0;return n<1024?n+' bytes':(n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB');}
async function coHistory(btn){
  const cid=+btn.dataset.id;const host=document.getElementById('hist-'+cid);if(!host)return;
  host.style.display='';host.innerHTML='<p class="help">Reading…</p>';
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'masterHistory'})});
  if(r.error){host.innerHTML='<div class="msg err">'+esc(r.error)+'</div>';return;}
  const h=r.history||[];
  host.innerHTML='<p class="help">The copy each master had before somebody changed or deleted it — the last 20 of each, newest first. <b>Put back</b> makes that copy the company&rsquo;s again: every computer and phone takes it at its next sync, and the copy it replaces is kept here in turn, so a put-back can itself be undone.</p>'+
    (h.length?'<table class="users"><thead><tr><th>Master</th><th>This copy was saved</th><th>Then</th><th>Size</th><th></th></tr></thead><tbody>'+
      h.map(x=>'<tr><td><b>'+esc(MASTER_NAMES[x.id]||x.id)+'</b><br><code>'+esc(x.id)+'</code></td>'+
        '<td>'+esc(fmtTime(x.savedAt))+(x.savedBy?'<br><span class="why">by '+esc(x.savedBy)+'</span>':'')+'</td>'+
        '<td>'+esc(howWord(x.how))+' '+esc(fmtTime(x.replacedAt))+(x.replacedBy?'<br><span class="why">by '+esc(x.replacedBy)+'</span>':'')+'</td>'+
        '<td>'+(x.items!=null?esc(String(x.items))+' item(s)<br>':'')+'<span class="why">'+esc(kbText(x.size))+'</span></td>'+
        '<td><button class="small" data-id="'+cid+'" data-hid="'+(+x.historyId)+'" data-name="'+esc(MASTER_NAMES[x.id]||x.id)+'" data-when="'+esc(fmtTime(x.savedAt))+'" onclick="coRestoreMaster(this)">Put back…</button></td></tr>').join('')+
      '</tbody></table>'
     :'<p class="help">Nothing is kept yet: a copy is kept the first time a master is changed or deleted (from 4.72.0 on).</p>');
}
async function coRestoreMaster(btn){
  if(!confirm('Put back '+btn.dataset.name+' as it was saved on '+btn.dataset.when+'?\\n\\nEvery computer and phone of the company takes this copy at its next sync. The copy it replaces is kept, so this can be undone the same way.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'restoreMaster',historyId:+btn.dataset.hid})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Put back.')+'</div>');
  await coHistory({dataset:{id:btn.dataset.id}});
}
async function coAct(btn){
  const id=+btn.dataset.id,action=btn.dataset.action,days=+btn.dataset.days||0;
  if(action==='suspend'&&!confirm('Suspend this company?\\n\\nEVERY machine on this licence stops calculating at its next check. Nothing is deleted; Restore puts it back.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id,action,days})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function coDays(btn){
  const v=prompt('Add how many days to this licence?\\n\\nThe company\\'s clock moves; every seat follows.','30');
  if(v===null)return;
  const days=parseInt(v,10);
  if(!(days>0)){say('<div class="msg err">Enter a number of days.</div>');return;}
  btn.dataset.action='extend';btn.dataset.days=String(days);await coAct(btn);
}
/* ---------- the tabs (4.48.1) ---------- */
const SECS=['sec-companies','sec-plans','sec-inquiries','sec-feedback','sec-broadcast','sec-installations','appcard','sec-activity','settings'];
function showSec(id){
  if(SECS.indexOf(id)<0)id='sec-companies';
  SECS.forEach(s=>{const n=document.getElementById(s);if(!n)return;n.classList.add('sec');n.classList.toggle('on',s===id);if(s===id)n.style.display='';});
  document.querySelectorAll('#jump .tab').forEach(t=>t.classList.toggle('active',t.dataset.sec===id));
  try{sessionStorage.setItem('nexora_admin_tab',id);}catch(e){}
  window.scrollTo({top:0});
  /* 4.72.0 — these two are read when they are opened, never in the background */
  if(id==='settings')loadDb();
  if(id==='sec-activity')loadActivity();
}
/* 4.72.0 (audit 9, 97) — the console key's length, and the computers and
   phones that have not handed their device key over yet. */
function renderKeyNote(){
  const n=document.getElementById('keycard');if(!n)return;
  const k=DATA.keyless||{devices:0,required:false};
  const n0=+k.devices||0;
  n.innerHTML=(DATA.adminKeyShort?'<div class="msg warn">The console key (NEXORA_ADMIN_KEY on Render) is shorter than 32 characters. Set a long random one there; this page then asks for the new key.</div>':'')+
    '<p class="help"><b>Device keys.</b> '+(n0
      ? '<b style="color:var(--warn)">'+n0+'</b> computer(s) and phone(s) in use hold no device key yet. Each hands its own key over at its next heartbeat once it runs Nexora 4.71.0 / Nexora Mobile 1.0.0 or later. '+
        (k.required?'NEXORA_DEVICE_KEY_REQUIRED is set: one of these that has also lost its token must be removed and join again.'
                   :'When this reaches 0, set <code>NEXORA_DEVICE_KEY_REQUIRED=1</code> on Render — a device id alone can then no longer re-join as that device.')
      : 'Every computer and phone in use holds its device key. '+(k.required?'NEXORA_DEVICE_KEY_REQUIRED is set.'
                   :'Set <code>NEXORA_DEVICE_KEY_REQUIRED=1</code> on Render now — a device id alone can then no longer re-join as that device.'))+'</p>';
}
/* 4.72.0 (audit 87) — how full the database is, against the free plan's 500 MB */
async function loadDb(){
  const host=document.getElementById('dbcard');if(!host)return;
  let r;
  try{r=await api('/admin/api/db');}catch(e){host.innerHTML='<div class="msg err">'+esc(e.message)+'</div>';return;}
  if(r.error){host.innerHTML='<div class="msg err">'+esc(r.message||r.error)+'</div>';return;}
  const mb=b=>((+b||0)/1048576).toFixed((+b||0)<10485760?1:0)+' MB';
  const pct=Math.min(100,+r.usedPct||0);
  const col=r.warn?'var(--bad)':(pct>=60?'var(--warn)':'var(--ok)');
  host.innerHTML='<p style="margin:6px 0"><b>'+esc(mb(r.bytes))+'</b> of '+esc(mb(r.limitBytes))+' used ('+esc(String(r.usedPct))+' %)</p>'+
    '<span class="bar'+(r.warn?' full':'')+'"><i style="width:'+pct+'%;background:'+col+'"></i></span>'+
    (r.warn?'<div class="msg err">The database is over '+esc(String(r.warnPct))+' % of the free 500 MB. At 500 MB Supabase stops every save in every plant — move to the paid plan, or clear what is not needed, before then.</div>'
           :'<p class="help">A warning shows here from '+esc(String(r.warnPct))+' %.</p>')+
    '<div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th>Table</th><th>Size</th><th>Rows</th></tr></thead><tbody>'+
    (r.tables||[]).map(t=>'<tr><td><code>'+esc(t.name)+'</code></td><td>'+esc(mb(t.bytes))+'</td><td>'+(t.rows==null?'—':esc(String(t.rows)))+'</td></tr>').join('')+
    '</tbody></table></div>';
}
/* 4.72.0 (audit 39) — what was done from the consoles, read-only */
const ACT_WORDS={ADMIN_FABRIC_CREATE:'Fabric Stock: company made',ADMIN_FABRIC_UPDATE:'Fabric Stock: licence changed',ADMIN_FABRIC_SUSPEND:'Fabric Stock: suspended',
  ADMIN_FABRIC_RESUME:'Fabric Stock: suspension lifted',ADMIN_FABRIC_ADMINUSER:'Fabric Stock: administrator set',ADMIN_FABRIC_USERSIGNOUT:'Fabric Stock: signed out',
  ADMIN_FABRIC_PASSCODE:'Fabric Stock: new company passcode',ADMIN_FABRIC_LINK:'Fabric Stock: linked to a company',ADMIN_FABRIC_APART:'Fabric Stock: kept apart',
  ADMIN_FABRIC_UNLINK:'Fabric Stock: link removed',ADMIN_FABRIC_DEVICE_REVOKE:'Fabric Stock: computer withdrawn',ADMIN_FABRIC_DEVICE_RESTORE:'Fabric Stock: computer given back',
  ADMIN_COMPANY_CREATE:'Company created',ADMIN_COMPANY_EXTEND:'Licence extended',ADMIN_COMPANY_LICENCE:'Made licensed',ADMIN_COMPANY_SEATS:'Seats changed',
  ADMIN_COMPANY_PLAN:'Plan changed',ADMIN_COMPANY_GRACE:'Offline days changed',ADMIN_COMPANY_SUSPEND:'Suspended',ADMIN_COMPANY_RESTORE:'Suspension lifted',
  ADMIN_COMPANY_RENAME:'Renamed',ADMIN_COMPANY_GSTIN:'GSTIN changed',ADMIN_COMPANY_AILIMIT:'Nexora AI limit changed',ADMIN_COMPANY_TXNLIMIT:'Transaction limit changed',
  ADMIN_COMPANY_RESETUSAGE:'Usage reset',ADMIN_COMPANY_PASSCODE:'Company passcode set',ADMIN_COMPANY_ADMINUSER:'Administrator set',
  ADMIN_COMPANY_DELETE:'Company deleted (kept 30 days)',ADMIN_COMPANY_UNDELETE:'Deleted company restored',ADMIN_COMPANY_PURGE:'Deleted company erased',
  ADMIN_COMPANY_REKEY:'New licence key',ADMIN_COMPANY_NOTE:'Company note',ADMIN_USER_CREATE:'Person added',ADMIN_USER_EMAIL:'Email changed',
  ADMIN_USER_ROLE:'Role changed',ADMIN_USER_PIN:'PIN set',ADMIN_USER_DELETE:'Person removed',ADMIN_USER_SIGNOUT:'Signed out',
  ADMIN_LICENCE:'Licensed (from a machine)',ADMIN_EXTEND:'Extended (from a machine)',ADMIN_RESETUSAGE:'Machine usage reset',ADMIN_PHONE_APPROVE:'Phone approved',
  ADMIN_PC_APPROVE:'Computer approved',ADMIN_REVOKE:'Machine revoked',ADMIN_RESTORE:'Machine restored',ADMIN_INSTALL_DELETE:'Installation deleted',
  ADMIN_LICENCE_NOTE:'Machine note',ADMIN_SETTINGS:'Service settings changed',ADMIN_KEY_WRONG:'Wrong console key',ADMIN_KEY_LOCKED:'Address shut out (5 wrong keys)',
  ADMIN_KEY_LOCKED_ALL:'Console shut for everybody (50 wrong keys)',ADMIN_APP_PUBLISH:'Phone app published',ADMIN_APP_SOURCE:'Phone app source set',
  ADMIN_APP_WITHDRAW:'Phone app withdrawn',MASTER_RESTORED:'Master put back',USER_SIGNED_OUT_EVERYWHERE:'Signed out everywhere',
  BROADCAST:'Message to every plant',BROADCAST_WITHDRAW:'Message withdrawn'};
async function loadActivity(){
  const tb=document.querySelector('#acttbl tbody');if(!tb)return;
  let r;
  try{r=await api('/admin/api/events?admin=1&limit=300');}catch(e){tb.innerHTML='<tr><td colspan="4"><div class="msg err">'+esc(e.message)+'</div></td></tr>';return;}
  const names={};(DATA.companies||[]).concat(DATA.archived||[]).forEach(c=>{names[c.id]=c.name;});
  tb.innerHTML=(r.events||[]).map(x=>{
    const d=(x.detail&&typeof x.detail==='object')?x.detail:{};
    const via=d.via&&typeof d.via==='object'?d.via:null;
    const co=d.companyId||(String(x.event).indexOf('ADMIN_COMPANY_')===0?d.id:null);
    const rest=Object.keys(d).filter(k=>k!=='via').map(k=>k+': '+(d[k]!==null&&typeof d[k]==='object'?JSON.stringify(d[k]):String(d[k]))).join(' · ');
    return '<tr><td class="why">'+esc(fmtTime(x.at))+'</td>'+
      '<td><b>'+esc(ACT_WORDS[x.event]||x.event)+'</b><br><code>'+esc(x.event)+'</code></td>'+
      '<td>'+(co&&names[co]?'<b>'+esc(names[co])+'</b><br>':'')+(x.device_id?'<code>'+esc(String(x.device_id).slice(0,12))+'…</code> ':'')+'<span class="why">'+esc(rest.slice(0,400))+'</span></td>'+
      '<td'+(via&&via.ua?' title="'+esc(via.ua)+'"':(d.ua?' title="'+esc(d.ua)+'"':''))+'>'+
        (via?esc(via.app==='android'?'phone console':'web console')+'<br><code>'+esc(via.ip||'')+'</code>'
            :(d.ip?'<code>'+esc(d.ip)+'</code>':'<span class="why">the service</span>'))+'</td></tr>';
  }).join('')||'<tr><td colspan="4" class="help">Nothing yet.</td></tr>';
}
function currentSec(){try{return sessionStorage.getItem('nexora_admin_tab')||'sec-companies';}catch(e){return 'sec-companies';}}
/* ---------- plans (4.48.0) ---------- */
const PLAN_LABELS={quotation:'Quotation',chat:'Company conversation (chat)',notes:'Notes pad',bomWorkflow:'BOM workflow automation',onlinePrices:'Prices from the producer\u2019s list',bagView:'3D bag view',ink:'Ink assumption',sharing:'Email & WhatsApp sharing',
  exportExcel:'Export to Excel',exportPdf:'Export to PDF',priceHistory:'RM price history (price versions)',activityLog:'Activity log',backup:'Backup & restore',numberSeries:'Document number series',tableSettings:'Table Settings (own column names)',sectionSuggest:'BOM sections learned from the plant',
  /* 4.65.0 */ priceImpact:'Price Impact',compare:'Compare calculations',targetCost:'Target Cost',mobile:'Nexora Mobile (Android app)',
  /* 4.68.0 */ marketing:'Marketing (enquiries, customers, follow-ups)'};
function renderPlans(){
  const m=(DATA.settings&&DATA.settings.planFeatures)||{STANDARD:{},PRO:{}};
  const tb=document.querySelector('#plantbl tbody');
  if(!tb)return;
  tb.innerHTML=Object.keys(PLAN_LABELS).map(id=>
    '<tr><td>'+esc(PLAN_LABELS[id])+'</td>'+
    '<td><input type="checkbox" data-plan="STANDARD" data-feat="'+id+'"'+(m.STANDARD&&m.STANDARD[id]?' checked':'')+'></td>'+
    '<td><input type="checkbox" data-plan="PRO" data-feat="'+id+'"'+(m.PRO&&m.PRO[id]?' checked':'')+'></td>'+
    '<td><input type="checkbox" checked disabled title="A demo always has everything"></td></tr>').join('');
}
async function savePlans(){
  const out={STANDARD:{},PRO:{}};
  document.querySelectorAll('#plantbl input[data-plan]').forEach(c=>{out[c.dataset.plan][c.dataset.feat]=c.checked;});
  try{
    await api('/admin/api/settings',{method:'POST',body:JSON.stringify({planFeatures:out})});
    const n=document.getElementById('plMsg');n.innerHTML='<div class="msg ok">Plans saved \u2014 every installation reads them at its next check.</div>';
    setTimeout(()=>{n.innerHTML='';},6000);
    await load();
  }catch(e){document.getElementById('plMsg').innerHTML='<div class="msg err">'+esc(e.message)+'</div>';}
}
async function coPlan(btn){
  const now=btn.dataset.plan==='STANDARD'?'STANDARD':'PRO';
  const next=now==='STANDARD'?'PRO':'STANDARD';
  if(!confirm('Change this company from '+(now==='STANDARD'?'Standard':'Pro')+' to '+(next==='STANDARD'?'Standard (calculation and costing)':'Pro (everything)')+'?'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'plan',plan:next})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function coSeats(btn){
  const v=prompt('How many people (seats) may this company have?\\n\\nOne seat is one person who signs in. Computers and phones are not counted.',btn.dataset.now);
  if(v===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'seats',seats:+v})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function coGrace(btn){
  const v=prompt('How many days may this customer work with no contact with the service?\\n\\n0 = none: it stops as soon as it cannot reach us.',btn.dataset.now);
  if(v===null)return;
  await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'grace',graceDays:+v})});
  await load();
}
async function coAiLimit(btn){
  const v=prompt('How many Nexora AI questions may this company ask a day (on Nexora\u2019s Google key)?\\n\\n0 = the service\u2019s own number. A company with its own Gemini key is limited by Google, not by this.',btn.dataset.now);
  if(v===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'ailimit',aiDailyLimit:+v})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await load();
}
async function coLimit(btn){
  const v=prompt('How many transactions may this licence commit?\\n\\n0 = no limit. Reaching the limit makes the machines READ-ONLY: everything saved still opens and prints.',btn.dataset.now);
  if(v===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'txnlimit',txnLimit:+v})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function coReset(btn){
  if(!confirm('Start '+btn.dataset.name+'\\'s transaction count and hours again from zero, on every machine?\\n\\nNothing saved is touched. A limit that was reached is no longer reached.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'resetusage'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">Usage reset for <b>'+esc(btn.dataset.name)+'</b>.</div>');
  await load();
}
/* 4.39.0 — the people on a company. What is shown is everything there
   IS to show: a PIN is a scrypt hash, so there is no PIN to print here
   or anywhere else. A forgotten one is SET again, not read. */
/* 4.43.0 — WHO IS ON WHICH MACHINE, RIGHT NOW.

     "update in console that i can know which user is currently online on
      machine"

   One person may be signed in at one place at a time, so there is a
   single honest answer for each name and this is where it is shown. It
   is the first thing needed when somebody rings to say they were signed
   out: they were not " thrown out", somebody signed in as them
   somewhere, and the console can say where.

   A person's session ends when the application is closed, so a name with
   nothing here is simply not working at the moment. */
function onlineCell(u){
  if(!u.sessionDevice)return '<span class="why">not signed in</span>';
  const where=u.sessionDeviceName||u.sessionDevice.slice(0,12);
  return '<b style="color:var(--good)">on '+esc(where)+'</b>'+
    (u.sessionAt?'<br><span class="why">since '+esc(fmtTime(u.sessionAt))+'</span>':'');
}
function userRow(cid,u){
  /* 4.58.1 — date AND time, and when their software last spoke to the
     service: a remembered session never types the PIN again, so "signed
     in" alone stood still while the person worked every day */
  const when=(u.lastLoginAt?('signed in '+fmtTime(u.lastLoginAt)):'never signed in')+
    (u.lastSeenAt?'<br>active <b>'+esc(ago(u.lastSeenAt))+'</b> <span title="'+esc(fmtTime(u.lastSeenAt))+'">('+esc(fmtTime(u.lastSeenAt))+')</span>':'');
  return '<tr'+(u.active?'':' class="off"')+'>'+
    '<td><b>'+esc(u.name)+'</b>'+(u.active?'':' <span class="why">switched off</span>')+
      (u.sessionDevice?' <span class="pill s-LICENSED">signed in</span>':'')+'</td>'+
    '<td>'+(u.role==='ADMIN'?'<b>administrator</b>':'user')+'</td>'+
    '<td>'+(u.scope==='ALL'?'sees everyone&rsquo;s work':'sees own work')+'</td>'+
    /* 4.42.0 — their own address. A person without one is not broken; they
       simply do not receive the circulars, and it says so plainly. */
    '<td>'+(u.email?'<code>'+esc(u.email)+'</code>':'<span class="why">no address</span>')+'</td>'+
    '<td>'+onlineCell(u)+'</td>'+
    '<td class="why">'+when+'</td>'+
    '<td>'+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" data-role="'+(u.role==='ADMIN'?'USER':'ADMIN')+'" onclick="uRole(this)">'+
        (u.role==='ADMIN'?'Make ordinary user':'Make administrator')+'</button> '+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" data-email="'+esc(u.email||'')+'" onclick="uEmail(this)">Email…</button> '+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" onclick="uPin(this)">Set PIN…</button> '+
      (u.sessionDevice?'<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" onclick="uSignOut(this)">Sign out…</button> ':'')+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" onclick="uDel(this)">Remove…</button>'+
    '</td></tr>';
}
async function coUsers(btn,quiet){
  const cid=+btn.dataset.id; let host=document.getElementById('users-'+cid);
  if(!host)return;
  host.style.display='';
  /* a quiet (timed) refresh keeps what is on screen until the answer is in */
  if(!quiet)host.innerHTML='<p class="help">Reading…</p>';
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'users'})});
  /* 4.58.1 — WHERE IT IS NOW, not where it was when the question left.
     Refresh asks for the people and then redraws the company list, so the
     panel this call started with had been replaced by the time the answer
     came back: the answer went into a panel nobody could see, and the one
     on screen said Reading… for ever. That was the Refresh that did not work. */
  host=document.getElementById('users-'+cid)||host;
  host.style.display='';
  if(r.error){host.innerHTML='<div class="msg err">'+esc(r.error)+'</div>';return;}
  const cap=r.cap||{max:0,count:0};
  host.innerHTML=
    '<p class="help"><b>'+cap.count+' of '+cap.max+' seat(s) taken'+
      (cap.max-cap.count>0?', '+(cap.max-cap.count)+' available':'; none available')+'.</b> '+
      (cap.count===0?'<b style="color:var(--bad)">Nobody can do any work on this company yet:</b> '+
        'the company login joins a computer, but nothing can be created or saved until a PERSON signs in. '+
        'Set an administrator first. ':'')+
      'A PIN cannot be shown here or anywhere else \u2014 it is stored scrambled, which is what stops anyone who gets the database from signing in as your customers. '+
      'When somebody forgets theirs, set a new one and tell them.</p>'+
    (r.users&&r.users.length
      ? '<table class="users"><thead><tr><th>Name</th><th>Role</th><th>Sees</th><th>Email</th><th>Signed in now</th><th>Last signed in / active</th><th></th></tr></thead><tbody>'+
        r.users.map(u=>userRow(cid,u)).join('')+'</tbody></table>'
      : '<p class="help">Nobody has been added to this company yet.</p>')+
    '<button data-id="'+cid+'" onclick="uAdd(this)">Add a person…</button>';
}
async function uAdd(btn){
  const cid=+btn.dataset.id;
  const name=prompt('Name of the person to add.\\n\\nThey sign in with this name and a PIN.');
  if(name===null||!name.trim())return;
  const pin=prompt('PIN for '+name.trim()+' (at least 4 characters). Tell it to them directly; it is not shown again.');
  if(pin===null)return;
  /* 4.42.0 — their own address, asked for once while we are already asking.
     Blank is fine; it only means they will not get the circulars. */
  const email=prompt('Email for '+name.trim()+' (optional).\\n\\nThis is where notices about new versions are sent. Leave it blank if they have none.','');
  if(email===null)return;
  const admin=confirm('Make '+name.trim()+' an ADMINISTRATOR?\\n\\nOK = administrator (can add and remove people from inside the application).\\nCancel = ordinary user.');
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'useradd',name:name.trim(),pin,email:email.trim(),role:admin?'ADMIN':'USER'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Added.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
  await load();
}
async function uRole(btn){
  const to=btn.dataset.role;
  const word=to==='ADMIN'?'an ADMINISTRATOR':'an ordinary user';
  if(!confirm('Make '+btn.dataset.name+' '+word+'?\\n\\n'+(to==='ADMIN'
    ?'They will be able to add and remove people from inside the application, and see everyone\u2019s work.'
    :'They will no longer be able to add or remove anybody, and they are signed out everywhere so the change holds at once.')))return;
  const cid=+btn.dataset.cid;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'userrole',userId:+btn.dataset.uid,role:to})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
}
/* 4.42.0 — a person's own address, set or taken off. This is what makes
   "tell every customer about the new version" reach the people who use the
   software rather than one inbox per plant. */
async function uEmail(btn){
  const cid=+btn.dataset.cid;
  const now=btn.dataset.email||'';
  const email=prompt('Email for '+btn.dataset.name+'.\\n\\nNotices about new versions are sent here. Leave it blank to take the address off.',now);
  if(email===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'useremail',userId:+btn.dataset.uid,email:email.trim()})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
  await load();
}
async function uPin(btn){
  const cid=+btn.dataset.cid;
  const pin=prompt('New PIN for '+btn.dataset.name+' (at least 4 characters).\\n\\nSetting it signs them out everywhere they are signed in. The old one cannot be read back. Tell them this one directly.');
  if(pin===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'userpin',userId:+btn.dataset.uid,pin})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  /* 4.72.0 (audit 38) — they are signed out: the list shows it */
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
}
/* 4.43.0 — the button beside somebody who is signed in. Only needed
   when the machine they are on will never close tidily — stolen, wiped,
   or switched off in a shed — because an ordinary close ends the session
   by itself. */
async function uSignOut(btn){
  const cid=+btn.dataset.cid;
  if(!confirm('Sign '+btn.dataset.name+' out?\\n\\nUse this when the computer they were on is gone or will not be opened again. '+
    'Their PIN does not change and nothing they saved is touched — they can simply sign in again anywhere.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'usersignout',userId:+btn.dataset.uid})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Signed out.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
}
async function uDel(btn){
  const cid=+btn.dataset.cid;
  if(!confirm('Remove '+btn.dataset.name+' from this company?\\n\\nThey are signed out everywhere and their seat is freed. Everything they saved stays with the company.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'userdel',userId:+btn.dataset.uid})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Removed.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
  await load();
}
async function coPasscode(btn){
  const name=btn.dataset.name;
  const id=prompt('Company login id for '+name+'\\n\\nThis is the first half of their login. Leave it as it is unless they want it changed.',btn.dataset.login||'');
  if(id===null)return;
  const pass=prompt('New company passcode for '+name+' (at least 6 characters).\\n\\nNobody can read the old one \u2014 it is stored scrambled. Tell them this new one directly; it is not shown again.');
  if(pass===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'passcode',loginId:id.trim(),passcode:pass})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  await load();
}
async function coAdmin(btn){
  const name=btn.dataset.name;
  const who=prompt('Administrator for '+name+'\\n\\nName the person who will manage users and see every calculation. If a user of that name exists, they become the administrator and get the new PIN.','Administrator');
  if(who===null||!who.trim())return;
  const pin=prompt('PIN for '+who.trim()+' (at least 4 characters). Tell it to them directly; it is not shown again.');
  if(pin===null)return;
  const email=prompt('Email for '+who.trim()+' (optional).\\n\\nWhere notices about new versions are sent. Blank leaves any address they already have alone.','');
  if(email===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'adminuser',name:who.trim(),pin,email:email.trim()})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  await load();
}
async function coDelete(btn){
  const name=btn.dataset.name;
  /* 4.72.0 (audit 40) — Delete archives for 30 days; the prompt and the answer say so */
  const typed=prompt('Delete '+name+'?\\n\\nIts computers and phones stop at their next check and nobody can sign in. It is kept for 30 days: Restore (Companies → Deleted) puts it back exactly as it was. After 30 days the company, its machines, its people, everything they synced, its chat and its problem reports are erased for good.\\n\\nType the company name exactly to confirm:');
  if(typed===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'delete',confirmName:typed})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  const x=r.removed||{};
  OPEN=null;await load();
  say('<div class="msg ok">'+(r.warning?esc(r.warning):'Deleted <b>'+esc(r.name)+'</b>.')+' <span class="why">('+(x.installations||0)+' installation(s), '+(x.users||0)+' user(s), '+(x.records||0)+' synced record(s), '+(x.inkModels||0)+' ink model(s) are kept until then.)</span></div>');
}
async function gstVerify(btn){
  const r=await api('/admin/api/gst',{method:'POST',body:JSON.stringify({action:'gstverify',id:+btn.dataset.id})});
  if(r.error){say('<div class="msg err">'+esc(r.message||r.error)+'</div>');return;}
  say('<div class="msg '+(r.gst.status==='VERIFIED'?'ok':r.gst.status==='FAILED'?'err':'warn')+'">GST '+esc(r.gst.status.toLowerCase())+(r.gst.reason?' — '+esc(r.gst.reason):r.gst.legalName?' — '+esc(r.gst.legalName):'')+'</div>');
  await load();
}
async function gstMark(btn){
  const status=btn.dataset.status;
  const note=status==='VERIFIED'?(prompt('How was it checked? (a note for the record)','Checked on the GST portal by hand')||''):'';
  const r=await api('/admin/api/gst',{method:'POST',body:JSON.stringify({action:'gstmark',id:+btn.dataset.id,status,note})});
  if(r.error){say('<div class="msg err">'+esc(r.message||r.error)+'</div>');return;}
  await load();
}
async function createCo(){
  const name=document.getElementById('nName').value.trim();
  if(!name){say('<div class="msg err">A company name is required.</div>');return;}
  /* 2026-10-07 (console) — which software: each one made in its own service, with its own licence key */
  const soft=(document.getElementById('nSoft')||{}).value||'weight';
  const seats=+document.getElementById('nSeats').value, days=+document.getElementById('nDays').value, grace=+document.getElementById('nGrace').value;
  const gstin=document.getElementById('nGst').value.trim(), email=document.getElementById('nEmail').value.trim();
  let made=null, fsMade=null;
  if(soft!=='fabric'){
    const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({
      action:'create',name,plan:document.getElementById('nPlan').value,seats,days,graceDays:grace,gstin,email})});
    if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
    made=r.company;
  }
  if(soft!=='weight'){
    let f;
    try{f=await api('/admin/api/fabric',{method:'POST',body:JSON.stringify({action:'create',name,state:'LICENSED',seats,days,graceDays:Math.min(30,grace),
      gstin:gstin||undefined,email:email||undefined,linkTo:made?made.id:undefined})});}catch(e){f={error:e.message};}
    if(f.error){
      if(made)await load();
      say('<div class="msg err">'+(made?'<b>'+esc(made.name)+'</b> was made in Weight Calc, but Fabric Stock said: ':'Fabric Stock: ')+esc(f.message||f.error)+'</div>');
      return;
    }
    fsMade=f.company;
  }
  document.getElementById('newco').style.display='none';
  document.getElementById('nName').value='';document.getElementById('nEmail').value='';document.getElementById('nGst').value='';
  await load();
  say('<div class="msg ok"><b>'+esc(name)+'</b> created.'+
    (made?' Weight Calc licence key <span class="key">'+esc(made.licence_key)+'</span>.':'')+
    (fsMade?' Fabric Stock licence key <span class="key">'+esc(fsMade.licenceKey)+'</span>.':'')+
    ' Give each key to the customer for its own software; every machine types it at activation.</div>');
}
/* ---------- every Nexora software in the one console (2026-10-07) ----------
   Owner 2026-10-07: "nexora console page single rahese badhi service tya thij update chalu bandh thase",
   and "દરેક software અલગ": each software keeps its own licence, key, period, seats, people and rights in
   its own service. /admin/api/products lists them, /admin/api/fabric changes Fabric Stock's (products.js).
   A Fabric Stock company with the same GSTIN is the same company; any other is linked by hand. */
let PRODUCTS=null, FDETAIL={}, OPENF=null;
async function loadProducts(){
  try{PRODUCTS=await api('/admin/api/products');}
  catch(e){PRODUCTS={products:[{id:'weight',ok:true},{id:'fabric',ok:false,error:'FABRIC_DOWN',message:e.message,companies:[]}]};}
  if(!DATA)return;
  renderCompanies();
  if(OPEN){const f=fabricOf(OPEN);if(f)fabricDetail(f.id);}
  if(OPENF)fabricDetail(OPENF);
}
function fabricProduct(){return PRODUCTS&&(PRODUCTS.products||[]).find(p=>p.id==='fabric')||null;}
function fabricAll(){const p=fabricProduct();return p&&p.ok?(p.companies||[]):[];}
function fabricOf(id){return fabricAll().find(f=>f.companyId!=null&&String(f.companyId)===String(id))||null;}
/* Fabric Stock's companies with no Weight Calc company of their own (a second one on the same company is listed too) */
function fabricOnly(){
  const ids=new Set(((DATA&&DATA.companies)||[]).map(c=>String(c.id)));
  return fabricAll().filter(f=>f.companyId==null||!ids.has(String(f.companyId))||fabricOf(f.companyId)!==f);
}
function fsWord(f){return f.shownState==='DEMO'?'demo':String(f.shownState||'').toLowerCase();}
function fsColour(f){return f.shownState==='LICENSED'?'var(--k-green)':f.shownState==='DEMO'?'var(--k-teal)':f.shownState==='EXPIRED'?'var(--k-amber)':'var(--k-red)';}
function fsDays(f){return f.shownState==='EXPIRED'||f.shownState==='SUSPENDED'?'since '+fmt(f.expiresAt):(f.daysLeft===0?'ends today':f.daysLeft+' day'+(f.daysLeft===1?'':'s'));}
function swPills(c){
  const f=fabricOf(c.id);
  return '<span class="pill sw-weight" title="Nexora Bag Weight Calculation">Weight Calc</span> '+
    (f?'<span class="pill sw-fabric" title="Nexora Loom &amp; Fabric Stock — its own licence">Fabric Stock · '+esc(fsWord(f))+' · '+esc(fsDays(f))+'</span> ':'');
}
/* when Fabric Stock cannot be reached, the Weight Calc list is shown all the same, with this above it */
function fabricNote(){
  const p=fabricProduct();
  if(!p)return COVIEW==='fabric'?'<p class="help">Reading Fabric Stock…</p>':'';
  if(p.ok)return '';
  return '<div class="sw-off"><b style="color:var(--k-violet)">Fabric Stock is not connected.</b> '+esc(p.message||'')+' <button class="small" onclick="loadProducts()">Try again</button></div>';
}
function fabricFacts(f){
  const used=+f.people||0, seats=+f.seats||1, pct=Math.min(100,Math.round(used/Math.max(1,seats)*100));
  const ended=f.shownState==='EXPIRED'||f.shownState==='SUSPENDED';
  return '<div class="co-facts">'+
    '<div class="fact"><span>Licence</span><b style="color:'+fsColour(f)+'">'+esc(fsWord(f))+'</b><small>'+(f.isDemo?'everything, while it is a demo':'plan '+esc(String(f.plan||'STANDARD').toLowerCase()))+'</small></div>'+
    '<div class="fact"><span>Licence key</span><b class="key" style="font-size:13px">'+esc(f.licenceKey||'')+'</b><small><button class="small" data-key="'+esc(f.licenceKey||'')+'" onclick="copyKey(this)">Copy</button></small></div>'+
    '<div class="fact"><span>Seats (people)</span><b>'+used+' of '+seats+'</b><small>'+(seats-used>0?(seats-used)+' available':'none available')+'</small><span class="bar'+(used>=seats?' full':'')+'"><i style="width:'+pct+'%"></i></span></div>'+
    '<div class="fact"><span>Computers and phones</span><b>'+(+f.devices||0)+'</b><small>not counted against seats</small></div>'+
    '<div class="fact"><span>'+(f.isDemo?'Demo started':'Licence started')+'</span><b>'+fmt(f.periodStartedAt||f.createdAt)+'</b><small>'+(f.periodDays?f.periodDays+'-day '+(f.isDemo?'demo':'licence'):'—')+'</small></div>'+
    '<div class="fact"'+(f.endingSoon?' style="border-color:var(--warn)" title="Ends within 30 days — ring them to renew"':'')+'><span>'+(f.shownState==='EXPIRED'?'Ended':f.shownState==='SUSPENDED'?'Suspended · ends':'Days left')+'</span><b'+(f.endingSoon?' style="color:var(--warn)"':'')+'>'+(ended?fmt(f.expiresAt):(f.daysLeft===0?'today':f.daysLeft))+'</b>'+(ended?'':'<small>'+fmt(f.expiresAt)+(f.endingSoon?' · <b style="color:var(--warn);display:inline;font-size:inherit">renew soon</b>':'')+'</small>')+'</div>'+
    '<div class="fact"><span>Offline allowed</span><b>'+(f.graceDays>0?f.graceDays+' days':'none')+'</b></div>'+
    (f.loginId?'<div class="fact"><span>Login id</span><b><code>'+esc(f.loginId)+'</code></b></div>':'')+
  '</div>';
}
function fabricManage(f,c){
  const p=fabricProduct();
  if(!p)return '<div class="sw-off">Reading Fabric Stock…</div>';
  if(!p.ok)return fabricNote();
  if(!f){
    const loose=fabricOnly().filter(x=>x.companyId==null);
    return '<div class="group"><h4>Not used yet</h4><div class="acts">'+
      '<span class="why" style="flex-basis:100%">'+esc(c.name)+' does not use Fabric Stock yet. It gets a licence of its own: starting it changes nothing in Weight Calc.</span>'+
      '<button class="primary" data-wc="'+c.id+'" data-state="DEMO" onclick="fsStart(this)">Start a 7-day demo</button>'+
      '<button data-wc="'+c.id+'" data-state="LICENSED" onclick="fsStart(this)">Make licensed for 1 year</button>'+
      (loose.length?'<select id="fslink-'+c.id+'"><option value="">Link an existing Fabric Stock company…</option>'+loose.map(x=>'<option value="'+x.id+'">'+esc(x.name)+(x.gstin?' · '+esc(x.gstin):'')+'</option>').join('')+'</select><button data-wc="'+c.id+'" onclick="fsLinkPick(this)">Link</button>':'')+
    '</div></div>';
  }
  const id=f.id, d=FDETAIL[id];
  return '<div class="group"><h4>Licence</h4><div class="acts">'+
      (f.isDemo?'<button class="primary" data-fid="'+id+'" onclick="fsLicense(this)">Make licensed for 1 year</button><span class="why">turns this demo into a paying customer</span>':'')+
      '<button data-fid="'+id+'" onclick="fsRenew(this)">Renew from today…</button>'+
      '<button data-fid="'+id+'" data-days="365" onclick="fsRenew(this)">1 year from today</button><span class="why">a new period from today; it replaces the old end date</span>'+
    '</div></div>'+
    '<div class="group"><h4>Machines</h4><div class="acts">'+
      '<button data-fid="'+id+'" data-now="'+(+f.seats||1)+'" onclick="fsSeats(this)">Seats…</button><span class="why">how many people may sign in to Fabric Stock</span>'+
      '<button data-fid="'+id+'" data-now="'+(+f.graceDays||0)+'" onclick="fsGrace(this)">Offline days…</button>'+
      '<div id="fsdev-'+id+'" class="users-panel">'+(d&&!d.error?fsDevicesHtml(d.devices||[]):'<p class="help">Reading…</p>')+'</div>'+
    '</div></div>'+
    '<div class="group"><h4>People</h4><div class="acts">'+
      '<button data-fid="'+id+'" data-name="'+esc(f.name)+'" onclick="fsAdmin(this)">Set administrator…</button><span class="why">the administrator adds everyone else and gives their rights inside Fabric Stock, apart from Weight Calc</span>'+
      '<button data-fid="'+id+'" data-login="'+esc(f.loginId||'')+'" onclick="fsPasscode(this)">New company passcode…</button>'+
      '<div id="fsppl-'+id+'" class="users-panel">'+(d&&!d.error?fsPeopleHtml(id,d.users||[]):'<p class="help">Reading…</p>')+'</div>'+
    '</div></div>'+
    '<div class="group"><h4>Company</h4><div class="acts">'+
      (c?(f.linkedBy==='gstin'
          ?'<span class="why">Shown with '+esc(c.name)+' because the GSTIN is the same.</span><button data-fid="'+id+'" data-action="apart" onclick="fsLink(this)">Not the same company</button>'
          :'<span class="why">Linked to '+esc(c.name)+' by hand.</span><button data-fid="'+id+'" data-action="unlink" onclick="fsLink(this)">Unlink</button>')
        :linkSelect(f))+
    '</div></div>'+
    '<div class="group"><h4>Stop</h4><div class="acts">'+
      (f.state==='SUSPENDED'
        ?'<button data-fid="'+id+'" data-action="resume" onclick="fsStop(this)">Restore</button><span class="why">every Fabric Stock computer and phone runs again</span>'
        :'<button class="danger" data-fid="'+id+'" data-action="suspend" onclick="fsStop(this)">Suspend</button><span class="why">every Fabric Stock computer and phone stops at its next check; nothing is deleted, and Weight Calc is not touched</span>')+
    '</div></div>';
}
function linkSelect(f){
  const cos=(DATA&&DATA.companies)||[];
  if(!cos.length)return '<span class="why">No Weight Calc company to link it to.</span>';
  return '<select id="fswc-'+f.id+'"><option value="">Link to a Weight Calc company…</option>'+cos.map(c=>'<option value="'+c.id+'">'+esc(c.name)+(c.gstin?' · '+esc(c.gstin):'')+'</option>').join('')+'</select>'+
    '<button data-fid="'+f.id+'" onclick="fsLinkTo(this)">Link</button><span class="why">the same plant using both; each keeps its own licence</span>';
}
function fsPeopleHtml(fid,users){
  if(!users.length)return '<p class="help"><b style="color:var(--bad)">Nobody yet</b> — set an administrator; the administrator adds everyone else from inside Fabric Stock.</p>';
  return '<table class="users"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Last seen</th><th></th></tr></thead><tbody>'+
    users.map(u=>'<tr'+(u.active===false?' style="opacity:.55"':'')+'><td><b>'+esc(u.name)+'</b>'+(u.active===false?' <small>(switched off)</small>':'')+'</td>'+
      '<td>'+(u.role==='ADMIN'?'<b>administrator</b>':'user'+(u.scope==='OWN'?' · own work only':''))+'</td>'+
      '<td>'+(u.email?'<code>'+esc(u.email)+'</code>':'<span class="why">—</span>')+'</td>'+
      '<td class="why">'+esc(u.lastSeenAt?fmtTime(u.lastSeenAt):'never')+'</td>'+
      '<td>'+(u.sessionDevice?'<button class="small" data-fid="'+fid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" onclick="fsSignOut(this)">Sign out</button>':'')+'</td></tr>').join('')+
    '</tbody></table>';
}
function fsDevicesHtml(devs){
  if(!devs.length)return '<p class="help">No Fabric Stock computer or phone has joined yet.</p>';
  return '<table class="users"><thead><tr><th>Computer / phone</th><th>State</th><th>Signed in</th><th>Last seen</th><th></th></tr></thead><tbody>'+
    devs.map(d=>{
      const st=d.state==='REVOKED'?(d.revokedBy==='NEXORA'?'withdrawn by Nexora':'removed by the company'):d.pending?'waiting for the administrator':'in use';
      return '<tr><td><b>'+esc(d.name||(d.platform==='mobile'?'Phone':'Computer'))+'</b><br><small>'+(d.platform==='mobile'?'phone':'computer'+(d.computerNo?' '+d.computerNo:''))+(d.appVersion?' · '+esc(d.appVersion):'')+'</small></td>'+
        '<td>'+esc(st)+'</td><td>'+(d.signedIn?esc(d.signedIn.name):'<span class="why">nobody</span>')+'</td>'+
        '<td class="why">'+esc(d.lastSeen?fmtTime(d.lastSeen):'never')+'</td>'+
        '<td>'+(d.state==='REVOKED'?(d.revokedBy==='NEXORA'?'<button class="small" data-dev="'+esc(d.id)+'" data-action="restore" onclick="fsDevice(this)">Give back</button>':'')
          :'<button class="small danger" data-dev="'+esc(d.id)+'" data-action="revoke" onclick="fsDevice(this)">Withdraw</button>')+'</td></tr>';
    }).join('')+'</tbody></table>';
}
function fabricOnlyHtml(term){
  return fabricOnly().filter(f=>!term||[f.name,f.licenceKey,f.email,f.gstin,f.loginId,f.phone].some(v=>String(v||'').toLowerCase().includes(term))).map(f=>{
    const open=OPENF===f.id;
    return '<div class="co fabric-only" id="fco-'+f.id+'">'+
      '<div class="co-head"><div class="grow" style="flex:1">'+
        '<span class="co-name">'+esc(f.name)+'</span> '+
        '<span class="pill s-'+esc(f.shownState)+'">'+esc(fsWord(f))+'</span> '+
        '<span class="pill sw-fabric" title="Nexora Loom &amp; Fabric Stock">Fabric Stock only</span> '+
        (f.selfRegistered?'<span class="pill s-SELF">self-registered</span> ':'')+
        '<div class="co-meta"><span>Key <span class="key">'+esc(f.licenceKey)+'</span> <button class="small" data-key="'+esc(f.licenceKey)+'" onclick="copyKey(this)">Copy</button></span>'+
          (f.gstin?'<span>GSTIN <code>'+esc(f.gstin)+'</code></span>':'')+(f.email?'<span><code>'+esc(f.email)+'</code></span>':'')+(f.phone?'<span><code>'+esc(f.phone)+'</code></span>':'')+'</div>'+
      '</div><div><button'+(open?' class="primary"':'')+' data-fid="'+f.id+'" onclick="manageF(this)">'+(open?'Close':'Manage')+'</button></div></div>'+
      '<div class="sw-cap sw-fabric">Fabric Stock</div>'+fabricFacts(f)+
      '<div class="manage'+(open?' open':'')+'">'+fabricManage(f,null)+'</div>'+
    '</div>';
  }).join('');
}
function manageF(btn){
  const id=+btn.dataset.fid;
  OPENF=OPENF===id?null:id;
  renderCompanies();
  if(OPENF){document.getElementById('fco-'+OPENF).scrollIntoView({block:'nearest'});fabricDetail(OPENF);}
}
async function fabricDetail(fid){
  let d;
  try{d=await api('/admin/api/fabric',{method:'POST',body:JSON.stringify({action:'detail',id:fid})});}catch(e){d={error:e.message};}
  FDETAIL[fid]=d;
  const pp=document.getElementById('fsppl-'+fid), dv=document.getElementById('fsdev-'+fid);
  if(d.error){const m='<div class="msg err">'+esc(d.message||d.error)+'</div>';if(pp)pp.innerHTML=m;if(dv)dv.innerHTML='';return;}
  if(pp)pp.innerHTML=fsPeopleHtml(fid,d.users||[]);
  if(dv)dv.innerHTML=fsDevicesHtml(d.devices||[]);
}
/* every change goes to Fabric Stock's own service, then the list is read again */
async function fsCall(body,done){
  let r;
  try{r=await api('/admin/api/fabric',{method:'POST',body:JSON.stringify(body)});}catch(e){r={error:e.message};}
  if(r.error){say('<div class="msg err">Fabric Stock: '+esc(r.message||r.error)+'</div>');return null;}
  if(done)say('<div class="msg ok">'+done+'</div>');
  await loadProducts();
  return r;
}
function fsName(id){const f=fabricAll().find(x=>String(x.id)===String(id));return f?f.name:'this company';}
async function fsStart(btn){
  const c=((DATA&&DATA.companies)||[]).find(x=>String(x.id)===String(btn.dataset.wc));if(!c)return;
  const demo=btn.dataset.state==='DEMO';
  if(!confirm((demo?'Start a 7-day Fabric Stock demo':'Make a licensed Fabric Stock company for 1 year')+' for '+c.name+'?  It gets a Fabric Stock licence key of its own; Weight Calc is not touched.'))return;
  const r=await fsCall({action:'create',name:c.name,state:demo?'DEMO':'LICENSED',days:demo?7:365,seats:3,gstin:c.gstin||undefined,email:c.email||undefined,phone:c.phone||undefined,linkTo:c.id});
  if(r&&r.company)say('<div class="msg ok"><b>'+esc(c.name)+'</b> now has Fabric Stock. Its Fabric Stock licence key is <span class="key">'+esc(r.company.licenceKey)+'</span> — for Fabric Stock only.</div>');
}
async function fsLicense(btn){
  if(!confirm('Make '+fsName(btn.dataset.fid)+' a licensed Fabric Stock customer for 1 year from today?'))return;
  await fsCall({action:'update',id:+btn.dataset.fid,state:'LICENSED',days:365},'Fabric Stock licensed for 1 year.');
}
async function fsRenew(btn){
  let days=+btn.dataset.days||0;
  if(!days){
    const v=prompt('Renew Fabric Stock for how many days from today?  The new end date replaces the old one.','365');
    if(v===null)return;
    days=parseInt(v,10);
    if(!(days>0)){say('<div class="msg err">Enter a number of days.</div>');return;}
  }else if(!confirm('Renew '+fsName(btn.dataset.fid)+' for '+days+' days from today?'))return;
  await fsCall({action:'update',id:+btn.dataset.fid,days},'Fabric Stock renewed for '+days+' days from today.');
}
async function fsSeats(btn){
  const v=prompt('How many people may sign in to Fabric Stock at '+fsName(btn.dataset.fid)+'?',btn.dataset.now||'3');
  if(v===null)return;
  const n=parseInt(v,10);
  if(!(n>0)){say('<div class="msg err">Enter a number of seats.</div>');return;}
  await fsCall({action:'update',id:+btn.dataset.fid,seats:n},'Fabric Stock seats set to '+n+'.');
}
async function fsGrace(btn){
  const v=prompt('How many days may Fabric Stock work without reaching the service (0 to 30)?',btn.dataset.now||'0');
  if(v===null)return;
  const n=parseInt(v,10);
  if(!(n>=0)){say('<div class="msg err">Enter a number of days.</div>');return;}
  await fsCall({action:'update',id:+btn.dataset.fid,graceDays:n},'Fabric Stock offline days set.');
}
async function fsAdmin(btn){
  const name=prompt('Fabric Stock administrator for '+btn.dataset.name+' — the person’s name:','');
  if(!name)return;
  const pin=prompt('A PIN for '+name+' (they change it themselves later):','');
  if(!pin)return;
  await fsCall({action:'adminuser',id:+btn.dataset.fid,name,pin},'Fabric Stock administrator set: '+esc(name)+'.');
}
async function fsPasscode(btn){
  const login=prompt('Fabric Stock company id (the name the plant signs a new computer in with):',btn.dataset.login||'');
  if(login===null)return;
  const passcode=prompt('A new company passcode (at least 6 characters):','');
  if(!passcode)return;
  await fsCall({action:'passcode',id:+btn.dataset.fid,loginId:login||undefined,passcode},'A new Fabric Stock company passcode is set.');
}
async function fsSignOut(btn){
  if(!confirm('Sign '+btn.dataset.name+' out of Fabric Stock everywhere?'))return;
  await fsCall({action:'usersignout',id:+btn.dataset.fid,userId:+btn.dataset.uid},esc(btn.dataset.name)+' is signed out of Fabric Stock.');
}
async function fsDevice(btn){
  const give=btn.dataset.action==='restore';
  if(!give&&!confirm('Withdraw this Fabric Stock computer or phone?  It stops at once; the person on it is signed out.'))return;
  await fsCall({action:btn.dataset.action,deviceId:btn.dataset.dev},give?'Given back.':'Withdrawn.');
}
async function fsStop(btn){
  const stop=btn.dataset.action==='suspend';
  if(stop&&!confirm('Suspend Fabric Stock for '+fsName(btn.dataset.fid)+'?  EVERY Fabric Stock computer and phone stops at its next check. Nothing is deleted, and Weight Calc is not touched; Restore puts it back.'))return;
  await fsCall({action:btn.dataset.action,id:+btn.dataset.fid},stop?'Fabric Stock suspended.':'Fabric Stock restored.');
}
async function fsLink(btn){
  const apart=btn.dataset.action==='apart';
  if(!confirm(apart?'These are two different companies, although the GSTIN is the same?  Fabric Stock is then listed on its own.':'Unlink?  It is then shown with whichever company has the same GSTIN, or on its own.'))return;
  await fsCall({action:btn.dataset.action,id:+btn.dataset.fid},apart?'Kept apart.':'Unlinked.');
}
async function fsLinkTo(btn){
  const sel=document.getElementById('fswc-'+btn.dataset.fid);const to=sel&&sel.value;
  if(!to){say('<div class="msg err">Choose the Weight Calc company first.</div>');return;}
  await fsCall({action:'link',id:+btn.dataset.fid,companyId:+to},'Linked.');
  OPENF=null;OPEN=+to;renderCompanies();
}
async function fsLinkPick(btn){
  const sel=document.getElementById('fslink-'+btn.dataset.wc);const fid=sel&&sel.value;
  if(!fid){say('<div class="msg err">Choose the Fabric Stock company first.</div>');return;}
  await fsCall({action:'link',id:+fid,companyId:+btn.dataset.wc},'Linked.');
  const f=fabricOf(btn.dataset.wc);if(f)fabricDetail(f.id);
}
/* ---------- the phone app's releases (4.44.0) -------------------------- */
let RELEASES=[];
function appsay(html){
  const n=document.getElementById('appMsg');
  if(!n)return;
  n.innerHTML=html;
  if(html)setTimeout(()=>{if(n.innerHTML===html)appsay('')},6000);
}
let REPO_RELEASE=null;
async function loadReleases(){
  try{
    const r=await api('/admin/api/app');
    RELEASES=r.releases||[];
    REPO_RELEASE=r.fromRepository||null;
    const s=document.getElementById('rSource');
    if(s&&document.activeElement!==s)s.value=r.manifestUrl||'';
  }catch(e){
    RELEASES=[];
    document.querySelector('#apptbl tbody').innerHTML=
      '<tr><td colspan="6" class="help">This service does not carry phone builds yet — deploy the API to switch them on.</td></tr>';
    return;
  }
  renderReleases();
}
async function saveSource(){
  const url=document.getElementById('rSource').value.trim();
  const r=await api('/admin/api/app',{method:'POST',body:JSON.stringify({action:'source',manifestUrl:url})});
  if(r.error){appsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  appsay('<div class="msg ok">'+esc(r.warning||'Saved.')+'</div>');
  await loadReleases();
}
function renderReleases(){
  const latest=RELEASES[0];
  /* Whichever is newer is what the phones will actually be offered. */
  const offered=(REPO_RELEASE&&(!latest||REPO_RELEASE.versionCode>latest.versionCode))?REPO_RELEASE:latest;
  document.getElementById('appsub').textContent=
    offered?('— phones are offered '+offered.versionName+' (code '+offered.versionCode+')')
           :'— nothing published yet';
  document.getElementById('repoLine').innerHTML=REPO_RELEASE
    ? '<div class="msg ok">The repository is offering <b>'+esc(REPO_RELEASE.versionName)+
      '</b> (code '+REPO_RELEASE.versionCode+')'+
      (REPO_RELEASE.notes?' &mdash; '+esc(REPO_RELEASE.notes):'')+
      '. Pushing a new build there is all a new version needs.</div>'
    : '';
  document.querySelector('#apptbl tbody').innerHTML=RELEASES.map((r,i)=>
    '<tr>'+
      '<td><b>'+esc(r.versionName)+'</b>'+(i===0?' <span class="pill s-LICENSED">newest</span>':'')+
        (r.mandatory?' <span class="pill s-EXPIRED">must install</span>':'')+'</td>'+
      '<td><code>'+r.versionCode+'</code></td>'+
      '<td class="why">'+fmt(r.publishedAt)+'</td>'+
      '<td class="why" style="max-width:280px">'+esc(r.notes||'')+'</td>'+
      '<td><a href="'+esc(r.url)+'" target="_blank" rel="noopener"><code>'+esc(String(r.url).slice(0,48))+'…</code></a></td>'+
      '<td><div class="acts">'+
        '<button class="small" data-code="'+r.versionCode+'" onclick="editRelease(this)">Edit</button>'+
        '<button class="small danger" data-code="'+r.versionCode+'" data-name="'+esc(r.versionName)+'" onclick="withdrawRelease(this)">Withdraw</button>'+
      '</div></td></tr>'
  ).join('')||'<tr><td colspan="6" class="help">Nothing published yet. Build the APK, put it somewhere the phones can reach over https, and publish its version code and address here.</td></tr>';
}
function editRelease(btn){
  const r=RELEASES.find(x=>x.versionCode===+btn.dataset.code);
  if(!r)return;
  document.getElementById('newrel').style.display='';
  document.getElementById('rCode').value=r.versionCode;
  document.getElementById('rName').value=r.versionName||'';
  document.getElementById('rUrl').value=r.url||'';
  document.getElementById('rNotes').value=r.notes||'';
  document.getElementById('rSha').value=r.sha256||'';
  document.getElementById('rMust').checked=!!r.mandatory;
  document.getElementById('newrel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function publishRelease(){
  const body={
    action:'publish',
    versionCode:+document.getElementById('rCode').value,
    versionName:document.getElementById('rName').value.trim(),
    url:document.getElementById('rUrl').value.trim(),
    notes:document.getElementById('rNotes').value.trim(),
    sha256:document.getElementById('rSha').value.trim(),
    mandatory:document.getElementById('rMust').checked
  };
  const r=await api('/admin/api/app',{method:'POST',body:JSON.stringify(body)});
  if(r.error){appsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  document.getElementById('newrel').style.display='none';
  appsay('<div class="msg ok">'+esc(r.warning||'Published.')+'</div>');
  await loadReleases();
}
async function withdrawRelease(btn){
  if(!confirm('Withdraw version '+btn.dataset.name+'?\\n\\nPhones will offer the version below it instead. Nothing already installed is touched.'))return;
  const r=await api('/admin/api/app',{method:'POST',body:JSON.stringify({action:'delete',versionCode:+btn.dataset.code})});
  if(r.error){appsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  appsay('<div class="msg ok">'+esc(r.warning||'Withdrawn.')+'</div>');
  await loadReleases();
}

/* ---------- enquiries (4.42.0) ----------------------------------------
   The same rows the phone console shows, from the same service. Nothing
   is cached here and nothing is merged: both read /admin/api/inquiries,
   so "in step" is not a thing that has to be arranged. */
let QDATA={inquiries:[],products:[],states:[],sources:[]}, QSTATE=null;

function qsay(html){
  const n=document.getElementById('qMsg');
  if(!n)return;
  n.innerHTML=html;
  if(html)setTimeout(()=>{if(n.innerHTML===html)qsay('')},6000);
}
async function loadInquiries(){
  try{
    QDATA=await api('/admin/api/inquiries');
  }catch(e){
    /* A service that has not been deployed with enquiries yet. The rest of
       the console is perfectly usable, so this says so once and stops. */
    QDATA={inquiries:[],products:[],states:[],sources:[]};
    document.querySelector('#qtbl tbody').innerHTML=
      '<tr><td colspan="8" class="help">This service does not have enquiries yet — deploy the API to switch them on.</td></tr>';
    return;
  }
  fillSelect('qProduct',QDATA.products);
  fillSelect('qSource',QDATA.sources);
  fillSelect('qState',QDATA.states);
  renderInquiries();
}
function fillSelect(id,list){
  const s=document.getElementById(id);
  if(!s||!list||!list.length)return;
  const keep=s.value;
  /* A code like WEBSITE or QUOTED reads better in lower case; a product
     name like "AMC & Support" is written the way it is written. All-capitals
     is the difference, and it is exactly the difference we mean. */
  s.innerHTML=list.map(v=>'<option value="'+esc(v)+'">'+esc(v===v.toUpperCase()?v.toLowerCase():v)+'</option>').join('');
  if(keep&&list.indexOf(keep)>=0)s.value=keep;
}
function qPill(state){
  const map={NEW:'TRIAL',CONTACTED:'SELF',DEMO:'EXPIRED',QUOTED:'EXPIRED',WON:'LICENSED',LOST:'REVOKED'};
  return map[state]||'SELF';
}
/* 4.73.0 — C17: the website form 2's manufacturing location, website and product ticks. A website is a link only
   when it is an ordinary web address (http, https, or a bare www.example.com); anything else is shown as text. */
function siteLink(w){
  const s=String(w==null?'':w).trim();if(!s)return '';
  const l=s.toLowerCase();
  const href=(l.indexOf('http://')===0||l.indexOf('https://')===0)?s:(s.indexOf(' ')<0&&s.indexOf(':')<0&&s.indexOf('.')>0?'https://'+s:'');
  return href?'<a href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">'+esc(s)+'</a>':esc(s);
}
function form2Lines(q){
  const out=[];
  if(q.location)out.push('<span class="why">Location: '+esc(q.location)+'</span>');
  if(q.products&&q.products.length)out.push('<span class="why">Makes: '+esc(q.products.map(p=>p==='Other'&&q.productOther?'Other ('+q.productOther+')':p).join(', '))+'</span>');
  if(q.website)out.push('<span class="why">Website: '+siteLink(q.website)+'</span>');
  return out.length?'<br>'+out.join('<br>'):'';
}
function renderInquiries(){
  const term=(document.getElementById('qq').value||'').toLowerCase();
  const all=QDATA.inquiries||[];
  const rows=all.filter(q=>(!QSTATE||q.state===QSTATE)&&(!term||
    [q.name,q.company,q.phone,q.email,q.product,q.message,q.notes,q.location,q.website,(q.products||[]).join(' '),q.productOther].some(v=>String(v||'').toLowerCase().includes(term))));
  document.getElementById('qsub').textContent='— '+rows.length+' of '+all.length;
  const jq=document.getElementById('jump-q');if(jq){const nn=all.filter(q=>q.state==='NEW').length;jq.textContent=nn;jq.className=nn?'hot':'zero';}

  /* The states, as filters that also count. */
  document.getElementById('qstates').innerHTML=
    '<button class="small'+(QSTATE?'':' primary')+'" onclick="qFilter(null)">All '+all.length+'</button>'+
    (QDATA.states||[]).map(s=>{
      const n=all.filter(q=>q.state===s).length;
      return '<button class="small'+(QSTATE===s?' primary':'')+'" data-state="'+s+'" onclick="qFilter(this.dataset.state)">'+s.toLowerCase()+' '+n+'</button>';
    }).join('');

  const today=new Date().toISOString().slice(0,10);
  document.querySelector('#qtbl tbody').innerHTML=rows.map(q=>{
    const due=q.followUp&&String(q.followUp).slice(0,10)<=today&&q.state!=='WON'&&q.state!=='LOST';
    const reach=[];
    if(q.phone)reach.push('<a href="tel:'+esc(q.phone)+'"><code>'+esc(q.phone)+'</code></a>');
    if(q.email)reach.push('<a href="'+esc(mailHref(q.email))+'"><code>'+esc(q.email)+'</code></a>');
    return '<tr>'+
      '<td><b>'+esc(q.name)+'</b>'+(q.company?'<br><span class="why">'+esc(q.company)+'</span>':'')+'</td>'+
      '<td>'+esc(q.product||'—')+form2Lines(q)+'</td>'+
      '<td><span class="pill s-'+qPill(q.state)+'">'+esc(String(q.state).toLowerCase())+'</span></td>'+
      '<td class="why">'+esc(String(q.source||'').toLowerCase())+'<br>'+fmt(q.createdAt)+'</td>'+
      '<td>'+(reach.join('<br>')||'<span class="why">nothing given</span>')+'</td>'+
      '<td class="why" style="max-width:260px">'+esc(q.message||'')+(q.notes?'<br><b>note:</b> '+esc(q.notes):'')+'</td>'+
      '<td'+(due?' style="color:var(--warn);font-weight:700"':' class="why"')+'>'+(q.followUp?esc(String(q.followUp).slice(0,10)):'—')+'</td>'+
      '<td><div class="acts">'+
        (QDATA.states||[]).filter(s=>s!==q.state).map(s=>
          '<button class="small'+(s==='WON'?' primary':'')+'" data-id="'+q.id+'" data-state="'+s+'" onclick="qState(this)">→ '+s.toLowerCase()+'</button>').join('')+
        '<button class="small" data-id="'+q.id+'" onclick="qEdit(this)">Edit</button>'+
        '<button class="small danger" data-id="'+q.id+'" data-name="'+esc(q.name)+'" onclick="qDelete(this)">Remove</button>'+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="8" class="help">Nothing here yet. The website&rsquo;s form fills this on its own; add the ones that come by phone with New enquiry.</td></tr>';
}
function qFilter(state){QSTATE=state||null;renderInquiries();}
function clearInquiryForm(){
  ['qId','qName','qCompany','qPhone','qEmail','qMessage','qNotes','qFollow'].forEach(id=>{
    const n=document.getElementById(id);if(n)n.value='';
  });
}
function qEdit(btn){
  const q=(QDATA.inquiries||[]).find(x=>x.id===+btn.dataset.id);
  if(!q)return;
  document.getElementById('newq').style.display='';
  document.getElementById('qId').value=q.id;
  document.getElementById('qName').value=q.name||'';
  document.getElementById('qCompany').value=q.company||'';
  document.getElementById('qPhone').value=q.phone||'';
  document.getElementById('qEmail').value=q.email||'';
  document.getElementById('qMessage').value=q.message||'';
  document.getElementById('qNotes').value=q.notes||'';
  document.getElementById('qFollow').value=q.followUp?String(q.followUp).slice(0,10):'';
  if(q.product)document.getElementById('qProduct').value=q.product;
  if(q.source)document.getElementById('qSource').value=q.source;
  if(q.state)document.getElementById('qState').value=q.state;
  document.getElementById('newq').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function saveInquiry(){
  const id=+document.getElementById('qId').value||0;
  const name=document.getElementById('qName').value.trim();
  if(!name){qsay('<div class="msg err">A name is required.</div>');return;}
  const body={
    action:id?'update':'create',
    name,
    company:document.getElementById('qCompany').value.trim(),
    phone:document.getElementById('qPhone').value.trim(),
    email:document.getElementById('qEmail').value.trim(),
    product:document.getElementById('qProduct').value,
    source:document.getElementById('qSource').value,
    state:document.getElementById('qState').value,
    message:document.getElementById('qMessage').value.trim(),
    notes:document.getElementById('qNotes').value.trim(),
    followUp:document.getElementById('qFollow').value||''
  };
  if(id)body.id=id;
  const r=await api('/admin/api/inquiry',{method:'POST',body:JSON.stringify(body)});
  if(r.error){qsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  clearInquiryForm();
  document.getElementById('newq').style.display='none';
  qsay('<div class="msg ok">'+(id?'Saved.':'Enquiry added.')+'</div>');
  await loadInquiries();
}
async function qState(btn){
  const r=await api('/admin/api/inquiry',{method:'POST',body:JSON.stringify({action:'state',id:+btn.dataset.id,state:btn.dataset.state})});
  if(r.error){qsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await loadInquiries();
}
async function qDelete(btn){
  if(!confirm('Remove '+btn.dataset.name+' from the enquiries?\\n\\nThe row is deleted. If they became a customer, their company is not touched.'))return;
  const r=await api('/admin/api/inquiry',{method:'POST',body:JSON.stringify({action:'delete',id:+btn.dataset.id})});
  if(r.error){qsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  qsay('<div class="msg ok">Removed.</div>');
  await loadInquiries();
}

/* ---------- a message from Nexora into every room (4.47.1) ---------- */
let BCDATA={broadcasts:[]};
function bcsay(html){
  const n=document.getElementById('bcMsg');
  if(!n)return;
  n.innerHTML=html;
  if(html)setTimeout(()=>{if(n.innerHTML===html)bcsay('')},6000);
}
async function loadBroadcasts(){
  try{
    BCDATA=await api('/admin/api/broadcast');
  }catch(e){
    BCDATA={broadcasts:[]};
    document.querySelector('#bctbl tbody').innerHTML=
      '<tr><td colspan="4" class="help">This service cannot speak in the rooms yet \u2014 deploy the API to switch it on.</td></tr>';
    return;
  }
  renderBroadcasts();
}
function renderBroadcasts(){
  const rows=BCDATA.broadcasts||[];
  document.querySelector('#bctbl tbody').innerHTML=rows.length?rows.map((b,i)=>
    '<tr><td><span class="why">'+fmt(b.at)+'</span></td>'+
    '<td style="white-space:pre-wrap;max-width:560px">'+esc(b.body)+'</td>'+
    '<td>'+b.rooms+'</td>'+
    '<td><button class="small" data-i="'+i+'" onclick="withdrawBroadcast(this)">Withdraw</button></td></tr>').join('')
    :'<tr><td colspan="4" class="help">Nothing sent yet.</td></tr>';
}
async function sendBroadcast(){
  const text=(document.getElementById('bcText').value||'').trim();
  const v=(document.getElementById('bcVersion').value||'').trim();
  if(!text){bcsay('<div class="msg err">Write the message first.</div>');return;}
  if(!confirm('Send this to the conversation of every plant, as Nexora?'))return;
  const body=v&&text.indexOf(v)<0?text+' ('+v+')':text;
  const tags=v?[{kind:'UPDATE',ref:v}]:[];
  try{
    const r=await api('/admin/api/broadcast',{method:'POST',body:JSON.stringify({action:'send',body:body,tags:tags})});
    if(r.error)throw new Error(r.message||r.error);
    bcsay('<div class="msg ok">Sent to '+r.rooms+' room'+(r.rooms===1?'':'s')+'.</div>');
    document.getElementById('bcText').value='';
    document.getElementById('bcVersion').value='';
    await loadBroadcasts();
  }catch(e){bcsay('<div class="msg err">'+esc(e.message)+'</div>');}
}
async function withdrawBroadcast(btn){
  const b=(BCDATA.broadcasts||[])[+btn.dataset.i];
  if(!b)return;
  if(!confirm('Take this message back from every room?'))return;
  try{
    const r=await api('/admin/api/broadcast',{method:'POST',body:JSON.stringify({action:'withdraw',body:b.body})});
    if(r.error)throw new Error(r.message||r.error);
    bcsay('<div class="msg ok">Withdrawn from '+r.rooms+' room'+(r.rooms===1?'':'s')+'.</div>');
    await loadBroadcasts();
  }catch(e){bcsay('<div class="msg err">'+esc(e.message)+'</div>');}
}

/* ---------- feedback & problem reports (4.45.0) ----------------------
   The same rows the phone console shows, from the same service. The
   picture is fetched only when View is pressed: a table of three hundred
   reports must not weigh three hundred screenshots. */
let FBDATA={feedback:[],kinds:[],states:[]}, FBKIND=null, FBSTATE=null, FBOPEN=0;
function fbsay(html){
  const n=document.getElementById('fbMsg');
  if(!n)return;
  n.innerHTML=html;
  if(html)setTimeout(()=>{if(n.innerHTML===html)fbsay('')},6000);
}
async function loadFeedback(){
  try{
    FBDATA=await api('/admin/api/feedback');
  }catch(e){
    FBDATA={feedback:[],kinds:[],states:[]};
    document.querySelector('#fbtbl tbody').innerHTML=
      '<tr><td colspan="7" class="help">This service does not have reports yet \u2014 deploy the API to switch them on.</td></tr>';
    return;
  }
  FBOPEN=(FBDATA.feedback||[]).filter(f=>f.state==='NEW'||f.state==='SEEN').length;
  const k=document.getElementById('kpiFbN');if(k)k.textContent=FBOPEN;
  renderFeedback();
}
function fbPill(state){
  return {NEW:'TRIAL',SEEN:'SELF',FIXED:'LICENSED',CLOSED:'REVOKED'}[state]||'SELF';
}
function renderFeedback(){
  const term=(document.getElementById('fq').value||'').toLowerCase();
  const all=FBDATA.feedback||[];
  const rows=all.filter(f=>(!FBKIND||f.kind===FBKIND)&&(!FBSTATE||f.state===FBSTATE)&&(!term||
    [f.subject,f.message,f.name,f.company,f.coName,f.userName,f.deviceName,f.view,f.reply,f.appVersion].some(v=>String(v||'').toLowerCase().includes(term))));
  document.getElementById('fbsub').textContent='\u2014 '+rows.length+' of '+all.length;
  const jf=document.getElementById('jump-fb');
  if(jf){const nn=all.filter(f=>f.state==='NEW').length;jf.textContent=nn;jf.className=nn?'hot':'zero';}
  document.getElementById('fbstates').innerHTML=
    '<button class="small'+(FBKIND?'':' primary')+'" onclick="fbKind(null)">All '+all.length+'</button>'+
    (FBDATA.kinds||[]).map(k=>'<button class="small'+(FBKIND===k?' primary':'')+'" data-kind="'+k+'" onclick="fbKind(this.dataset.kind)">'+(k==='BUG'?'problems':'feedback')+' '+all.filter(f=>f.kind===k).length+'</button>').join('')+
    '<span class="why">\u00b7</span>'+
    (FBDATA.states||[]).map(s=>'<button class="small'+(FBSTATE===s?' primary':'')+'" data-state="'+s+'" onclick="fbState(this.dataset.state)">'+s.toLowerCase()+' '+all.filter(f=>f.state===s).length+'</button>').join('');
  document.querySelector('#fbtbl tbody').innerHTML=rows.map(f=>{
    const reach=[];
    if(f.phone)reach.push('<a href="tel:'+esc(f.phone)+'"><code>'+esc(f.phone)+'</code></a>');
    if(f.email)reach.push('<a href="'+esc(mailHref(f.email))+'"><code>'+esc(f.email)+'</code></a>');
    return '<tr>'+
      '<td><span class="pill s-'+(f.kind==='BUG'?'REVOKED':'LICENSED')+'">'+(f.kind==='BUG'?'problem':'feedback')+'</span><br><span class="why">'+fmt(f.createdAt)+'</span></td>'+
      '<td><b>'+esc(f.coName||f.company||'\u2014')+'</b>'+((f.name||f.userName)?'<br>'+esc(f.name||f.userName):'')+(reach.length?'<br>'+reach.join('<br>'):'')+'</td>'+
      '<td><b>'+esc(f.subject||'')+'</b><span class="say why">'+esc(f.message||'')+'</span>'+(f.reply?'<span class="say"><b>note:</b> '+esc(f.reply)+'</span>':'')+'</td>'+
      '<td class="why">'+esc(f.view||'\u2014')+'<br>'+esc(f.appVersion||'')+(f.edition?' '+esc(String(f.edition).toLowerCase()):'')+(f.deviceName?'<br><code>'+esc(f.deviceName)+'</code>':'')+'</td>'+
      '<td>'+(f.hasShot?'<button class="small" data-id="'+f.id+'" onclick="fbShot(this)">View</button>':'<span class="why">none</span>')+'</td>'+
      '<td><span class="pill s-'+fbPill(f.state)+'">'+esc(String(f.state).toLowerCase())+'</span></td>'+
      '<td><div class="acts">'+
        (FBDATA.states||[]).filter(s=>s!==f.state).map(s=>
          '<button class="small'+(s==='FIXED'?' primary':'')+'" data-id="'+f.id+'" data-state="'+s+'" onclick="fbMove(this)">\u2192 '+s.toLowerCase()+'</button>').join('')+
        '<button class="small" data-id="'+f.id+'" onclick="fbReply(this)">Note</button>'+
        '<button class="small danger" data-id="'+f.id+'" onclick="fbDelete(this)">Remove</button>'+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="7" class="help">Nothing here yet. Reports arrive from Help \u2192 Nexora Contact inside the application.</td></tr>';
}
function fbKind(k){FBKIND=k||null;renderFeedback();}
function fbState(s){FBSTATE=(FBSTATE===s)?null:s;renderFeedback();}
async function fbMove(btn){
  const r=await api('/admin/api/feedback',{method:'POST',body:JSON.stringify({action:'state',id:+btn.dataset.id,state:btn.dataset.state})});
  if(r.error){fbsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await loadFeedback();
}
async function fbReply(btn){
  const f=(FBDATA.feedback||[]).find(x=>x.id===+btn.dataset.id);
  const note=prompt('Your note on this report (kept here and on the phone, never sent to the plant):',(f&&f.reply)||'');
  if(note===null)return;
  const r=await api('/admin/api/feedback',{method:'POST',body:JSON.stringify({action:'reply',id:+btn.dataset.id,reply:note})});
  if(r.error){fbsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await loadFeedback();
}
async function fbDelete(btn){
  if(!confirm('Remove this report?\\n\\nThe row and its picture are deleted.'))return;
  const r=await api('/admin/api/feedback',{method:'POST',body:JSON.stringify({action:'delete',id:+btn.dataset.id})});
  if(r.error){fbsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  fbsay('<div class="msg ok">Removed.</div>');
  await loadFeedback();
}
async function fbShot(btn){
  btn.disabled=true;btn.textContent='Loading\u2026';
  try{
    const r=await api('/admin/api/feedback/shot?id='+(+btn.dataset.id));
    const shot=(r&&typeof r.shot==='string')?r.shot:'';
    if(r.error||!shot){fbsay('<div class="msg err">'+esc(r.error||'No picture on that report.')+'</div>');return;}
    /* 4.72.0 (audit 42) \u2014 only a picture is ever shown: the window is built
       piece by piece (never written as text, so nothing in the value can become
       markup), it cannot reach back to this page (opener cut), and the picture
       is set only when the value is a data: image. */
    if(shot.indexOf('data:image/')!==0){fbsay('<div class="msg err">That report&rsquo;s picture is not one this console can show.</div>');return;}
    const w=window.open('','_blank');
    if(!w){fbsay('<div class="msg warn">The browser blocked the window \u2014 allow pop-ups for this page.</div>');return;}
    try{w.opener=null;}catch(e){}
    const d=w.document;
    d.title='Report #'+(+btn.dataset.id);
    const body=d.body||(d.documentElement||d.appendChild(d.createElement('html'))).appendChild(d.createElement('body'));
    body.style.cssText='margin:0;background:#12141c;display:flex;align-items:flex-start;justify-content:center';
    const img=d.createElement('img');
    img.alt='Report #'+(+btn.dataset.id);
    img.style.cssText='max-width:100%;height:auto';
    img.src=shot;
    body.appendChild(img);
  }catch(e){
    fbsay('<div class="msg err">'+esc(e.message||'Could not fetch the picture.')+'</div>');
  }finally{btn.disabled=false;btn.textContent='View';}
}

/* ---------- installations ---------- */
function showInstallations(btn){COFILTER=+btn.dataset.id;render();showSec('sec-installations');document.getElementById('tbl').scrollIntoView({behavior:'smooth',block:'start'});}
function clearCompanyFilter(){COFILTER=null;render();}
function render(){
  const term=(document.getElementById('q').value||'').toLowerCase();
  const all=DATA.licences, cos=DATA.companies||[];
  const rows=all.filter(l=>(!COFILTER||l.company_id===COFILTER)&&(!term||[l.company,l.co_name,l.co_key,l.email,l.device_id,l.device_name].some(v=>String(v||'').toLowerCase().includes(term))));
  const live=all.filter(l=>!l.expired&&l.state!=='REVOKED').length;
  document.getElementById('kpi').innerHTML=
    '<div class="kpi"><b>'+cos.filter(c=>!c.is_demo).length+'</b><span>Customers</span></div>'+
    '<div class="kpi"><b>'+cos.filter(c=>c.is_demo).length+'</b><span>Demos</span></div>'+
    '<div class="kpi"><b>'+all.length+'</b><span>Installations</span></div>'+
    '<div class="kpi"><b>'+live+'</b><span>Running</span></div>'+
    '<div class="kpi"><b id="kpiFbN">'+FBOPEN+'</b><span>Reports open</span></div>';
  const jc=document.getElementById('jump-co');if(jc){jc.textContent=cos.length;jc.className=cos.length?'':'zero';}
  const ji=document.getElementById('jump-inst');if(ji){ji.textContent=all.length;ji.className=all.length?'':'zero';}
  document.getElementById('sub').textContent=cos.length+' compan'+(cos.length===1?'y':'ies')+' · '+all.length+' installation'+(all.length===1?'':'s');
  const fc=COFILTER?cos.find(c=>c.id===COFILTER):null;
  document.getElementById('instsub').textContent=fc?'— '+fc.name+' only':'— '+rows.length+' of '+all.length;
  document.getElementById('clearFilter').style.display=COFILTER?'':'none';
  document.querySelector('#tbl tbody').innerHTML=rows.map(l=>{
    let state=(l.state==='TRIAL'&&l.expired)?'EXPIRED':l.state;
    if(l.co_state==='SUSPENDED'&&state!=='REVOKED')state='SUSPENDED';
    return '<tr>'+
      '<td><b>'+esc(l.co_name||l.company||'—')+'</b>'+(l.platform==='mobile'?' <code>📱 phone'+(l.approved_at?'':' · waiting for approval')+'</code>':(l.seat_no?' <code>computer '+l.seat_no+(l.approved_at||l.state==='REVOKED'?'':' · waiting for approval')+'</code>':(l.approved_at||l.state==='REVOKED'?'':' <code>computer · waiting for approval</code>')))+
        (l.on_user
          ? '<br><span class="pill s-LICENSED">'+esc(l.on_user)+' is signed in</span>'
          : '<br><span class="why">nobody signed in — this machine shows its sign-in screen</span>')+
        '<br><code>'+esc(String(l.device_id).slice(0,12))+'…</code>'+(l.device_name?' <code>'+esc(l.device_name)+'</code>':'')+
        /* 4.72.0 (audit 97) — not handed its own device key over yet */
        (l.key_held===false&&l.state!=='REVOKED'?' <code title="Hands its key over at its next heartbeat on Nexora 4.71.0 / Nexora Mobile 1.0.0 or later">no device key yet</code>':'')+'</td>'+
      '<td><span class="pill s-'+state+'">'+state.toLowerCase()+'</span></td>'+
      '<td>'+esc(l.email||'—')+'</td>'+
      '<td>'+(state==='EXPIRED'||state==='REVOKED'?'—':(l.days_left===0?'today':l.days_left))+'</td>'+
      '<td>'+fmt(l.trial_started_at)+'</td>'+
      '<td>'+fmt(l.last_seen_at)+'</td>'+
      '<td>'+esc(l.app_version||'—')+'</td>'+
      '<td><b>'+(+l.txn_count||0)+'</b>'+(l.usage_reset_at?'<br><code>reset '+fmt(l.usage_reset_at)+'</code>':'')+'</td>'+
      '<td>'+hoursText(l.usage_minutes)+'</td>'+
      '<td><div class="acts">'+
        (!l.approved_at&&l.state!=='REVOKED'?'<button class="small primary" data-device="'+esc(l.device_id)+'" data-action="approve" onclick="act(this)" title="'+(l.platform==='mobile'?'Let this phone sign in (Nexora Mobile)':'Let this computer onto its company (it joined with the key or passcode)')+'">Approve '+(l.platform==='mobile'?'phone':'computer')+'</button>':'')+
        '<button class="small" data-device="'+esc(l.device_id)+'" data-action="resetusage" onclick="act(this)">Reset usage</button>'+
        (l.state==='REVOKED'
          ?'<button class="small" data-device="'+esc(l.device_id)+'" data-action="restore" onclick="act(this)">Restore</button>'
          :'<button class="small danger" data-device="'+esc(l.device_id)+'" data-action="revoke" onclick="act(this)" title="Stops this machine. It frees no seat: seats are people">Revoke</button>')+
        '<button class="small danger" data-device="'+esc(l.device_id)+'" data-name="'+esc(l.co_name||l.company||l.device_name||l.device_id)+'" onclick="delInstall(this)" title="Remove this installation row altogether">Delete</button>'+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="10" class="help">Nothing here yet.</td></tr>';
}
async function delInstall(btn){
  if(!confirm('Delete the installation "'+btn.dataset.name+'"?\\n\\nThe row is removed altogether. If the machine is still in use it can join again (and waits for its company’s approval) — use Revoke to stop a machine, and this to tidy away one that is finished with.'))return;
  const r=await api('/admin/api/licence',{method:'POST',body:JSON.stringify({deviceId:btn.dataset.device,action:'delete'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">Installation deleted'+(r.orphan?' — it belonged to no company.':'.')+'</div>');
  await load();
}
async function act(btn){
  const deviceId=btn.dataset.device,action=btn.dataset.action;
  if(action==='revoke'&&!confirm('Revoke this installation?\\n\\nIt stops at its next check, and only this console can restore it. It frees no seat — seats are people. The company keeps running.'))return;
  if(action==='resetusage'&&!confirm('Start this machine\\'s transaction count and hours again from zero? Nothing saved is touched.'))return;
  const r=await api('/admin/api/licence',{method:'POST',body:JSON.stringify({deviceId,action,days:0})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function saveSettings(){
  await api('/admin/api/settings',{method:'POST',body:JSON.stringify({
    trialDays:+document.getElementById('sTrial').value,
    demoGraceDays:+document.getElementById('sGrace').value,
    sessionMinutes:+document.getElementById('sSession').value,
    expiredMode:document.getElementById('sMode').value,
    signupsOpen:document.getElementById('sOpen').checked,
    demoSignup:document.getElementById('sDemo').checked})});
  say('<div class="msg ok">Settings saved.</div>');
  await load();
}
try{const k=sessionStorage.getItem('nexora_admin_key');if(k){KEY=k;load();}}catch(e){}
</script></body></html>`;

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
import { cleanPlan, cleanPlanFeatures, cleanOverrides, PLAN_FEATURES } from './plans.js';
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
           c.feature_overrides,
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

/* 2026-10-08 — a plan the owner made that is not retired, by its code; null if there is none */
async function livePlan(v) {
  const s = await getSettings();
  const code = String(v || '').toUpperCase().trim();
  const p = (s.plans || []).find((x) => x.code === code);
  return p && p.active !== false ? p.code : null;
}

export async function companyAction(body) {
  const action = String(body.action || '');
  const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 365));

  /* CREATE is the only action without an id. Everything else names one. */
  if (action === 'create') {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'A company name is required.' };
    /* 4.48.0 — the plan. Seats are the owner's to set on either plan (4.48.1). 2026-10-08 — any plan the
       owner made and has not retired; anything else is Pro, as always. */
    const plan = await livePlan(body.plan) || 'PRO';
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
    const plan = await livePlan(body.plan);
    if (!plan) return { error: 'There is no plan ' + String(body.plan || '') + ', or it has been retired. Choose one under Software & plans.' };
    await q(`UPDATE companies SET plan = $2 WHERE id = $1`, [id, plan]);
    await logEvent(null, 'ADMIN_COMPANY_PLAN', { id, plan });
  } else if (action === 'features') {
    /* 2026-10-08 (owner: per customer "+ added / − off": "ha") — this company's own changes over its plan:
       { featureId: true (added) | false (off) | null (back to the plan) }. Its machines hear it at their next
       check, like a plan change; a demo keeps everything regardless. */
    const co = (await q(`SELECT feature_overrides FROM companies WHERE id = $1`, [id]))[0];
    if (!co) return { error: 'No such company.' };
    const was = cleanOverrides(co.feature_overrides);
    const now = Object.assign({}, was);
    const asked = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    if (body.reset === true) Object.keys(now).forEach((k) => { delete now[k]; });
    PLAN_FEATURES.forEach((f) => {
      if (!(f.id in asked)) return;
      if (asked[f.id] === true || asked[f.id] === false) now[f.id] = asked[f.id];
      else delete now[f.id];
    });
    const changed = PLAN_FEATURES.filter((f) => was[f.id] !== now[f.id]).map((f) => f.id + ': ' +
      (was[f.id] === undefined ? 'plan' : was[f.id] ? 'added' : 'off') + ' → ' + (now[f.id] === undefined ? 'plan' : now[f.id] ? 'added' : 'off'));
    await q(`UPDATE companies SET feature_overrides = $2 WHERE id = $1`, [id, Object.keys(now).length ? JSON.stringify(now) : null]);
    if (changed.length) await logEvent(null, 'ADMIN_COMPANY_FEATURES', { id, changed });
    return { ok: true, overrides: now };
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
  /* 4.72.0 (audit 39) — what the settings were, so the log can say what changed */
  const before = await getSettings();
  if (body.planFeatures !== undefined) {
    const m = cleanPlanFeatures(body.planFeatures);
    pairs.push(['plan_features', JSON.stringify(m)]);
    /* 2026-10-08 — and Standard and Pro among the owner's plans say the same (the phone console 1.9.0 and
       older still save this matrix) */
    pairs.push(['plans_weight', JSON.stringify((before.plans || []).map((p) => (m[p.code] ? Object.assign({}, p, { features: m[p.code] }) : p)))]);
  }
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
/* 2026-10-07 (console) — every Nexora software in the one console: each software its own colour (Fabric Stock green, as on the phone console) */
.pill.sw-weight{background:var(--k-blue-bg);color:var(--k-blue);border-color:color-mix(in srgb,var(--k-blue) 35%,transparent)}
.pill.sw-fabric{background:var(--k-green-bg);color:var(--k-green);border-color:color-mix(in srgb,var(--k-green) 35%,transparent)}
.sw-cap{display:flex;align-items:center;gap:8px;margin:12px 0 6px;font-size:12px;font-weight:800;letter-spacing:.02em}
.sw-cap::after{content:'';flex:1;height:1px;background:var(--border)}
.sw-cap.sw-weight{color:var(--k-blue)}.sw-cap.sw-fabric{color:var(--k-green)}
.co.fabric-only{box-shadow:var(--shadow-sm),inset 5px 0 0 var(--k-green)}
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
/* ==== 2026-10-08 — THE CONSOLE AS SOFTWARE ====================================================
   Owner: "console ne software jevu banavanu che row type details click and open window". The
   application's own frame: a menu bar, the modules down the left, a title and a hint, a toolbar of
   coloured buttons, a filter card with Quick buttons, figure cards, one table of rows — and a click on
   a row opens that record in a window of its own (Display first; Edit, Ctrl+W, to change it). */
body{margin:0}
#app{position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg)}
.pcontent>.sec{display:none}.pcontent>.sec.on{display:block}
.menubar{flex:0 0 34px;display:flex;align-items:center;gap:20px;padding:0 14px;background:var(--surface);border-bottom:1px solid var(--border);font-size:14px;position:relative;z-index:3}
.menubar .mt{position:absolute;left:0;right:0;text-align:center;font-weight:700;pointer-events:none}
.menubar .mi{cursor:pointer;color:var(--text)}
.menubar .mi:hover{color:var(--accent)}
.ak{color:var(--accent);font-weight:800}
.menubar .mode-switch{margin-left:auto}
.shell{flex:1;display:flex;min-height:0}
.side{flex:0 0 236px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:12px 10px;overflow-y:auto}
.side .sbrand{display:flex;align-items:center;gap:10px;padding:2px 8px 12px}
.side .sbrand img{width:36px;height:36px}
.side .sbrand b{display:block;font-size:15.5px;letter-spacing:.03em}.side .sbrand small{display:block;color:var(--muted);font-size:11.5px;line-height:1.3}
#jump.snav{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;background:none;border:0;position:static;box-shadow:none}
#jump.snav .tab{display:flex;align-items:center;gap:11px;width:100%;text-align:left;border:1px solid transparent;border-radius:12px;padding:8px 10px;background:none;color:var(--text);font-weight:650;font-size:13.5px;box-shadow:none;cursor:pointer}
#jump.snav .tab:hover{background:var(--surface-hover)}
#jump.snav .tab.active{background:var(--k-orange-bg);border-color:color-mix(in srgb,var(--k-orange) 30%,transparent);color:var(--text);box-shadow:none}
#jump.snav .tab .ic{flex:0 0 28px;height:28px;border-radius:9px;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:800}
#jump.snav .tab.sub{padding-left:22px;font-weight:600}#jump.snav .tab.sub .ic{flex-basis:24px;height:24px;border-radius:8px;font-size:11px}
#jump.snav .tab b{margin-left:auto;font-size:11.5px;background:var(--bg-sunken);color:var(--muted);border-radius:999px;padding:1px 8px}
#jump.snav .tab b.zero{opacity:.55}
#jump.snav .sgap{height:8px}
.side .sfoot{margin-top:auto;border-top:1px solid var(--border);padding-top:8px}
.side .sclock{padding:8px 10px 2px}.side .sclock small{display:block;color:var(--muted);font-size:11.5px}.side .sclock b{font-size:15px}
.side .sver{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:11px;padding:6px 10px}
.side .sver span:last-child{background:var(--bg-sunken);padding:2px 9px;border-radius:999px;font-weight:700;color:var(--text)}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.phead{display:flex;align-items:center;gap:14px;padding:9px 20px;background:var(--surface);border-bottom:2px solid color-mix(in srgb,var(--accent) 30%,var(--border))}
.phead .mn{width:28px;height:22px;border:1px solid var(--border);border-radius:6px;display:grid;place-items:center;font-size:12px;color:var(--muted)}
.phead h1{margin:0;font-size:17px;line-height:1.2}.phead small{display:block;color:var(--muted);font-size:11.5px}
.phead .hint{display:flex;gap:8px;align-items:center;border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border));border-radius:999px;padding:4px 13px;font-size:12px;color:var(--muted);white-space:nowrap}
.phead .hint i{font-style:normal;color:var(--accent);font-weight:800;font-size:10.5px;letter-spacing:.04em}.phead .hint b{color:var(--text)}
.tbar{display:flex;align-items:flex-end;gap:2px;padding:7px 16px 5px;background:var(--bg-elevated);border-bottom:1px solid var(--border);flex-wrap:wrap;min-height:58px}
.tbi{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:56px;padding:2px 4px;font-size:10.5px;font-weight:650;color:var(--text);background:none;border:0;cursor:pointer;border-radius:8px;box-shadow:none}
.tbi:hover{background:var(--surface-hover)}
.tbi .sq{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:800;box-shadow:0 2px 4px rgba(20,33,61,.15)}
.tbi[disabled]{color:var(--faint);cursor:default}.tbi[disabled] .sq{background:var(--bg-sunken)!important;color:var(--faint);box-shadow:none}
.tbi[disabled]:hover{background:none}
.tsep{width:1px;height:34px;background:var(--border);margin:0 6px 3px}
.pcontent{flex:1;overflow-y:auto;padding:16px 20px 30px}
.pcontent>.card{margin-bottom:14px}
.pcontent>.sec>.card,.pcontent .card{border-radius:16px}
/* filter card, quick row, figures, record table — the Records window's */
.fcard{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
.fcard label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:700;color:var(--muted)}
.fcard input,.fcard select{min-width:150px}
.quick{display:flex;gap:7px;align-items:center;margin-top:10px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.qb{border:1px solid var(--border);border-radius:8px;padding:4px 10px;font-weight:650;color:var(--text);background:var(--surface);cursor:pointer;font-size:12.5px}
.qb.on{border-color:var(--accent);color:var(--accent);background:var(--accentbg)}
.qb i{font-style:normal;color:var(--muted);margin-left:4px;font-weight:600}
.figs{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.fig{border-radius:13px;border:1px solid var(--border);border-top:3px solid var(--accent);padding:10px 16px;background:var(--surface)}
.fig span{font-weight:700;font-size:12.5px}.fig b{display:block;font-size:24px;margin-top:3px;line-height:1.15}.fig small{color:var(--muted);font-size:12px}
.fig.f1{border-top-color:var(--k-blue)}.fig.f1 span{color:var(--k-blue)}
.fig.f2{border-top-color:var(--k-green)}.fig.f2 span{color:var(--k-green)}
.fig.f3{border-top-color:var(--k-amber)}.fig.f3 span{color:var(--k-amber)}
.fig.f4{border-top-color:var(--k-violet)}.fig.f4 span{color:var(--k-violet)}
.ctitle{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
.ctitle h3{margin:0;font-size:14px}
table.rec{width:100%;border-collapse:collapse}
table.rec th{font-size:12px;color:var(--muted);font-weight:700;text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;text-transform:none}
table.rec td{padding:9px 10px;border-bottom:1px solid var(--bg-sunken);vertical-align:middle}
table.rec tbody tr{cursor:pointer}
table.rec tbody tr:hover td{background:var(--surface-hover)}
table.rec tbody tr.on td{background:var(--accentbg)}
table.rec td small{display:block;color:var(--muted);font-size:11.5px}
table.rec .num{text-align:right;white-space:nowrap}
table.rec tfoot td{font-weight:800;border-top:1px solid var(--border);border-bottom:0}
.c-ok{color:var(--k-green);font-weight:700}.c-demo{color:var(--k-teal);font-weight:700}.c-warn{color:var(--k-amber);font-weight:700}.c-bad{color:var(--k-red);font-weight:700}.c-none{color:var(--faint)}
.swd{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:1px}
.swd.w{background:var(--k-blue)}.swd.f{background:var(--k-green)}.swd.j{background:var(--k-orange)}
/* the toast every message comes in */
#coMsg.toast{position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:60;min-width:320px;max-width:760px}
#coMsg.toast:empty{display:none}
#coMsg.toast .msg{box-shadow:var(--shadow-lg);margin:0}
/* windows */
#winLayer:empty{display:none}
#winLayer{position:fixed;inset:34px 0 0 0;z-index:40;background:rgba(15,22,40,.36);display:flex;align-items:flex-start;justify-content:center;padding:22px 20px;overflow:auto}
.win{width:min(1240px,100%);background:var(--bg);border:1px solid var(--border-strong);border-radius:14px;box-shadow:0 24px 60px rgba(10,20,45,.35);display:flex;flex-direction:column;min-height:min(820px,calc(100vh - 80px))}
.win.small{width:min(900px,100%);min-height:0}
.wtitle{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--surface);border-bottom:2px solid color-mix(in srgb,var(--accent) 30%,var(--border));border-radius:14px 14px 0 0}
.wtitle .av{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:13px;background:linear-gradient(135deg,#5b7cfa,#7c5cf6)}
.wtitle h2{margin:0;font-size:16px}.wtitle small{display:block;color:var(--muted);font-size:11.5px}
.mode{border-radius:999px;padding:2px 10px;font-size:11px;font-weight:800;background:var(--bg-sunken);color:var(--muted);margin-left:8px;vertical-align:2px}
.mode.edit{background:var(--warnbg);color:var(--warn)}.mode.new{background:var(--accentbg);color:var(--accent)}
.wx{margin-left:auto;display:flex;gap:4px}
.wx button{width:32px;height:28px;border-radius:8px;border:0;background:none;color:var(--muted);font-size:16px;cursor:pointer;box-shadow:none;padding:0}
.wx button:hover{background:var(--badbg);color:var(--bad)}
.wbody{padding:14px 18px 18px;display:flex;flex-direction:column;gap:12px}
.fgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.fgrid.five{grid-template-columns:2fr 1.3fr 1.6fr 1.2fr 1fr}
.fl{display:flex;flex-direction:column;gap:5px;min-width:0}
.fl>span{font-size:12px;font-weight:700;color:var(--muted)}
.ro{background:var(--bg-sunken);border:1px solid var(--border);border-radius:9px;padding:7px 11px;min-height:35px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fl input,.fl select,.fl textarea{width:100%}
.swtabs{display:flex;gap:10px}
.swt{flex:1;display:flex;gap:11px;align-items:center;padding:10px 14px;border-radius:13px;border:1px solid var(--border);background:var(--surface);cursor:pointer;text-align:left;box-shadow:none;color:var(--text);font-weight:400}
.swt .b{flex:0 0 34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff;font-size:15px;font-weight:800}
.swt b{display:block;font-size:14px}.swt small{color:var(--muted);font-size:12px}
.swt.w .b{background:linear-gradient(135deg,#3366ff,#6a8cff)}.swt.f .b{background:linear-gradient(135deg,#10a37f,#2cc6b0)}.swt.j .b{background:linear-gradient(135deg,#f08a0c,#f7b538)}
.swt.on.w{background:linear-gradient(120deg,#3366ff,#6a8cff);color:#fff;border-color:transparent}
.swt.on.f{background:linear-gradient(120deg,#10a37f,#2cc6b0);color:#fff;border-color:transparent}
.swt.on small{color:rgba(255,255,255,.9)}.swt.on .b{background:rgba(255,255,255,.22)}
.swt.add{flex:0 0 190px;justify-content:center;border-style:dashed;color:var(--muted);font-weight:700}
.swt.soon{opacity:.55;cursor:default}
.subt{display:flex;gap:2px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.subt button{padding:8px 14px;font-weight:700;color:var(--muted);border:0;border-bottom:2.5px solid transparent;margin-bottom:-1px;background:none;border-radius:0;box-shadow:none;cursor:pointer}
.subt button.on{color:var(--text);border-bottom-color:var(--accent)}
.subt button small{color:var(--accent);margin-left:3px}
.feat{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
.fx{display:flex;align-items:center;gap:9px;border:1px solid var(--border);background:var(--surface);border-radius:10px;padding:7px 10px;text-align:left;color:var(--text);font-weight:500;box-shadow:none;font-size:13px}
button.fx{cursor:pointer}
button.fx:disabled{cursor:default;opacity:1}
.fx .cb{flex:0 0 17px;height:17px;border-radius:5px;border:1.5px solid var(--border-strong);display:grid;place-items:center;font-size:11px;color:#fff;font-weight:900}
.fx.on .cb{background:var(--accent);border-color:var(--accent)}
.fx .tg{margin-left:auto;font-size:11px;font-weight:800;white-space:nowrap}
.fx.plan .tg{color:var(--faint)}.fx.add{background:var(--accentbg);border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}.fx.add .tg{color:var(--accent)}
.fx.off{background:var(--badbg);border-color:color-mix(in srgb,var(--bad) 35%,var(--border))}.fx.off .tg{color:var(--bad)}.fx.off .nm{text-decoration:line-through;color:var(--muted)}
.fx.no .nm{color:var(--muted)}
.fgh{font-size:11.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:4px 0 6px}
.sumline{display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:13px}
.wfoot{display:flex;gap:10px;justify-content:flex-end;align-items:center}
.empty{padding:22px;text-align:center;color:var(--muted)}
.mini-tbl{width:100%;border-collapse:collapse}.mini-tbl th{font-size:12px;color:var(--muted);text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}.mini-tbl td{padding:7px 8px;border-bottom:1px solid var(--bg-sunken)}
@media (max-width:900px){.side{display:none}.figs{grid-template-columns:repeat(2,1fr)}.fgrid,.fgrid.five{grid-template-columns:1fr 1fr}.feat{grid-template-columns:1fr}.swtabs{flex-wrap:wrap}}
#jump.snav .sgroup{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;padding:4px 10px 2px}
#jump.snav .tab.soon{opacity:.55;cursor:default}#jump.snav .tab.soon:hover{background:none}
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
    <!-- 2026-10-08 — THE CONSOLE AS SOFTWARE (owner: "console ne software jevu banavanu che row type details
         click and open window"): the menu bar, the modules down the left, a title and a hint, the toolbar. -->
    <div class="menubar">
      <span class="mi" data-sec="sec-dashboard" onclick="showSec(this.dataset.sec)"><b class="ak">F</b>ile</span>
      <span class="mi" onclick="refreshNow()"><b class="ak">V</b>iew</span>
      <span class="mi" data-sec="sec-companies" onclick="showSec(this.dataset.sec)"><b class="ak">C</b>ustomers</span>
      <span class="mi" data-sec="sec-plans" onclick="showSec(this.dataset.sec)"><b class="ak">S</b>oftware</span>
      <span class="mi" data-sec="settings" onclick="showSec(this.dataset.sec)"><b class="ak">T</b>ools</span>
      <span class="mi" data-sec="sec-activity" onclick="showSec(this.dataset.sec)"><b class="ak">H</b>elp</span>
      <span class="mt">Nexora Console</span>
      <button class="mode-switch" id="mode-switch" role="switch" aria-checked="false" onclick="flipMode()" title="Light — click for dark">
        <span class="mode-mark mode-sun">☀</span><span class="mode-mark mode-moon">☾</span>
        <span class="mode-knob">☀</span></button>
    </div>
    <div class="shell">
      <aside class="side">
        <div class="sbrand"><img src="/logo.png" alt="Nexora" width="36" height="36"><div><b>NEXORA</b><small id="sub">Licence console</small></div></div>
        <nav id="jump" class="snav">
          <button class="tab" data-sec="sec-dashboard" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#4f7cff,#7aa2ff)">▦</span>Dashboard</button>
          <button class="tab" data-sec="sec-companies" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#f08a0c,#f7b538)">C</span>Customers <b id="jump-co">–</b></button>
          <button class="tab sub" data-sec="sec-validity" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#e2457a,#f47aa0)">⟳</span>Validity <b id="jump-val">–</b></button>
          <button class="tab sub" data-sec="sec-payments" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#15803d,#34d399)">₹</span>Payments <b id="jump-pay">–</b></button>
          <div class="sgroup">By software</div>
          <button class="tab sub" data-sec="sec-sw-weight" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#3366ff,#6a8cff)">⚖</span>Sales &amp; Costing <b id="jump-sw-weight">–</b></button>
          <button class="tab sub" data-sec="sec-sw-fabric" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#10a37f,#2cc6b0)">▤</span>Fabric Stock <b id="jump-sw-fabric">–</b></button>
          <div class="tab sub soon" title="Jobwork joins when it has a licence of its own"><span class="ic" style="background:linear-gradient(135deg,#f08a0c,#f7b538)">⚙</span>Jobwork <b>soon</b></div>
          <div class="sgap"></div>
          <button class="tab" data-sec="sec-plans" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#6d3ff5,#a78bfa)">◫</span>Software &amp; plans <b id="jump-plans">–</b></button>
          <div class="sgap"></div>
          <button class="tab" data-sec="sec-inquiries" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#db2777,#f472b6)">✉</span>Enquiries <b id="jump-q">–</b></button>
          <button class="tab" data-sec="sec-feedback" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#eab308,#f6cf4a)">!</span>Feedback <b id="jump-fb">–</b></button>
          <button class="tab" data-sec="sec-broadcast" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#0ea5e9,#5cc8f5)">✎</span>Message plants</button>
          <button class="tab" data-sec="sec-installations" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#d9730d,#fb923c)">▭</span>Installations <b id="jump-inst">–</b></button>
          <button class="tab" data-sec="appcard" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#0d9488,#2dd4bf)">▯</span>Phone app</button>
          <button class="tab" data-sec="sec-activity" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#475569,#94a3b8)">◷</span>Activity</button>
          <div class="sfoot">
            <button class="tab" data-sec="settings" onclick="showSec(this.dataset.sec)"><span class="ic" style="background:linear-gradient(135deg,#475569,#94a3b8)">⚙</span>Service settings</button>
            <button class="tab" onclick="signOut()" title="Forget the key in this browser tab"><span class="ic" style="background:linear-gradient(135deg,#dc2626,#f87171)">⏻</span>Sign out</button>
            <div class="sclock"><small id="sDate"></small><b id="sTime"></b></div>
            <div class="sver"><span>CONSOLE</span><span>v2.0</span></div>
          </div>
        </nav>
      </aside>
      <main class="main">
        <div class="phead"><span class="mn">–</span><div><h1 id="ptitle">Customers</h1><small id="psub"></small></div><span style="flex:1"></span>
          <span class="sub" id="refreshed" style="font-size:12px"></span><span class="hint" id="phint"></span></div>
        <div class="tbar" id="tbar"></div>
        <div class="pcontent">
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

    <!-- 2026-10-08 — DASHBOARD: the figures, the renewals coming, the money in -->
    <div id="sec-dashboard">
      <div class="card"><div class="kpis" id="kpi"></div></div>
      <div class="card"><div class="ctitle"><h3>By software</h3><span class="sub" id="dashNote"></span></div><div class="figs" id="dashSoft"></div></div>
      <div class="card"><div class="ctitle"><h3>Ending within 30 days</h3><button class="small" data-sec="sec-validity" onclick="showSec(this.dataset.sec)">All validity</button></div><div id="dashEnding"></div></div>
      <div class="card"><div class="ctitle"><h3>Latest payments</h3><button class="small" data-sec="sec-payments" onclick="showSec(this.dataset.sec)">All payments</button></div><div id="dashPay"></div></div>
    </div>

    <!-- 2026-10-08 — CUSTOMERS: one row per customer, each software in its own column; a click opens the customer -->
    <div id="sec-companies">
      <div class="card">
        <div class="fcard">
          <label>Search<input id="cq" placeholder="Customer, GSTIN, key, phone, email…" oninput="renderCompanies()" style="min-width:260px"></label>
          <label>Software<select id="cSoft" onchange="renderCompanies()"><option value="">Any software</option><option value="weight">Sales & Costing</option><option value="fabric">Fabric Stock</option><option value="both">Both</option></select></label>
          <label>Plan<select id="cPlan" onchange="renderCompanies()"><option value="">Any plan</option></select></label>
          <label>State<select id="cState" onchange="renderCompanies()"><option value="">Any state</option><option value="LICENSED">Licensed</option><option value="DEMO">Demo</option><option value="EXPIRED">Ended</option><option value="SUSPENDED">Suspended</option></select></label>
          <label>Renews from<input id="cFrom" type="date" onchange="renderCompanies()"></label>
          <label>To<input id="cTo" type="date" onchange="renderCompanies()"></label>
          <button onclick="clearCustomerFilter()">Clear</button>
        </div>
        <div class="quick" id="cQuick"></div>
      </div>
      <div class="card"><div class="ctitle"><h3 id="cCount">Customers</h3><span class="sub" id="cNote"></span></div><div class="figs" id="cFigs"></div></div>
      <div class="card"><div class="ctitle"><h3 id="cListTitle">Every customer</h3><span class="sub">Click a row to open it</span></div><div id="colist" style="overflow-x:auto"></div>
        <div class="legend" style="margin-top:12px"><div><b>Suspend</b>stops every computer and phone of that software at its next check. Nothing is deleted; Restore puts it all back.</div><div><b>Revoke</b>(one computer or phone, under Computers &amp; phones) stops that one machine. It frees no seat — seats are people — and the company keeps running.</div><div><b>Delete</b>(Sales &amp; Costing, under More) stops the company at once and keeps it for 30 days with everything it had — Restore under Deleted puts it back exactly as it was. After 30 days it is erased for good. The name must be typed to confirm.</div><div><b>Each software</b>has its own licence: its own key, plan, period, seats, people and rights; renewing, suspending or restoring one never touches the other.</div></div></div>
    </div>

    <!-- 2026-10-08 — VALIDITY & RENEWALS (owner: "kayo plan expire thay che"): one row per software per customer -->
    <div id="sec-validity">
      <div class="card">
        <div class="fcard">
          <label>Search<input id="vq" placeholder="Customer, GSTIN…" oninput="renderValidity()" style="min-width:240px"></label>
          <label>Software<select id="vSoft" onchange="renderValidity()"><option value="">Any software</option><option value="weight">Sales & Costing</option><option value="fabric">Fabric Stock</option></select></label>
          <label>Ends from<input id="vFrom" type="date" onchange="renderValidity()"></label>
          <label>To<input id="vTo" type="date" onchange="renderValidity()"></label>
          <button onclick="clearValidityFilter()">Clear</button>
        </div>
        <div class="quick" id="vQuick"></div>
      </div>
      <div class="card"><div class="ctitle"><h3 id="vCount">Validity</h3><span class="sub">Ending first</span></div><div class="figs" id="vFigs"></div></div>
      <div class="card"><div class="ctitle"><h3>Every licence</h3><span class="sub">Click a row to open the customer</span></div><div id="vlist" style="overflow-x:auto"></div></div>
    </div>

    <!-- 2026-10-08 — PAYMENTS (owner: "payment kyare aavyu kya plan nu"): the owner's ledger -->
    <div id="sec-payments">
      <div class="card">
        <div class="fcard">
          <label>Search<input id="pq" placeholder="Customer, reference, note…" oninput="renderPayments()" style="min-width:240px"></label>
          <label>Software<select id="pSoft" onchange="renderPayments()"><option value="">Any software</option><option value="weight">Sales & Costing</option><option value="fabric">Fabric Stock</option></select></label>
          <label>Kind<select id="pKind" onchange="renderPayments()"><option value="">Any</option><option value="NEW">New customer</option><option value="RENEWAL">Renewal</option><option value="EXTRA_USERS">Extra users</option><option value="UPGRADE">Plan upgrade</option><option value="OTHER">Other</option></select></label>
          <label>From<input id="pFrom" type="date" onchange="renderPayments()"></label>
          <label>To<input id="pTo" type="date" onchange="renderPayments()"></label>
          <button onclick="clearPaymentFilter()">Clear</button>
        </div>
        <div class="quick" id="pQuick"></div>
      </div>
      <div class="card"><div class="ctitle"><h3 id="pCount">Payments</h3><span class="sub" id="pNote"></span></div><div class="figs" id="pFigs"></div></div>
      <div class="card"><div class="ctitle"><h3>Every payment</h3><span class="sub">Click a row to open it</span></div><div id="plist" style="overflow-x:auto"></div></div>
    </div>

    <!-- 2026-10-08 — BY SOFTWARE (owner: "by customer pan joi sakay ane by software wise pan joi sakay"): Sales &amp; Costing alone -->
    <div id="sec-sw-weight">
      <div class="card">
        <div class="fcard">
          <label>Search<input id="sw-q-weight" placeholder="Customer, GSTIN, key…" data-sw="weight" oninput="renderSoftware(this.dataset.sw)" style="min-width:240px"></label>
          <label>Plan<select id="sw-plan-weight" data-sw="weight" onchange="renderSoftware(this.dataset.sw)"><option value="">Any plan</option></select></label>
          <label>State<select id="sw-state-weight" data-sw="weight" onchange="renderSoftware(this.dataset.sw)"><option value="">Any state</option><option value="LICENSED">Licensed</option><option value="DEMO">Demo</option><option value="EXPIRED">Ended</option><option value="SUSPENDED">Suspended</option></select></label>
          <label>Ends from<input id="sw-from-weight" type="date" data-sw="weight" onchange="renderSoftware(this.dataset.sw)"></label>
          <label>To<input id="sw-to-weight" type="date" data-sw="weight" onchange="renderSoftware(this.dataset.sw)"></label>
          <button data-sw="weight" onclick="clearSoftwareFilter(this.dataset.sw)">Clear</button>
        </div>
        <div class="quick" id="sw-quick-weight"></div>
      </div>
      <div class="card"><div class="ctitle"><h3 id="sw-count-weight">Sales &amp; Costing</h3><span class="sub" id="sw-note-weight"></span></div><div class="figs" id="sw-figs-weight"></div></div>
      <div class="card"><div class="subt" id="sw-tabs-weight" style="margin-bottom:12px"></div><div id="sw-list-weight" style="overflow-x:auto"></div></div>
    </div>

    <!-- 2026-10-08 — BY SOFTWARE (owner: "by customer pan joi sakay ane by software wise pan joi sakay"): Fabric Stock alone -->
    <div id="sec-sw-fabric">
      <div class="card">
        <div class="fcard">
          <label>Search<input id="sw-q-fabric" placeholder="Customer, GSTIN, key…" data-sw="fabric" oninput="renderSoftware(this.dataset.sw)" style="min-width:240px"></label>
          <label>Plan<select id="sw-plan-fabric" data-sw="fabric" onchange="renderSoftware(this.dataset.sw)"><option value="">Any plan</option></select></label>
          <label>State<select id="sw-state-fabric" data-sw="fabric" onchange="renderSoftware(this.dataset.sw)"><option value="">Any state</option><option value="LICENSED">Licensed</option><option value="DEMO">Demo</option><option value="EXPIRED">Ended</option><option value="SUSPENDED">Suspended</option></select></label>
          <label>Ends from<input id="sw-from-fabric" type="date" data-sw="fabric" onchange="renderSoftware(this.dataset.sw)"></label>
          <label>To<input id="sw-to-fabric" type="date" data-sw="fabric" onchange="renderSoftware(this.dataset.sw)"></label>
          <button data-sw="fabric" onclick="clearSoftwareFilter(this.dataset.sw)">Clear</button>
        </div>
        <div class="quick" id="sw-quick-fabric"></div>
      </div>
      <div class="card"><div class="ctitle"><h3 id="sw-count-fabric">Fabric Stock</h3><span class="sub" id="sw-note-fabric"></span></div><div class="figs" id="sw-figs-fabric"></div></div>
      <div class="card"><div class="subt" id="sw-tabs-fabric" style="margin-bottom:12px"></div><div id="sw-list-fabric" style="overflow-x:auto"></div></div>
    </div>

    <!-- 2026-10-08 — SOFTWARE & PLANS (owner: "plan pan hu create kri saku darek software wise", "price open rakho") -->
    <div id="sec-plans">
      <div class="card">
        <div class="fcard">
          <label>Software<select id="plSoft" onchange="renderPlanList()"><option value="">Every software</option><option value="weight">Sales & Costing</option><option value="fabric">Fabric Stock</option></select></label>
          <label>Search<input id="plq" placeholder="Plan or feature…" oninput="renderPlanList()" style="min-width:240px"></label>
          <button onclick="clearPlanFilter()">Clear</button>
        </div>
        <div class="quick"><span>Quick:</span><span class="qb" data-sw="weight" onclick="plQuick(this.dataset.sw)">Sales &amp; Costing</span><span class="qb" data-sw="fabric" onclick="plQuick(this.dataset.sw)">Fabric Stock</span><span class="qb" data-sw="weight" onclick="openPlan(this.dataset.sw,null)">+ New Sales &amp; Costing plan</span><span class="qb" data-sw="fabric" onclick="openPlan(this.dataset.sw,null)">+ New Fabric Stock plan</span></div>
      </div>
      <div class="card"><div class="ctitle"><h3 id="plCount">Plans</h3><span class="sub">Each software has its own plans and its own features — never mixed</span></div><div class="figs" id="plFigs"></div></div>
      <div class="card"><div class="ctitle"><h3>Every plan</h3><span class="sub">Click a row to open it — its price, users and features</span></div><div id="pllist" style="overflow-x:auto"></div>
        <p class="help" style="margin-top:10px">A price left empty is not set yet. Prices are for this console and the renewals; a plan’s ticks decide what the application lets the plant do, at its next check. A demo has every feature, whatever its plan. A customer’s own changes (on the customer, Features) lie over the plan.</p></div>
      <table id="plantbl" style="display:none"><tbody></tbody></table>
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
      </main>
    </div>
    <div id="coMsg" class="toast"></div>
    <div id="winLayer"></div>
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
    /* 2026-10-08 — every software’s plans, and the payments, before the slower calls */
    loadPlans();
    loadPayments();
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
const SECS=['sec-dashboard','sec-companies','sec-validity','sec-payments','sec-sw-weight','sec-sw-fabric','sec-plans','sec-inquiries','sec-feedback','sec-broadcast','sec-installations','appcard','sec-activity','settings'];
function showSec(id){
  if(SECS.indexOf(id)<0)id='sec-companies';
  SECS.forEach(s=>{const n=document.getElementById(s);if(!n)return;n.classList.add('sec');n.classList.toggle('on',s===id);if(s===id)n.style.display='';});
  document.querySelectorAll('#jump .tab').forEach(t=>t.classList.toggle('active',t.dataset.sec===id));
  /* 2026-10-08 — the title, the hint and the toolbar of this screen */
  shellFor(id);
  const pc=document.querySelector('.pcontent');if(pc)pc.scrollTop=0;
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
const ACT_WORDS={ADMIN_PLAN_CREATE:'Plan made',ADMIN_PLAN_UPDATE:'Plan changed',ADMIN_PLAN_RETIRE:'Plan retired',ADMIN_PLAN_RESTORE:'Plan in use again',ADMIN_PLAN_DELETE:'Plan deleted',
  ADMIN_COMPANY_FEATURES:'Features changed for one customer',ADMIN_PAYMENT_ADD:'Payment recorded',ADMIN_PAYMENT_UPDATE:'Payment corrected',ADMIN_PAYMENT_DELETE:'Payment deleted',
  ADMIN_FABRIC_CREATE:'Fabric Stock: company made',ADMIN_FABRIC_UPDATE:'Fabric Stock: licence changed',ADMIN_FABRIC_SUSPEND:'Fabric Stock: suspended',
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
/* Fabric Stock's companies with no Sales & Costing company of their own (a second one on the same company is listed too) */
function fabricOnly(){
  const ids=new Set(((DATA&&DATA.companies)||[]).map(c=>String(c.id)));
  return fabricAll().filter(f=>f.companyId==null||!ids.has(String(f.companyId))||fabricOf(f.companyId)!==f);
}
function fsWord(f){return f.shownState==='DEMO'?'demo':String(f.shownState||'').toLowerCase();}
function fsColour(f){return f.shownState==='LICENSED'?'var(--k-green)':f.shownState==='DEMO'?'var(--k-teal)':f.shownState==='EXPIRED'?'var(--k-amber)':'var(--k-red)';}
function fsDays(f){return f.shownState==='EXPIRED'||f.shownState==='SUSPENDED'?'since '+fmt(f.expiresAt):(f.daysLeft===0?'ends today':f.daysLeft+' day'+(f.daysLeft===1?'':'s'));}
function swPills(c){
  const f=fabricOf(c.id);
  return '<span class="pill sw-weight" title="Nexora Bag Weight Calculation">Sales & Costing</span> '+
    (f?'<span class="pill sw-fabric" title="Nexora Loom &amp; Fabric Stock — its own licence">Fabric Stock · '+esc(fsWord(f))+' · '+esc(fsDays(f))+'</span> ':'');
}
/* when Fabric Stock cannot be reached, the Sales & Costing list is shown all the same, with this above it */
function fabricNote(){
  const p=fabricProduct();
  if(!p)return COVIEW==='fabric'?'<p class="help">Reading Fabric Stock…</p>':'';
  if(p.ok)return '';
  return '<div class="sw-off"><b style="color:var(--k-green)">Fabric Stock is not connected.</b> '+esc(p.message||'')+' <button class="small" onclick="loadProducts()">Try again</button></div>';
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
      '<span class="why" style="flex-basis:100%">'+esc(c.name)+' does not use Fabric Stock yet. It gets a licence of its own: starting it changes nothing in Sales & Costing.</span>'+
      '<button class="primary" data-wc="'+c.id+'" data-state="DEMO" onclick="fsStart(this)">Start a 7-day demo</button>'+
      '<button data-wc="'+c.id+'" data-state="LICENSED" onclick="fsStart(this)">Make licensed for 1 year</button>'+
      (loose.length?'<select id="fslink-'+c.id+'"><option value="">Link an existing Fabric Stock company…</option>'+loose.map(x=>'<option value="'+x.id+'">'+esc(x.name)+(x.gstin?' · '+esc(x.gstin):'')+'</option>').join('')+'</select><button data-wc="'+c.id+'" onclick="fsLinkPick(this)">Link</button>':'')+
    '</div></div>';
  }
  const id=f.id, d=FDETAIL[id];
  return '<div class="group"><h4>Licence</h4><div class="acts">'+
      (f.isDemo?'<button class="primary" data-fid="'+id+'" onclick="fsLicense(this)">Make licensed for 1 year</button><span class="why">turns this demo into a paying customer</span>':'')+
      '<button data-fid="'+id+'" onclick="fsRenew(this)">Add days…</button>'+
      '<button data-fid="'+id+'" data-days="365" onclick="fsRenew(this)">+1 year</button><span class="why">added to the days still left; one that has ended starts again from today</span>'+
    '</div></div>'+
    '<div class="group"><h4>Machines</h4><div class="acts">'+
      '<button data-fid="'+id+'" data-now="'+(+f.seats||1)+'" onclick="fsSeats(this)">Seats…</button><span class="why">how many people may sign in to Fabric Stock</span>'+
      '<button data-fid="'+id+'" data-now="'+(+f.graceDays||0)+'" onclick="fsGrace(this)">Offline days…</button>'+
      '<div id="fsdev-'+id+'" class="users-panel">'+(d&&!d.error?fsDevicesHtml(d.devices||[]):'<p class="help">Reading…</p>')+'</div>'+
    '</div></div>'+
    '<div class="group"><h4>People</h4><div class="acts">'+
      '<button data-fid="'+id+'" data-name="'+esc(f.name)+'" onclick="fsAdmin(this)">Set administrator…</button><span class="why">the administrator adds everyone else and gives their rights inside Fabric Stock, apart from Sales & Costing</span>'+
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
        :'<button class="danger" data-fid="'+id+'" data-action="suspend" onclick="fsStop(this)">Suspend</button><span class="why">every Fabric Stock computer and phone stops at its next check; nothing is deleted, and Sales & Costing is not touched</span>')+
    '</div></div>';
}
function linkSelect(f){
  const cos=(DATA&&DATA.companies)||[];
  if(!cos.length)return '<span class="why">No Sales & Costing company to link it to.</span>';
  return '<select id="fswc-'+f.id+'"><option value="">Link to a Sales & Costing company…</option>'+cos.map(c=>'<option value="'+c.id+'">'+esc(c.name)+(c.gstin?' · '+esc(c.gstin):'')+'</option>').join('')+'</select>'+
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
  if(!confirm((demo?'Start a 7-day Fabric Stock demo':'Make a licensed Fabric Stock company for 1 year')+' for '+c.name+'?  It gets a Fabric Stock licence key of its own; Sales & Costing is not touched.'))return;
  const r=await fsCall({action:'create',name:c.name,state:demo?'DEMO':'LICENSED',days:demo?7:365,seats:3,gstin:c.gstin||undefined,email:c.email||undefined,phone:c.phone||undefined,linkTo:c.id});
  if(r&&r.company)say('<div class="msg ok"><b>'+esc(c.name)+'</b> now has Fabric Stock. Its Fabric Stock licence key is <span class="key">'+esc(r.company.licenceKey)+'</span> — for Fabric Stock only.</div>');
}
async function fsLicense(btn){
  if(!confirm('Make '+fsName(btn.dataset.fid)+' a licensed Fabric Stock customer for 1 year from today?'))return;
  await fsCall({action:'update',id:+btn.dataset.fid,state:'LICENSED',days:365},'Fabric Stock licensed for 1 year.');
}
/* Fabric Stock sets a new period FROM TODAY; to ADD days, as Sales & Costing's buttons do, the days still left go
   with them (an ended licence starts again from today) — the same as the phone console 1.9.0 */
async function fsRenew(btn){
  const f=fabricAll().find(x=>String(x.id)===String(btn.dataset.fid));if(!f)return;
  let add=+btn.dataset.days||0;
  if(!add){
    const v=prompt('Add how many days to Fabric Stock at '+f.name+'?','30');
    if(v===null)return;
    add=parseInt(v,10);
    if(!(add>0)){say('<div class="msg err">Enter a number of days.</div>');return;}
  }else if(!confirm('Add '+add+' days to Fabric Stock at '+f.name+'?'))return;
  const left=(f.expired||f.shownState==='EXPIRED')?0:(+f.daysLeft||0);
  await fsCall({action:'update',id:f.id,days:left+add},'Fabric Stock now runs '+(left+add)+' days from today'+(left?' ('+left+' left + '+add+')':'')+'.');
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
  if(stop&&!confirm('Suspend Fabric Stock for '+fsName(btn.dataset.fid)+'?  EVERY Fabric Stock computer and phone stops at its next check. Nothing is deleted, and Sales & Costing is not touched; Restore puts it back.'))return;
  await fsCall({action:btn.dataset.action,id:+btn.dataset.fid},stop?'Fabric Stock suspended.':'Fabric Stock restored.');
}
async function fsLink(btn){
  const apart=btn.dataset.action==='apart';
  if(!confirm(apart?'These are two different companies, although the GSTIN is the same?  Fabric Stock is then listed on its own.':'Unlink?  It is then shown with whichever company has the same GSTIN, or on its own.'))return;
  await fsCall({action:btn.dataset.action,id:+btn.dataset.fid},apart?'Kept apart.':'Unlinked.');
}
async function fsLinkTo(btn){
  const sel=document.getElementById('fswc-'+btn.dataset.fid);const to=sel&&sel.value;
  if(!to){say('<div class="msg err">Choose the Sales & Costing company first.</div>');return;}
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
/* ==================================================================================================
   2026-10-08 — THE CONSOLE AS SOFTWARE. Owner: "console ne software jevu banavanu che row type details
   click and open window", one console for every software ("darek na plan pan alag … aena software wise
   features"), plans the owner makes ("plan pan hu create kri saku darek software wise", "price open rakho"),
   a customer's own changes over a plan ("ha"), and the record of payments and validity ("customer ni
   validity payment kyare aavyu kya plan nu kayo plan expire thay che aena record").
   Every list is a filter card, figures and one table of rows; a row opens its record in a window, read-only
   until Edit (Ctrl+E here — Ctrl+W closes a browser tab). The older company actions (coAct, coDays,
   coUsers, fsRenew, …) are used as they were, from the window's toolbar.
   ================================================================================================== */
let COVIEW='all';  /* read by fabricNote(), from the older card list */
let PLANDATA=null, PAYDATA=null, WIN=null, CQUICK='all', VQUICK='all', PQUICK='all', CLIST=[], VLIST=[], PLIST=[], PLLIST=[], SELKEY={};
const NL=String.fromCharCode(13,10);
const C_={back:'linear-gradient(135deg,#475569,#64748b)',green:'linear-gradient(135deg,#10b981,#34d399)',blue:'linear-gradient(135deg,#2563eb,#60a5fa)',
  orange:'linear-gradient(135deg,#f97316,#fb923c)',amber:'linear-gradient(135deg,#f59e0b,#fbbf24)',lime:'linear-gradient(135deg,#65a30d,#84cc16)',
  violet:'linear-gradient(135deg,#6d28d9,#8b5cf6)',pink:'linear-gradient(135deg,#db2777,#f472b6)',red:'linear-gradient(135deg,#dc2626,#f87171)',
  slate:'linear-gradient(135deg,#475569,#94a3b8)',teal:'linear-gradient(135deg,#0d9488,#2dd4bf)'};
const SEC_INFO={
  'sec-dashboard':['Dashboard','Every Nexora software at a glance','Dashboard','Click a figure or a row','to open it.'],
  'sec-companies':['Customers','Every plant, with each Nexora software it uses — each software its own licence','Customers','Click a row to open it','Esc closes, Ctrl+E edits.'],
  'sec-validity':['Validity & renewals','Every licence of every software — the one ending first at the top','Validity','Which plan ends when','click a row for its customer.'],
  'sec-payments':['Payments','What each customer paid, for which software and plan, and the validity it bought','Payments','Record payment','can renew the licence in the same step.'],
  'sec-sw-weight':['Sales & Costing','Nexora Bag Weight Calculation — its customers, its plans and its payments','Sales & Costing','Click a row','for the customer, on this software.'],
  'sec-sw-fabric':['Fabric Stock','Nexora Loom & Fabric Stock — its customers, its plans and its payments','Fabric Stock','Click a row','for the customer, on this software.'],
  'sec-plans':['Software & plans','Each software has its own plans and its own features — never mixed','Software & plans','New plan','is one click; a price can stay open.'],
  'sec-inquiries':['Enquiries','The leads, before they are customers','Enquiries','',''],
  'sec-feedback':['Feedback & problems','Reports and screenshots sent from the application','Feedback','',''],
  'sec-broadcast':['Message plants','A message in every plant’s company chat','Message plants','',''],
  'sec-installations':['Installations','Every computer and phone of every Sales & Costing company','Installations','',''],
  'appcard':['Phone app','The phone console’s own releases','Phone app','',''],
  'sec-activity':['Activity','What was done from this console and the phone console, newest first','Activity','Read-only',''],
  'settings':['Service settings','They apply to every installation from its next check','Settings','','']
};
const SEC_TOOLS={
  'sec-dashboard':[['Refresh','↻',C_.green,'refresh'],'|',['New customer','+',C_.green,'newCustomer'],['Record payment','₹',C_.teal,'newPayment'],['New plan','◫',C_.violet,'newPlan']],
  'sec-companies':[['New','+',C_.green,'newCustomer'],['Open','▭',C_.blue,'openSel'],'|',['Record payment','₹',C_.teal,'newPayment'],'|',['Excel','▦',C_.lime,'csvCustomers'],['Print','⎙',C_.slate,'print'],'|',['Refresh','↻',C_.green,'refresh']],
  'sec-validity':[['Open','▭',C_.blue,'openSel'],['Record payment','₹',C_.teal,'newPayment'],'|',['Excel','▦',C_.lime,'csvValidity'],['Print','⎙',C_.slate,'print'],'|',['Refresh','↻',C_.green,'refresh']],
  'sec-payments':[['Record payment','₹',C_.green,'newPayment'],['Open','▭',C_.blue,'openSel'],'|',['Excel','▦',C_.lime,'csvPayments'],['Print','⎙',C_.slate,'print'],'|',['Refresh','↻',C_.green,'refresh']],
  'sec-sw-weight':[['New customer','+',C_.green,'swNew'],['Open','▭',C_.blue,'openSel'],'|',['Record payment','₹',C_.teal,'swPay'],['New plan','◫',C_.violet,'swPlan'],'|',['Excel','▦',C_.lime,'swCsv'],['Print','⎙',C_.slate,'print'],'|',['Refresh','↻',C_.green,'refresh']],
  'sec-sw-fabric':[['New customer','+',C_.green,'swNew'],['Open','▭',C_.blue,'openSel'],'|',['Record payment','₹',C_.teal,'swPay'],['New plan','◫',C_.violet,'swPlan'],'|',['Excel','▦',C_.lime,'swCsv'],['Print','⎙',C_.slate,'print'],'|',['Refresh','↻',C_.green,'refresh']],
  'sec-plans':[['New plan','+',C_.green,'newPlan'],['Open','▭',C_.blue,'openSel'],'|',['Print','⎙',C_.slate,'print'],'|',['Refresh','↻',C_.green,'refresh']],
  def:[['Refresh','↻',C_.green,'refresh'],['Print','⎙',C_.slate,'print']]
};
function tbHtml(items,attr){return items.filter(Boolean).map(x=>x==='|'?'<span class="tsep"></span>':'<button class="tbi" '+(attr||'data-tool')+'="'+x[3]+'"'+(x[4]?' disabled':'')+' title="'+esc(x[0])+'"><span class="sq" style="background:'+x[2]+'">'+x[1]+'</span>'+esc(x[0])+'</button>').join('');}
function shellFor(id){
  const i=SEC_INFO[id]||[id,'','','',''];
  const t=document.getElementById('ptitle');if(!t)return;
  t.textContent=i[0];document.getElementById('psub').textContent=i[1];
  document.getElementById('phint').innerHTML=i[2]?'<i>'+esc(i[2])+'</i><b>'+esc(i[3])+'</b>'+esc(i[4]):'';
  document.getElementById('phint').style.display=i[2]?'':'none';
  document.getElementById('tbar').innerHTML=tbHtml(SEC_TOOLS[id]||SEC_TOOLS.def);
  if(id==='sec-dashboard')renderDashboard();
  if(id==='sec-validity')renderValidity();
  if(id==='sec-payments')renderPayments();
  if(id==='sec-plans')renderPlanList();
  if(id.indexOf('sec-sw-')===0)renderSoftware(id.slice(7));
}
function curSw(){const s=curSec();return s==='sec-sw-fabric'?'fabric':'weight';}
function curSec(){const a=document.querySelector('#jump .tab.active');return a?a.dataset.sec:'sec-companies';}
document.addEventListener('click',e=>{
  const t=e.target.closest&&e.target.closest('[data-tool]');
  if(t&&!t.disabled){runTool(t.dataset.tool);return;}
  const w=e.target.closest&&e.target.closest('[data-wtool]');
  if(w&&!w.disabled){winTool(w.dataset.wtool);return;}
  const r=e.target.closest&&e.target.closest('tr[data-open]');
  if(r){const k=r.dataset.open;r.parentNode.querySelectorAll('tr.on').forEach(x=>x.classList.remove('on'));r.classList.add('on');SELKEY[curSec()]=k;openRow(k);}
});
function openRow(k){
  const p=k.split(':');
  if(p[0]==='c')openCustomer(p[1],p[2]||'',p[3]||'');
  else if(p[0]==='p')openPayment(+p[1]);
  else if(p[0]==='pl')openPlan(p[1],p[2]);
}
function runTool(k){
  if(k==='refresh')return refreshNow();
  if(k==='print')return window.print();
  if(k==='newCustomer')return openNewCustomer();
  if(k==='newPayment')return openPayment(0,WIN&&WIN.type==='cust'?presetFromWin():null);
  if(k==='newPlan')return openPlan(document.getElementById('plSoft')&&document.getElementById('plSoft').value||'weight','');
  if(k==='openSel'){const s=SELKEY[curSec()];if(s)openRow(s);else say('<div class="msg warn">Click a row first.</div>');return;}
  if(k==='swNew')return openNewCustomer(curSw());
  if(k==='swPay')return openPayment(0,{software:curSw()});
  if(k==='swPlan')return openPlan(curSw(),'');
  if(k==='swCsv')return csvSoftware(curSw());
  if(k==='csvCustomers')return csvCustomers();
  if(k==='csvValidity')return csvValidity();
  if(k==='csvPayments')return csvPayments();
}
/* the clock in the corner, as in the application */
function tick(){const d=new Date();const a=document.getElementById('sDate'),b=document.getElementById('sTime');if(!a)return;
  a.textContent=d.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'});b.textContent=d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
setInterval(tick,20000);setTimeout(tick,50);
document.addEventListener('keydown',e=>{
  if(!WIN)return;
  if(e.key==='Escape'){e.preventDefault();closeWin();}
  else if((e.ctrlKey||e.metaKey)&&(e.key==='e'||e.key==='E')){e.preventDefault();winTool('edit');}
  else if((e.ctrlKey||e.metaKey)&&(e.key==='s'||e.key==='S')){e.preventDefault();winTool('save');}
});

/* ---------- the data the new screens read ---------- */
async function loadPlans(){try{PLANDATA=await api('/admin/api/plans');}catch(e){PLANDATA=null;}
  const n=document.getElementById('jump-plans');if(n)n.textContent=allPlans().length;
  if(curSec()==='sec-plans')renderPlanList();renderCompanies();if(WIN&&WIN.type==='plan')renderPlanWin();}
async function loadPayments(){try{PAYDATA=await api('/admin/api/payments');}catch(e){PAYDATA={payments:[],totals:{count:0,amount:0,bySoftware:{}}};}
  const n=document.getElementById('jump-pay');if(n)n.textContent=(PAYDATA.payments||[]).length;
  const s=curSec();if(s.indexOf('sec-sw-')===0)renderSoftware(curSw());if(s==='sec-payments')renderPayments();if(s==='sec-validity')renderValidity();if(s==='sec-dashboard')renderDashboard();
  if(WIN&&WIN.type==='cust'&&!WIN.edit)renderWin();}
function softBlock(id){return PLANDATA&&PLANDATA.software?PLANDATA.software.find(s=>s.id===id):null;}
function wPlans(){const b=softBlock('weight');return b?b.plans:((DATA.settings&&DATA.settings.plans)||[]);}
function fPlans(){const b=softBlock('fabric');return b&&b.supported?b.plans:[];}
function allPlans(){return wPlans().map(p=>Object.assign({sw:'weight'},p)).concat(fPlans().map(p=>Object.assign({sw:'fabric'},p)));}
function wFeatures(){const b=softBlock('weight');return b?b.features:Object.keys(PLAN_LABELS).map(id=>({id,label:PLAN_LABELS[id],group:'Features'}));}
function planOf(sw,code){const c=String(code||'').toUpperCase();return (sw==='weight'?wPlans():fPlans()).find(p=>p.code===c)||null;}
function planNameOf(sw,code){const p=planOf(sw,code);if(p)return p.name;const c=String(code||(sw==='fabric'?'STANDARD':'PRO'));return c.charAt(0)+c.slice(1).toLowerCase().replace(/_/g,' ');}
function rupees(n){return n==null||n===''?'—':'₹'+Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});}
function isoToday(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function dayNum(iso){return iso?Math.floor(new Date(iso).getTime()/86400000):null;}

/* ---------- one customer, every software ---------- */
function wState(c){return c.state==='SUSPENDED'?'SUSPENDED':c.expired?'EXPIRED':c.is_demo?'DEMO':'LICENSED';}
function fState(f){return f.shownState||'LICENSED';}
function stCls(s){return s==='LICENSED'?'c-ok':s==='DEMO'?'c-demo':s==='EXPIRED'?'c-warn':'c-bad';}
function stWord(s){return s==='LICENSED'?'licensed':s==='DEMO'?'demo':s==='EXPIRED'?'ended':'suspended';}
function daysText(state,left,at){return state==='SUSPENDED'?'suspended':state==='EXPIRED'?'ended '+fmt(at):(state==='DEMO'?'demo · ':'')+(left===0?'ends today':left+' day'+(left===1?'':'s'));}
function ownOf(l){const o=l&&(l.feature_overrides||l.featureOverrides);return o&&typeof o==='object'?o:{};}
function ovCount(c){return Object.keys(ownOf(c)).length;}
/* each software's own features: Sales & Costing's from this service, Fabric Stock's from its own (0.8.1 on) */
function featsOf(sw){if(sw==='weight')return wFeatures();const b=softBlock('fabric');return b&&b.supported?(b.features||[]):[];}
function fabricPlans(){const b=softBlock('fabric');return !!(b&&b.supported);}
function customers(){
  const out=[];
  (DATA.companies||[]).forEach(c=>{const f=fabricOf(c.id);out.push({key:'w'+c.id,name:c.name,gstin:c.gstin||'',email:c.email||'',phone:c.phone||'',w:c,f:f||null,self:!!c.self_registered,since:c.created_at});});
  fabricOnly().forEach(f=>out.push({key:'f'+f.id,name:f.name,gstin:f.gstin||'',email:f.email||'',phone:f.phone||'',w:null,f:f,self:!!f.selfRegistered,since:f.createdAt}));
  out.forEach(x=>{
    const subs=[];
    if(x.w)subs.push({sw:'weight',state:wState(x.w),at:x.w.expires_at,left:x.w.days_left});
    if(x.f)subs.push({sw:'fabric',state:fState(x.f),at:x.f.expiresAt,left:x.f.daysLeft});
    x.subs=subs;
    const live=subs.filter(s=>s.state!=='SUSPENDED').sort((a,b)=>new Date(a.at)-new Date(b.at));
    x.next=live[0]||null;
    x.soon=subs.some(s=>s.state!=='SUSPENDED'&&s.state!=='EXPIRED'&&s.left<=30);
  });
  return out;
}
function custByKey(k){return customers().find(x=>x.key===k)||null;}
function swCell(sw,x){
  if(sw==='weight'){const c=x.w;if(!c)return '<span class="c-none">— not taken</span>';const s=wState(c),n=ovCount(c);
    return '<b>'+esc(planNameOf('weight',c.plan))+(n?' <span style="color:var(--accent)">± '+n+'</span>':'')+'</b><small class="'+stCls(s)+'">'+esc(daysText(s,c.days_left,c.expires_at))+'</small>';}
  const f=x.f;
  if(!f){const p=fabricProduct();return '<span class="c-none">'+(p&&!p.ok?'not connected':'— not taken')+'</span>';}
  const s=fState(f),n=ovCount(f);return '<b>'+esc(planNameOf('fabric',f.plan))+(n?' <span style="color:var(--accent)">± '+n+'</span>':'')+'</b><small class="'+stCls(s)+'">'+esc(daysText(s,f.daysLeft,f.expiresAt))+'</small>';
}
function coView(v){CQUICK=v==='deleted'?'deleted':v==='ending'?'soon':'all';renderCompanies();}
function plQuick(sw){document.getElementById('plSoft').value=sw;renderPlanList();}
function clearPlanFilter(){document.getElementById('plSoft').value='';document.getElementById('plq').value='';renderPlanList();}
function clearCustomerFilter(){['cq','cFrom','cTo'].forEach(i=>{document.getElementById(i).value='';});['cSoft','cPlan','cState'].forEach(i=>{document.getElementById(i).value='';});CQUICK='all';renderCompanies();}
function cQuick(v){CQUICK=v;renderCompanies();}
/* renderCompanies is what every older action calls after it has changed something (load() → here):
   the list is drawn again, and the open window with it */
function renderCompanies(){
  const host=document.getElementById('colist');if(!host)return;
  const term=(document.getElementById('cq').value||'').toLowerCase().trim();
  const soft=document.getElementById('cSoft').value, plan=document.getElementById('cPlan').value, st=document.getElementById('cState').value;
  const from=document.getElementById('cFrom').value, to=document.getElementById('cTo').value;
  const ps=document.getElementById('cPlan');const keep=ps.value;
  ps.innerHTML='<option value="">Any plan</option>'+wPlans().map(p=>'<option value="weight:'+esc(p.code)+'">Sales & Costing · '+esc(p.name)+'</option>').join('')+fPlans().map(p=>'<option value="fabric:'+esc(p.code)+'">Fabric Stock · '+esc(p.name)+'</option>').join('');
  ps.value=keep;
  const all=customers(), arch=DATA.archived||[];
  const count=(fn)=>all.filter(fn).length;
  const Q=[['all','All',all.length],['soon','Renew in 30 days',count(x=>x.soon)],['demo','On a demo',count(x=>x.subs.some(s=>s.state==='DEMO'))],['both','Both software',count(x=>x.w&&x.f)],
    ['susp','Suspended',count(x=>x.subs.some(s=>s.state==='SUSPENDED'))],['self','Self-registered',count(x=>x.self)],['deleted','Deleted',arch.length]];
  document.getElementById('cQuick').innerHTML='<span>Quick:</span>'+Q.map(q=>'<span class="qb'+(CQUICK===q[0]?' on':'')+'" onclick="cQuick(this.dataset.q)" data-q="'+q[0]+'">'+q[1]+'<i>'+q[2]+'</i></span>').join('');
  const jc=document.getElementById('jump-co');if(jc){jc.textContent=all.length;jc.className=all.length?'':'zero';}
  const ws=all.filter(x=>x.w).map(x=>wState(x.w)), fs=all.filter(x=>x.f).map(x=>fState(x.f));
  const n=(arr,s)=>arr.filter(v=>v===s).length;
  const fp=fabricProduct();
  document.getElementById('cFigs').innerHTML=
    '<div class="fig f1"><span>Sales & Costing</span><b>'+ws.length+'</b><small>'+n(ws,'LICENSED')+' licensed · '+n(ws,'DEMO')+' demo · '+n(ws,'SUSPENDED')+' suspended</small></div>'+
    '<div class="fig f2"><span>Fabric Stock</span><b>'+(fp&&fp.ok?fs.length:'—')+'</b><small>'+(fp&&fp.ok?n(fs,'LICENSED')+' licensed · '+n(fs,'DEMO')+' demo · '+n(fs,'SUSPENDED')+' suspended':(fp?'not connected':'reading…'))+'</small></div>'+
    '<div class="fig f3"><span>Renew in 30 days</span><b>'+count(x=>x.soon)+'</b><small>a licence of theirs ends within 30 days</small></div>'+
    '<div class="fig f4"><span>Using both</span><b>'+count(x=>x.w&&x.f)+'</b><small>Sales & Costing + Fabric Stock</small></div>';
  if(CQUICK==='deleted'){document.getElementById('cCount').textContent=arch.length+' deleted';document.getElementById('cListTitle').textContent='Deleted companies';host.innerHTML=archivedHtml(arch,term);CLIST=[];return;}
  document.getElementById('cListTitle').textContent='Every customer';
  const rows=all.filter(x=>{
    if(term&&![x.name,x.gstin,x.email,x.phone,x.w&&x.w.licence_key,x.w&&x.w.login_id,x.f&&x.f.licenceKey,x.f&&x.f.loginId].some(v=>String(v||'').toLowerCase().includes(term)))return false;
    if(soft==='weight'&&!x.w)return false;if(soft==='fabric'&&!x.f)return false;if(soft==='both'&&!(x.w&&x.f))return false;
    if(plan){const p=plan.split(':');if(p[0]==='weight'&&!(x.w&&String(x.w.plan||'PRO').toUpperCase()===p[1]))return false;if(p[0]==='fabric'&&!(x.f&&String(x.f.plan||'STANDARD').toUpperCase()===p[1]))return false;}
    if(st&&!x.subs.some(s=>s.state===st))return false;
    if(from&&!(x.next&&String(x.next.at).slice(0,10)>=from))return false;
    if(to&&!(x.next&&String(x.next.at).slice(0,10)<=to))return false;
    if(CQUICK==='soon'&&!x.soon)return false;if(CQUICK==='demo'&&!x.subs.some(s=>s.state==='DEMO'))return false;if(CQUICK==='both'&&!(x.w&&x.f))return false;
    if(CQUICK==='susp'&&!x.subs.some(s=>s.state==='SUSPENDED'))return false;if(CQUICK==='self'&&!x.self)return false;
    return true;
  }).sort((a,b)=>(a.next&&b.next?new Date(a.next.at)-new Date(b.next.at):(a.next?-1:b.next?1:0))||a.name.localeCompare(b.name));
  CLIST=rows.map(x=>x.key);
  const people=rows.reduce((s,x)=>s+(x.w?(+x.w.users_total||0):0)+(x.f?(+x.f.people||0):0),0);
  document.getElementById('cCount').textContent=rows.length+' customer'+(rows.length===1?'':'s');
  document.getElementById('cNote').textContent=people+' people on seats · '+(DATA.licences||[]).length+' Sales & Costing computers and phones';
  host.innerHTML=fabricNote()+(rows.length?'<table class="rec"><thead><tr><th>Customer</th><th>GSTIN</th><th><span class="swd w"></span>Sales & Costing</th><th><span class="swd f"></span>Fabric Stock</th><th><span class="swd j"></span>Jobwork</th><th class="num">People</th><th>Next renewal</th></tr></thead><tbody>'+
    rows.map(x=>'<tr data-open="c:'+x.key+'"'+(SELKEY['sec-companies']==='c:'+x.key?' class="on"':'')+'><td><b>'+esc(x.name)+'</b><small>'+(x.self?'self-registered · ':'')+(x.w&&x.f?(x.f.linkedBy==='gstin'?'linked by GSTIN':'linked by hand'):'')+'</small></td>'+
      '<td>'+esc(x.gstin||'—')+'</td><td>'+swCell('weight',x)+'</td><td>'+swCell('fabric',x)+'</td><td><span class="c-none">coming</span></td>'+
      '<td class="num">'+(x.w?(+x.w.users_total||0):'—')+' + '+(x.f?(+x.f.people||0):'—')+'</td>'+
      '<td>'+(x.next?'<b class="'+(x.soon?'c-warn':'')+'">'+fmt(x.next.at)+'</b><small>'+(x.subs.length>1&&x.subs.every(s=>String(s.at).slice(0,10)===String(x.next.at).slice(0,10))?'both software':(x.next.sw==='weight'?'Sales & Costing':'Fabric Stock'))+'</small>':'—')+'</td></tr>').join('')+
    '</tbody></table>':'<div class="empty">No customer matches. Clear the filter, or make one with New.</div>');
  if(WIN&&WIN.type==='cust'&&!WIN.edit)renderWin();
  if(curSec()==='sec-validity')renderValidity();
  if(curSec()==='sec-dashboard')renderDashboard();
  if(curSec().indexOf('sec-sw-')===0)renderSoftware(curSw());
}

/* ---------- the window ---------- */
function showWin(html){document.getElementById('winLayer').innerHTML=html;}
function closeWin(){
  if(WIN&&WIN.edit&&!confirm('Close without saving the changes?'))return;
  WIN=null;OPEN=null;OPENF=null;document.getElementById('winLayer').innerHTML='';
}
function initials(n){return String(n||'?').split(/[ .]+/).filter(Boolean).slice(0,2).map(w=>w.charAt(0).toUpperCase()).join('')||'N';}
function fv(label,val,raw){return '<div class="fl"><span>'+esc(label)+'</span><div class="ro">'+(raw?val:esc(val==null||val===''?'—':val))+'</div></div>';}
function fin(label,id,val,type,extra){return '<div class="fl"><span>'+esc(label)+'</span><input id="'+id+'" type="'+(type||'text')+'" value="'+esc(val==null?'':val)+'"'+(extra||'')+'></div>';}
function openCustomer(key,sw,sub){
  const x=custByKey(key);if(!x){say('<div class="msg err">That customer is no longer there.</div>');return;}
  WIN={type:'cust',key,sw:sw||(x.w?'weight':'fabric'),sub:sub||'licence',edit:false,draft:{}};
  renderWin();
}
function presetFromWin(){const x=custByKey(WIN.key);if(!x)return null;return {key:x.key,software:WIN.sw==='fabric'&&x.f?'fabric':(x.w?'weight':'fabric')};}
let PEOPLE_KEPT={};
function renderWin(){
  if(!WIN||WIN.type!=='cust')return;
  let x=custByKey(WIN.key);
  if(!x&&WIN.fid){x=customers().find(c=>c.f&&String(c.f.id)===String(WIN.fid))||null;if(x)WIN.key=x.key;}
  if(!x){WIN=null;document.getElementById('winLayer').innerHTML='';return;}
  if(WIN.sw==='weight'&&!x.w&&!WIN.adding)WIN.sw='fabric';
  if(WIN.sw==='fabric'&&!x.f&&!x.w)WIN.sw='weight';
  WIN.fid=x.f?x.f.id:null;
  OPEN=x.w?x.w.id:null;OPENF=x.f?x.f.id:null;
  const ph=x.w?document.getElementById('users-'+x.w.id):null;if(ph&&!/Reading/.test(ph.innerHTML))PEOPLE_KEPT[x.w.id]=ph.innerHTML;
  const W=WIN.sw==='weight', c=x.w, f=x.f, E=WIN.edit;
  const i=CLIST.indexOf(x.key);
  let tools=[['Edit','✎',C_.blue,'edit',E||(W?!c:!f)],['Save','💾',C_.green,'save',!E],['Cancel','✕',C_.back,'cancel',!E],'|',['Previous','‹',C_.back,'prev',i<=0],['Next','›',C_.back,'next',i<0||i>=CLIST.length-1],'|'];
  if(W&&c){const s=wState(c);tools=tools.concat([
    ['Add days','+',C_.orange,'w-days'],c.is_demo?['Make licensed','✓',C_.green,'w-licence']:['+1 year','+1',C_.amber,'w-year'],['Plan','◫',C_.violet,'w-plan'],['Seats','☺',C_.teal,'w-seats'],
    s==='SUSPENDED'?['Restore','▶',C_.green,'w-restore']:['Suspend','⏸',C_.red,'w-suspend'],['New key','⚿',C_.violet,'w-rekey'],'|',['Record payment','₹',C_.teal,'pay']]);}
  if(!W&&f){const s=fState(f);tools=tools.concat([
    ['Add days','+',C_.orange,'f-days'],f.isDemo?['Make licensed','✓',C_.green,'f-licence']:['+1 year','+1',C_.amber,'f-year'],fabricPlans()?['Plan','◫',C_.violet,'f-plan']:null,['Seats','☺',C_.teal,'f-seats'],
    s==='SUSPENDED'?['Restore','▶',C_.green,'f-restore']:['Suspend','⏸',C_.red,'f-suspend'],'|',['Record payment','₹',C_.teal,'pay']]);}
  tools=tools.concat(['|',['Close','✕',C_.back,'close']]);
  const subs=W?[['licence','Licence'],['features','Features'],['people','People'],['computers','Computers & phones'],['payments','Payments'],['more','More'],['history','History']]
             :[['licence','Licence']].concat(fabricPlans()?[['features','Features']]:[]).concat([['people','People'],['computers','Computers & phones'],['payments','Payments'],['company','Company'],['history','History']]);
  if(!subs.some(s=>s[0]===WIN.sub))WIN.sub='licence';
  const payN=custPayments(x).length;
  const head='<div class="wtitle"><span class="av">'+esc(initials(x.name))+'</span><div><h2>'+esc(x.name)+'<span class="mode'+(E?' edit':'')+'">'+(E?'EDIT':'DISPLAY')+'</span></h2>'+
    '<small>Customer · '+x.subs.length+' software'+(x.since?' · since '+fmt(x.since):'')+(x.self?' · registered by the plant itself':'')+'</small></div><div class="wx"><button data-wtool="close" title="Close (Esc)">✕</button></div></div>';
  const idRow=(E&&W&&c)
    ?'<div class="card"><div class="fgrid five">'+fin('Name','e-name',c.name)+fin('GSTIN','e-gstin',c.gstin||'','text',' maxlength="15" style="text-transform:uppercase"')+fv('Email',c.email)+fv('Mobile',c.phone)+fin('Note','e-note',c.notes||'')+'</div></div>'
    :(E&&!W&&f)
    ?'<div class="card"><div class="fgrid five">'+fin('Name','e-name',f.name)+fin('GSTIN','e-gstin',f.gstin||'','text',' maxlength="15" style="text-transform:uppercase"')+fin('Email','e-email',f.email||'')+fin('Mobile','e-phone',f.phone||'')+fin('Note','e-note',f.notes||'')+'</div></div>'
    :'<div class="card"><div class="fgrid five">'+fv('Name',x.name)+fv('GSTIN',x.gstin?(x.gstin+(c&&c.gst_status==='VERIFIED'?' · verified':'')):'—')+fv('Email',x.email)+fv('Mobile',x.phone)+fv('Note',(W&&c?c.notes:(f&&f.notes))||'—')+'</div></div>';
  const tabs='<div class="swtabs">'+
    (c?'<button class="swt w'+(W?' on':'')+'" data-wtool="sw-weight"><span class="b">⚖</span><span><b>Sales & Costing</b><small>'+esc(planNameOf('weight',c.plan))+(ovCount(c)?' ± '+ovCount(c):'')+' · '+esc(daysText(wState(c),c.days_left,c.expires_at))+'</small></span></button>'
       :'<button class="swt add" data-wtool="add-weight">+ Add Sales & Costing</button>')+
    (f?'<button class="swt f'+(!W?' on':'')+'" data-wtool="sw-fabric"><span class="b">▤</span><span><b>Fabric Stock</b><small>'+esc(planNameOf('fabric',f.plan))+(ovCount(f)?' ± '+ovCount(f):'')+' · '+esc(daysText(fState(f),f.daysLeft,f.expiresAt))+'</small></span></button>'
       :'<button class="swt add'+(!W?' on':'')+'" data-wtool="sw-fabric">+ Add Fabric Stock</button>')+
    '<span class="swt j soon"><span class="b">⚙</span><span><b>Jobwork</b><small>coming — no licence yet</small></span></span></div>';
  const subt=(W?c:f)?'<div class="subt">'+subs.map(s=>'<button class="'+(WIN.sub===s[0]?'on':'')+'" data-wtool="sub-'+s[0]+'">'+s[1]+(s[0]==='payments'&&payN?'<small>'+payN+'</small>':'')+(s[0]==='features'&&ovCount(W?c:f)?'<small>± '+ovCount(W?c:f)+'</small>':'')+'</button>').join('')+'</div>':'';
  let body='';
  if(W&&!c)body='<div class="card"><h3>'+esc(x.name)+' does not use Sales & Costing yet</h3><p class="help">It gets a licence of its own; Fabric Stock is not touched.</p><div class="acts"><button class="primary" data-wtool="start-weight">Make licensed for 1 year</button></div></div>';
  else if(!W&&!f)body='<div class="card">'+(c?fabricManage(null,c):'')+'</div>';
  else body=W?wBody(x,c):fBody(x,f);
  showWin('<div class="win">'+head+'<div class="tbar">'+tbHtml(tools,'data-wtool')+'</div><div class="wbody">'+idRow+tabs+subt+body+'</div></div>');
  if(W&&c&&WIN.sub==='people'){const h=document.getElementById('users-'+c.id);if(h&&PEOPLE_KEPT[c.id])h.innerHTML=PEOPLE_KEPT[c.id];coUsers({dataset:{id:c.id}},true);}
  if(!W&&f&&(WIN.sub==='people'||WIN.sub==='computers')&&!FDETAIL[f.id])fabricDetail(f.id);
  if(WIN.sub==='history')loadHistory(x,W);
}
function wBody(x,c){
  const E=WIN.edit, s=wState(c), sub=WIN.sub;
  if(sub==='licence'){
    const plans=wPlans().filter(p=>p.active!==false||p.code===String(c.plan||'PRO').toUpperCase());
    const g=[
      E?'<div class="fl"><span>Plan</span><select id="e-plan">'+plans.map(p=>'<option value="'+esc(p.code)+'"'+(p.code===String(c.plan||'PRO').toUpperCase()?' selected':'')+'>'+esc(p.name)+(p.note?' — '+esc(p.note):'')+(p.active===false?' (retired)':'')+'</option>').join('')+'</select></div>'
       :fv('Plan',planNameOf('weight',c.plan)+(c.is_demo?' — a demo has every feature':'')),
      fv('State','<b class="'+stCls(s)+'">'+stWord(s)+'</b>',true),
      fv('Licence key','<code>'+esc(c.licence_key)+'</code> <button class="small" data-key="'+esc(c.licence_key)+'" onclick="copyKey(this)">Copy</button>',true),
      fv('Company id (sign-in)',c.login_id||'—'),
      fv(c.is_demo?'Demo started':'Licence started',fmt(c.period_started_at)+(c.period_days?' · '+c.period_days+'-day '+(c.is_demo?'demo':'licence'):'')),
      fv(s==='EXPIRED'?'Ended':'Ends','<b'+(c.ending_soon?' class="c-warn"':'')+'>'+fmt(c.expires_at)+'</b>'+(s==='LICENSED'||s==='DEMO'?' · '+(c.days_left===0?'ends today':c.days_left+' days left'):''),true),
      E?fin('Seats (people)','e-seats',c.seats,'number',' min="1" max="500"'):fv('Seats (people)',(+c.users_total||0)+' of '+c.seats+((+c.seats)-(+c.users_total||0)>0?' · '+((+c.seats)-(+c.users_total||0))+' free':' · full')),
      E?fin('Offline days','e-grace',c.grace_days,'number',' min="0" max="365"'):fv('Offline days',c.grace_days>0?c.grace_days+' days':'none'),
      E?fin('Nexora AI a day (0 = the service’s)','e-ai',c.ai_daily_limit||0,'number',' min="0"'):fv('Nexora AI a day',c.ai_daily_limit?c.ai_daily_limit:(DATA.aiDefaultDaily&&DATA.aiDefaultDaily<100000?DATA.aiDefaultDaily+' (the service’s)':'no limit')),
      E?fin('Transaction limit (0 = none)','e-txn',c.txn_limit||0,'number',' min="0"'):fv('Transaction limit',c.txn_limit?c.txn_limit:'none'),
      fv('Self-registered',c.self_registered?'yes · '+fmt(c.registered_at)+(c.registered_ip?' · '+c.registered_ip:''):'no'),
      fv('GST check',c.gstin?(c.gst_status==='VERIFIED'?'verified':c.gst_status==='FAILED'?'failed':'not yet verified'):'no GSTIN')
    ];
    return '<div class="card"><div class="fgrid">'+g.join('')+'</div></div>'+
      '<div class="figs"><div class="fig f1"><span>Computers &amp; phones</span><b>'+(c.machines_used||0)+'</b><small>not counted against seats</small></div>'+
      '<div class="fig f2"><span>Nexora AI today</span><b>'+(c.ai_used_today||0)+'</b><small>'+(c.ai_daily_limit?'of '+c.ai_daily_limit+' a day':'questions asked today')+'</small></div>'+
      '<div class="fig f3"><span>Transactions</span><b>'+(+c.txn_used||0)+'</b><small>'+(c.txn_limit?'of '+c.txn_limit:'no limit')+'</small></div>'+
      '<div class="fig f4"><span>Hours in use</span><b>'+hoursText(c.usage_minutes)+'</b><small>summed over its machines</small></div></div>';
  }
  if(sub==='features')return featBody('weight',c);
  if(sub==='people')return '<div class="card"><div class="acts" style="margin-bottom:10px">'+
      '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coAdmin(this)">Set administrator…</button>'+
      '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" data-login="'+esc(c.login_id||'')+'" onclick="coPasscode(this)">New company passcode…</button>'+
      '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coUsers(this)">Refresh</button><span class="why">the administrator adds everyone else and gives their rights inside Sales & Costing</span></div>'+
      '<div id="users-'+c.id+'" class="users-panel"><p class="help">Reading…</p></div></div>';
  if(sub==='computers')return '<div class="card"><div class="acts" style="margin-bottom:10px"><button data-id="'+c.id+'" onclick="closeWin();showInstallations(this)">Show in Installations</button><span class="why">computers and phones take no seat; withdraw one to stop that machine</span></div><div class="users-panel">'+machinesHtml(c)+'</div></div>';
  if(sub==='payments')return payTab(x,'weight');
  if(sub==='more')return '<div class="card">'+
      (c.gstin?'<div class="group"><h4>GST</h4><div class="acts"><button data-id="'+c.id+'" onclick="gstVerify(this)">Verify online</button>'+(c.gst_status!=='VERIFIED'?'<button data-id="'+c.id+'" data-status="VERIFIED" onclick="gstMark(this)">Mark checked by hand</button>':'<button data-id="'+c.id+'" data-status="UNVERIFIED" onclick="gstMark(this)">Take the verified mark off</button>')+'</div></div>':'')+
      '<div class="group"><h4>Masters</h4><div class="acts"><button data-id="'+c.id+'" onclick="coHistory(this)">Earlier copies…</button><span class="why">materials, routes, processes, recipes as they were before a change or a delete — any one can be put back</span><div id="hist-'+c.id+'" class="users-panel" style="display:none"></div></div></div>'+
      '<div class="group"><h4>Usage</h4><div class="acts"><button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coReset(this)">Reset usage</button><span class="why">count and hours from zero; nothing saved is touched</span></div></div>'+
      '<div class="group"><h4>Stop</h4><div class="acts">'+(c.state==='SUSPENDED'?'<button data-id="'+c.id+'" data-action="restore" data-days="0" onclick="coAct(this)">Restore</button>':'<button class="danger" data-id="'+c.id+'" data-action="suspend" data-days="0" onclick="coAct(this)">Suspend</button>')+
      '<button class="danger" data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coDelete(this)">Delete…</button><span class="why">stops it now and keeps it 30 days (Restore under Deleted); then it and everything that belongs to it are erased</span></div></div></div>';
  return '<div class="card"><div id="whist"><p class="help">Reading…</p></div></div>';
}
function featBody(sw,l){
  const E=WIN.edit, demo=sw==='weight'?l.is_demo:l.isDemo;
  const plan=planOf(sw,l.plan)||{features:{},name:planNameOf(sw,l.plan)};
  const own=Object.assign({},ownOf(l));
  if(E)Object.keys(WIN.draft).forEach(k=>{if(WIN.draft[k]===null)delete own[k];else own[k]=WIN.draft[k];});
  const feats=featsOf(sw), groups=[];
  feats.forEach(fe=>{const g=fe.group||'Features';if(groups.indexOf(g)<0)groups.push(g);});
  if(sw==='weight')groups.sort((a,b)=>GROUP_ORDER.indexOf(a)-GROUP_ORDER.indexOf(b));
  let fromPlan=0,added=0,off=0,onN=0;
  const cell=fe=>{
    const p=plan.features[fe.id]===true, o=own[fe.id], eff=typeof o==='boolean'?o:p;
    const cls=o===true&&!p?'add':o===false&&p?'off':p?'plan':'no';
    if(p)fromPlan++;if(cls==='add')added++;if(cls==='off')off++;if(eff)onN++;
    return '<button class="fx '+cls+(eff?' on':'')+'" data-wtool="feat-'+fe.id+'"'+(E?'':' disabled')+'><span class="cb">'+(eff?'✓':'')+'</span><span class="nm">'+esc(fe.label)+'</span><span class="tg">'+({plan:'from plan',add:'+ added',off:'− off',no:'not in plan'})[cls]+'</span></button>';
  };
  const grid=groups.map(g=>'<div class="fgh">'+esc(g)+'</div><div class="feat">'+feats.filter(fe=>(fe.group||'Features')===g).map(cell).join('')+'</div>').join('');
  return '<div class="card" style="padding:10px 14px"><div class="sumline"><span><b>'+esc(plan.name||planNameOf(sw,l.plan))+'</b> gives '+fromPlan+' of '+feats.length+'</span>'+
    '<span style="color:var(--accent);font-weight:700">+'+added+' added for '+esc(l.name)+'</span><span class="c-bad">−'+off+' turned off</span><span>→ <b>'+onN+' on</b></span><span style="flex:1"></span>'+
    (demo?'<span class="sub">A demo has every feature; these apply once it is licensed.</span>':'<span class="sub">'+(E?'Click a feature to add it or take it off for this customer only.':'Grey until Edit (Ctrl+E). The plan itself stays as it is.')+'</span>')+
    (E?'<button class="small" data-wtool="feat-reset">Back to the plan only</button>':'')+'</div></div><div class="card">'+grid+'</div>';
}
function fBody(x,f){
  const E=WIN.edit, s=fState(f), sub=WIN.sub, p=fabricProduct();
  if(p&&!p.ok)return '<div class="card">'+fabricNote()+'</div>';
  const d=FDETAIL[f.id];
  if(sub==='licence'){
    const g=[
      E&&fabricPlans()?'<div class="fl"><span>Plan</span><select id="e-plan">'+fPlans().filter(p=>p.active!==false||p.code===String(f.plan||'STANDARD').toUpperCase()).map(p=>'<option value="'+esc(p.code)+'"'+(p.code===String(f.plan||'STANDARD').toUpperCase()?' selected':'')+'>'+esc(p.name)+(p.note?' — '+esc(p.note):'')+(p.active===false?' (retired)':'')+'</option>').join('')+'</select></div>'
        :fv('Plan',planNameOf('fabric',f.plan)+(ovCount(f)?' ± '+ovCount(f):'')+(f.isDemo?' — a demo has everything':'')),
      fv('State','<b class="'+stCls(s)+'">'+stWord(s)+'</b>',true),
      fv('Licence key','<code>'+esc(f.licenceKey)+'</code> <button class="small" data-key="'+esc(f.licenceKey)+'" onclick="copyKey(this)">Copy</button>',true),
      fv('Company id (sign-in)',f.loginId||'—'),
      fv(f.isDemo?'Demo started':'Licence started',fmt(f.periodStartedAt||f.createdAt)+(f.periodDays?' · '+f.periodDays+'-day '+(f.isDemo?'demo':'licence'):'')),
      fv(s==='EXPIRED'?'Ended':'Ends','<b'+(f.endingSoon?' class="c-warn"':'')+'>'+fmt(f.expiresAt)+'</b>'+(s==='LICENSED'||s==='DEMO'?' · '+(f.daysLeft===0?'ends today':f.daysLeft+' days left'):''),true),
      E?fin('Seats (people)','e-seats',f.seats,'number',' min="1" max="500"'):fv('Seats (people)',(+f.people||0)+' of '+f.seats),
      E?fin('Offline days (0–30)','e-grace',f.graceDays,'number',' min="0" max="30"'):fv('Offline days',f.graceDays>0?f.graceDays+' days':'none')
    ];
    const sb=softBlock('fabric');
    return '<div class="card"><div class="fgrid">'+g.join('')+'</div></div>'+
      '<div class="figs"><div class="fig f1"><span>Computers &amp; phones</span><b>'+(+f.devices||0)+'</b><small>not counted against seats</small></div>'+
      '<div class="fig f2"><span>People</span><b>'+(+f.people||0)+'</b><small>of '+f.seats+' seats</small></div>'+
      '<div class="fig f3"><span>Linked</span><b style="font-size:16px">'+(x.w?(f.linkedBy==='gstin'?'same GSTIN':'by hand'):'Fabric Stock only')+'</b><small>'+(x.w?'shown with its Sales & Costing company':'not with a Sales & Costing company')+'</small></div>'+
      '<div class="fig f4"><span>Plans</span><b style="font-size:16px">'+(sb&&sb.supported?'its own':'Standard')+'</b><small>'+(sb&&sb.supported?'made under Software & plans':'Fabric Stock has no plans yet')+'</small></div></div>';
  }
  if(sub==='people')return '<div class="card"><div class="acts" style="margin-bottom:10px"><button data-fid="'+f.id+'" data-name="'+esc(f.name)+'" onclick="fsAdmin(this)">Set administrator…</button>'+
      '<button data-fid="'+f.id+'" data-login="'+esc(f.loginId||'')+'" onclick="fsPasscode(this)">New company passcode…</button><span class="why">the administrator adds everyone else and gives their rights inside Fabric Stock, apart from Sales & Costing</span></div>'+
      '<div id="fsppl-'+f.id+'" class="users-panel">'+(d&&!d.error?fsPeopleHtml(f.id,d.users||[]):'<p class="help">Reading…</p>')+'</div></div>';
  if(sub==='computers')return '<div class="card"><div id="fsdev-'+f.id+'" class="users-panel">'+(d&&!d.error?fsDevicesHtml(d.devices||[]):'<p class="help">Reading…</p>')+'</div></div>';
  if(sub==='payments')return payTab(x,'fabric');
  if(sub==='features')return featBody('fabric',f);
  if(sub==='company')return '<div class="card"><div class="group"><h4>Which customer</h4><div class="acts">'+
      (x.w?(f.linkedBy==='gstin'?'<span class="why">Shown with '+esc(x.w.name)+' because the GSTIN is the same.</span><button data-fid="'+f.id+'" data-action="apart" onclick="fsLink(this)">Not the same company</button>'
                                :'<span class="why">Linked to '+esc(x.w.name)+' by hand.</span><button data-fid="'+f.id+'" data-action="unlink" onclick="fsLink(this)">Unlink</button>')
          :linkSelect(f))+'</div></div>'+
      '<div class="group"><h4>Stop</h4><div class="acts">'+(f.state==='SUSPENDED'?'<button data-fid="'+f.id+'" data-action="resume" onclick="fsStop(this)">Restore</button>':'<button class="danger" data-fid="'+f.id+'" data-action="suspend" onclick="fsStop(this)">Suspend</button>')+
      '<span class="why">every Fabric Stock computer and phone stops at its next check; nothing is deleted, and Sales & Costing is not touched</span></div></div></div>';
  return '<div class="card"><div id="whist"><p class="help">Reading…</p></div></div>';
}
async function loadHistory(x,W){
  let r;try{r=await api('/admin/api/events?admin=1&limit=500');}catch(e){r={events:[]};}
  const host=document.getElementById('whist');if(!host)return;
  const cid=x.w?String(x.w.id):null, fid=x.f?String(x.f.id):null;
  const rows=(r.events||[]).filter(ev=>{const d=ev.detail&&typeof ev.detail==='object'?ev.detail:{};
    if(W)return cid&&(String(d.id)===cid||String(d.companyId)===cid)&&String(ev.event).indexOf('ADMIN_FABRIC_')<0;
    return fid&&(String(d.fabricId)===fid||(String(ev.event).indexOf('ADMIN_PAYMENT_')===0&&String(d.fabricId)===fid));});
  host.innerHTML=rows.length?'<table class="mini-tbl"><thead><tr><th>When</th><th>What</th><th>Details</th><th>From</th></tr></thead><tbody>'+rows.map(ev=>{
    const d=ev.detail&&typeof ev.detail==='object'?ev.detail:{};const via=d.via||{};
    const rest=Object.keys(d).filter(k=>k!=='via'&&k!=='id'&&k!=='companyId'&&k!=='fabricId').map(k=>k+': '+(d[k]!==null&&typeof d[k]==='object'?JSON.stringify(d[k]):String(d[k]))).join(' · ');
    return '<tr><td class="why">'+esc(fmtTime(ev.at))+'</td><td><b>'+esc(ACT_WORDS[ev.event]||ev.event)+'</b></td><td class="why">'+esc(rest.slice(0,300))+'</td><td class="why">'+esc(via.app==='android'?'phone console':via.app?'web console':'the service')+'</td></tr>';}).join('')+'</tbody></table>'
    :'<p class="help">Nothing done from the consoles on this licence yet (the Activity list keeps the last 500 entries).</p>';
}
function custPayments(x){return (PAYDATA&&PAYDATA.payments||[]).filter(p=>(x.w&&p.companyId===String(x.w.id))||(x.f&&p.fabricId===String(x.f.id)));}
function payTab(x,sw){
  const list=custPayments(x).filter(p=>p.software===sw);
  const total=list.reduce((s,p)=>s+(p.amount||0),0);
  return '<div class="card"><div class="ctitle"><h3>'+(sw==='weight'?'Sales & Costing':'Fabric Stock')+' payments · '+list.length+' · '+rupees(total)+'</h3><button class="primary small" data-wtool="pay">+ Record payment</button></div>'+
    (list.length?'<table class="rec"><thead><tr><th>Paid on</th><th>For</th><th>Plan</th><th class="num">Amount</th><th>How</th><th>Reference</th><th>Validity it bought</th></tr></thead><tbody>'+
      list.map(p=>'<tr data-open="p:'+p.id+'"><td><b>'+fmt(p.paidOn)+'</b></td><td>'+esc(KIND_WORDS[p.kind]||p.kind)+'</td><td>'+esc(p.planName||p.plan||'—')+'</td><td class="num"><b>'+rupees(p.amount)+'</b></td><td>'+esc(p.mode||'—')+'</td><td>'+esc(p.reference||'—')+'</td><td>'+(p.validTo?(p.validFrom?fmt(p.validFrom)+' → ':'to ')+'<b>'+fmt(p.validTo)+'</b>':'<span class="c-none">—</span>')+'</td></tr>').join('')+'</tbody></table>'
      :'<p class="help">No payment recorded for this software yet. <b>Record payment</b> keeps when it came, how much, for which plan, and can renew the licence in the same step.</p>')+'</div>';
}
const GROUP_ORDER=['Calculation','Sales','Cost tools','Output','Company','Other','Features'];
const KIND_WORDS={NEW:'New customer',RENEWAL:'Renewal',EXTRA_USERS:'Extra users',UPGRADE:'Plan upgrade',OTHER:'Other'};
async function winTool(k){
  if(!WIN)return;
  if(WIN.type==='plan')return planTool(k);
  if(WIN.type==='pay')return payTool(k);
  if(WIN.type==='newcust')return newCustTool(k);
  const x=custByKey(WIN.key);if(!x&&k!=='close')return closeWin();
  const c=x&&x.w, f=x&&x.f;
  if(k==='close')return closeWin();
  if(k.indexOf('sub-')===0){if(WIN.edit&&!confirm('Leave Edit without saving?'))return;WIN.edit=false;WIN.draft={};WIN.sub=k.slice(4);return renderWin();}
  if(k==='sw-weight'||k==='sw-fabric'){if(WIN.edit&&!confirm('Leave Edit without saving?'))return;WIN.edit=false;WIN.draft={};WIN.sw=k.slice(3);return renderWin();}
  if(k==='prev'||k==='next'){if(WIN.edit&&!confirm('Leave Edit without saving?'))return;const i=CLIST.indexOf(WIN.key);const j=k==='prev'?i-1:i+1;if(j>=0&&j<CLIST.length){const sub=WIN.sub;openCustomer(CLIST[j],'',sub);}return;}
  if(k==='edit'){WIN.edit=true;WIN.draft={};if(WIN.sub!=='licence'&&WIN.sub!=='features')WIN.sub='licence';return renderWin();}
  if(k==='cancel'){WIN.edit=false;WIN.draft={};return renderWin();}
  if(k==='save')return saveCustomer(x);
  if(k.indexOf('feat-')===0&&WIN.edit){
    const id=k.slice(5);
    const sw=WIN.sw, l=sw==='weight'?c:f;if(!l)return;
    if(id==='reset'){featsOf(sw).forEach(fe=>{WIN.draft[fe.id]=null;});return renderWin();}
    const plan=planOf(sw,l.plan)||{features:{}};const p=plan.features[id]===true;
    const own=Object.assign({},ownOf(l));Object.keys(WIN.draft).forEach(z=>{if(WIN.draft[z]===null)delete own[z];else own[z]=WIN.draft[z];});
    const eff=typeof own[id]==='boolean'?own[id]:p;const next=!eff;
    WIN.draft[id]=next===p?null:next;return renderWin();
  }
  if(k==='pay')return openPayment(0,{key:x.key,software:WIN.sw==='fabric'&&f?'fabric':(c?'weight':'fabric')});
  if(k==='add-weight')return startWeightFor(x);
  if(k==='start-weight')return startWeightFor(x);
  if(c&&k==='w-days')return coDays({dataset:{id:String(c.id)}});
  if(c&&k==='w-year'){if(!confirm('Add a year to Sales & Costing for '+c.name+'?'))return;return coAct({dataset:{id:String(c.id),action:'extend',days:'365'}});}
  if(c&&k==='w-licence'){if(!confirm('Make '+c.name+' a licensed Sales & Costing customer for 1 year?'))return;return coAct({dataset:{id:String(c.id),action:'licence',days:'365'}});}
  if(c&&k==='w-suspend')return coAct({dataset:{id:String(c.id),action:'suspend',days:'0'}});
  if(c&&k==='w-restore')return coAct({dataset:{id:String(c.id),action:'restore',days:'0'}});
  if(c&&k==='w-rekey')return coRekey({dataset:{id:String(c.id),name:c.name}});
  if(c&&(k==='w-plan'||k==='w-seats')){WIN.sub='licence';WIN.edit=true;WIN.draft={};renderWin();const el=document.getElementById(k==='w-plan'?'e-plan':'e-seats');if(el)el.focus();return;}
  if(f&&k==='f-days')return fsRenew({dataset:{fid:String(f.id)}});
  if(f&&k==='f-year')return fsRenew({dataset:{fid:String(f.id),days:'365'}});
  if(f&&k==='f-licence')return fsLicense({dataset:{fid:String(f.id)}});
  if(f&&k==='f-suspend')return fsStop({dataset:{fid:String(f.id),action:'suspend'}});
  if(f&&k==='f-restore')return fsStop({dataset:{fid:String(f.id),action:'resume'}});
  if(f&&k==='f-plan'){WIN.sub='licence';WIN.edit=true;WIN.draft={};renderWin();const el=document.getElementById('e-plan');if(el)el.focus();return;}
  if(f&&k==='f-seats'){WIN.sub='licence';WIN.edit=true;WIN.draft={};renderWin();const el=document.getElementById('e-seats');if(el)el.focus();return;}
}
function val(id){const n=document.getElementById(id);return n?n.value:undefined;}
async function saveCustomer(x){
  const W=WIN.sw==='weight', c=x.w, f=x.f;
  const post=(body)=>api('/admin/api/company',{method:'POST',body:JSON.stringify(body)});
  const errs=[];
  try{
    if(W&&c){
      const nm=val('e-name'),gs=val('e-gstin'),nt=val('e-note'),pl=val('e-plan'),se=val('e-seats'),gr=val('e-grace'),ai=val('e-ai'),tx=val('e-txn');
      const steps=[];
      if(nm!==undefined&&nm.trim()&&nm.trim()!==c.name)steps.push({id:c.id,action:'rename',name:nm.trim()});
      if(gs!==undefined&&gs.trim().toUpperCase()!==String(c.gstin||''))steps.push({id:c.id,action:'gstin',gstin:gs.trim().toUpperCase()});
      if(nt!==undefined&&nt!==String(c.notes||''))steps.push({id:c.id,action:'note',notes:nt});
      if(pl!==undefined&&pl!==String(c.plan||'PRO').toUpperCase())steps.push({id:c.id,action:'plan',plan:pl});
      if(se!==undefined&&+se!==+c.seats)steps.push({id:c.id,action:'seats',seats:+se});
      if(gr!==undefined&&+gr!==+c.grace_days)steps.push({id:c.id,action:'grace',graceDays:+gr});
      if(ai!==undefined&&+ai!==+(c.ai_daily_limit||0))steps.push({id:c.id,action:'ailimit',aiDailyLimit:+ai});
      if(tx!==undefined&&+tx!==+(c.txn_limit||0))steps.push({id:c.id,action:'txnlimit',txnLimit:+tx});
      const ch={};Object.keys(WIN.draft).forEach(k=>{ch[k]=WIN.draft[k];});
      if(Object.keys(ch).length)steps.push({id:c.id,action:'features',overrides:ch});
      for(const s of steps){const r=await post(s);if(r.error)errs.push(r.error);if(r.warning)errs.push(r.warning);}
    }else if(f){
      const body={action:'update',id:f.id};
      const nm=val('e-name'),gs=val('e-gstin'),em=val('e-email'),phn=val('e-phone'),nt=val('e-note'),se=val('e-seats'),gr=val('e-grace');
      if(nm!==undefined&&nm.trim()&&nm.trim()!==f.name)body.name=nm.trim();
      if(gs!==undefined&&gs.trim().toUpperCase()!==String(f.gstin||''))body.gstin=gs.trim().toUpperCase();
      if(em!==undefined&&em.trim()!==String(f.email||''))body.email=em.trim();
      if(phn!==undefined&&phn.trim()!==String(f.phone||''))body.phone=phn.trim();
      if(nt!==undefined&&nt!==String(f.notes||''))body.notes=nt;
      if(se!==undefined&&+se!==+f.seats)body.seats=+se;
      if(gr!==undefined&&+gr!==+f.graceDays)body.graceDays=+gr;
      const fpl=val('e-plan');if(fpl!==undefined&&fpl!==String(f.plan||'STANDARD').toUpperCase())body.plan=fpl;
      if(Object.keys(WIN.draft).length)body.featureOverrides=Object.assign({},WIN.draft);
      if(Object.keys(body).length>2){const r=await api('/admin/api/fabric',{method:'POST',body:JSON.stringify(body)});if(r.error)errs.push('Fabric Stock: '+(r.message||r.error));}
    }
  }catch(e){errs.push(e.message);}
  WIN.edit=false;WIN.draft={};
  if(errs.length)say('<div class="msg err">'+errs.map(esc).join('<br>')+'</div>');else say('<div class="msg ok">Saved.</div>');
  await load();if(!W)await loadProducts();renderWin();
}
async function startWeightFor(x){
  const f=x.f;if(!f)return;
  if(!confirm('Make '+f.name+' a licensed Sales & Costing customer for 1 year?  It gets a Sales & Costing licence key of its own; Fabric Stock is not touched.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({action:'create',name:f.name,gstin:f.gstin||'',email:f.email||'',phone:f.phone||'',seats:f.seats||1,days:365,plan:'PRO'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await api('/admin/api/fabric',{method:'POST',body:JSON.stringify({action:'link',id:f.id,companyId:r.company.id})});
  say('<div class="msg ok"><b>'+esc(f.name)+'</b> now has Sales & Costing. Its Sales & Costing licence key is <span class="key">'+esc(r.company.licence_key)+'</span>.</div>');
  WIN.key='w'+r.company.id;WIN.sw='weight';await load();await loadProducts();
}

/* ---------- validity & renewals ---------- */
function vQuick(v){VQUICK=v;renderValidity();}
function clearValidityFilter(){['vq','vFrom','vTo'].forEach(i=>{document.getElementById(i).value='';});document.getElementById('vSoft').value='';VQUICK='all';renderValidity();}
function lastPay(sw,x){const l=custPayments(x).filter(p=>p.software===sw);return l[0]||null;}
function validityRows(){
  const out=[];
  customers().forEach(x=>{
    if(x.w)out.push({x,sw:'weight',plan:planNameOf('weight',x.w.plan),state:wState(x.w),start:x.w.period_started_at,ends:x.w.expires_at,left:x.w.days_left,seats:x.w.seats,pay:lastPay('weight',x)});
    if(x.f)out.push({x,sw:'fabric',plan:planNameOf('fabric',x.f.plan),state:fState(x.f),start:x.f.periodStartedAt||x.f.createdAt,ends:x.f.expiresAt,left:x.f.daysLeft,seats:x.f.seats,pay:lastPay('fabric',x)});
  });
  return out.sort((a,b)=>new Date(a.ends)-new Date(b.ends));
}
function renderValidity(){
  const host=document.getElementById('vlist');if(!host)return;
  const all=validityRows();
  const term=(document.getElementById('vq').value||'').toLowerCase().trim(), soft=document.getElementById('vSoft').value, from=document.getElementById('vFrom').value, to=document.getElementById('vTo').value;
  const live=r=>r.state==='LICENSED'||r.state==='DEMO';
  const Q=[['all','All',all.length],['30','Ending in 30 days',all.filter(r=>live(r)&&r.left<=30).length],['7','In 7 days',all.filter(r=>live(r)&&r.left<=7).length],['ended','Ended',all.filter(r=>r.state==='EXPIRED').length],['demo','Demos',all.filter(r=>r.state==='DEMO').length],['susp','Suspended',all.filter(r=>r.state==='SUSPENDED').length]];
  document.getElementById('vQuick').innerHTML='<span>Quick:</span>'+Q.map(q=>'<span class="qb'+(VQUICK===q[0]?' on':'')+'" data-q="'+q[0]+'" onclick="vQuick(this.dataset.q)">'+q[1]+'<i>'+q[2]+'</i></span>').join('');
  const n30=all.filter(r=>live(r)&&r.left<=30).length;
  const jv=document.getElementById('jump-val');if(jv){jv.textContent=n30;jv.className=n30?'':'zero';}
  document.getElementById('vFigs').innerHTML=
    '<div class="fig f3"><span>Ending in 7 days</span><b>'+all.filter(r=>live(r)&&r.left<=7).length+'</b><small>ring them now</small></div>'+
    '<div class="fig f1"><span>Ending in 30 days</span><b>'+n30+'</b><small>'+all.filter(r=>r.state==='LICENSED'&&r.left<=30).length+' paying · '+all.filter(r=>r.state==='DEMO'&&r.left<=30).length+' demos</small></div>'+
    '<div class="fig f4"><span>Ended, not renewed</span><b>'+all.filter(r=>r.state==='EXPIRED').length+'</b><small>read-only until renewed</small></div>'+
    '<div class="fig f2"><span>Licences</span><b>'+all.length+'</b><small>'+all.filter(r=>r.sw==='weight').length+' Sales & Costing · '+all.filter(r=>r.sw==='fabric').length+' Fabric Stock</small></div>';
  const rows=all.filter(r=>{
    if(term&&![r.x.name,r.x.gstin].some(v=>String(v||'').toLowerCase().includes(term)))return false;
    if(soft&&r.sw!==soft)return false;
    const d=String(r.ends||'').slice(0,10);if(from&&d<from)return false;if(to&&d>to)return false;
    if(VQUICK==='30'&&!(live(r)&&r.left<=30))return false;if(VQUICK==='7'&&!(live(r)&&r.left<=7))return false;
    if(VQUICK==='ended'&&r.state!=='EXPIRED')return false;if(VQUICK==='demo'&&r.state!=='DEMO')return false;if(VQUICK==='susp'&&r.state!=='SUSPENDED')return false;
    return true;});
  VLIST=rows;
  document.getElementById('vCount').textContent=rows.length+' licence'+(rows.length===1?'':'s');
  host.innerHTML=rows.length?'<table class="rec"><thead><tr><th>Customer</th><th>Software</th><th>Plan</th><th>State</th><th>Started</th><th>Ends</th><th class="num">Days left</th><th class="num">Seats</th><th>Last payment</th></tr></thead><tbody>'+
    rows.map(r=>'<tr data-open="c:'+r.x.key+':'+r.sw+':payments"><td><b>'+esc(r.x.name)+'</b></td><td><span class="swd '+(r.sw==='weight'?'w':'f')+'"></span>'+(r.sw==='weight'?'Sales & Costing':'Fabric Stock')+'</td><td>'+esc(r.plan)+'</td>'+
      '<td class="'+stCls(r.state)+'">'+stWord(r.state)+'</td><td>'+fmt(r.start)+'</td><td><b>'+fmt(r.ends)+'</b></td>'+
      '<td class="num '+(live(r)&&r.left<=30?'c-warn':'')+'">'+(live(r)?r.left:'—')+'</td><td class="num">'+(r.seats||'—')+'</td>'+
      '<td>'+(r.pay?'<b>'+rupees(r.pay.amount)+'</b><small>'+fmt(r.pay.paidOn)+' · '+esc(KIND_WORDS[r.pay.kind]||r.pay.kind)+'</small>':'<span class="c-none">none recorded</span>')+'</td></tr>').join('')+'</tbody></table>'
    :'<div class="empty">Nothing in this view.</div>';
}

/* ---------- payments ---------- */
function pQuick(v){PQUICK=v;renderPayments();}
function clearPaymentFilter(){['pq','pFrom','pTo'].forEach(i=>{document.getElementById(i).value='';});['pSoft','pKind'].forEach(i=>{document.getElementById(i).value='';});PQUICK='all';renderPayments();}
function renderPayments(){
  const host=document.getElementById('plist');if(!host)return;
  const all=(PAYDATA&&PAYDATA.payments)||[];
  const term=(document.getElementById('pq').value||'').toLowerCase().trim(), soft=document.getElementById('pSoft').value, kind=document.getElementById('pKind').value;
  let from=document.getElementById('pFrom').value, to=document.getElementById('pTo').value;
  const t=isoToday(), m=t.slice(0,8)+'01', y=(+t.slice(5,7)>=4?t.slice(0,4):String(+t.slice(0,4)-1))+'-04-01';
  if(PQUICK==='today'){from=t;to=t;}if(PQUICK==='month'){from=m;to=t;}if(PQUICK==='fy'){from=y;to=t;}
  const d30=new Date(Date.now()-30*86400000);const l30=d30.getFullYear()+'-'+String(d30.getMonth()+1).padStart(2,'0')+'-'+String(d30.getDate()).padStart(2,'0');
  if(PQUICK==='30'){from=l30;to=t;}
  document.getElementById('pQuick').innerHTML='<span>Quick:</span>'+[['all','All'],['today','Today'],['30','Last 30 days'],['month','This month'],['fy','This financial year']].map(q=>'<span class="qb'+(PQUICK===q[0]?' on':'')+'" data-q="'+q[0]+'" onclick="pQuick(this.dataset.q)">'+q[1]+'</span>').join('');
  const rows=all.filter(p=>{
    if(term&&![p.customer,p.reference,p.note,p.planName].some(v=>String(v||'').toLowerCase().includes(term)))return false;
    if(soft&&p.software!==soft)return false;if(kind&&p.kind!==kind)return false;
    if(from&&p.paidOn<from)return false;if(to&&p.paidOn>to)return false;return true;});
  PLIST=rows;
  const sum=a=>a.reduce((s,p)=>s+(p.amount||0),0);
  document.getElementById('pCount').textContent=rows.length+' payment'+(rows.length===1?'':'s')+' · '+rupees(sum(rows));
  document.getElementById('pNote').textContent=from||to?(from?fmt(from):'…')+' → '+(to?fmt(to):'…'):'';
  document.getElementById('pFigs').innerHTML=
    '<div class="fig f1"><span>Sales & Costing</span><b>'+rupees(sum(rows.filter(p=>p.software==='weight')))+'</b><small>'+rows.filter(p=>p.software==='weight').length+' payments</small></div>'+
    '<div class="fig f2"><span>Fabric Stock</span><b>'+rupees(sum(rows.filter(p=>p.software==='fabric')))+'</b><small>'+rows.filter(p=>p.software==='fabric').length+' payments</small></div>'+
    '<div class="fig f3"><span>Renewals</span><b>'+rupees(sum(rows.filter(p=>p.kind==='RENEWAL')))+'</b><small>'+rows.filter(p=>p.kind==='RENEWAL').length+' renewals</small></div>'+
    '<div class="fig f4"><span>New customers</span><b>'+rupees(sum(rows.filter(p=>p.kind==='NEW')))+'</b><small>'+rows.filter(p=>p.kind==='NEW').length+' first payments</small></div>';
  host.innerHTML=rows.length?'<table class="rec"><thead><tr><th>Paid on</th><th>Customer</th><th>Software</th><th>Plan</th><th>For</th><th class="num">Amount</th><th>How</th><th>Reference</th><th>Validity it bought</th></tr></thead><tbody>'+
    rows.map(p=>'<tr data-open="p:'+p.id+'"'+(SELKEY['sec-payments']==='p:'+p.id?' class="on"':'')+'><td><b>'+fmt(p.paidOn)+'</b></td><td><b>'+esc(p.customer)+'</b></td><td><span class="swd '+(p.software==='weight'?'w':'f')+'"></span>'+(p.software==='weight'?'Sales & Costing':'Fabric Stock')+'</td><td>'+esc(p.planName||p.plan||'—')+'</td>'+
      '<td>'+esc(KIND_WORDS[p.kind]||p.kind)+'</td><td class="num"><b>'+rupees(p.amount)+'</b></td><td>'+esc(p.mode||'—')+'</td><td>'+esc(p.reference||'—')+'</td>'+
      '<td>'+(p.validTo?(p.validFrom?fmt(p.validFrom)+' → ':'to ')+'<b>'+fmt(p.validTo)+'</b>':'<span class="c-none">—</span>')+'</td></tr>').join('')+
    '</tbody><tfoot><tr><td colspan="5">Total</td><td class="num">'+rupees(sum(rows))+'</td><td colspan="3"></td></tr></tfoot></table>'
    :'<div class="empty">No payment in this view. <b>Record payment</b> keeps one.</div>';
}
function openPayment(id,preset){
  const p=id?((PAYDATA&&PAYDATA.payments)||[]).find(z=>z.id===id):null;
  if(id&&!p){say('<div class="msg err">That payment is no longer there.</div>');return;}
  WIN={type:'pay',id:id||0,edit:!id,preset:preset||null,back:WIN&&WIN.type==='cust'?{key:WIN.key,sw:WIN.sw,sub:'payments'}:null};
  renderPayWin();
}
function payCustomers(){return customers().map(x=>({key:x.key,name:x.name,w:x.w,f:x.f}));}
function renderPayWin(){
  const p=WIN.id?((PAYDATA&&PAYDATA.payments)||[]).find(z=>z.id===WIN.id):null, E=WIN.edit, N=!p;
  const pre=WIN.preset||{};
  let custSel='', swSel='', planText='', extend='';
  if(N){
    const cs=payCustomers();
    const first=pre.software?cs.find(c=>pre.software==='weight'?c.w:c.f):null;
    const ck=pre.key||(first&&first.key)||(cs[0]&&cs[0].key)||'';
    custSel='<div class="fl"><span>Customer</span><select id="p-cust" onchange="WIN.preset=Object.assign({},WIN.preset||{},{key:this.value,software:null});renderPayWin()">'+cs.map(c=>'<option value="'+c.key+'"'+(c.key===ck?' selected':'')+'>'+esc(c.name)+'</option>').join('')+'</select></div>';
    const cx=cs.find(c=>c.key===ck)||{};
    const sws=[];if(cx.w)sws.push('weight');if(cx.f)sws.push('fabric');
    const sw=sws.indexOf(pre.software)>=0?pre.software:(sws[0]||'weight');
    swSel='<div class="fl"><span>Software</span><select id="p-sw" onchange="WIN.preset=Object.assign({},WIN.preset||{},{key:document.getElementById(&quot;p-cust&quot;).value,software:this.value});renderPayWin()">'+sws.map(s=>'<option value="'+s+'"'+(s===sw?' selected':'')+'>'+(s==='weight'?'Sales & Costing':'Fabric Stock')+'</option>').join('')+'</select></div>';
    const lic=sw==='weight'?cx.w:cx.f;
    const st=lic?(sw==='weight'?wState(lic):fState(lic)):'';
    planText=lic?fv('Plan',planNameOf(sw,lic.plan)+' · '+stWord(st)+' · ends '+fmt(sw==='weight'?lic.expires_at:lic.expiresAt)):fv('Plan','—');
    extend='<div class="fl"><span>Renew the licence with it</span><select id="p-ext"><option value="0">No — only record the payment</option><option value="365" selected>Yes — 1 year'+(st==='DEMO'?' (makes it licensed)':' added')+'</option><option value="730">Yes — 2 years</option><option value="180">Yes — 6 months</option><option value="30">Yes — 30 days</option></select></div>';
  }
  const v=(k,d)=>p?(p[k]==null?'':p[k]):(d==null?'':d);
  const kindSel='<div class="fl"><span>For</span>'+(E?'<select id="p-kind">'+Object.keys(KIND_WORDS).map(k=>'<option value="'+k+'"'+((p?p.kind:'RENEWAL')===k?' selected':'')+'>'+KIND_WORDS[k]+'</option>').join('')+'</select>':'<div class="ro">'+esc(KIND_WORDS[p.kind]||p.kind)+'</div>')+'</div>';
  const modeSel='<div class="fl"><span>How it came</span>'+(E?'<select id="p-mode">'+['UPI','BANK','CASH','CHEQUE','CARD','OTHER'].map(k=>'<option value="'+k+'"'+((p?p.mode:'UPI')===k?' selected':'')+'>'+({UPI:'UPI',BANK:'Bank transfer',CASH:'Cash',CHEQUE:'Cheque',CARD:'Card',OTHER:'Other'})[k]+'</option>').join('')+'</select>':'<div class="ro">'+esc(p.mode||'—')+'</div>')+'</div>';
  const fields=N
    ?'<div class="fgrid">'+custSel+swSel+planText+kindSel+fin('Amount received (₹)','p-amount','','text',' placeholder="15,000" inputmode="decimal"')+fin('Paid on','p-date',isoToday(),'date')+modeSel+fin('Reference (UTR, cheque, invoice)','p-ref','')+extend+fin('Valid from (if not renewing)','p-from','','date')+fin('Valid to (if not renewing)','p-to','','date')+fin('Note','p-note','')+'</div>'
    :'<div class="fgrid">'+fv('Customer',p.customer)+fv('Software',p.software==='weight'?'Sales & Costing':'Fabric Stock')+fv('Plan',p.planName||p.plan)+kindSel+
      (E?fin('Amount received (₹)','p-amount',p.amount,'text',' inputmode="decimal"'):fv('Amount received',rupees(p.amount)))+
      (E?fin('Paid on','p-date',p.paidOn,'date'):fv('Paid on',fmt(p.paidOn)))+modeSel+
      (E?fin('Reference','p-ref',v('reference')):fv('Reference',p.reference||'—'))+
      (E?fin('Valid from','p-from',v('validFrom'),'date'):fv('Valid from',p.validFrom?fmt(p.validFrom):'—'))+
      (E?fin('Valid to','p-to',v('validTo'),'date'):fv('Valid to',p.validTo?fmt(p.validTo):'—'))+
      (E?fin('Note','p-note',v('note')):fv('Note',p.note||'—'))+fv('Recorded',fmtTime(p.createdAt)+(p.via?' · '+(p.via==='android'?'phone console':'web console'):''))+'</div>';
  const tools=N?[['Save','💾',C_.green,'save'],['Cancel','✕',C_.back,'close']]
    :[['Edit','✎',C_.blue,'edit',E],['Save','💾',C_.green,'save',!E],['Cancel','✕',C_.back,'cancel',!E],'|',['Customer','☺',C_.teal,'customer'],['Delete','🗑',C_.red,'delete'],'|',['Close','✕',C_.back,'close']];
  showWin('<div class="win small"><div class="wtitle"><span class="av" style="background:linear-gradient(135deg,#15803d,#34d399)">₹</span><div><h2>'+(N?'Record payment':esc(p.customer)+' · '+rupees(p.amount))+'<span class="mode'+(N?' new':E?' edit':'')+'">'+(N?'NEW':E?'EDIT':'DISPLAY')+'</span></h2><small>'+(N?'What came in, for which software and plan — and, if you like, the renewal it pays for':fmt(p.paidOn)+' · '+(p.software==='weight'?'Sales & Costing':'Fabric Stock'))+'</small></div><div class="wx"><button data-wtool="close">✕</button></div></div>'+
    '<div class="tbar">'+tbHtml(tools,'data-wtool')+'</div><div class="wbody"><div class="card">'+fields+'</div>'+
    (N?'<p class="help">With a renewal chosen, the licence is renewed in the same step and the payment keeps the validity it bought: Sales & Costing adds the time after what is left; Fabric Stock carries the days left into the new period. Without one, give the validity by hand if you know it.</p>':'')+'</div></div>');
}
async function payTool(k){
  const p=WIN.id?((PAYDATA&&PAYDATA.payments)||[]).find(z=>z.id===WIN.id):null;
  if(k==='close'){if(WIN.edit&&WIN.id&&!confirm('Close without saving?'))return;const b=WIN.back;WIN=null;document.getElementById('winLayer').innerHTML='';if(b)openCustomer(b.key,b.sw,b.sub);return;}
  if(k==='edit'){WIN.edit=true;return renderPayWin();}
  if(k==='cancel'){WIN.edit=false;return renderPayWin();}
  if(k==='customer'&&p){const x=customers().find(c=>(c.w&&String(c.w.id)===p.companyId)||(c.f&&String(c.f.id)===p.fabricId));if(x)openCustomer(x.key,p.software,'payments');return;}
  if(k==='delete'&&p){if(!confirm('Delete this payment of '+rupees(p.amount)+' from '+p.customer+'?  It leaves the list; the Activity list keeps that it was deleted.'))return;
    const r=await api('/admin/api/payments',{method:'POST',body:JSON.stringify({action:'delete',id:p.id})});
    if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}say('<div class="msg ok">Deleted.</div>');WIN=null;document.getElementById('winLayer').innerHTML='';await loadPayments();return;}
  if(k!=='save')return;
  const body={amount:val('p-amount'),paidOn:val('p-date'),mode:val('p-mode'),reference:val('p-ref'),kind:val('p-kind'),note:val('p-note'),validFrom:val('p-from')||undefined,validTo:val('p-to')||undefined};
  if(!WIN.id){
    const ck=val('p-cust'), sw=val('p-sw');const x=custByKey(ck);if(!x){say('<div class="msg err">Choose the customer.</div>');return;}
    Object.assign(body,{action:'add',software:sw,companyId:x.w?x.w.id:undefined,fabricId:sw==='fabric'&&x.f?x.f.id:undefined,extendDays:+val('p-ext')||undefined});
    if(sw==='fabric'&&!x.f){say('<div class="msg err">This customer has no Fabric Stock licence.</div>');return;}
  }else Object.assign(body,{action:'update',id:WIN.id});
  let r;try{r=await api('/admin/api/payments',{method:'POST',body:JSON.stringify(body)});}catch(e){r={error:e.message};}
  if(r.error){say('<div class="msg err">'+esc(r.message||r.error)+'</div>');return;}
  say('<div class="msg '+(r.warning?'warn':'ok')+'">'+esc(r.warning||('Recorded '+rupees(r.payment.amount)+' from '+r.payment.customer+(r.payment.validTo?' — valid to '+fmt(r.payment.validTo):'')+'.'))+'</div>');
  const b=WIN.back;WIN=null;document.getElementById('winLayer').innerHTML='';
  await loadPayments();if(body.extendDays){await load();await loadProducts();}
  if(b)openCustomer(b.key,b.sw,'payments');
}

/* ---------- software & plans ---------- */
function renderPlanList(){
  const host=document.getElementById('pllist');if(!host)return;
  const soft=document.getElementById('plSoft').value, term=(document.getElementById('plq').value||'').toLowerCase().trim();
  const wb=softBlock('weight'), fb=softBlock('fabric');
  const wf=wFeatures().length;
  document.getElementById('plFigs').innerHTML=
    '<div class="fig f1"><span>Sales & Costing</span><b>'+wPlans().length+' plans</b><small>'+wf+' features · '+wPlans().reduce((s,p)=>s+(p.customers||0),0)+' paying customers</small></div>'+
    '<div class="fig f2"><span>Fabric Stock</span><b>'+(fb&&fb.supported?fPlans().length+' plans':'—')+'</b><small>'+(fb?(fb.supported?(fb.features||[]).length+' features':(fb.ok?'no plans in its service yet':'not connected')):'reading…')+'</small></div>'+
    '<div class="fig f3"><span>Jobwork</span><b>—</b><small>joins when it has a licence</small></div>'+
    '<div class="fig f4"><span>Customer changes</span><b>'+wPlans().reduce((s,p)=>s+(p.changed||0),0)+'</b><small>customers with a feature added or off</small></div>';
  const rows=allPlans().filter(p=>(!soft||p.sw===soft)&&(!term||[p.name,p.code,p.note].some(v=>String(v||'').toLowerCase().includes(term))||(p.sw==='weight'&&wFeatures().some(fe=>p.features[fe.id]&&fe.label.toLowerCase().includes(term)))));
  PLLIST=rows;
  document.getElementById('plCount').textContent=rows.length+' plan'+(rows.length===1?'':'s');
  const fbNote=(!soft||soft==='fabric')&&fb&&!fb.supported?'<div class="msg warn" style="margin-bottom:10px"><b>Fabric Stock:</b> '+esc(fb.message||'its service did not answer')+'</div>':'';
  host.innerHTML=fbNote+(rows.length?'<table class="rec"><thead><tr><th>Software</th><th>Plan</th><th>Gives</th><th class="num">First year</th><th class="num">Renewal / year</th><th class="num">Users included</th><th class="num">Extra user / year</th><th class="num">Features</th><th class="num">Customers</th><th>State</th></tr></thead><tbody>'+
    rows.map(p=>{const fN=p.sw==='weight'?wf:((fb&&fb.features)||[]).length;const on=Object.keys(p.features||{}).filter(k=>p.features[k]).length;
      return '<tr data-open="pl:'+p.sw+':'+esc(p.code)+'"'+(SELKEY['sec-plans']==='pl:'+p.sw+':'+p.code?' class="on"':'')+'><td><span class="swd '+(p.sw==='weight'?'w':'f')+'"></span>'+(p.sw==='weight'?'Sales & Costing':'Fabric Stock')+'</td><td><b>'+esc(p.name)+'</b><small>'+esc(p.code)+'</small></td><td>'+esc(p.note||'—')+'</td>'+
      '<td class="num">'+rupees(p.priceFirst)+'</td><td class="num">'+rupees(p.priceRenewal)+'</td><td class="num">'+(p.usersIncluded||'—')+'</td><td class="num">'+rupees(p.extraUserPrice)+'</td>'+
      '<td class="num">'+on+' of '+fN+'</td><td class="num"><b>'+(p.customers||0)+'</b>'+(p.changed?'<small>'+p.changed+' changed</small>':'')+'</td><td class="'+(p.active===false?'c-none':'c-ok')+'">'+(p.active===false?'retired':'in use')+'</td></tr>';}).join('')+'</tbody></table>'
    :'<div class="empty">No plan here yet. <b>New plan</b> makes one.</div>');
}
async function openPlan(sw,code){
  if(!PLANDATA)await loadPlans();
  const b=softBlock(sw);
  if(!b||!b.supported){say('<div class="msg warn"><b>'+(sw==='fabric'?'Fabric Stock':'Sales & Costing')+':</b> '+esc((b&&b.message)||'its plans could not be read')+'</div>');return;}
  const p=code?planOf(sw,code):null;
  if(code&&!p){say('<div class="msg err">That plan is no longer there.</div>');return;}
  WIN={type:'plan',sw,code:p?p.code:'',edit:!p,draft:p?Object.assign({},p.features):{},tab:'features',copyFrom:''};
  renderPlanWin();
}
function renderPlanWin(){
  const b=softBlock(WIN.sw);if(!b)return;
  const p=WIN.code?planOf(WIN.sw,WIN.code):null, E=WIN.edit, N=!p;
  const feats=WIN.sw==='weight'?wFeatures():(b.features||[]);
  const groups=[];feats.forEach(fe=>{const g=fe.group||'Features';if(groups.indexOf(g)<0)groups.push(g);});
  const on=feats.filter(fe=>WIN.draft[fe.id]).length;
  const g=E?[fin('Plan name','pl-name',p?p.name:''),fin('Gives (a few words)','pl-note',p?p.note:'','text',' placeholder="e.g. calculation, quotation and the cost tools"'),fin('First year (₹, + GST)','pl-first',p&&p.priceFirst!=null?p.priceFirst:'','text',' placeholder="open" inputmode="decimal"'),fin('Renewal / year (₹, + GST)','pl-renew',p&&p.priceRenewal!=null?p.priceRenewal:'','text',' placeholder="open" inputmode="decimal"'),
      fin('Users included','pl-users',p&&p.usersIncluded!=null?p.usersIncluded:'','number',' min="1" max="500" placeholder="open"'),fin('Each extra user / year (₹)','pl-extra',p&&p.extraUserPrice!=null?p.extraUserPrice:'','text',' placeholder="open" inputmode="decimal"'),
      N?'<div class="fl"><span>Start from the ticks of</span><select id="pl-copy" onchange="planCopy(this.value)"><option value="">nothing ticked</option>'+(WIN.sw==='weight'?wPlans():fPlans()).map(z=>'<option value="'+esc(z.code)+'"'+(WIN.copyFrom===z.code?' selected':'')+'>'+esc(z.name)+'</option>').join('')+'</select></div>':fv('Code',p.code),
      fv('Software',WIN.sw==='weight'?'Sales & Costing':'Fabric Stock')]
    :[fv('Plan name',p.name),fv('Gives',p.note||'—'),fv('First year',p.priceFirst!=null?rupees(p.priceFirst)+' + GST':'open — not set'),fv('Renewal / year',p.priceRenewal!=null?rupees(p.priceRenewal)+' + GST':'open — not set'),
      fv('Users included',p.usersIncluded||'open'),fv('Each extra user / year',p.extraUserPrice!=null?rupees(p.extraUserPrice):'open'),fv('Customers on it',(p.customers||0)+(p.changed?' · '+p.changed+' with their own changes':'')),fv('State',p.active===false?'retired — not offered to new customers':'in use')];
  const grid=groups.map(gr=>'<div class="fgh">'+esc(gr)+'</div><div class="feat">'+feats.filter(fe=>(fe.group||'Features')===gr).map(fe=>{const o=!!WIN.draft[fe.id];
    return '<button class="fx '+(o?'on plan':'no')+'" data-wtool="pf-'+fe.id+'"'+(E?'':' disabled')+'><span class="cb">'+(o?'✓':'')+'</span><span class="nm">'+esc(fe.label)+'</span></button>';}).join('')+'</div>').join('');
  const custs=p?customers().filter(x=>WIN.sw==='weight'?(x.w&&!x.w.is_demo&&String(x.w.plan||'PRO').toUpperCase()===p.code):(x.f&&String(x.f.plan||'STANDARD').toUpperCase()===p.code)):[];
  const tab=WIN.tab==='customers'&&p?'<div class="card">'+(custs.length?'<table class="rec"><thead><tr><th>Customer</th><th>State</th><th>Ends</th><th>Own changes</th></tr></thead><tbody>'+custs.map(x=>{const l=WIN.sw==='weight'?x.w:x.f;const s=WIN.sw==='weight'?wState(l):fState(l);
      return '<tr data-open="c:'+x.key+':'+WIN.sw+':licence"><td><b>'+esc(x.name)+'</b></td><td class="'+stCls(s)+'">'+stWord(s)+'</td><td>'+fmt(WIN.sw==='weight'?l.expires_at:l.expiresAt)+'</td><td>'+(WIN.sw==='weight'&&ovCount(l)?'± '+ovCount(l):'—')+'</td></tr>';}).join('')+'</tbody></table>':'<p class="help">No paying customer is on this plan.</p>')+'</div>'
    :'<div class="card"><div class="sumline" style="margin-bottom:8px"><span><b>'+on+' of '+feats.length+'</b> features</span><span class="sub">'+(E?'Click to tick or untick. ':'')+'A tick changes every customer on this plan at their next check; a customer’s own additions and removals stay.</span></div>'+grid+'</div>';
  const tools=N?[['Save','💾',C_.green,'save'],['Cancel','✕',C_.back,'close']]
    :[['Edit','✎',C_.blue,'edit',E],['Save','💾',C_.green,'save',!E],['Cancel','✕',C_.back,'cancel',!E],'|',['Duplicate','⧉',C_.blue,'dup'],p.active===false?['Restore','▶',C_.green,'restore']:['Retire','⊘',C_.red,'retire'],['Delete','🗑',C_.red,'delete',p.builtIn||(p.customers||0)>0],'|',['Close','✕',C_.back,'close']];
  showWin('<div class="win"><div class="wtitle"><span class="av" style="background:'+(WIN.sw==='weight'?'linear-gradient(135deg,#3366ff,#6a8cff)':'linear-gradient(135deg,#10a37f,#2cc6b0)')+'">◫</span><div><h2>'+(WIN.sw==='weight'?'Sales & Costing':'Fabric Stock')+' · '+esc(p?p.name:'New plan')+'<span class="mode'+(N?' new':E?' edit':'')+'">'+(N?'NEW':E?'EDIT':'DISPLAY')+'</span></h2><small>'+(p?'Plan · '+(p.customers||0)+' customer'+((p.customers||0)===1?'':'s')+' on it':'A name, a price (or leave it open), how many users, and which features it gives')+'</small></div><div class="wx"><button data-wtool="close">✕</button></div></div>'+
    '<div class="tbar">'+tbHtml(tools,'data-wtool')+'</div><div class="wbody"><div class="card"><div class="fgrid">'+g.join('')+'</div></div>'+
    (p?'<div class="subt"><button class="'+(WIN.tab!=='customers'?'on':'')+'" data-wtool="tab-features">Features<small>'+on+'</small></button><button class="'+(WIN.tab==='customers'?'on':'')+'" data-wtool="tab-customers">Customers<small>'+custs.length+'</small></button></div>':'')+tab+'</div></div>');
}
function planCopy(code){WIN.copyFrom=code;const z=planOf(WIN.sw,code);WIN.draft=z?Object.assign({},z.features):{};
  const keep={};['pl-name','pl-note','pl-first','pl-renew','pl-users','pl-extra'].forEach(i=>{keep[i]=val(i);});renderPlanWin();Object.keys(keep).forEach(i=>{const n=document.getElementById(i);if(n&&keep[i]!==undefined)n.value=keep[i];});}
async function planTool(k){
  const p=WIN.code?planOf(WIN.sw,WIN.code):null;
  if(k==='close'){if(WIN.edit&&p&&!confirm('Close without saving?'))return;WIN=null;document.getElementById('winLayer').innerHTML='';return;}
  if(k==='edit'){WIN.edit=true;return renderPlanWin();}
  if(k==='cancel'){WIN.edit=false;WIN.draft=Object.assign({},p.features);return renderPlanWin();}
  if(k==='tab-features'||k==='tab-customers'){WIN.tab=k.slice(4);return renderPlanWin();}
  if(k.indexOf('pf-')===0&&WIN.edit){const id=k.slice(3);const keep={};['pl-name','pl-note','pl-first','pl-renew','pl-users','pl-extra'].forEach(i=>{keep[i]=val(i);});
    WIN.draft[id]=!WIN.draft[id];renderPlanWin();Object.keys(keep).forEach(i=>{const n=document.getElementById(i);if(n&&keep[i]!==undefined)n.value=keep[i];});return;}
  if(k==='dup'&&p){WIN={type:'plan',sw:WIN.sw,code:'',edit:true,draft:Object.assign({},p.features),tab:'features',copyFrom:p.code};renderPlanWin();const n=document.getElementById('pl-name');if(n){n.value=p.name+' copy';n.focus();}return;}
  const post=async(body)=>{let r;try{r=await api('/admin/api/plans',{method:'POST',body:JSON.stringify(Object.assign({software:WIN.sw},body))});}catch(e){r={error:e.message};}
    if(r.error){say('<div class="msg err">'+esc(r.message||r.error)+'</div>');return null;}return r;};
  if(k==='retire'&&p){if(!confirm('Retire '+p.name+'?  It is no longer offered to a new customer; the '+(p.customers||0)+' on it keep it.'))return;if(await post({action:'retire',code:p.code})){say('<div class="msg ok">Retired.</div>');await loadPlans();}return;}
  if(k==='restore'&&p){if(await post({action:'restore',code:p.code})){say('<div class="msg ok">In use again.</div>');await loadPlans();}return;}
  if(k==='delete'&&p){if(!confirm('Delete the plan '+p.name+'?'))return;if(await post({action:'delete',code:p.code})){say('<div class="msg ok">Deleted.</div>');WIN=null;document.getElementById('winLayer').innerHTML='';await loadPlans();}return;}
  if(k!=='save')return;
  const body={name:val('pl-name'),note:val('pl-note'),priceFirst:val('pl-first'),priceRenewal:val('pl-renew'),usersIncluded:val('pl-users'),extraUserPrice:val('pl-extra'),features:Object.assign({},WIN.draft)};
  if(!String(body.name||'').trim()){say('<div class="msg err">Give the plan a name.</div>');return;}
  const r=await post(Object.assign(body,p?{action:'update',code:p.code}:{action:'create',copyFrom:WIN.copyFrom||undefined}));
  if(!r)return;
  say('<div class="msg ok">'+(p?'Saved':'Made')+': '+esc(r.plan.name)+'. Every customer on it hears it at their next check.</div>');
  WIN={type:'plan',sw:WIN.sw,code:r.plan.code,edit:false,draft:Object.assign({},r.plan.features),tab:'features'};
  await loadPlans();
}

/* ---------- new customer: any software, each its own licence ---------- */
/* the older page called it createCo; New customer is the window now */
function createCo(){openNewCustomer();}
function openNewCustomer(only){WIN={type:'newcust',only:only==='weight'||only==='fabric'?only:''};renderNewCust();}
function renderNewCust(){
  const wp=wPlans().filter(p=>p.active!==false), fb=softBlock('fabric'), fp=fabricProduct();
  const fOk=!!(fp&&fp.ok);
  showWin('<div class="win"><div class="wtitle"><span class="av" style="background:linear-gradient(135deg,#10b981,#34d399)">+</span><div><h2>New customer<span class="mode new">NEW</span></h2><small>One customer, any software — each gets its own licence key</small></div><div class="wx"><button data-wtool="close">✕</button></div></div>'+
    '<div class="tbar">'+tbHtml([['Save','💾',C_.green,'save'],['Cancel','✕',C_.back,'close']],'data-wtool')+'</div><div class="wbody">'+
    '<div class="card"><div class="fgrid">'+fin('Company name','n-name','')+fin('GSTIN','n-gstin','','text',' maxlength="15" style="text-transform:uppercase"')+fin('Email','n-email','')+fin('Mobile','n-phone','')+
      fin('Administrator (optional)','n-admin','','text',' placeholder="the person who adds everyone else"')+fin('Administrator PIN','n-pin','','password',' placeholder="4 digits or more" autocomplete="new-password"')+'</div></div>'+
    '<div class="card"><h3 style="margin:0 0 10px">Which software, on which plan</h3><table class="rec" style="cursor:default"><thead><tr><th style="width:36px"></th><th>Software</th><th>Plan</th><th>Start as</th><th class="num">Days</th><th class="num">Seats / users</th><th class="num">Offline days</th><th>Price</th></tr></thead><tbody>'+
    '<tr style="cursor:default"><td><input type="checkbox" id="n-w" checked></td><td><span class="swd w"></span><b>Sales & Costing</b></td><td><select id="n-wplan">'+wp.map(p=>'<option value="'+esc(p.code)+'"'+(p.code==='PRO'?' selected':'')+'>'+esc(p.name)+(p.note?' — '+esc(p.note):'')+'</option>').join('')+'</select></td><td>Licensed</td>'+
      '<td class="num"><input id="n-wdays" type="number" value="365" min="1" style="width:80px"></td><td class="num"><input id="n-wseats" type="number" value="1" min="1" style="width:70px"></td><td class="num"><input id="n-wgrace" type="number" value="3" min="0" style="width:70px"></td><td class="sub" id="n-wprice"></td></tr>'+
    '<tr style="cursor:default"><td><input type="checkbox" id="n-f"'+(fOk?'':' disabled')+'></td><td><span class="swd f"></span><b>Fabric Stock</b></td><td>'+(fb&&fb.supported?'<select id="n-fplan">'+fPlans().filter(p=>p.active!==false).map(p=>'<option value="'+esc(p.code)+'">'+esc(p.name)+'</option>').join('')+'</select>':'Standard')+'</td>'+
      '<td><select id="n-fstate"'+(fOk?'':' disabled')+'><option value="DEMO">Demo</option><option value="LICENSED">Licensed</option></select></td><td class="num"><input id="n-fdays" type="number" value="7" min="1" style="width:80px"'+(fOk?'':' disabled')+'></td>'+
      '<td class="num"><input id="n-fseats" type="number" value="3" min="1" style="width:70px"'+(fOk?'':' disabled')+'></td><td class="num"><input id="n-fgrace" type="number" value="0" min="0" max="30" style="width:70px"'+(fOk?'':' disabled')+'></td><td class="sub">'+(fOk?'':'Fabric Stock is not connected')+'</td></tr>'+
    '<tr style="cursor:default"><td><input type="checkbox" disabled></td><td class="c-none"><span class="swd j"></span>Jobwork</td><td colspan="6" class="c-none">coming — no licence yet</td></tr></tbody></table>'+
    '<p class="help">On Save each software ticked gets its own licence key, made in its own service; they are shown with each other as one customer. A plant that registers itself from the application appears here on its own, as a demo.</p></div></div></div>');
  const wsel=document.getElementById('n-wplan');const price=()=>{const p=planOf('weight',wsel.value);document.getElementById('n-wprice').textContent=p&&p.priceFirst!=null?rupees(p.priceFirst)+' first year':'price open';};
  if(wsel){wsel.onchange=price;price();}
  if(WIN.only==='fabric'){document.getElementById('n-w').checked=false;if(fOk)document.getElementById('n-f').checked=true;}
}
async function newCustTool(k){
  if(k==='close'){WIN=null;document.getElementById('winLayer').innerHTML='';return;}
  if(k!=='save')return;
  const name=(val('n-name')||'').trim();if(!name){say('<div class="msg err">A company name is required.</div>');return;}
  const W=document.getElementById('n-w').checked, F=document.getElementById('n-f').checked;
  if(!W&&!F){say('<div class="msg err">Tick at least one software.</div>');return;}
  const gstin=(val('n-gstin')||'').trim().toUpperCase(), email=(val('n-email')||'').trim(), phone=(val('n-phone')||'').trim(), admin=(val('n-admin')||'').trim(), pin=val('n-pin')||'';
  let made=null, fmade=null;const notes=[];
  if(W){
    const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({action:'create',name,gstin,email,phone,plan:val('n-wplan'),days:+val('n-wdays')||365,seats:+val('n-wseats')||1,graceDays:+val('n-wgrace')||0})});
    if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
    made=r.company;
    if(admin&&pin){const a=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:made.id,action:'adminuser',name:admin,pin,email})});if(a.error)notes.push('Sales & Costing administrator: '+a.error);}
  }
  if(F){
    const body={action:'create',name,state:val('n-fstate'),days:+val('n-fdays')||7,seats:+val('n-fseats')||3,graceDays:+val('n-fgrace')||0,gstin:gstin||undefined,email:email||undefined,phone:phone||undefined,linkTo:made?made.id:undefined};
    if(document.getElementById('n-fplan'))body.plan=val('n-fplan');
    if(admin&&pin){body.adminName=admin;body.adminPin=pin;}
    let r;try{r=await api('/admin/api/fabric',{method:'POST',body:JSON.stringify(body)});}catch(e){r={error:e.message};}
    if(r.error)notes.push('Fabric Stock: '+(r.message||r.error));else fmade=r.company;
  }
  WIN=null;document.getElementById('winLayer').innerHTML='';
  await load();await loadProducts();
  say('<div class="msg '+(notes.length?'warn':'ok')+'"><b>'+esc(name)+'</b> made.'+(made?' Sales & Costing key <span class="key">'+esc(made.licence_key)+'</span>.':'')+(fmade?' Fabric Stock key <span class="key">'+esc(fmade.licenceKey)+'</span>.':'')+(notes.length?'<br>'+notes.map(esc).join('<br>'):'')+'</div>');
  const key=made?'w'+made.id:(fmade?'f'+fmade.id:null);if(key)openCustomer(key,made?'weight':'fabric','licence');
}

/* ---------- dashboard ---------- */
function renderDashboard(){
  const s=document.getElementById('dashSoft');if(!s)return;
  const all=customers(), fp=fabricProduct();
  const ws=all.filter(x=>x.w).map(x=>wState(x.w)), fs=all.filter(x=>x.f).map(x=>fState(x.f));const n=(a,v)=>a.filter(z=>z===v).length;
  const pays=(PAYDATA&&PAYDATA.payments)||[];const t=isoToday(), m=t.slice(0,8)+'01';
  const month=pays.filter(p=>p.paidOn>=m).reduce((z,p)=>z+(p.amount||0),0);
  s.innerHTML='<div class="fig f1"><span>Sales & Costing</span><b>'+ws.length+'</b><small>'+n(ws,'LICENSED')+' licensed · '+n(ws,'DEMO')+' demo · '+n(ws,'SUSPENDED')+' suspended</small></div>'+
    '<div class="fig f2"><span>Fabric Stock</span><b>'+(fp&&fp.ok?fs.length:'—')+'</b><small>'+(fp&&fp.ok?n(fs,'LICENSED')+' licensed · '+n(fs,'DEMO')+' demo':(fp?'not connected':'reading…'))+'</small></div>'+
    '<div class="fig f3"><span>Received this month</span><b>'+rupees(month)+'</b><small>'+pays.filter(p=>p.paidOn>=m).length+' payments</small></div>'+
    '<div class="fig f4"><span>Plans</span><b>'+allPlans().length+'</b><small>'+wPlans().length+' Sales & Costing · '+fPlans().length+' Fabric Stock</small></div>';
  document.getElementById('dashNote').textContent=all.length+' customers';
  const end=validityRows().filter(r=>(r.state==='LICENSED'||r.state==='DEMO')&&r.left<=30).slice(0,10);
  document.getElementById('dashEnding').innerHTML=end.length?'<table class="rec"><thead><tr><th>Customer</th><th>Software</th><th>Plan</th><th>State</th><th>Ends</th><th class="num">Days left</th></tr></thead><tbody>'+end.map(r=>'<tr data-open="c:'+r.x.key+':'+r.sw+':licence"><td><b>'+esc(r.x.name)+'</b></td><td><span class="swd '+(r.sw==='weight'?'w':'f')+'"></span>'+(r.sw==='weight'?'Sales & Costing':'Fabric Stock')+'</td><td>'+esc(r.plan)+'</td><td class="'+stCls(r.state)+'">'+stWord(r.state)+'</td><td><b>'+fmt(r.ends)+'</b></td><td class="num c-warn">'+r.left+'</td></tr>').join('')+'</tbody></table>':'<p class="help">Nothing ends within 30 days.</p>';
  const lp=pays.slice(0,8);
  document.getElementById('dashPay').innerHTML=lp.length?'<table class="rec"><thead><tr><th>Paid on</th><th>Customer</th><th>Software</th><th>Plan</th><th class="num">Amount</th><th>Valid to</th></tr></thead><tbody>'+lp.map(p=>'<tr data-open="p:'+p.id+'"><td>'+fmt(p.paidOn)+'</td><td><b>'+esc(p.customer)+'</b></td><td><span class="swd '+(p.software==='weight'?'w':'f')+'"></span>'+(p.software==='weight'?'Sales & Costing':'Fabric Stock')+'</td><td>'+esc(p.planName||'—')+'</td><td class="num"><b>'+rupees(p.amount)+'</b></td><td>'+(p.validTo?fmt(p.validTo):'—')+'</td></tr>').join('')+'</tbody></table>':'<p class="help">No payment recorded yet. <b>Record payment</b> keeps one.</p>';
}

/* ---------- Excel: the rows on screen, as a CSV Excel opens ---------- */
function csvCell(v){const s=String(v==null?'':v);return /[",;]/.test(s)||s.indexOf(String.fromCharCode(10))>=0?'"'+s.replace(/"/g,'""')+'"':s;}
function downloadCsv(name,rows){
  const text=String.fromCharCode(65279)+rows.map(r=>r.map(csvCell).join(',')).join(NL);
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));a.download=name+'-'+isoToday()+'.csv';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);
}
function csvCustomers(){const all=customers().filter(x=>CLIST.indexOf(x.key)>=0);
  downloadCsv('nexora-customers',[['Customer','GSTIN','Email','Mobile','Sales & Costing plan','Sales & Costing state','Sales & Costing ends','Fabric Stock plan','Fabric Stock state','Fabric Stock ends']].concat(all.map(x=>[x.name,x.gstin,x.email,x.phone,
    x.w?planNameOf('weight',x.w.plan):'',x.w?stWord(wState(x.w)):'',x.w?String(x.w.expires_at||'').slice(0,10):'',x.f?planNameOf('fabric',x.f.plan):'',x.f?stWord(fState(x.f)):'',x.f?String(x.f.expiresAt||'').slice(0,10):''])));}
function csvValidity(){downloadCsv('nexora-validity',[['Customer','Software','Plan','State','Started','Ends','Days left','Seats','Last payment','Paid on']].concat(VLIST.map(r=>[r.x.name,r.sw==='weight'?'Sales & Costing':'Fabric Stock',r.plan,stWord(r.state),String(r.start||'').slice(0,10),String(r.ends||'').slice(0,10),r.left,r.seats,r.pay?r.pay.amount:'',r.pay?r.pay.paidOn:''])));}
function csvPayments(){downloadCsv('nexora-payments',[['Paid on','Customer','Software','Plan','For','Amount','How','Reference','Valid from','Valid to','Note']].concat(PLIST.map(p=>[p.paidOn,p.customer,p.software==='weight'?'Sales & Costing':'Fabric Stock',p.planName,KIND_WORDS[p.kind]||p.kind,p.amount,p.mode,p.reference,p.validFrom,p.validTo,p.note])));}

/* ---------- by software (owner: "by customer pan joi sakay ane by software wise pan joi sakay") ----------
   Sales & Costing alone, Fabric Stock alone: that software's customers, its plans and its payments. A row
   opens the customer's window on that software's tab. */
const SWF={weight:{quick:'all',tab:'customers'},fabric:{quick:'all',tab:'customers'}};
const SWNAME={weight:'Sales & Costing',fabric:'Fabric Stock'};
function swLic(x,sw){return sw==='weight'?x.w:x.f;}
function swSt(sw,l){return sw==='weight'?wState(l):fState(l);}
function swEnds(sw,l){return sw==='weight'?l.expires_at:l.expiresAt;}
function swLeft(sw,l){return sw==='weight'?l.days_left:l.daysLeft;}
function swStart(sw,l){return sw==='weight'?l.period_started_at:(l.periodStartedAt||l.createdAt);}
function swQuick(sw,v){SWF[sw].quick=v;renderSoftware(sw);}
function swTab(sw,v){SWF[sw].tab=v;renderSoftware(sw);}
function clearSoftwareFilter(sw){['q','from','to','plan','state'].forEach(i=>{document.getElementById('sw-'+i+'-'+sw).value='';});SWF[sw].quick='all';renderSoftware(sw);}
function fyStart(){const t=isoToday();return (+t.slice(5,7)>=4?t.slice(0,4):String(+t.slice(0,4)-1))+'-04-01';}
function renderSoftware(sw){
  const host=document.getElementById('sw-list-'+sw);if(!host)return;
  const g=id=>document.getElementById('sw-'+id+'-'+sw);
  const term=(g('q').value||'').toLowerCase().trim(), plan=g('plan').value, st=g('state').value, from=g('from').value, to=g('to').value;
  const ps=g('plan'), keep=ps.value;
  ps.innerHTML='<option value="">Any plan</option>'+(sw==='weight'?wPlans():fPlans()).map(p=>'<option value="'+esc(p.code)+'">'+esc(p.name)+'</option>').join('');ps.value=keep;
  const fp=fabricProduct(), off=sw==='fabric'&&!(fp&&fp.ok);
  const all=customers().filter(x=>swLic(x,sw));
  const S=x=>swSt(sw,swLic(x,sw)), L=x=>swLeft(sw,swLic(x,sw)), live=x=>S(x)==='LICENSED'||S(x)==='DEMO';
  const cnt=fn=>all.filter(fn).length;
  const Q=[['all','All',all.length],['30','Ending in 30 days',cnt(x=>live(x)&&L(x)<=30)],['demo','On a demo',cnt(x=>S(x)==='DEMO')],['ended','Ended',cnt(x=>S(x)==='EXPIRED')],
    ['susp','Suspended',cnt(x=>S(x)==='SUSPENDED')],['both','Also on '+(sw==='weight'?'Fabric Stock':'Sales & Costing'),cnt(x=>x.w&&x.f)]];
  g('quick').innerHTML='<span>Quick:</span>'+Q.map(q=>'<span class="qb'+(SWF[sw].quick===q[0]?' on':'')+'" data-sw="'+sw+'" data-q="'+q[0]+'" onclick="swQuick(this.dataset.sw,this.dataset.q)">'+esc(q[1])+'<i>'+q[2]+'</i></span>').join('');
  const j=document.getElementById('jump-sw-'+sw);if(j){j.textContent=off?'–':all.length;j.className=all.length?'':'zero';}
  const pays=((PAYDATA&&PAYDATA.payments)||[]).filter(p=>p.software===sw), fy=fyStart();
  const fyPays=pays.filter(p=>p.paidOn>=fy), sum=a=>a.reduce((z,p)=>z+(p.amount||0),0);
  const plans=sw==='weight'?wPlans():fPlans(), sb=softBlock(sw);
  g('count').textContent=SWNAME[sw]+' · '+all.length+' customer'+(all.length===1?'':'s');
  g('note').textContent=off?'not connected':(sw==='weight'?(DATA.licences||[]).length+' computers and phones':all.reduce((z,x)=>z+(+x.f.devices||0),0)+' computers and phones');
  g('figs').innerHTML=
    '<div class="fig '+(sw==='weight'?'f1':'f2')+'"><span>Customers</span><b>'+(off?'—':all.length)+'</b><small>'+cnt(x=>S(x)==='LICENSED')+' licensed · '+cnt(x=>S(x)==='DEMO')+' demo · '+cnt(x=>S(x)==='SUSPENDED')+' suspended</small></div>'+
    '<div class="fig f3"><span>Ending in 30 days</span><b>'+cnt(x=>live(x)&&L(x)<=30)+'</b><small>'+cnt(x=>S(x)==='LICENSED'&&L(x)<=30)+' paying · '+cnt(x=>S(x)==='DEMO'&&L(x)<=30)+' demos</small></div>'+
    '<div class="fig f2"><span>Received this financial year</span><b>'+rupees(sum(fyPays))+'</b><small>'+fyPays.length+' payments since '+fmt(fy)+'</small></div>'+
    '<div class="fig f4"><span>Plans</span><b>'+(sb&&sb.supported?plans.length:'—')+'</b><small>'+(sb&&sb.supported?plans.filter(p=>p.active!==false).length+' in use':(sb&&sb.message?'no plans in its service yet':'reading…'))+'</small></div>';
  const tab=SWF[sw].tab;
  g('tabs').innerHTML=[['customers','Customers',all.length],['plans','Plans',plans.length],['payments','Payments',pays.length]].map(t=>'<button class="'+(tab===t[0]?'on':'')+'" data-sw="'+sw+'" data-t="'+t[0]+'" onclick="swTab(this.dataset.sw,this.dataset.t)">'+t[1]+'<small>'+t[2]+'</small></button>').join('');
  if(off&&tab!=='payments'){host.innerHTML=fabricNote();return;}
  if(tab==='plans'){
    if(!(sb&&sb.supported)){host.innerHTML='<div class="msg warn">'+esc((sb&&sb.message)||'Its plans could not be read.')+'</div>';return;}
    const fN=sw==='weight'?wFeatures().length:(sb.features||[]).length;
    host.innerHTML='<table class="rec"><thead><tr><th>Plan</th><th>Gives</th><th class="num">First year</th><th class="num">Renewal / year</th><th class="num">Users included</th><th class="num">Extra user / year</th><th class="num">Features</th><th class="num">Customers</th><th>State</th></tr></thead><tbody>'+
      plans.map(p=>'<tr data-open="pl:'+sw+':'+esc(p.code)+'"><td><b>'+esc(p.name)+'</b><small>'+esc(p.code)+'</small></td><td>'+esc(p.note||'—')+'</td><td class="num">'+rupees(p.priceFirst)+'</td><td class="num">'+rupees(p.priceRenewal)+'</td><td class="num">'+(p.usersIncluded||'—')+'</td><td class="num">'+rupees(p.extraUserPrice)+'</td><td class="num">'+Object.keys(p.features||{}).filter(k=>p.features[k]).length+' of '+fN+'</td><td class="num"><b>'+(p.customers||0)+'</b></td><td class="'+(p.active===false?'c-none':'c-ok')+'">'+(p.active===false?'retired':'in use')+'</td></tr>').join('')+
      '</tbody></table><div class="acts" style="margin-top:10px"><button class="primary" data-sw="'+sw+'" onclick="openPlan(this.dataset.sw,null)">+ New '+esc(SWNAME[sw])+' plan</button></div>';
    return;
  }
  if(tab==='payments'){
    const rows=pays.filter(p=>(!term||[p.customer,p.reference,p.note].some(v=>String(v||'').toLowerCase().includes(term)))&&(!from||p.paidOn>=from)&&(!to||p.paidOn<=to));
    host.innerHTML=rows.length?'<table class="rec"><thead><tr><th>Paid on</th><th>Customer</th><th>Plan</th><th>For</th><th class="num">Amount</th><th>How</th><th>Reference</th><th>Valid to</th></tr></thead><tbody>'+
      rows.map(p=>'<tr data-open="p:'+p.id+'"><td><b>'+fmt(p.paidOn)+'</b></td><td><b>'+esc(p.customer)+'</b></td><td>'+esc(p.planName||'—')+'</td><td>'+esc(KIND_WORDS[p.kind]||p.kind)+'</td><td class="num"><b>'+rupees(p.amount)+'</b></td><td>'+esc(p.mode||'—')+'</td><td>'+esc(p.reference||'—')+'</td><td>'+(p.validTo?fmt(p.validTo):'—')+'</td></tr>').join('')+
      '</tbody><tfoot><tr><td colspan="4">Total</td><td class="num">'+rupees(sum(rows))+'</td><td colspan="3"></td></tr></tfoot></table>'
      :'<div class="empty">No '+esc(SWNAME[sw])+' payment in this view.</div>';
    return;
  }
  const rows=all.filter(x=>{const l=swLic(x,sw);
    if(term&&![x.name,x.gstin,x.email,x.phone,sw==='weight'?l.licence_key:l.licenceKey,sw==='weight'?l.login_id:l.loginId].some(v=>String(v||'').toLowerCase().includes(term)))return false;
    if(plan&&String(l.plan||(sw==='weight'?'PRO':'STANDARD')).toUpperCase()!==plan)return false;
    if(st&&S(x)!==st)return false;
    const d=String(swEnds(sw,l)||'').slice(0,10);if(from&&d<from)return false;if(to&&d>to)return false;
    const q=SWF[sw].quick;
    if(q==='30'&&!(live(x)&&L(x)<=30))return false;if(q==='demo'&&S(x)!=='DEMO')return false;if(q==='ended'&&S(x)!=='EXPIRED')return false;
    if(q==='susp'&&S(x)!=='SUSPENDED')return false;if(q==='both'&&!(x.w&&x.f))return false;
    return true;}).sort((a,b)=>new Date(swEnds(sw,swLic(a,sw)))-new Date(swEnds(sw,swLic(b,sw))));
  host.innerHTML=rows.length?'<table class="rec"><thead><tr><th>Customer</th><th>Plan</th><th>State</th><th>Started</th><th>Ends</th><th class="num">Days left</th><th class="num">Seats</th><th class="num">Computers</th><th>Last payment</th><th>Also on</th></tr></thead><tbody>'+
    rows.map(x=>{const l=swLic(x,sw), s=S(x), lp=lastPay(sw,x);
      return '<tr data-open="c:'+x.key+':'+sw+':licence"><td><b>'+esc(x.name)+'</b><small>'+esc(x.gstin||'')+'</small></td>'+
        '<td>'+esc(planNameOf(sw,l.plan))+(ovCount(l)?' <span style="color:var(--accent)">± '+ovCount(l)+'</span>':'')+'</td><td class="'+stCls(s)+'">'+stWord(s)+'</td>'+
        '<td>'+fmt(swStart(sw,l))+'</td><td><b>'+fmt(swEnds(sw,l))+'</b></td><td class="num '+(live(x)&&L(x)<=30?'c-warn':'')+'">'+(live(x)?L(x):'—')+'</td>'+
        '<td class="num">'+(sw==='weight'?(+l.users_total||0):(+l.people||0))+' of '+l.seats+'</td><td class="num">'+(sw==='weight'?(l.machines_used||0):(+l.devices||0))+'</td>'+
        '<td>'+(lp?'<b>'+rupees(lp.amount)+'</b><small>'+fmt(lp.paidOn)+'</small>':'<span class="c-none">none recorded</span>')+'</td>'+
        '<td>'+(sw==='weight'?(x.f?'<span class="swd f"></span>Fabric Stock':'<span class="c-none">—</span>'):(x.w?'<span class="swd w"></span>Sales &amp; Costing':'<span class="c-none">—</span>'))+'</td></tr>';}).join('')+'</tbody></table>'
    :'<div class="empty">No '+esc(SWNAME[sw])+' customer in this view.</div>';
}
function csvSoftware(sw){const all=customers().filter(x=>swLic(x,sw));
  downloadCsv('nexora-'+(sw==='weight'?'sales-costing':'fabric-stock'),[['Customer','GSTIN','Plan','State','Started','Ends','Days left','Seats','Email','Mobile']].concat(all.map(x=>{const l=swLic(x,sw);
    return [x.name,x.gstin,planNameOf(sw,l.plan),stWord(swSt(sw,l)),String(swStart(sw,l)||'').slice(0,10),String(swEnds(sw,l)||'').slice(0,10),swLeft(sw,l),l.seats,x.email,x.phone];})));}

</script></body></html>`;

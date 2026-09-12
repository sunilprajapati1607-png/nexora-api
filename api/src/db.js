/**
 * Nexora API — database access
 * ----------------------------------------------------------------------
 * One connection, created once at module scope so it is reused across
 * invocations, and a schema that creates itself on first use.
 *
 * The client is `pgmini` rather than `pg`: Neon Functions ship whatever
 * they need inside the uploaded archive, and a 60 KB driver for a handful
 * of parameterised statements is most of the payload. See pgmini.js.
 *
 * The schema bootstraps here rather than in a migration script because
 * nothing outside this function can reach the database — the service IS
 * the only client, so it owns its own tables.
 */
import { createClient } from './pgmini.js';

export const pool = createClient(process.env.DATABASE_URL);

export async function q(text, params) {
  return pool.query(text, params);
}

let ready = null;

/** Idempotent. Every statement is IF NOT EXISTS, so it is safe on every
 *  cold start and safe to run concurrently. */
export function ensureSchema() {
  if (ready) return ready;
  ready = (async () => {
    await q(`
      CREATE TABLE IF NOT EXISTS licences (
        device_id        TEXT PRIMARY KEY,
        device_name      TEXT,
        company          TEXT,
        email            TEXT,
        state            TEXT NOT NULL DEFAULT 'TRIAL',
        trial_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at       TIMESTAMPTZ NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at     TIMESTAMPTZ,
        seen_count       INTEGER NOT NULL DEFAULT 0,
        app_version      TEXT,
        notes            TEXT
      )`);
    await q(`
      CREATE TABLE IF NOT EXISTS activation_log (
        id        BIGSERIAL PRIMARY KEY,
        device_id TEXT,
        at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        event     TEXT NOT NULL,
        detail    JSONB
      )`);
    await q(`CREATE INDEX IF NOT EXISTS activation_log_device_idx ON activation_log (device_id, at DESC)`);
    await q(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);

    /* ---- 4.0.0 — COMPANIES ------------------------------------------
       A company is the licence. One key, N seats, one expiry, one state.
       Suspending the company stops every one of its machines at once,
       which is the whole point of "more than one licence, connected to
       each other".

       Every device row gains company_id. Existing rows have none; they
       are backfilled lazily on their next activate/heartbeat rather than
       by a sweeping UPDATE, so an installation that never comes back is
       never touched and no existing data is rewritten (rule #28). */
    await q(`
      CREATE TABLE IF NOT EXISTS companies (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        licence_key TEXT NOT NULL UNIQUE,
        email       TEXT,
        phone       TEXT,
        state       TEXT NOT NULL DEFAULT 'DEMO',
        seats       INTEGER NOT NULL DEFAULT 1,
        grace_days  INTEGER NOT NULL DEFAULT 0,
        is_demo     BOOLEAN NOT NULL DEFAULT true,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        notes       TEXT
      )`);
    await q(`CREATE INDEX IF NOT EXISTS companies_key_idx ON companies (licence_key)`);

    /* 4.2.0 — the customer's GST number, against the COMPANY (which is
       the licence). Additive, like every other change here.

       NOT unique, deliberately. One GSTIN can hold more than one Nexora
       licence — a group with two plants on one registration is ordinary
       — and a UNIQUE constraint would refuse the second one at midnight
       with a database error nobody could read. The later "one database
       per customer" work needs to FIND a company by GSTIN, which an
       index gives; it does not need the database to forbid a second. */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS gstin TEXT`);
    await q(`CREATE INDEX IF NOT EXISTS companies_gstin_idx ON companies (gstin)`);

    /* ADD COLUMN IF NOT EXISTS is the safe form: it does nothing on a
       database that already has them, so this runs on every cold start. */
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS company_id BIGINT`);
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS seat_no INTEGER`);
    await q(`CREATE INDEX IF NOT EXISTS licences_company_idx ON licences (company_id)`);

    /* 4.3.0 — USAGE METERING.

       txn_limit is how many transactions this LICENCE may commit. It sits
       on the company, not on the device, for the same reason the clock
       does: the company IS the licence, and a limit that could be reset
       by installing on a second machine is not a limit.

       DEFAULT 0 MEANS NO LIMIT, deliberately. Every company that already
       exists gets 0 when this column appears, so nothing that works today
       starts refusing tomorrow. A metering feature must never be able to
       stop a plant that was never sold a cap. */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS txn_limit INTEGER NOT NULL DEFAULT 0`);

    /* Per device, because each machine reports its own. The company total
       is the SUM across its seats, computed when needed rather than
       stored, so it cannot drift out of step with the rows it came from. */
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS txn_count INTEGER NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS usage_minutes INTEGER NOT NULL DEFAULT 0`);

    /* Defaults, written once. ON CONFLICT DO NOTHING means an operator's
       later change is never overwritten by a cold start. */
    await q(`INSERT INTO settings (key, value) VALUES
               ('trial_days', '7'),
               ('expired_mode', 'READONLY'),
               ('signups_open', 'yes'),
               ('demo_grace_days', '0'),
               ('session_minutes', '30')
             ON CONFLICT (key) DO NOTHING`);
    return true;
  })();
  return ready;
}

export async function getSettings() {
  const rows = await q(`SELECT key, value FROM settings`);
  const s = {};
  rows.forEach((r) => { s[r.key] = r.value; });
  return {
    trialDays: Math.max(1, parseInt(s.trial_days, 10) || 7),
    expiredMode: s.expired_mode === 'HARDSTOP' ? 'HARDSTOP' : 'READONLY',
    signupsOpen: s.signups_open !== 'no',
    /* 4.0.0 — how long a DEMO may run with no contact. Zero by design:
       a demo taken offline stops working. */
    demoGraceDays: Math.max(0, parseInt(s.demo_grace_days, 10) || 0),
    /* With no grace at all the app would need a round trip per keystroke,
       which is absurd. This is the working window a good answer stays
       usable for — caching, not grace. The app re-checks well inside it. */
    sessionMinutes: Math.min(720, Math.max(5, parseInt(s.session_minutes, 10) || 30))
  };
}

export async function logEvent(deviceId, event, detail) {
  try {
    await q(`INSERT INTO activation_log (device_id, event, detail) VALUES ($1, $2, $3)`,
      [deviceId || null, event, detail ? JSON.stringify(detail) : null]);
  } catch (e) { /* logging must never break a request */ }
}

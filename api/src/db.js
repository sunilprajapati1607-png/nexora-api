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

/* Where the connection string lives depends on the host, and the choice has
   to be made by READING, never by writing.
     DATABASE_URL      what Render is given
     SUPABASE_DB_URL   what Supabase injects into an Edge Function
     NEXORA_DB_URL     an override, so the pooler can be changed by adding a
                       secret rather than by editing code
   4.34.0 — the Edge entry used to copy SUPABASE_DB_URL into DATABASE_URL so
   that this line would not have to change. The Edge runtime REFUSES writes
   to process.env: "NotSupported", thrown from inside the node:process shim,
   AFTER the function has booted. Every route then answers 500 with nothing
   in the body to explain it. Reading is fine, so the fallback belongs here. */
export const pool = createClient(
  process.env.NEXORA_DB_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL
);

export async function q(text, params) {
  return pool.query(text, params);
}

let ready = null;

/** Idempotent. Every statement is IF NOT EXISTS, so it is safe on every
 *  cold start and safe to run concurrently. */
/** 4.31.0 - rows written before expiry landed at end of day are moved to
 *  23:59:59 Asia/Kolkata of their day. Idempotent; run on every boot. */
export async function moveExpiriesToEndOfDay() {
  await q(`UPDATE companies SET expires_at = nexora_eod(expires_at) WHERE expires_at <> nexora_eod(expires_at)`);
  await q(`UPDATE licences  SET expires_at = nexora_eod(expires_at) WHERE expires_at <> nexora_eod(expires_at)`);
}

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
    /* ---- 4.23.0 — SELF-REGISTRATION ---------------------------------
       A plant registers itself: company + GSTIN + email + mobile, a
       company login id and passcode its other machines activate with,
       the IP and device it registered from, and what the GST check
       said. Every one an ALTER of its own, because CREATE TABLE IF NOT
       EXISTS above does nothing for a database that already has the
       table (the 4.19.0 lesson). DEFAULTs are chosen so every company
       that already exists reads as: not self-registered, GST not yet
       verified — which is the truth. */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS login_id TEXT`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS companies_login_idx ON companies (login_id) WHERE login_id IS NOT NULL`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS passcode_hash TEXT`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS self_registered BOOLEAN NOT NULL DEFAULT false`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS registered_ip TEXT`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS registered_device TEXT`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS gst_status TEXT NOT NULL DEFAULT 'UNVERIFIED'`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS gst_checked_at TIMESTAMPTZ`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS gst_note TEXT`);
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
    /* 4.6.0 — an owner's RESET of a machine's usage. The reported counts
       are monotonic (a reinstall must not lower them), so a reset cannot
       simply zero txn_count: the next heartbeat would put it straight
       back. Instead the reset records where the count stood, and every
       figure shown or enforced is count − base. The raw report is never
       altered, so the monotonic guarantee survives the reset. */
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS txn_base INTEGER NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS usage_base INTEGER NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ`);
    /* 4.31.0 — a licence ends at the END of its last day, Indian time.
       "if a licence shows Expires Sep 23, the customer can use it for the
       entire working day without it stopping mid-shift." nexora_eod()
       moves any instant to 23:59:59 IST (+05:30, no daylight saving, so a
       fixed offset is exact and needs no zone table) of that calendar day;
       every write of expires_at goes through it, and rows written before
       4.31.0 are moved once here (idempotent: eod(eod(x)) = eod(x)). */
    await q(`CREATE OR REPLACE FUNCTION nexora_eod(ts TIMESTAMPTZ) RETURNS TIMESTAMPTZ
             LANGUAGE sql IMMUTABLE AS $f$
               SELECT (((ts AT TIME ZONE INTERVAL '+05:30')::date + INTERVAL '1 day' - INTERVAL '1 second') AT TIME ZONE INTERVAL '+05:30')
             $f$`);
    await moveExpiriesToEndOfDay();
    /* 4.29.0 added companies.max_users and withdrew it the same day: one
       seat = one person, so seats is the number. The column may exist on a
       database that booted the first 4.29.0; nothing reads it. */

    /* ---- 4.8.0 — COMPANY USERS AND COMPANY-WIDE SYNC -----------------
       A person signs in on any seat of their company with name + PIN. The
       company is the seat's company (licences.company_id), never typed.
       role ADMIN manages users; scope ALL sees every calculation, OWN
       sees only their own. See sync.js. */
    await q(`
      CREATE TABLE IF NOT EXISTS company_users (
        id            BIGSERIAL PRIMARY KEY,
        company_id    BIGINT NOT NULL,
        name          TEXT NOT NULL,
        name_key      TEXT NOT NULL,
        pin_hash      TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'USER',
        scope         TEXT NOT NULL DEFAULT 'OWN',
        permissions   JSONB,
        active        BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ,
        UNIQUE (company_id, name_key)
      )`);
    /* One row per synced record. kind master|calc|bom; id is the storage
       key for a master, the calculation id otherwise. seq is taken fresh
       on EVERY write (see the upsert in sync.js), so "everything since
       seq N" is exact and cheap. Full bodies as JSONB — the owner chose to
       store whole calculations, trace included. */
    await q(`
      CREATE TABLE IF NOT EXISTS sync_records (
        seq        BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL,
        kind       TEXT NOT NULL,
        id         TEXT NOT NULL,
        body       JSONB,
        owner_id   BIGINT,
        deleted    BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by BIGINT,
        UNIQUE (company_id, kind, id)
      )`);
    await q(`CREATE INDEX IF NOT EXISTS sync_records_company_seq_idx ON sync_records (company_id, seq)`);
    await q(`CREATE INDEX IF NOT EXISTS sync_records_calcnumber_idx ON sync_records (company_id, (body->>'calcNumber')) WHERE kind = 'calc'`);

    /* Defaults, written once. ON CONFLICT DO NOTHING means an operator's
       later change is never overwritten by a cold start. */
    await q(`INSERT INTO settings (key, value) VALUES
               ('trial_days', '7'),
               ('expired_mode', 'READONLY'),
               ('signups_open', 'yes'),
               ('demo_grace_days', '0'),
               /* 4.23.1 — an anonymous demo is a company with no GSTIN,
                  no email and no way to tell a real plant from a made-up
                  one. Since 4.23.0 a plant registers itself, so this is
                  OFF unless the owner deliberately opens it (a trade
                  show, a machine handed to a prospect). */
               ('demo_signup', 'no'),
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
    /* Absent reads as NO: a database that has never seen this key is a
       database from before registration existed, and the safe reading of
       silence is "do not hand out anonymous demos". */
    demoSignup: s.demo_signup === 'yes',
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

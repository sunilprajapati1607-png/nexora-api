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
import { parsePlanFeatures } from './plans.js';

export const pool = createClient(process.env.DATABASE_URL);

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
    /* 4.48.0 — the PLAN: STANDARD (one seat, calculation and costing) or
       PRO (everything). Every company that already exists reads PRO,
       which is what it has been getting; a demo answers PRO regardless. */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'PRO'`);
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

    /* 4.42.0 — ENQUIRIES.

         "enquiry i will add by self for now … jodi do website sathe …
          pan menually pn thai sake"

       Somebody who has not bought anything yet. The website's contact and
       demo forms post here, and the owner adds the ones that arrive by
       phone or in person by hand, so every lead sits in ONE place instead
       of in an inbox, a WhatsApp thread and somebody's memory.

       `product` is which software they asked about — the same list the
       website's "I am interested in" select offers. `state` is how far the
       lead has got; it is a plain string rather than an enum so a new step
       can be added without a migration.

       Nothing here is a customer yet. When a lead becomes one, a company is
       created in the ordinary way and `company_id` links the two, which is
       what makes "how many enquiries turned into customers" answerable. */
    await q(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        company     TEXT,
        phone       TEXT,
        email       TEXT,
        product     TEXT,
        message     TEXT,
        state       TEXT NOT NULL DEFAULT 'NEW',
        source      TEXT NOT NULL DEFAULT 'MANUAL',
        source_page TEXT,
        channel     TEXT,
        notes       TEXT,
        follow_up   DATE,
        company_id  BIGINT,
        remote_ip   TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q(`CREATE INDEX IF NOT EXISTS inquiries_created_idx ON inquiries (created_at DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS inquiries_state_idx ON inquiries (state)`);

    /* 4.45.0 — FEEDBACK AND PROBLEM REPORTS, from Help → Nexora Contact.

       One row per report. `kind` is FEEDBACK or BUG; `shot` is the picture
       of the screen a BUG carries, as a JPEG data URL — kept in the row
       rather than in a bucket because the free tier has no bucket, a
       report is opened a handful of times, and the list never selects
       it. `company_id` is set when the application sent a good token,
       which is what lets the console say which plant is speaking. */
    await q(`
      CREATE TABLE IF NOT EXISTS feedback (
        id          BIGSERIAL PRIMARY KEY,
        kind        TEXT NOT NULL DEFAULT 'FEEDBACK',
        subject     TEXT,
        message     TEXT NOT NULL,
        name        TEXT,
        phone       TEXT,
        email       TEXT,
        company     TEXT,
        company_id  BIGINT,
        licence_key TEXT,
        user_name   TEXT,
        device_id   TEXT,
        device_name TEXT,
        app_version TEXT,
        edition     TEXT,
        view        TEXT,
        shot        TEXT,
        state       TEXT NOT NULL DEFAULT 'NEW',
        reply       TEXT,
        remote_ip   TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q(`CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS feedback_state_idx ON feedback (state)`);

    /* 4.44.0 — WHAT THE PHONE CONSOLE SHOULD BE RUNNING.

       The Android console is not on Play, so nothing tells it a new build
       exists. The owner publishes one here and every phone offers it at
       its next check.

       The APK itself is NOT stored here — `url` points at wherever it
       lives (a GitHub release asset, a file on the site, anywhere over
       https). A binary in the database is a binary in every backup, and
       this service has no business serving sixteen megabytes.

       version_code is the primary key because that is the number Android
       itself compares; it only ever goes up. */
    await q(`
      CREATE TABLE IF NOT EXISTS app_releases (
        version_code BIGINT PRIMARY KEY,
        version_name TEXT NOT NULL,
        url          TEXT NOT NULL,
        notes        TEXT,
        sha256       TEXT,
        size_bytes   BIGINT,
        mandatory    BOOLEAN NOT NULL DEFAULT false,
        published_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    /* 4.42.0 — a person's own address.

       Until now the only email the service held was the company's, so a
       notice about a new version reached one inbox per plant and stopped
       there. A person may now carry their own, which is what makes it
       possible to write to everybody who actually uses the software.

       Optional on purpose: a plant that adds five operators with no email
       is not broken, and nobody is forced to invent addresses to satisfy a
       form. NOT unique either — a small plant where three people share one
       address is a real plant, not a mistake to be refused. */
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS email TEXT`);

    /* 4.43.0 — ONE PERSON, ONE PLACE AT A TIME.

         "one user can only login at one place on same time"

       A seat is a person (4.42.0), but nothing stopped one PIN being used
       on ten machines at once — so five seats could be worked by fifty
       people simply by passing the PIN round, and the count the plant pays
       for meant nothing. The person is now bound to the machine they last
       signed in on: signing in elsewhere moves the binding, and the machine
       left behind is told at its next heartbeat and signs itself out.

       Deliberately the DEVICE and not a session token: the device id is
       already what every request proves, so there is nothing new to keep in
       step, and nothing to leak. `session_at` is kept so the console can
       say WHERE somebody is, which is the first question asked when
       somebody rings to say they were signed out. */
    /* 4.44.0 — THE COMPANY'S OWN CONVERSATION.

         "add best ui base company internal chat window with tagging of
          documents and item code, only for inter company"

       One room per company. `tags` are REFERENCES — a calculation
       number, a BOM number, an item code — and never the record
       itself: what travels is the name of the thing, and each reader's
       own installation opens its own copy. No costing and no price is
       ever in a message unless somebody types one.

       `name` is stored beside user_id on purpose. A message should
       still read correctly a year after the person who wrote it has
       left and their row has been removed.

       Indexed on (company_id, id) because every read is 'this
       company, since this id' and nothing else. */
    await q(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          BIGSERIAL PRIMARY KEY,
        company_id  BIGINT NOT NULL,
        user_id     BIGINT,
        name        TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
        deleted     BOOLEAN NOT NULL DEFAULT false,
        at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q(`CREATE INDEX IF NOT EXISTS chat_company_id_idx ON chat_messages (company_id, id)`);

    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS session_device TEXT`);
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS session_at TIMESTAMPTZ`);

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
    sessionMinutes: Math.min(720, Math.max(5, parseInt(s.session_minutes, 10) || 30)),
    /* 4.48.0 — which features each plan carries; the console edits it. */
    planFeatures: parsePlanFeatures(s.plan_features)
  };
}

export async function logEvent(deviceId, event, detail) {
  try {
    await q(`INSERT INTO activation_log (device_id, event, detail) VALUES ($1, $2, $3)`,
      [deviceId || null, event, detail ? JSON.stringify(detail) : null]);
  } catch (e) { /* logging must never break a request */ }
}

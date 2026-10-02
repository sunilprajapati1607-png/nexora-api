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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from './pgmini.js';
import { parsePlanFeatures } from './plans.js';

/* 2026-10-01 — up to 4 connections (PG_POOL to change it; 1 = the old single one) */
export const pool = createClient(process.env.DATABASE_URL, process.env.PG_POOL || 4);

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
  /* 4.71.0 (audit) — a failed bootstrap is not remembered. The promise used
     to be kept whatever it settled to, so one cold start that met the
     database down (Supabase restarting, a network blip) left every request
     failing until the service itself was restarted. */
  const attempt = (async () => {
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
    /* 4.57.0 — WHEN THIS STRETCH BEGAN.

         "licence ke demo kai date thi start thayo ane kyare patese"

       expires_at said when it ends and days_left said how far off that
       was, but nothing said when it STARTED — so "3 days left" had no
       scale. Three of seven and three of three hundred and sixty-five
       read identically and mean nothing like the same thing.

       Not created_at, which is when the COMPANY was made: right for a
       demo, and a year out of date for a licence that has been renewed
       twice since. This is the current stretch, reset whenever the
       clock is actually moved. Every company that exists today is
       backfilled from created_at, which IS when its demo began. */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS period_started_at TIMESTAMPTZ`);
    await q(`UPDATE companies SET period_started_at = created_at WHERE period_started_at IS NULL`);
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
    /* 4.67.18 — a company's own Google Gemini key, kept locked (aikey.js): the sealed key, its last four
       characters (all the application is ever shown) and when it was set. NULL = Nexora's own key answers. */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_key_enc TEXT`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_key_last4 TEXT`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_key_set_at TIMESTAMPTZ`);
    /* 4.67.21 — "want to limit ai call as per company per day from console and from console android app":
       Nexora AI questions a day for this company on Nexora's key. NULL or 0 = the service's own (AI_DAILY_PER_COMPANY). */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_daily_limit INTEGER`);

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
    /* One row per synced record. kind master|calc|bom|quote (4.66.0); id is the storage
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
    /* 4.68.0 — marketing: an enquiry's number is checked on every push, like a calculation's */
    await q(`CREATE INDEX IF NOT EXISTS sync_records_enqnumber_idx ON sync_records (company_id, (body->>'enquiryNumber')) WHERE kind = 'enquiry'`);

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
    /* Nexora Mobile (2026-09-28, owner: licence A) — a person may be signed in on ONE computer and
       ONE phone at once; the phone takes no seat. A phone is a licences row with platform 'mobile',
       usable once the company's administrator has approved it (approved_at). */
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS session_mobile TEXT`);
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS session_mobile_at TIMESTAMPTZ`);
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS platform TEXT`);
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS approved_by TEXT`);
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS session_at TIMESTAMPTZ`);
    /* 4.58.1 — the last time this person's software spoke to the service.
       last_login_at moves only when a name and PIN are typed; a person
       who opens the software every morning on a remembered session never
       types them, so their "last signed in" stood still for weeks. */
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);

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

    /* ---- 4.71.0 (audit, owner 2026-10-01) ------------------------------ */
    /* Three wrong PINs lock the person for fifteen minutes; three wrong
       passcodes lock the company's join the same way (lockout.js). */
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS pin_fails INTEGER NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE company_users ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS passcode_fails INTEGER NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS passcode_locked_until TIMESTAMPTZ`);

    /* A COMPUTER WAITS FOR ITS ADMINISTRATOR, AS A PHONE DOES.
       A second computer joining an existing company (its licence key, or its
       company id and passcode) is now created unapproved — approved_at,
       the phone's own column. Every computer that existed before this
       release was working, so each is approved ONCE, here; the settings row
       says it was done, so a computer that joins afterwards and is waiting
       is never approved by a later cold start. */
    const pcDone = await q(`SELECT 1 FROM settings WHERE key = 'pc_approval_v1'`);
    if (!pcDone.length) {
      await q(`UPDATE licences SET approved_at = now(), approved_by = 'Nexora (before computer approval)'
                WHERE (platform IS NULL OR platform <> 'mobile') AND approved_at IS NULL`);
      await q(`INSERT INTO settings (key, value) VALUES ('pc_approval_v1', $1) ON CONFLICT (key) DO NOTHING`, [new Date().toISOString()]);
    }
    /* WHO WITHDREW A MACHINE. 'COMPANY' — its own administrator removed it
       (/v1/devices/remove), and may bring it back (/v1/devices/approve);
       'NEXORA' — the console revoked it, and only the console restores it.
       Without this a company administrator could undo Nexora's revoke of a
       computer through the phones' approve. NULL on a row revoked before
       this column existed: before 4.71.0 only the console could revoke a
       computer, so sync.js deviceAction reads a NULL computer as Nexora's. */
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS revoked_by TEXT`);
    /* C7 — THE DEVICE KEY (owner 2026-10-01: "દરેક PC/phone ને ગુપ્ત key").
       A device id is not a secret — it is in the console and in reports —
       so knowing an approved computer's id was enough to activate another
       machine AS it and be handed its token. Each installation now makes one
       random key of its own and sends it whenever it joins or re-joins; only
       its sha256 is kept, here, and it is never listed or returned by any
       route (licence.js deviceKeyHash). NULL on every row made before this
       release: such a row takes the first key it is shown (licence.js
       activate), and one that is removed or revoked is cleared back to NULL. */
    await q(`ALTER TABLE licences ADD COLUMN IF NOT EXISTS device_key_hash TEXT`);

    /* Row level security on the tables the service alone reads. The service
       connects as their OWNER, and an owner is not held by row level
       security, so its own queries are unchanged; anything else that can
       reach the database (Supabase's public API among them) is shut out.
       Only a table this connection owns is touched — ALTER TABLE on
       somebody else's table would fail, and a failed bootstrap stops the
       whole service — and a failure here is never allowed to stop it. */
    /* 4.71.0 — each company's Nexora AI questions per India day, kept beside the service's own memory (ai.js
       takeCounted: the higher of the two is the count, so a restart no longer gives a company its day again) */
    await q(`CREATE TABLE IF NOT EXISTS ai_usage (company_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
                                                PRIMARY KEY (company_id, day))`);
    await q(`DELETE FROM ai_usage WHERE day < to_char(now() AT TIME ZONE 'Asia/Kolkata' - interval '40 days', 'YYYY-MM-DD')`);
    /* 4.72.0 (audit 3, C12) — THE PREVIOUS COPY OF EVERY MASTER. A shared master
       (materials, routes, processes, recipes, workflows …) used to be simply
       overwritten — or deleted — by whoever pushed last, with nothing kept to go
       back to but last night's whole-database backup. Before a master is
       replaced, the copy being replaced is written here (sync.js keepHistory),
       the last 20 for each master; the console puts one back (sync.js
       restoreMaster). `updated_by` / `at` are who saved that copy and when;
       `replaced_by` / `replaced_at` who replaced it (NULL: the console) and
       when; `how` is push, delete or restore. */
    await q(`
      CREATE TABLE IF NOT EXISTS sync_history (
        history_id  BIGSERIAL PRIMARY KEY,
        company_id  BIGINT NOT NULL,
        kind        TEXT NOT NULL,
        id          TEXT NOT NULL,
        body        JSONB,
        updated_by  BIGINT,
        at          TIMESTAMPTZ,
        replaced_by BIGINT,
        replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        how         TEXT
      )`);
    await q(`CREATE INDEX IF NOT EXISTS sync_history_record_idx ON sync_history (company_id, kind, id, history_id DESC)`);
    /* 4.72.0 (audit 40) — A DELETED COMPANY IS KEPT FOR 30 DAYS. The console's Delete
       used to erase a company and everything it synced on the spot, with no way
       back. It now sets deleted_at (and keeps the state it had in deleted_state,
       so Restore puts back exactly that): the company is suspended, hidden from the
       console's lists and refused everywhere, and erased with everything that
       belongs to it once deleted_at is 30 days old (admin.js purgeArchived).
       Two new, empty columns: no existing row is touched. */
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS deleted_state TEXT`);
    /* 4.73.0 — C15 (owner: recycle bin "ha") — THE RECYCLE BIN. Before a push marks a calculation, a BOM, a
       quotation, an enquiry or a customer deleted, the copy being deleted is written here (sync.js push, in the
       same statement), and kept RECYCLE_KEEP_DAYS (30): the company's administrator puts one back
       (/v1/recycle/restore), and the routine that erases a deleted company erases what is older (admin.js
       purgeArchived, at most every six hours). `title` is the record's number / name, so the list never reads a
       body; `deleted_by_name` keeps who deleted it readable after that person is removed. A new table: nothing
       that exists is touched. */
    await q(`
      CREATE TABLE IF NOT EXISTS recycle_bin (
        bin_id          BIGSERIAL PRIMARY KEY,
        company_id      BIGINT NOT NULL,
        kind            TEXT NOT NULL,
        rec_id          TEXT NOT NULL,
        body            JSONB,
        owner_id        BIGINT,
        title           TEXT,
        deleted_by      BIGINT,
        deleted_by_name TEXT,
        deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q(`CREATE INDEX IF NOT EXISTS recycle_bin_company_idx ON recycle_bin (company_id, deleted_at DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS recycle_bin_age_idx ON recycle_bin (deleted_at)`);
    /* 4.73.0 — C17 (owner: "location of manufacturing, website, product range … all information mandatory") —
       what the website's enquiry form 2 adds (inquiry.js publicInquiry): the manufacturing location, the
       website, the product ticks (a JSON list of the form's own names) and the words typed beside "Other".
       Nullable, no default: an existing row reads NULL and nothing is rewritten. */
    await q(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS location TEXT`);
    await q(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS website TEXT`);
    await q(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS products JSONB`);
    await q(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS product_other TEXT`);
    /* 4.73.0 — C19 (owner: a separate backup password; "admin can get that passward from software also only
       admin") — ONE PER COMPANY, LOCKED: AES-256-GCM under a key derived from the token secret
       (backupSecret.js), never the password itself. A table of its own, so no company row, licence answer,
       pull, heartbeat or console listing can ever carry it; erased with the company (admin.js PURGE_SQL). */
    await q(`
      CREATE TABLE IF NOT EXISTS backup_secrets (
        company_id BIGINT PRIMARY KEY,
        secret_enc TEXT NOT NULL,
        set_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        set_by     BIGINT
      )`);
    /* 4.72.0 — ink_model_history (inkstore.js, made with the ink tables) has row level security like
       sync_history; on a database where it does not exist yet it is skipped and done on a later start */
    /* 4.73.0 — and the recycle bin and the backup passwords */
    for (const t of ['chat_messages', 'feedback', 'inquiries', 'app_releases', 'ai_usage', 'sync_history', 'ink_model_history', 'recycle_bin', 'backup_secrets']) {
      try {
        await q(`DO $rls$ BEGIN
                   IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = '${t}' AND tableowner = current_user)
                      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                       WHERE n.nspname = current_schema() AND c.relname = '${t}' AND c.relrowsecurity) THEN
                     EXECUTE 'ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY';
                   END IF;
                 END $rls$`);
      } catch (e) { /* the service runs on without it; the owner sees it in Supabase's advisor */ }
    }
    return true;
  })();
  ready = attempt;
  attempt.catch(() => { if (ready === attempt) ready = null; });
  return attempt;
}

/** 4.71.0 (audit) — /health: can the database answer at all? One SELECT 1
 *  with a short limit of its own, so a database that has stopped answering
 *  makes /health say so in two seconds instead of hanging with it. */
export async function dbAlive(ms) {
  let timer = null;
  try {
    const out = await Promise.race([
      q('SELECT 1 AS ok').then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms || 2000); })
    ]);
    return out === true;
  } catch (e) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 2026-10-01 — the settings are read on nearly every request (24,000 reads
   since 17 Sep) and change only when the owner saves them in the console.
   The rows are kept here for 30 s and dropped the moment this service
   writes them (forgetSettings); every call still builds its own object. */
const SETTINGS_TTL_MS = 30 * 1000;
let settingsRows = null, settingsAt = 0, settingsGen = 0;
export function forgetSettings() { settingsGen++; settingsRows = null; }

export async function getSettings() {
  let rows = settingsRows;
  if (!rows || Date.now() - settingsAt > SETTINGS_TTL_MS) {
    const gen = settingsGen;
    rows = await q(`SELECT key, value FROM settings`);
    /* a read that started before a write must not put the old rows back */
    if (gen === settingsGen) { settingsRows = rows; settingsAt = Date.now(); }
  }
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

/* 4.72.0 (audit 39) — WHO DID IT, AND FROM WHERE. Every /admin/api request is
   run inside this context (index.js), holding where the console call came from:
   { ip, app: 'web' | 'android', ua }. Anything logged while it runs — the
   console's own actions, and what they set off in sync.js, chat.js or
   appupdate.js — carries it as detail.via, so the log can say which console,
   from which address, did it. Never the key: only the address, the console's
   kind and the first part of its user-agent. Outside a console call there is no
   context and nothing is added. */
export const consoleCall = new AsyncLocalStorage();

export async function logEvent(deviceId, event, detail) {
  try {
    const via = consoleCall.getStore();
    const d = via ? Object.assign({}, detail || {}, { via }) : detail;
    await q(`INSERT INTO activation_log (device_id, event, detail) VALUES ($1, $2, $3)`,
      [deviceId || null, event, d ? JSON.stringify(d) : null]);
  } catch (e) { /* logging must never break a request */ }
}

/* 4.71.0 — the database side of the Nexora AI day count (ai.js setUsageStore). One statement adds this question and
   takes the HIGHER of the database's count and the service's memory (atLeast), so the two never undercount. */
export const aiUsageStore = {
  add: (company, day, atLeast) => q(`INSERT INTO ai_usage (company_id, day, n) VALUES ($1, $2, GREATEST($3::int, 1))
      ON CONFLICT (company_id, day) DO UPDATE SET n = GREATEST(ai_usage.n + 1, EXCLUDED.n) RETURNING n`,
    [String(company), String(day), Number(atLeast) || 1]).then((r) => (r && r[0] ? Number(r[0].n) : 0)),
  back: (company, day) => q(`UPDATE ai_usage SET n = GREATEST(n - 1, 0) WHERE company_id = $1 AND day = $2`, [String(company), String(day)]),
  get: (company, day) => q(`SELECT n FROM ai_usage WHERE company_id = $1 AND day = $2`, [String(company), String(day)])
    .then((r) => (r && r[0] ? Number(r[0].n) : 0))
};

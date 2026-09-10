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
    /* Defaults, written once. ON CONFLICT DO NOTHING means an operator's
       later change is never overwritten by a cold start. */
    await q(`INSERT INTO settings (key, value) VALUES
               ('trial_days', '7'),
               ('expired_mode', 'READONLY'),
               ('signups_open', 'yes')
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
    signupsOpen: s.signups_open !== 'no'
  };
}

export async function logEvent(deviceId, event, detail) {
  try {
    await q(`INSERT INTO activation_log (device_id, event, detail) VALUES ($1, $2, $3)`,
      [deviceId || null, event, detail ? JSON.stringify(detail) : null]);
  } catch (e) { /* logging must never break a request */ }
}

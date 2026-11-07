/**
 * Nexora Console — its own tables, in the schema "console" (the Supabase project "nexora").
 *
 * Only what is the console's own lives here: which company of one software belongs to which Sales &
 * Costing company (product_links), the owner's payments ledger (customer_payments) and what was done
 * from the consoles (events). Licences, plans and demo rules stay on each software's own service.
 */
import { createClient } from './pgmini.js';

export const pool = createClient(process.env.DATABASE_URL, process.env.PG_POOL || 3);
export const q = (text, params) => pool.query(text, params);

let ready = null;
export function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await q(`CREATE SCHEMA IF NOT EXISTS console`);
      await q(`CREATE TABLE IF NOT EXISTS console.product_links (
        product    TEXT NOT NULL,
        remote_id  TEXT NOT NULL,
        company_id BIGINT,
        linked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (product, remote_id)
      )`);
      await q(`CREATE TABLE IF NOT EXISTS console.customer_payments (
        id            BIGSERIAL PRIMARY KEY,
        software      TEXT NOT NULL,
        company_id    BIGINT,
        fabric_id     TEXT,
        customer_name TEXT NOT NULL,
        plan          TEXT,
        plan_name     TEXT,
        kind          TEXT NOT NULL DEFAULT 'RENEWAL',
        amount        NUMERIC(14,2) NOT NULL,
        paid_on       DATE NOT NULL,
        mode          TEXT,
        reference     TEXT,
        valid_from    DATE,
        valid_to      DATE,
        note          TEXT,
        via           TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at    TIMESTAMPTZ
      )`);
      await q(`CREATE INDEX IF NOT EXISTS console_payments_company ON console.customer_payments (company_id)`);
      await q(`CREATE TABLE IF NOT EXISTS console.events (
        id      BIGSERIAL PRIMARY KEY,
        at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        event   TEXT NOT NULL,
        detail  JSONB
      )`);
      await q(`CREATE INDEX IF NOT EXISTS console_events_at ON console.events (at DESC)`);
      /* Supabase: nobody but this service reaches these through the public API */
      for (const t of ['product_links', 'customer_payments', 'events']) {
        try { await q(`ALTER TABLE console.${t} ENABLE ROW LEVEL SECURITY`); } catch (e) { /* not Supabase */ }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Never breaks a request. `via` = which console (web / android / desktop) and from where. */
export async function logEvent(event, detail) {
  try { await q(`INSERT INTO console.events (event, detail) VALUES ($1, $2)`, [event, detail ? JSON.stringify(detail) : null]); } catch (e) { /* fine */ }
}

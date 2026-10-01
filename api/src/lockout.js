/**
 * Nexora API — wrong PINs and wrong passcodes  (4.71.0, audit)
 * ----------------------------------------------------------------------
 * Owner's decision (2026-10-01): three wrong PINs for a person and that
 * person is locked for fifteen minutes; the same for a company's passcode
 * when a machine joins with the company id. While locked, EVERY attempt
 * is refused — the right PIN as well — so guessing gains nothing by
 * waiting for a lucky one to slip through. A right PIN starts the count
 * again.
 *
 * A PIN is four digits: ten thousand guesses, which a script runs through
 * in an afternoon. Three every fifteen minutes is about three hundred a
 * day — a month of trying for one person, all of it in the event log.
 *
 * THE COUNT IS TAKEN BEFORE THE PIN IS CHECKED. Read-the-lock-then-check
 * lets a hundred guesses sent at the same moment all read "not locked"
 * before any of them counts. Here each attempt first claims its place in
 * one UPDATE; an attempt past the third is refused without its PIN ever
 * being compared.
 *
 * Kept on the row (company_users / companies), not in memory, so a
 * restart or a second instance of the service does not hand out a fresh
 * three. A name or company id that does not exist is counted in memory
 * instead, so that a lock never says "this name is real" — the refusal for
 * a stranger reads exactly as it does for a person.
 */
import { q } from './db.js';

export const LOCK_TRIES = 3;
export const LOCK_MINUTES = 15;

/* table and column names are this file's own constants, never input */
const TARGETS = {
  pin: { table: 'company_users', fails: 'pin_fails', until: 'pin_locked_until' },
  passcode: { table: 'companies', fails: 'passcode_fails', until: 'passcode_locked_until' }
};

/** The answer while locked, in the words the owner chose. */
export function lockedBody(kind, retryAfter) {
  const s = Math.max(1, Math.ceil(Number(retryAfter) || LOCK_MINUTES * 60));
  const m = Math.max(1, Math.ceil(s / 60));
  const mins = m + ' minute' + (m === 1 ? '' : 's');
  return kind === 'passcode'
    ? { error: 'PASSCODE_LOCKED', message: 'Too many wrong passcodes — try again in ' + mins + '.', retryAfter: s }
    : { error: 'PIN_LOCKED', message: 'Too many wrong PINs — try again in ' + mins + '.', retryAfter: s };
}

async function secondsLeft(t, id) {
  const rows = await q(`SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (${t.until} - now()))))::int AS s
                          FROM ${t.table} WHERE id = $1 AND ${t.until} > now()`, [id]);
  return rows.length ? Number(rows[0].s) || 1 : 1;
}
async function lockRow(t, id) {
  const rows = await q(`UPDATE ${t.table} SET ${t.until} = COALESCE(${t.until}, now() + make_interval(mins => $2::int))
                         WHERE id = $1
                     RETURNING GREATEST(1, CEIL(EXTRACT(EPOCH FROM (${t.until} - now()))))::int AS s`, [id, LOCK_MINUTES]);
  return rows.length ? Number(rows[0].s) || LOCK_MINUTES * 60 : LOCK_MINUTES * 60;
}

/** Claim one attempt for this row. { ok: true, tries } — check the secret;
 *  { ok: false, retryAfter } — locked, do not check it at all. A lock that
 *  has run out is cleared here and the count starts again at one. */
export async function takeAttempt(kind, id) {
  const t = TARGETS[kind];
  const rows = await q(`UPDATE ${t.table}
                           SET ${t.fails} = CASE WHEN ${t.until} IS NOT NULL THEN 1 ELSE ${t.fails} + 1 END,
                               ${t.until} = NULL
                         WHERE id = $1 AND (${t.until} IS NULL OR ${t.until} <= now())
                     RETURNING ${t.fails} AS n`, [id]);
  if (!rows.length) return { ok: false, retryAfter: await secondsLeft(t, id) };
  const n = Number(rows[0].n) || 0;
  /* more than three at once: the ones past the third are not even compared */
  if (n > LOCK_TRIES) return { ok: false, retryAfter: await lockRow(t, id) };
  return { ok: true, tries: n };
}
/** The secret was wrong. Returns the seconds of the lock this started, or 0. */
export async function failedAttempt(kind, id, tries) {
  if (Number(tries) < LOCK_TRIES) return 0;
  return lockRow(TARGETS[kind], id);
}
/** The secret was right: the count starts again. */
export async function clearAttempts(kind, id) {
  const t = TARGETS[kind];
  await q(`UPDATE ${t.table} SET ${t.fails} = 0, ${t.until} = NULL WHERE id = $1 AND (${t.fails} <> 0 OR ${t.until} IS NOT NULL)`, [id]);
}

/* ---- names that do not exist ------------------------------------------ */
const STRANGERS = new Map();
/** One more wrong attempt on a name (or company id) that is not there.
 *  Answers exactly as takeAttempt + failedAttempt would for a real one:
 *  { locked: true, retryAfter } from the third on, for fifteen minutes. */
export function strangerAttempt(key) {
  const now = Date.now();
  let s = STRANGERS.get(key);
  if (s && s.until && s.until > now) return { locked: true, retryAfter: Math.ceil((s.until - now) / 1000) };
  if (!s || (s.until && s.until <= now)) s = { n: 0, until: 0 };
  s.n++;
  if (s.n >= LOCK_TRIES) { s.until = now + LOCK_MINUTES * 60000; s.n = 0; }
  STRANGERS.set(key, s);
  if (STRANGERS.size > 5000) {
    for (const [k, v] of STRANGERS) if (!(v.until > now)) STRANGERS.delete(k);
  }
  return s.until > now ? { locked: true, retryAfter: Math.ceil((s.until - now) / 1000) } : { locked: false };
}

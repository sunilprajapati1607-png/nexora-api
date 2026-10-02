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
import { scryptSync, randomBytes } from 'node:crypto';
import { q } from './db.js';

export const LOCK_TRIES = 3;
export const LOCK_MINUTES = 15;

/* ---- 4.72.0 review (audit 4) — THE TIME AN ATTEMPT TAKES, NOT ITS CPU ----------
   A name or company id that is not there must take as long to refuse as a real
   one with the wrong PIN or passcode, or the time says which are real. 4.72.0
   first did that by running the same scrypt against a hash of nobody — which
   handed anybody on the internet a way to keep this service's processor busy:
   every made-up company id at the open /v1/activate cost one scrypt (tens of
   milliseconds of a full core; the free instance has a tenth of one), so a few
   requests a second, each with a new made-up id, stalled every plant at once.
   A real id costs at most three before its lock; a made-up one had no end.
   So the time is now WAITED, not spent: every real attempt measures itself, from
   claiming its turn to the end of its compare (attemptClock), the service keeps
   a running figure of that (noteAttemptTime — seeded at start with one scrypt
   of its own), and an unknown name or id waits that long (strangerPause) on
   exactly the attempts a real one compares on. The same answer, the same time,
   no processor. */
const ATTEMPT_MS_MAX = 3000;
let attemptMs = 0;
export function noteAttemptTime(ms) {
  const v = Number(ms);
  if (!(v > 0) || !isFinite(v)) return;
  const c = Math.min(v, ATTEMPT_MS_MAX);
  attemptMs = attemptMs ? attemptMs * 0.8 + c * 0.2 : c;
}
/** The running figure (ms) an unknown name or id waits. */
export function attemptTime() { return attemptMs; }
/** Started just before a real attempt claims its turn; called once its compare is done. */
export function attemptClock() {
  const t0 = process.hrtime.bigint();
  return () => noteAttemptTime(Number(process.hrtime.bigint() - t0) / 1e6);
}
/** An unknown name or company id: as long as a real attempt takes, without its scrypt. */
export function strangerPause() {
  const ms = attemptMs;
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
{
  /* the figure starts from one scrypt with the PIN's and the passcode's own settings (sync.js hashPin,
     passcode.js hashPasscode: node's defaults, 32 bytes) */
  const t0 = process.hrtime.bigint();
  scryptSync(randomBytes(16).toString('hex'), randomBytes(16).toString('hex'), 32);
  noteAttemptTime(Number(process.hrtime.bigint() - t0) / 1e6);
}

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
 *  { locked: true, retryAfter } from the third on, for fifteen minutes.
 *  4.72.0 (audit 4) — `started: true` on the one attempt that STARTS the lock:
 *  a real name compares its PIN on that attempt (and on none after it), so a
 *  caller that pauses for a stranger (strangerPause) does it exactly then. Read
 *  from retryAfter instead, an attempt in the same second after the lock began
 *  looked like the one that started it, and paid a compare a real name does not. */
export function strangerAttempt(key) {
  const now = Date.now();
  let s = STRANGERS.get(key);
  if (s && s.until && s.until > now) return { locked: true, retryAfter: Math.ceil((s.until - now) / 1000) };
  if (!s || (s.until && s.until <= now)) s = { n: 0, until: 0 };
  s.n++;
  let started = false;
  if (s.n >= LOCK_TRIES) { s.until = now + LOCK_MINUTES * 60000; s.n = 0; started = true; }
  STRANGERS.set(key, s);
  if (STRANGERS.size > 5000) {
    for (const [k, v] of STRANGERS) if (!(v.until > now)) STRANGERS.delete(k);
  }
  return s.until > now ? { locked: true, retryAfter: Math.ceil((s.until - now) / 1000), started } : { locked: false };
}

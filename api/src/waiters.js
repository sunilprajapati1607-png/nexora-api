/**
 * Nexora service — 4.66.6: who is waiting to hear that something changed
 * ======================================================================
 *   "data sync haju slow che within 5 second ma sync thai javu joiye"
 *   "same user can login via two different laptop ... another one is
 *    logout after 1 min but this should be quick"
 *
 * A signed-in machine keeps one request open here (GET /v1/sync/wait).
 * It is answered the moment
 *   - another machine of the same company pushes something   → changed
 *   - the same person signs in on another machine             → ended
 * or after WAIT_MS with nothing to say, when the machine simply asks again.
 *
 * Nothing waits on the database: the waiters live in this process's memory,
 * and the service runs as one process (server.js on Render), so every push
 * and every sign-in passes through here. A request that finds a waiter gone
 * (a restart) costs nothing — the machine's own timer still pulls.
 *
 * 4.72.0 (audit 10) — HOW MANY MAY WAIT. Until now any number of waits could
 * be held open, by one machine or one company, and a wait whose machine had
 * gone (the connection dropped, the application closed) stayed until it ran
 * out. Now:
 *   - a wait whose connection closes is let go at once (server.js passes
 *     the request's signal; opts.signal here);
 *   - one machine holds at most PER_DEVICE waits (2: the phone's open
 *     application and its quick-alerts service overlap for a moment, and a
 *     computer that stopped and started waiting leaves one behind), one
 *     person PER_USER (a computer and a phone, two each), one company
 *     PER_COMPANY. A new wait over a limit answers the OLDEST one of that
 *     machine / person / company { changed: false } — what it would have
 *     heard when it ran out — so the newest, the one somebody is looking
 *     at, is the one kept. Never the new one: a machine refused at once
 *     would ask again at once.
 */

export const WAIT_MS = 25000;
export const PER_DEVICE = 2;
export const PER_USER = 4;
export const PER_COMPANY = 200;

/* companyId -> Set of { userId, deviceId, chat, done } (a Set keeps the order they arrived in: oldest first) */
const byCompany = new Map();

function remove(companyId, w) {
  const set = byCompany.get(companyId);
  if (!set) return;
  set.delete(w);
  if (!set.size) byCompany.delete(companyId);
}

/** Over a limit: the oldest waits of `set` that `same` picks are answered until `max - 1` remain, making room for one more. */
function makeRoom(set, same, max) {
  const mine = [...set].filter(same);
  for (let i = 0; i <= mine.length - max; i++) mine[i].done({ changed: false });
}

/** Wait until something is said to this machine, or WAIT_MS passes. A phone (opts.chat) is also
 *  woken by a new message in the company chat — Nexora Mobile, 2026-09-28: instant instead of
 *  asking every two seconds. opts.signal (4.72.0): when it aborts — the machine's connection closed —
 *  the wait is let go at once. */
export function waitFor(companyId, userId, deviceId, ms, opts) {
  return new Promise((resolve) => {
    const signal = opts && opts.signal;
    if (signal && signal.aborted) { resolve({ changed: false, gone: true }); return; }
    const w = { userId: Number(userId), deviceId: String(deviceId || ''), chat: !!(opts && opts.chat), done: null };
    let set = byCompany.get(companyId);
    if (!set) { set = new Set(); byCompany.set(companyId, set); }
    /* 4.72.0 (audit 10) — room is made BEFORE this one joins, oldest first */
    makeRoom(set, (x) => x.deviceId === w.deviceId, PER_DEVICE);
    makeRoom(set, (x) => x.userId === w.userId, PER_USER);
    makeRoom(set, () => true, PER_COMPANY);
    set = byCompany.get(companyId) || new Set();
    if (!byCompany.has(companyId)) byCompany.set(companyId, set);
    let onAbort = null;
    const timer = setTimeout(() => w.done({ changed: false }), Math.max(1000, Math.min(ms || WAIT_MS, 55000)));
    w.done = (answer) => {
      clearTimeout(timer);
      if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort); } catch (e) { /* gone */ } }
      remove(companyId, w);
      w.done = () => {};   /* answered once; anything later is a no-op */
      resolve(answer);
    };
    if (signal) {
      onAbort = () => w.done({ changed: false, gone: true });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    set.add(w);
  });
}

/** Something was pushed: every other machine of the company pulls now. */
export function wakeCompany(companyId, exceptDeviceId) {
  const set = byCompany.get(companyId);
  if (!set) return 0;
  let n = 0;
  [...set].forEach((w) => { if (w.deviceId !== String(exceptDeviceId || '')) { w.done({ changed: true }); n++; } });
  return n;
}

/** Somebody wrote in the company chat: every phone waiting for it hears it now (computers keep their own chat timer). */
export function wakeChat(companyId, exceptDeviceId) {
  const set = byCompany.get(companyId);
  if (!set) return 0;
  let n = 0;
  [...set].forEach((w) => { if (w.chat && w.deviceId !== String(exceptDeviceId || '')) { w.done({ changed: true, chat: true }); n++; } });
  return n;
}

/** This person signed in somewhere else: the machine they left hears it now. */
export function endSessionOn(companyId, userId, deviceId, ended) {
  const set = byCompany.get(companyId);
  if (!set) return 0;
  let n = 0;
  [...set].forEach((w) => {
    if (w.userId === Number(userId) && w.deviceId === String(deviceId || '')) { w.done({ ended }); n++; }
  });
  return n;
}

/** For tests and the health line. With a company id: that company's waits only. */
export function waiting(companyId) {
  if (companyId !== undefined) { const s = byCompany.get(companyId); return s ? s.size : 0; }
  let n = 0;
  byCompany.forEach((s) => { n += s.size; });
  return n;
}

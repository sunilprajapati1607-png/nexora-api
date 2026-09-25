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
 */

export const WAIT_MS = 25000;

/* companyId -> Set of { userId, deviceId, done } */
const byCompany = new Map();

function remove(companyId, w) {
  const set = byCompany.get(companyId);
  if (!set) return;
  set.delete(w);
  if (!set.size) byCompany.delete(companyId);
}

/** Wait until something is said to this machine, or WAIT_MS passes. */
export function waitFor(companyId, userId, deviceId, ms) {
  return new Promise((resolve) => {
    const w = { userId: Number(userId), deviceId: String(deviceId || ''), done: null };
    const timer = setTimeout(() => w.done({ changed: false }), Math.max(1000, Math.min(ms || WAIT_MS, 55000)));
    w.done = (answer) => { clearTimeout(timer); remove(companyId, w); resolve(answer); };
    if (!byCompany.has(companyId)) byCompany.set(companyId, new Set());
    byCompany.get(companyId).add(w);
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

/** For tests and the health line. */
export function waiting() {
  let n = 0;
  byCompany.forEach((s) => { n += s.size; });
  return n;
}

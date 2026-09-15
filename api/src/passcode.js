/**
 * Nexora API — the company passcode  (4.23.0)
 * ======================================================================
 * The same scrypt-with-a-salt used for a person's PIN (sync.js), in a
 * file of its own so licence.js and register.js can both use it without
 * importing each other. A passcode is longer than a PIN and stands in
 * front of a whole company's seats, so the minimum is six characters,
 * not four.
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const PASSCODE_MIN = 6;

export function validPasscode(p) {
  const s = String(p == null ? '' : p);
  return s.length >= PASSCODE_MIN && s.length <= 128;
}

export function hashPasscode(passcode, salt) {
  const s = salt || randomBytes(16).toString('hex');
  const h = scryptSync(String(passcode), s, 32).toString('hex');
  return s + ':' + h;
}

export function passcodeMatches(passcode, stored) {
  if (!stored || typeof stored !== 'string' || stored.indexOf(':') < 0) return false;
  const salt = stored.slice(0, stored.indexOf(':'));
  const a = Buffer.from(hashPasscode(passcode, salt));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Nexora service — a company's own Google Gemini key (4.67.18)
 * ======================================================================
 *   "also if someone whant to use its own gemini api key then add this
 *    option in setting they can change easyly api key"
 *
 * An administrator pastes the company's Gemini key in Settings → Features.
 * It is checked with Google first (a key Google refuses is never kept),
 * then kept here LOCKED: AES-256-GCM, with a lock made from
 * NEXORA_TOKEN_SECRET, which lives only on Render and never in the
 * database. So the database alone — a copy of it, a backup — does not
 * give the key away. It is never sent back: the application is only told
 * that the company has one, its last four characters, and when it was
 * set. Without NEXORA_TOKEN_SECRET no key can be kept at all.
 *
 * ai.js is told the key for a question with withKey(); a key that can no
 * longer be read (the secret changed) counts as none, and the
 * administrator is told to enter it again.
 */
import crypto from 'node:crypto';
import { q as dbQuery } from './db.js';

let query = dbQuery;
export function _setQuery(fn) { query = fn || dbQuery; cache.clear(); }

const secret = () => String(process.env.NEXORA_TOKEN_SECRET || '');
export function canKeep() { return secret().length >= 16; }
function lock() { return crypto.createHash('sha256').update('nexora-ai-key-v1|' + secret()).digest(); }

export function seal(k) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', lock(), iv);
  const enc = Buffer.concat([c.update(String(k), 'utf8'), c.final()]);
  return 'v1.' + iv.toString('base64') + '.' + c.getAuthTag().toString('base64') + '.' + enc.toString('base64');
}
export function unseal(s) {
  try {
    const p = String(s || '').split('.');
    if (p.length !== 4 || p[0] !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', lock(), Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

/* the database helper answers with the rows (pgmini); a pg-style {rows} is read too */
function rowsOf(r) { return Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : []); }

/* read once a minute per company, not on every question */
const cache = new Map();   // companyId -> { key, at }
const CACHE_MS = 60 * 1000;

/** The company's own key, or '' (none, or it can no longer be read). */
export async function companyKey(companyId) { return (await companyAi(companyId)).key; }

/** 4.67.21 — what a Nexora AI question of this company is asked with: its own key ('' = Nexora's) and its
 *  day's limit set in the console (0 = the service's own). Read once a minute per company. */
export async function companyAi(companyId) {
  const id = Number(companyId);
  if (!id) return { key: '', limit: 0 };
  const c = cache.get(id);
  if (c && Date.now() - c.at < CACHE_MS) return { key: c.key, limit: c.limit };
  let k = '', limit = 0;
  try {
    const row = rowsOf(await query('SELECT ai_key_enc, ai_daily_limit FROM companies WHERE id = $1', [id]))[0];
    k = row && row.ai_key_enc && canKeep() ? (unseal(row.ai_key_enc) || '') : '';
    limit = row ? Math.max(0, Number(row.ai_daily_limit) || 0) : 0;
  } catch (e) { k = ''; limit = 0; }
  cache.set(id, { key: k, limit: limit, at: Date.now() });
  return { key: k, limit: limit };
}
/** the console changed something: read again at the next question */
export function forget(companyId) { cache.delete(Number(companyId)); }

/** What the application may know: whether there is one, its last 4, when it was set — never the key. */
export async function keyInfo(companyId) {
  const id = Number(companyId);
  if (!id) return { own: false, canKeep: canKeep() };
  const row = rowsOf(await query('SELECT ai_key_enc, ai_key_last4, ai_key_set_at FROM companies WHERE id = $1', [id]))[0] || {};
  const has = !!row.ai_key_enc;
  const readable = has && canKeep() && !!unseal(row.ai_key_enc);
  return { own: has && readable, unreadable: has && !readable, last4: has ? (row.ai_key_last4 || '') : '', setAt: has && row.ai_key_set_at ? new Date(row.ai_key_set_at).toISOString() : null, canKeep: canKeep() };
}

export async function setKey(companyId, k) {
  const id = Number(companyId);
  const v = String(k || '').trim();
  await query('UPDATE companies SET ai_key_enc = $2, ai_key_last4 = $3, ai_key_set_at = now() WHERE id = $1', [id, seal(v), v.slice(-4)]);
  cache.delete(id);
}
export async function clearKey(companyId) {
  const id = Number(companyId);
  await query('UPDATE companies SET ai_key_enc = NULL, ai_key_last4 = NULL, ai_key_set_at = NULL WHERE id = $1', [id]);
  cache.delete(id);
}

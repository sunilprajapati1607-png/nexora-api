/**
 * Nexora API — Marketing: is this customer already with somebody?  (4.68.0)
 * ----------------------------------------------------------------------
 * "anyone can make but check weather is this customer already available by
 *  any other user" — and, agreed with the owner, the answer names only WHO
 *  has the customer already and on what it matched (name, phone, GSTIN).
 *  Another person's customer is never opened up by this: no address, no
 *  contact, no enquiry, no figure. A customer the asker may see anyway
 *  (their own, or a person the administrator let them see) comes back with
 *  its id, so the application can offer to use it instead of a second copy.
 *
 * Customers are owned sync records (kind 'customer', sync.js), so this reads
 * the company's rows directly; company_id comes from authorise(), as always.
 */
import { q } from './db.js';
import { mktSeesPerson } from './sync.js';

/* Words a firm's name carries that do not tell two firms apart:
   "Shree Foods", "M/s Shree Foods Pvt. Ltd." and "SHREE FOODS PRIVATE LIMITED" are one buyer. */
const NOISE = new Set(['m', 's', 'ms', 'the', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'and', 'inc', 'corp', 'corporation', 'opc']);
export function nameKey(v) {
  const words = String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9઀-૿ऀ-ॿ]+/g, ' ').trim().split(/\s+/)
    .filter((w) => w && !NOISE.has(w));
  return words.join(' ');
}
/** The last ten digits: +91 98250 12345, 098250-12345 and 9825012345 are one phone. */
export function phoneKey(v) {
  const d = String(v || '').replace(/\D+/g, '');
  return d.length >= 8 ? d.slice(-10) : '';
}
export function gstKey(v) {
  const g = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return g.length === 15 ? g : '';
}
function phonesOf(b) {
  return [b.phone, b.phone2, b.contactPhone].map(phoneKey).filter(Boolean);
}

export async function customerCheck(companyId, user, body) {
  const b = body && typeof body === 'object' ? body : {};
  const want = { name: nameKey(b.name), gstin: gstKey(b.gstin), phones: phonesOf(b) };
  if (!want.name && !want.gstin && !want.phones.length) return { matches: [] };
  const except = b.except ? String(b.except) : '';
  const rows = await q(
    `SELECT r.id, r.body, r.owner_id, u.name AS owner_name
       FROM sync_records r LEFT JOIN company_users u ON u.id = r.owner_id AND u.company_id = r.company_id
      WHERE r.company_id = $1 AND r.kind = 'customer' AND r.deleted = false`, [companyId]);
  const matches = [];
  for (const r of rows) {
    if (except && r.id === except) continue;
    const c = r.body && typeof r.body === 'object' ? r.body : {};
    const on = [];
    if (want.name && nameKey(c.name) === want.name) on.push('name');
    if (want.gstin && gstKey(c.gstin) === want.gstin) on.push('gstin');
    if (want.phones.length && phonesOf(c).some((p) => want.phones.indexOf(p) > -1)) on.push('phone');
    if (!on.length) continue;
    const mine = r.owner_id != null && Number(r.owner_id) === Number(user.id);
    const sees = mktSeesPerson(user, r.owner_id);
    matches.push({
      on, mine,
      by: r.owner_id == null ? null : (r.owner_name || 'another person'),
      /* only what this person may see anyway */
      id: sees ? r.id : null,
      name: sees ? (c.name || '') : null
    });
    if (matches.length >= 10) break;
  }
  return { matches };
}

/* 4.68.2 — Nexora Mobile: what a new enquiry needs from the company — the next number in its series and the
   sources it may be booked under. The phone keeps no list-shaped master (its store holds objects), so the
   sources come from here: the administrator's list, else the same starting list every computer shows. */
const SOURCE_SEED = ['IndiaMART', 'TradeIndia', 'Website', 'Reference', 'Existing Customer', 'Cold Call', 'Visit',
  'Exhibition', 'WhatsApp', 'Email', 'Walk-In', 'Other'];
const sourceId = (name) => 'src-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export async function sourcesOf(companyId) {
  const rows = await q(`SELECT body FROM sync_records WHERE company_id = $1 AND kind = 'master' AND id = 'nexora.mkt.sources.v1' AND deleted = false`, [companyId]);
  const b = rows[0] && rows[0].body;
  const list = Array.isArray(b) ? b.filter((x) => x && x.id && x.name) : SOURCE_SEED.map((n) => ({ id: sourceId(n), name: n, active: true }));
  return list.filter((x) => x.active !== false).map((x) => ({ id: String(x.id), name: String(x.name) }));
}

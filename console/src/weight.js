/**
 * Sales & Costing as the console sees it: its companies (for joining customers by GSTIN and for the
 * payments ledger) and its plan names, read from its own service with its own key and kept for a
 * short while so one screen does not ask twice.
 */
import { softwareCall } from './software.js';

const KEEP_MS = 20000;
let companiesSeen = null, plansSeen = null;

/** { ok, companies: [{ id, name, gstin, plan, isDemo, expiresAt }] } — deleted ones left out. */
export async function weightCompanies(fresh) {
  if (!fresh && companiesSeen && Date.now() - companiesSeen.at < KEEP_MS) return companiesSeen.out;
  const r = await softwareCall('weight', 'GET', '/admin/api/licences');
  let out;
  if (r.status === 200 && Array.isArray(r.body.companies)) {
    out = { ok: true, companies: r.body.companies.filter((c) => !c.deleted_at).map((c) => ({
      id: String(c.id), name: c.name, gstin: c.gstin || '', plan: String(c.plan || 'PRO').toUpperCase(),
      isDemo: c.is_demo === true, expiresAt: c.expires_at || null, seats: parseInt(c.seats, 10) || 1 })) };
  } else out = { ok: false, companies: [], error: r.body.error, message: r.body.message };
  companiesSeen = { at: Date.now(), out };
  return out;
}
export function forgetWeight() { companiesSeen = null; plansSeen = null; }

/** Sales & Costing's plan block (GET /admin/api/plans?software=weight on its own service). */
export async function weightPlans(fresh) {
  if (!fresh && plansSeen && Date.now() - plansSeen.at < KEEP_MS) return plansSeen.out;
  const r = await softwareCall('weight', 'GET', '/admin/api/plans?software=weight');
  const block = r.status === 200 && Array.isArray(r.body.software) ? r.body.software.find((b) => b.id === 'weight') : null;
  const out = block || { id: 'weight', ok: false, supported: false, error: r.body.error || 'WEIGHT_DOWN', message: r.body.message || '', features: [], plans: [] };
  plansSeen = { at: Date.now(), out };
  return out;
}

/**
 * Nexora API — the plans (4.48.0)
 * ----------------------------------------------------------------------
 *   "give me two plan one is standard with one seat and some feature ya
 *    ofcource calculation and costing will be available second is pro
 *    … give this plan wise access things in console so i can control
 *    app feature from console as per plan … for demo everything is
 *    available."
 *
 * A company is on a PLAN — STANDARD or PRO — and a plan is a list of
 * features that are on. Which features a plan carries is NOT written
 * into the application: it is a service setting the console edits, and
 * the licence answer carries the resolved list (`company.features`) so
 * the application only ever asks "is this on for me?". Calculation and
 * costing are never in the list, because they are the product; the list
 * is the things a plant may or may not have paid for on top.
 *
 * A DEMO always answers with everything on, whatever its plan says: a
 * prospect is shown the whole application. SEATS are not a plan matter
 * (4.48.1): Nexora sets them per company, on either plan. A company that existed before
 * plans reads as PRO, which is what it has been getting.
 */

/* The catalogue. `id` is the feature id the application already gates
   on (Settings → Features, the chat and notes buttons), so a feature
   switched off by the plan disappears exactly as one switched off by the
   plant would. STANDARD's default is the owner's words: calculation and
   costing, nothing on top. */
export const PLAN_FEATURES = [
  { id: 'quotation',    label: 'Quotation',                          standard: false },
  { id: 'chat',         label: 'Company conversation (chat)',        standard: false },
  { id: 'notes',        label: 'Notes pad',                          standard: false },
  { id: 'bomWorkflow',  label: 'BOM workflow automation',            standard: false },
  { id: 'onlinePrices', label: 'Prices from the producer’s list', standard: false },
  { id: 'bagView',      label: '3D bag view',                        standard: false },
  { id: 'ink',          label: 'Ink assumption',                     standard: false },
  { id: 'sharing',      label: 'Email & WhatsApp sharing',           standard: false },
  /* 4.48.1 — "u can add more feature under plan section" */
  { id: 'exportExcel',  label: 'Export to Excel',                    standard: false },
  { id: 'exportPdf',    label: 'Export to PDF',                      standard: true  },
  { id: 'priceHistory', label: 'RM price history (price versions)',  standard: false },
  { id: 'activityLog',  label: 'Activity log',                       standard: false },
  { id: 'backup',       label: 'Backup & restore',                   standard: true  },
  { id: 'numberSeries', label: 'Document number series',             standard: false },
  { id: 'tableSettings', label: 'Table Settings (own column names)', standard: false }
];

export const PLANS = ['STANDARD', 'PRO'];

export function cleanPlan(v) {
  return String(v || '').toUpperCase() === 'STANDARD' ? 'STANDARD' : 'PRO';
}

/** The default matrix: PRO has everything, STANDARD what the catalogue says. */
export function defaultPlanFeatures() {
  const out = { STANDARD: {}, PRO: {} };
  PLAN_FEATURES.forEach((f) => { out.STANDARD[f.id] = f.standard === true; out.PRO[f.id] = true; });
  return out;
}

/** What the console saved, laid over the defaults; anything unknown is
 *  dropped, anything missing keeps its default. */
export function parsePlanFeatures(raw) {
  const out = defaultPlanFeatures();
  let saved = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch (e) { saved = null; }
  if (!saved || typeof saved !== 'object') return out;
  PLANS.forEach((p) => {
    const row = saved[p];
    if (!row || typeof row !== 'object') return;
    PLAN_FEATURES.forEach((f) => { if (typeof row[f.id] === 'boolean') out[p][f.id] = row[f.id]; });
  });
  return out;
}

export function cleanPlanFeatures(body) {
  const out = defaultPlanFeatures();
  if (!body || typeof body !== 'object') return out;
  PLANS.forEach((p) => {
    const row = body[p];
    if (!row || typeof row !== 'object') return;
    PLAN_FEATURES.forEach((f) => { out[p][f.id] = row[f.id] === true; });
  });
  return out;
}

/** The resolved list for one company: everything for a demo, else the
 *  plan's row from the settings. */
export function featuresFor(plan, settings, isDemo) {
  const out = {};
  const matrix = (settings && settings.planFeatures) || defaultPlanFeatures();
  const row = matrix[cleanPlan(plan)] || {};
  PLAN_FEATURES.forEach((f) => { out[f.id] = isDemo === true ? true : row[f.id] === true; });
  return out;
}

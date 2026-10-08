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
  { id: 'tableSettings', label: 'Table Settings (own column names)', standard: false },
  /* 4.51.0 — "this bom mlm will be feature and also add this in
     console, user can use it or use it normal standard suggetion also".
     With it off, the BOM behaves exactly as it always did: an empty
     section stays empty and Suggest is pressed by hand. */
  /* 4.55.0 — named for what it is. The console showed "BOM sections
     learned from the plant", which describes one thing it does; the
     owner sells it as the learning itself, and asked for it to stand
     beside workflow automation as its own line on the plan. */
  { id: 'sectionSuggest', label: 'BOM learning (MLM)', standard: false },
  /* 4.65.0 — "in console under plan add these all feature": the three
     cost tools, each its own line on the plan. */
  { id: 'priceImpact',  label: 'Price Impact',                       standard: false },
  { id: 'compare',      label: 'Compare calculations',               standard: false },
  { id: 'targetCost',   label: 'Target Cost',                        standard: false },
  /* Nexora Mobile (owner 2026-09-28: "licence A … fakt PRO ma"): one phone per person, free, on PRO */
  { id: 'mobile',       label: 'Nexora Mobile (Android app)',        standard: false },
  /* 4.68.0 — Marketing: enquiries, customers, follow-ups, targets (owner 2026-09-29: "pro ma j") */
  { id: 'marketing',    label: 'Marketing (enquiries, customers, follow-ups)', standard: false }
];

/* 2026-10-08 (console) — where each feature sits on the console's plan and customer windows */
const FEATURE_GROUP = {
  bagView: 'Calculation', ink: 'Calculation', bomWorkflow: 'Calculation', sectionSuggest: 'Calculation',
  onlinePrices: 'Calculation', priceHistory: 'Calculation',
  quotation: 'Sales', marketing: 'Sales', sharing: 'Sales',
  priceImpact: 'Cost tools', compare: 'Cost tools', targetCost: 'Cost tools',
  exportExcel: 'Output', exportPdf: 'Output', numberSeries: 'Output', tableSettings: 'Output',
  chat: 'Company', notes: 'Company', activityLog: 'Company', backup: 'Company', mobile: 'Company'
};
export function featureGroup(id) { return FEATURE_GROUP[id] || 'Other'; }

/* The two plans every service started with. Since 2026-10-08 the owner makes as many as wanted ("plan pan hu
   create kri saku darek software wise"); these two can be retired but never deleted, because every company made
   before then is on one of them. */
export const PLANS = ['STANDARD', 'PRO'];

/** A plan code the service knows (any plan, retired or not); anything else reads as before: STANDARD or PRO. */
export function cleanPlan(v, settings) {
  const c = String(v || '').toUpperCase().trim();
  if (settings && Array.isArray(settings.plans) && settings.plans.some((p) => p.code === c)) return c;
  return c === 'STANDARD' ? 'STANDARD' : 'PRO';
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
export function featuresFor(plan, settings, isDemo, overrides) {
  const out = {};
  const matrix = (settings && settings.planFeatures) || defaultPlanFeatures();
  const row = matrix[cleanPlan(plan, settings)] || {};
  /* 2026-10-08 — the owner's changes for this one company ("+ added" / "− off") lie over its plan;
     a demo still has everything */
  const own = cleanOverrides(overrides);
  PLAN_FEATURES.forEach((f) => {
    out[f.id] = isDemo === true ? true : (typeof own[f.id] === 'boolean' ? own[f.id] : row[f.id] === true);
  });
  return out;
}

/* ---- 2026-10-08 (console) — the plans the owner makes ---------------------------------------------------
   Owner: "price open rakho hu change kris pasad thi", "plan pan hu create kri saku darek software wise",
   and per customer "+ added / − off": "ha". A plan is { code, name, note, priceFirst, priceRenewal,
   usersIncluded, extraUserPrice, features, active, sort }. Prices are the owner's, kept for the console
   and the renewals; null until set. They live in the settings table as JSON (settings key plans_weight),
   so the licence answer reads them from the same cached settings as before — no extra query per check. */
const MONEY_MAX = 100000000;
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= MONEY_MAX ? Math.round(n * 100) / 100 : null;
}
function smallInt(v, lo, hi) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}
/** A code from a name: GOLD PLUS → GOLD_PLUS (letters, digits, underscore; at most 24). */
export function planCode(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
}
/** Only features the service knows, as true or false; anything else is dropped. */
export function cleanOverrides(raw) {
  let o = raw;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
  const out = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  PLAN_FEATURES.forEach((f) => { if (typeof o[f.id] === 'boolean') out[f.id] = o[f.id]; });
  return out;
}
function cleanFeatureRow(row, fallback) {
  const out = {};
  PLAN_FEATURES.forEach((f) => { out[f.id] = row && typeof row[f.id] === 'boolean' ? row[f.id] : fallback(f); });
  return out;
}
/** One plan as stored. `was` is the plan before an edit (anything not given keeps what it had). */
export function cleanPlanRow(p, was) {
  const w = was || {};
  const name = String(p.name != null ? p.name : (w.name || '')).trim().slice(0, 40);
  const code = w.code || planCode(p.code || name);
  const def = code === 'PRO' ? () => true : code === 'STANDARD' ? (f) => f.standard === true : () => false;
  const keep = (k, clean) => (p[k] !== undefined ? clean(p[k]) : (w[k] != null ? w[k] : null));
  return {
    code, name: name || code,
    note: String(p.note != null ? p.note : (w.note || '')).trim().slice(0, 120),
    priceFirst: keep('priceFirst', money),
    priceRenewal: keep('priceRenewal', money),
    usersIncluded: keep('usersIncluded', (v) => smallInt(v, 1, 500)),
    extraUserPrice: keep('extraUserPrice', money),
    features: cleanFeatureRow(p.features && typeof p.features === 'object' ? Object.assign({}, w.features || {}, p.features) : w.features, def),
    active: p.active !== undefined ? p.active !== false : w.active !== false,
    sort: smallInt(p.sort, 0, 999) != null ? smallInt(p.sort, 0, 999) : (w.sort != null ? w.sort : 100),
    createdAt: w.createdAt || p.createdAt || new Date().toISOString()
  };
}
/** The plans from the settings: plans_weight once the owner has saved any, else Standard and Pro from the
 *  older matrix (plan_features), exactly as every company has had them. */
export function parsePlans(rawPlans, legacyMatrix) {
  let list = null;
  try { list = rawPlans ? JSON.parse(rawPlans) : null; } catch (e) { list = null; }
  const legacy = legacyMatrix || defaultPlanFeatures();
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((p) => {
    if (!p || typeof p !== 'object') return;
    const code = planCode(p.code || p.name);
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push(cleanPlanRow(Object.assign({}, p, { code }), { code, createdAt: p.createdAt }));
  });
  if (!seen.has('STANDARD')) out.push(cleanPlanRow({ code: 'STANDARD', name: 'Standard', note: 'calculation and costing', features: legacy.STANDARD, sort: 10 }));
  if (!seen.has('PRO')) out.push(cleanPlanRow({ code: 'PRO', name: 'Pro', note: 'everything', features: legacy.PRO, sort: 20 }));
  return out.sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
}
/** code → features, for every plan (what featuresFor reads) */
export function matrixOf(plans) {
  const m = {};
  (plans || []).forEach((p) => { m[p.code] = Object.assign({}, p.features); });
  return m;
}

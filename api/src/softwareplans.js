/**
 * Nexora API — every software's plans, made by the owner (2026-10-08)
 * ----------------------------------------------------------------------
 * Owner: "darek na plan pan alag hoi sake che … aena software wise
 * features pn alag hoi sake che", then "price open rakho hu change kris
 * pasad thi", "plan pan hu create kri saku darek software wise", and the
 * customer's own changes over a plan: "ha".
 *
 * Each software has its OWN plans and its OWN features — a Weight Calc
 * feature means nothing in Fabric Stock, so they are never mixed:
 *
 *   weight  this service — plans in the settings (plans.js parsePlans),
 *           a company's own changes in companies.feature_overrides
 *   fabric  nexora-fabric-stock-api's own console API (/admin/api/plans),
 *           asked like every other Fabric Stock call (products.js). Until
 *           that service has plans, the console says so; nothing of it is
 *           kept here.
 *
 *   GET  /admin/api/plans   { software: [ { id, name, short, ok, supported,
 *                             features: [{ id, label, group }],
 *                             plans: [{ code, name, note, priceFirst,
 *                               priceRenewal, usersIncluded, extraUserPrice,
 *                               features, active, sort, customers, changed }] } ] }
 *   POST /admin/api/plans   { software, action: create | update | retire |
 *                             restore | delete, code, ...fields }
 */
import { q, getSettings, forgetSettings, logEvent } from './db.js';
import { PLAN_FEATURES, PLANS, cleanPlanRow, planCode, featureGroup, cleanPlanFeatures } from './plans.js';
import { PRODUCTS, fabricCall } from './products.js';

const NOT_YET = 'Fabric Stock’s own service has no plans yet. They are made there first (in its own window); until then every Fabric Stock company is on Standard.';

async function weightBlock() {
  const s = await getSettings();
  const rows = await q(`SELECT plan, COUNT(*)::int AS n,
                               COUNT(*) FILTER (WHERE feature_overrides IS NOT NULL AND feature_overrides::text <> '{}')::int AS o
                          FROM companies WHERE deleted_at IS NULL AND is_demo = false GROUP BY plan`);
  const by = {};
  rows.forEach((r) => { by[String(r.plan || 'PRO').toUpperCase()] = r; });
  return Object.assign({}, PRODUCTS[0], {
    ok: true, supported: true,
    features: PLAN_FEATURES.map((f) => ({ id: f.id, label: f.label, group: featureGroup(f.id) })),
    plans: (s.plans || []).map((p) => Object.assign({}, p, {
      customers: by[p.code] ? by[p.code].n : 0,
      changed: by[p.code] ? by[p.code].o : 0,
      builtIn: PLANS.includes(p.code)
    })),
    demo: 'A demo has every feature, whatever its plan.'
  });
}

async function fabricBlock() {
  const base = Object.assign({}, PRODUCTS[1]);
  const r = await fabricCall('GET', '/admin/api/plans');
  if (r.status === 200 && Array.isArray(r.body.plans)) {
    return Object.assign(base, { ok: true, supported: true, features: r.body.features || [], plans: r.body.plans });
  }
  if (r.status === 404) return Object.assign(base, { ok: true, supported: false, message: NOT_YET, features: [], plans: [] });
  return Object.assign(base, { ok: false, supported: false, error: r.body.error || 'FABRIC_DOWN', message: r.body.message || '', features: [], plans: [] });
}

export async function listPlans() {
  const [weight, fabric] = await Promise.all([weightBlock(), fabricBlock()]);
  return { software: [weight, fabric] };
}

/* the plans written back: the owner's list, and Standard and Pro in the older matrix too (the phone console
   1.9.0 and the desktop read plan_features through the settings) */
async function savePlans(plans) {
  const matrix = {};
  PLANS.forEach((c) => { const p = plans.find((x) => x.code === c); if (p) matrix[c] = p.features; });
  await q(`INSERT INTO settings (key, value) VALUES ('plans_weight', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(plans)]);
  await q(`INSERT INTO settings (key, value) VALUES ('plan_features', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(cleanPlanFeatures(matrix))]);
  forgetSettings();
}

function diff(a, b) {
  const out = [];
  ['name', 'note', 'priceFirst', 'priceRenewal', 'usersIncluded', 'extraUserPrice', 'active'].forEach((k) => {
    if ((a || {})[k] !== (b || {})[k]) out.push(k + ': ' + JSON.stringify((a || {})[k] === undefined ? null : a[k]) + ' → ' + JSON.stringify(b[k]));
  });
  PLAN_FEATURES.forEach((f) => {
    const x = !!((a && a.features) || {})[f.id], y = !!(b.features || {})[f.id];
    if (a && x !== y) out.push(f.id + ': ' + (x ? 'on' : 'off') + ' → ' + (y ? 'on' : 'off'));
  });
  return out;
}

async function weightAction(b) {
  const action = String(b.action || '');
  const s = await getSettings();
  const plans = (s.plans || []).map((p) => Object.assign({}, p));
  const code = String(b.code || '').toUpperCase().trim();
  const at = plans.findIndex((p) => p.code === code);

  if (action === 'create') {
    const name = String(b.name || '').trim();
    if (!name) return { httpStatus: 400, body: { error: 'A plan needs a name.' } };
    const newCode = planCode(b.code || name);
    if (!newCode) return { httpStatus: 400, body: { error: 'Give the plan a name with letters or digits.' } };
    if (plans.some((p) => p.code === newCode)) return { httpStatus: 409, body: { error: 'There is a plan ' + newCode + ' already. Give the new one another name.' } };
    /* a copy of another plan's ticks, when asked (New plan from …) */
    const from = b.copyFrom ? plans.find((p) => p.code === String(b.copyFrom).toUpperCase()) : null;
    const row = cleanPlanRow(Object.assign({ sort: (plans.reduce((m, p) => Math.max(m, p.sort || 0), 0) || 20) + 10 }, from ? { features: from.features } : {}, b, { code: newCode }));
    plans.push(row);
    await savePlans(plans);
    await logEvent(null, 'ADMIN_PLAN_CREATE', { software: 'weight', code: newCode, name: row.name, from: from ? from.code : undefined });
    return { httpStatus: 200, body: { ok: true, plan: row } };
  }
  if (at < 0) return { httpStatus: 404, body: { error: 'There is no plan ' + code + '.' } };
  const was = plans[at];

  if (action === 'update') {
    const row = cleanPlanRow(Object.assign({}, b, { code: was.code }), was);
    plans[at] = row;
    await savePlans(plans);
    const changed = diff(was, row);
    if (changed.length) await logEvent(null, 'ADMIN_PLAN_UPDATE', { software: 'weight', code: was.code, changed });
    return { httpStatus: 200, body: { ok: true, plan: row } };
  }
  if (action === 'retire' || action === 'restore') {
    if (action === 'retire' && plans.filter((p) => p.active !== false && p.code !== was.code).length === 0) {
      return { httpStatus: 409, body: { error: 'This is the only plan left in use. Make another one before retiring it.' } };
    }
    plans[at] = Object.assign({}, was, { active: action === 'restore' });
    await savePlans(plans);
    await logEvent(null, 'ADMIN_PLAN_' + action.toUpperCase(), { software: 'weight', code: was.code });
    return { httpStatus: 200, body: { ok: true, plan: plans[at] } };
  }
  if (action === 'delete') {
    if (PLANS.includes(was.code)) return { httpStatus: 409, body: { error: was.name + ' is one of the two plans every company started on: it can be retired, not deleted.' } };
    const on = (await q(`SELECT COUNT(*)::int AS n FROM companies WHERE plan = $1`, [was.code]))[0];
    if (on && on.n) return { httpStatus: 409, body: { error: on.n + ' compan' + (on.n === 1 ? 'y is' : 'ies are') + ' on ' + was.name + '. Move them to another plan first, or retire it instead.' } };
    plans.splice(at, 1);
    await savePlans(plans);
    await logEvent(null, 'ADMIN_PLAN_DELETE', { software: 'weight', code: was.code, name: was.name });
    return { httpStatus: 200, body: { ok: true } };
  }
  return { httpStatus: 400, body: { error: 'Unknown action: ' + action } };
}

const FABRIC_PLAN_ACTIONS = new Set(['create', 'update', 'retire', 'restore', 'delete']);

/** POST /admin/api/plans → { httpStatus, body } */
export async function planAction(body) {
  const b = Object.assign({}, body || {});
  const software = String(b.software || 'weight');
  delete b.software;
  if (software === 'weight') return weightAction(b);
  if (software === 'fabric') {
    if (!FABRIC_PLAN_ACTIONS.has(String(b.action || ''))) return { httpStatus: 400, body: { error: 'Unknown action: ' + b.action } };
    const r = await fabricCall('POST', '/admin/api/plans', b);
    if (r.status === 404) return { httpStatus: 501, body: { error: 'NOT_YET', message: NOT_YET } };
    if (r.status === 200) await logEvent(null, 'ADMIN_PLAN_' + String(b.action).toUpperCase(), { software: 'fabric', code: b.code || b.name || null });
    return { httpStatus: r.status, body: r.body };
  }
  return { httpStatus: 400, body: { error: 'No such software: ' + software } };
}

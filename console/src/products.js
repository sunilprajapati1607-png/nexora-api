/**
 * Every software side by side: their companies, the links between them, their actions, their plans
 * and their demo rules — each asked of its own service with its own key.
 */
import { q, logEvent } from './db.js';
import { SOFTWARE, PRODUCTS, REMOTE_IDS, isRemote, softwareOf, softwareCall, asleep } from './software.js';
import { weightCompanies, weightPlans, forgetWeight } from './weight.js';

const IST = 5.5 * 3600000;
const istDay = (ms) => Math.floor((ms + IST) / 86400000);
const gstKey = (g) => String(g || '').toUpperCase().replace(/\s+/g, '');

async function linksOf(product) {
  const rows = await q(`SELECT remote_id, company_id FROM console.product_links WHERE product = $1`, [product]);
  const m = new Map();
  rows.forEach((r) => m.set(String(r.remote_id), r.company_id == null ? null : String(r.company_id)));
  return m;
}

/** One remote company as the console shows it: its own record, plus its days and whose it is. */
function shown(id, c, owner, via) {
  const now = Date.now();
  const end = c.expiresAt ? new Date(c.expiresAt).getTime() : 0;
  const start = c.periodStartedAt || c.createdAt;
  const expired = !end || end < now;
  const daysLeft = end ? Math.max(0, istDay(end) - istDay(now)) : 0;
  return Object.assign({}, c, {
    product: id, daysLeft, expired,
    periodDays: start && end ? Math.max(0, istDay(end) - istDay(new Date(start).getTime())) : null,
    shownState: c.state === 'SUSPENDED' ? 'SUSPENDED' : expired ? 'EXPIRED' : c.state === 'DEMO' ? 'DEMO' : 'LICENSED',
    endingSoon: c.state === 'LICENSED' && !expired && daysLeft <= 30,
    companyId: owner, linkedBy: owner ? via : null
  });
}

async function remoteProduct(id, ours, known) {
  const out = Object.assign({}, PRODUCTS.find((p) => p.id === id), { ok: false, companies: [] });
  const r = await softwareCall(id, 'GET', '/admin/api/companies');
  if (r.status === 200 && Array.isArray(r.body.companies)) {
    const links = await linksOf(id);
    const byGst = new Map();
    ours.forEach((x) => { const k = gstKey(x.gstin); if (k) byGst.set(k, byGst.has(k) ? '' : String(x.id)); });
    out.ok = true;
    out.companies = r.body.companies.filter((c) => !c.deletedAt).map((c) => {
      const rid = String(c.id);
      if (links.has(rid)) { const to = links.get(rid); return shown(id, c, to && known.has(to) ? to : null, 'hand'); }
      const g = byGst.get(gstKey(c.gstin));
      return shown(id, c, g || null, 'gstin');
    });
  } else { out.error = r.body.error || id.toUpperCase() + '_DOWN'; out.message = r.body.message || asleep(id).message; }
  return out;
}

/** GET /admin/api/products */
export async function listProducts() {
  const w = await weightCompanies();
  const known = new Set(w.companies.map((c) => c.id));
  const remotes = await Promise.all(REMOTE_IDS.map((id) => remoteProduct(id, w.companies, known)));
  const weight = Object.assign({}, PRODUCTS[0], w.ok ? { ok: true } : { ok: false, error: w.error || 'WEIGHT_DOWN', message: w.message || asleep('weight').message });
  return { products: [weight].concat(remotes) };
}

/* GET /console/links — whether each software answers its key. Only the word, never a company. */
let linkSeen = null;
export async function consoleLinks() {
  if (linkSeen && Date.now() - linkSeen.at < 5 * 60000) return linkSeen.out;
  const out = { checkedAt: new Date().toISOString() };
  await Promise.all(SOFTWARE.map(async (s) => {
    const r = await softwareCall(s.id, 'GET', s.id === 'weight' ? '/admin/api/events?limit=1' : '/admin/api/events?limit=1');
    out[s.id] = r.status === 200 ? 'connected' : r.body.error === s.id.toUpperCase() + '_KEY' ? 'key refused' : 'not answering';
  }));
  linkSeen = { at: Date.now(), out };
  return out;
}

const COMPANY_ACTIONS = new Set(['create', 'update', 'suspend', 'resume', 'adminuser', 'usersignout', 'passcode']);
const DEVICE_ACTIONS = new Set(['revoke', 'restore']);

/** POST /admin/api/fabric | erp | consult — { action, id, ... } → { httpStatus, body } */
export async function remoteAction(id, body, who) {
  if (!isRemote(id)) return { httpStatus: 400, body: { error: 'No such software: ' + id } };
  const EV = 'ADMIN_' + id.toUpperCase() + '_';
  const b = Object.assign({}, body || {});
  const action = String(b.action || '');

  if (action === 'link' || action === 'apart' || action === 'unlink') {
    const rid = String(parseInt(b.id, 10) || '');
    if (!rid) return { httpStatus: 400, body: { error: 'Which ' + softwareOf(id).short + ' company?' } };
    if (action === 'unlink') await q(`DELETE FROM console.product_links WHERE product = $1 AND remote_id = $2`, [id, rid]);
    else {
      let to = null;
      if (action === 'link') {
        to = String(parseInt(b.companyId, 10) || '');
        const w = await weightCompanies(true);
        if (!to || !w.companies.some((c) => c.id === to)) return { httpStatus: 404, body: { error: 'No such Sales & Costing company.' } };
      }
      await q(`INSERT INTO console.product_links (product, remote_id, company_id) VALUES ($1, $2, $3)
               ON CONFLICT (product, remote_id) DO UPDATE SET company_id = EXCLUDED.company_id, linked_at = now()`, [id, rid, to]);
    }
    await logEvent(EV + action.toUpperCase(), { remoteId: Number(rid), companyId: b.companyId ? Number(b.companyId) : null, via: who });
    return { httpStatus: 200, body: { ok: true } };
  }

  if (action === 'detail') {
    const r = await softwareCall(id, 'GET', '/admin/api/company?id=' + encodeURIComponent(parseInt(b.id, 10) || 0));
    return { httpStatus: r.status, body: r.body };
  }

  if (COMPANY_ACTIONS.has(action)) {
    const linkTo = action === 'create' ? parseInt(b.linkTo, 10) || null : null;
    delete b.linkTo;
    const r = await softwareCall(id, 'POST', '/admin/api/company', b);
    if (r.status === 200 && linkTo && r.body.company && r.body.company.id != null) {
      await q(`INSERT INTO console.product_links (product, remote_id, company_id) VALUES ($1, $2, $3)
               ON CONFLICT (product, remote_id) DO UPDATE SET company_id = EXCLUDED.company_id, linked_at = now()`, [id, String(r.body.company.id), linkTo]);
    }
    if (r.status === 200) {
      await logEvent(EV + action.toUpperCase(), {
        remoteId: r.body.company ? Number(r.body.company.id) : (b.id != null ? Number(b.id) : null),
        name: b.name || undefined, days: b.days != null ? Number(b.days) : undefined, seats: b.seats != null ? Number(b.seats) : undefined,
        state: b.state || undefined, linkedTo: linkTo || undefined, via: who });
    }
    return { httpStatus: r.status, body: r.body };
  }

  if (DEVICE_ACTIONS.has(action)) {
    const r = await softwareCall(id, 'POST', '/admin/api/device', { action, deviceId: String(b.deviceId || '') });
    if (r.status === 200) await logEvent(EV + 'DEVICE_' + action.toUpperCase(), { deviceId: String(b.deviceId || '').slice(0, 12), via: who });
    return { httpStatus: r.status, body: r.body };
  }
  return { httpStatus: 400, body: { error: 'Unknown action: ' + action } };
}

/* ---- each software's own demo rules ---- */
export const DEMO_FIELDS = ['trialDays', 'demoGraceDays', 'demoSeats', 'signupsOpen', 'expiredMode'];
export const pickDemo = (s) => { const o = {}; DEMO_FIELDS.forEach((k) => { if (s && s[k] !== undefined) o[k] = s[k]; }); return o; };

async function rulesOf(id) {
  if (id === 'weight') {
    const r = await softwareCall('weight', 'GET', '/admin/api/software-settings?software=weight');
    const w = r.status === 200 && Array.isArray(r.body.software) ? r.body.software.find((x) => x.id === 'weight') : null;
    return w && w.ok ? { id, ok: true, settings: pickDemo(w.settings) } : { id, ok: false, error: r.body.error || 'WEIGHT_DOWN', message: r.body.message || asleep(id).message };
  }
  const r = await softwareCall(id, 'POST', '/admin/api/settings', {});
  if (r.status === 200 && r.body && r.body.settings) return { id, ok: true, settings: pickDemo(r.body.settings) };
  return { id, ok: false, error: r.body.error || id.toUpperCase() + '_DOWN', message: r.body.message || asleep(id).message };
}
export async function listRules() { return { software: await Promise.all(SOFTWARE.map((s) => rulesOf(s.id))) }; }

export async function setRules(body, who) {
  const b = body || {};
  const id = String(b.software || '');
  if (!softwareOf(id)) return { httpStatus: 400, body: { error: 'No such software: ' + id } };
  const big = id === 'weight';
  const out = {};
  const int = (k, lo, hi, msg) => {
    if (b[k] === undefined) return null;
    const n = parseInt(b[k], 10);
    if (!(n >= lo && n <= hi) || String(n) !== String(b[k]).trim()) return msg;
    out[k] = n; return null;
  };
  const bad = int('trialDays', 1, big ? 365 : 60, 'Demo days must be 1 to ' + (big ? 365 : 60) + '.')
    || int('demoGraceDays', 0, big ? 365 : 30, 'Offline days for a demo must be 0 to ' + (big ? 365 : 30) + '.')
    || (big ? null : int('demoSeats', 1, 50, 'Demo seats must be 1 to 50.'));
  if (bad) return { httpStatus: 400, body: { error: bad } };
  if (big && b.demoSeats !== undefined) return { httpStatus: 400, body: { error: 'Sales & Costing sets seats per company, not for demos.' } };
  if (b.signupsOpen !== undefined) out.signupsOpen = b.signupsOpen === true || b.signupsOpen === 'yes';
  if (b.expiredMode !== undefined) {
    if (b.expiredMode !== 'READONLY' && b.expiredMode !== 'HARDSTOP') return { httpStatus: 400, body: { error: 'When a licence ends: READONLY or HARDSTOP.' } };
    out.expiredMode = b.expiredMode;
  }
  if (!Object.keys(out).length) return { httpStatus: 400, body: { error: 'Nothing to change.' } };
  const before = await rulesOf(id);
  const r = big ? await softwareCall('weight', 'POST', '/admin/api/software-settings', Object.assign({ software: 'weight' }, out))
    : await softwareCall(id, 'POST', '/admin/api/settings', out);
  if (r.status !== 200 || !r.body || !r.body.settings) return { httpStatus: r.status === 200 ? 502 : r.status, body: r.body };
  const after = pickDemo(r.body.settings), was = {}, now = {};
  Object.keys(out).forEach((k) => { if (!before.ok || before.settings[k] !== after[k]) { was[k] = before.ok ? before.settings[k] : null; now[k] = after[k]; } });
  if (Object.keys(now).length) await logEvent('ADMIN_' + id.toUpperCase() + '_SETTINGS', { was, now, via: who });
  return { httpStatus: 200, body: { ok: true, id, settings: after } };
}

/* ---- plans: Sales & Costing's from its service, the others' from theirs ---- */
const NOT_YET = (id) => softwareOf(id).short + '’s own service has no plans yet. They are made there first (in its own window); until then every company is on Standard.';
async function remotePlanBlock(id) {
  const base = Object.assign({}, PRODUCTS.find((p) => p.id === id));
  const r = await softwareCall(id, 'GET', '/admin/api/plans');
  if (r.status === 200 && Array.isArray(r.body.plans)) return Object.assign(base, { ok: true, supported: true, features: r.body.features || [], plans: r.body.plans });
  if (r.status === 404) return Object.assign(base, { ok: true, supported: false, message: NOT_YET(id), features: [], plans: [] });
  return Object.assign(base, { ok: false, supported: false, error: r.body.error || id.toUpperCase() + '_DOWN', message: r.body.message || '', features: [], plans: [] });
}
export async function listPlans() {
  const blocks = await Promise.all([weightPlans(true)].concat(REMOTE_IDS.map((id) => remotePlanBlock(id))));
  return { software: blocks };
}
const PLAN_ACTIONS = new Set(['create', 'update', 'retire', 'restore', 'delete']);
export async function planAction(body, who) {
  const b = Object.assign({}, body || {});
  const software = String(b.software || 'weight');
  if (!softwareOf(software)) return { httpStatus: 400, body: { error: 'No such software: ' + software } };
  if (!PLAN_ACTIONS.has(String(b.action || ''))) return { httpStatus: 400, body: { error: 'Unknown action: ' + b.action } };
  if (software === 'weight') {
    const r = await softwareCall('weight', 'POST', '/admin/api/plans', b);
    forgetWeight();
    return { httpStatus: r.status, body: r.body };            /* Sales & Costing logs its own plan changes */
  }
  delete b.software;
  const r = await softwareCall(software, 'POST', '/admin/api/plans', b);
  if (r.status === 404) return { httpStatus: 501, body: { error: 'NOT_YET', message: NOT_YET(software) } };
  if (r.status === 200) await logEvent('ADMIN_PLAN_' + String(b.action).toUpperCase(), { software, code: b.code || b.name || null, via: who });
  return { httpStatus: r.status, body: r.body };
}

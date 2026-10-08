/**
 * Nexora API — every Nexora software in the one console (owner 2026-10-07)
 * ----------------------------------------------------------------------
 * "nexora console page single rahese badhi service tya thij update chalu
 *  bandh thase" — one console page for every Nexora software: a licence is
 * renewed, started and stopped from here, whichever software it is for.
 *
 * Each software keeps ITS OWN service, database, licence key, plan, period,
 * seats, people and rights ("દરેક software અલગ"). Nothing of another
 * software is copied into this database: the console asks that software's
 * own console API, with the console key, and shows the answer beside the
 * weight calculation's. The one thing kept here is which weight-calculation
 * company another software's company belongs to (product_links) — and only
 * when the owner says so by hand; a company with the same GSTIN is taken to
 * be the same company without asking.
 *
 *   weight  Nexora Bag Weight Calculation — this service (admin.js)
 *   fabric  Nexora Loom & Fabric Stock — nexora-fabric-stock-api, its own
 *           Supabase. Its console API answers only to FS_ADMIN_KEY, which
 *           the owner sets on that service to the SAME key as this console
 *           (NEXORA_ADMIN_KEY), so one key opens both. FABRIC_STOCK_ADMIN_KEY
 *           here would override it, should the two ever need to differ.
 *
 * Jobwork has no licence yet (owner: "હમણાં બહાર રાખો") and joins this list
 * when it has one.
 */
import { q, logEvent } from './db.js';

export const PRODUCTS = [
  { id: 'weight', name: 'Nexora Bag Weight Calculation', short: 'Sales & Costing' },
  { id: 'fabric', name: 'Nexora Loom & Fabric Stock', short: 'Fabric Stock' }
];

const FABRIC_URL = String(process.env.FABRIC_STOCK_URL || 'https://nexora-fabric-stock-api.onrender.com').replace(/\/+$/, '');
/* A free Render service that has gone to sleep takes up to about a minute to wake. */
const FABRIC_WAIT_MS = Math.max(2000, parseInt(process.env.FABRIC_STOCK_WAIT_MS, 10) || 55000);
const fabricKey = () => process.env.FABRIC_STOCK_ADMIN_KEY || process.env.NEXORA_ADMIN_KEY || '';

const NOT_CONNECTED = {
  error: 'FABRIC_KEY',
  message: 'Fabric Stock did not accept the console key. On Render, open nexora-fabric-stock-api → Environment and set FS_ADMIN_KEY to the same key as this console, then try again.'
};
const ASLEEP = {
  error: 'FABRIC_DOWN',
  message: 'Fabric Stock\'s service did not answer — it may be waking up. Try again in a minute.'
};

/** Ask Fabric Stock's console API. Never throws: { status, body } with body.error on a failure. */
export async function fabricCall(method, path, body) {
  let r;
  try {
    r = await fetch(FABRIC_URL + path, {
      method,
      headers: Object.assign({ 'x-admin-key': fabricKey(), accept: 'application/json' },
        body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(FABRIC_WAIT_MS)
    });
  } catch (e) {
    return { status: 502, body: Object.assign({}, ASLEEP) };
  }
  if (r.status === 403) return { status: 502, body: Object.assign({}, NOT_CONNECTED) };
  let out = null;
  try { out = await r.json(); } catch (e) { out = null; }
  if (!out || typeof out !== 'object') return { status: 502, body: Object.assign({}, ASLEEP) };
  return { status: r.status, body: out };
}

/* GET /console/links — is each software's console API answering the console key? Only the word, never a
   company: it lets the key set on Fabric Stock be checked without anybody reading it. Asked at most once in
   five minutes, whoever asks; the smallest console call there is (one event), its answer thrown away. */
let linkSeen = null;
export async function consoleLinks() {
  if (linkSeen && Date.now() - linkSeen.at < 5 * 60000) return linkSeen.out;
  const r = await fabricCall('GET', '/admin/api/events?limit=1');
  const fabric = r.status === 200 ? 'connected' : r.body.error === 'FABRIC_KEY' ? 'key refused' : 'not answering';
  const out = { fabric, checkedAt: new Date().toISOString() };
  linkSeen = { at: Date.now(), out };
  return out;
}

/* ---- the links: which weight-calculation company another software's company is ---- */
/* company_id NULL = kept apart on purpose (a same-GSTIN pair the owner said are two companies) */
async function linksOf(product) {
  const rows = await q(`SELECT remote_id, company_id FROM product_links WHERE product = $1`, [product]);
  const m = new Map();
  rows.forEach((r) => m.set(String(r.remote_id), r.company_id == null ? null : String(r.company_id)));
  return m;
}

/* Calendar days in IST, the way both services count a licence's days. */
const IST = 5.5 * 3600000;
const istDay = (ms) => Math.floor((ms + IST) / 86400000);

/** One Fabric Stock company as the console shows it: its own record, plus its days and whose it is. */
function fabricShown(c, owner, via) {
  const now = Date.now();
  const end = c.expiresAt ? new Date(c.expiresAt).getTime() : 0;
  const start = c.periodStartedAt || c.createdAt;
  const expired = !end || end < now;
  const daysLeft = end ? Math.max(0, istDay(end) - istDay(now)) : 0;
  return Object.assign({}, c, {
    product: 'fabric',
    daysLeft,
    expired,
    periodDays: start && end ? Math.max(0, istDay(end) - istDay(new Date(start).getTime())) : null,
    /* the word the console colours it by, the same words as the weight calculation's */
    shownState: c.state === 'SUSPENDED' ? 'SUSPENDED' : expired ? 'EXPIRED' : c.state === 'DEMO' ? 'DEMO' : 'LICENSED',
    endingSoon: c.state === 'LICENSED' && !expired && daysLeft <= 30,
    companyId: owner,          /* the weight-calculation company it belongs to, or null */
    linkedBy: owner ? via : null   /* 'hand' | 'gstin' */
  });
}

const gstKey = (g) => String(g || '').toUpperCase().replace(/\s+/g, '');

/** GET /admin/api/products — every software the console looks after, each with its companies. */
export async function listProducts() {
  const fabric = Object.assign({}, PRODUCTS[1], { ok: false, companies: [] });
  const r = await fabricCall('GET', '/admin/api/companies');
  if (r.status === 200 && Array.isArray(r.body.companies)) {
    const links = await linksOf('fabric');
    /* a GSTIN that belongs to exactly one weight-calculation company names it */
    const ours = await q(`SELECT id, gstin FROM companies WHERE deleted_at IS NULL AND gstin IS NOT NULL AND gstin <> ''`);
    const known = new Set((await q(`SELECT id FROM companies WHERE deleted_at IS NULL`)).map((x) => String(x.id)));
    const byGst = new Map();
    ours.forEach((x) => { const k = gstKey(x.gstin); byGst.set(k, byGst.has(k) ? '' : String(x.id)); });
    fabric.ok = true;
    fabric.companies = r.body.companies.filter((c) => !c.deletedAt).map((c) => {
      const rid = String(c.id);
      if (links.has(rid)) {
        const to = links.get(rid);
        return fabricShown(c, to && known.has(to) ? to : null, 'hand');
      }
      const g = byGst.get(gstKey(c.gstin));
      return fabricShown(c, g || null, 'gstin');
    });
  } else {
    fabric.error = r.body.error || 'FABRIC_DOWN';
    fabric.message = r.body.message || ASLEEP.message;
  }
  return { products: [Object.assign({}, PRODUCTS[0], { ok: true }), fabric] };
}

const COMPANY_ACTIONS = new Set(['create', 'update', 'suspend', 'resume', 'adminuser', 'usersignout', 'passcode']);
const DEVICE_ACTIONS = new Set(['revoke', 'restore']);

/** POST /admin/api/fabric — { action, id, ... }. Returns { httpStatus, body }. */
export async function fabricAction(body) {
  const b = Object.assign({}, body || {});
  const action = String(b.action || '');

  /* the links are this console's own */
  if (action === 'link' || action === 'apart' || action === 'unlink') {
    const rid = String(parseInt(b.id, 10) || '');
    if (!rid) return { httpStatus: 400, body: { error: 'Which Fabric Stock company?' } };
    if (action === 'unlink') {
      await q(`DELETE FROM product_links WHERE product = 'fabric' AND remote_id = $1`, [rid]);
    } else {
      let to = null;
      if (action === 'link') {
        to = parseInt(b.companyId, 10);
        const co = to ? (await q(`SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL`, [to]))[0] : null;
        if (!co) return { httpStatus: 404, body: { error: 'No such Sales & Costing company.' } };
      }
      await q(`INSERT INTO product_links (product, remote_id, company_id) VALUES ('fabric', $1, $2)
               ON CONFLICT (product, remote_id) DO UPDATE SET company_id = EXCLUDED.company_id, linked_at = now()`, [rid, to]);
    }
    await logEvent(null, 'ADMIN_FABRIC_' + action.toUpperCase(), { fabricId: Number(rid), companyId: b.companyId ? Number(b.companyId) : null });
    return { httpStatus: 200, body: { ok: true } };
  }

  if (action === 'detail') {
    const r = await fabricCall('GET', '/admin/api/company?id=' + encodeURIComponent(parseInt(b.id, 10) || 0));
    return { httpStatus: r.status, body: r.body };
  }

  if (COMPANY_ACTIONS.has(action)) {
    /* "Start Fabric Stock" on a weight-calculation company: made there, linked here */
    const linkTo = action === 'create' ? parseInt(b.linkTo, 10) || null : null;
    delete b.linkTo;
    const r = await fabricCall('POST', '/admin/api/company', b);
    if (r.status === 200 && linkTo && r.body.company && r.body.company.id != null) {
      await q(`INSERT INTO product_links (product, remote_id, company_id) VALUES ('fabric', $1, $2)
               ON CONFLICT (product, remote_id) DO UPDATE SET company_id = EXCLUDED.company_id, linked_at = now()`,
        [String(r.body.company.id), linkTo]);
    }
    if (r.status === 200) {
      await logEvent(null, 'ADMIN_FABRIC_' + action.toUpperCase(), {
        fabricId: r.body.company ? Number(r.body.company.id) : (b.id != null ? Number(b.id) : null),
        name: b.name || undefined, days: b.days != null ? Number(b.days) : undefined,
        seats: b.seats != null ? Number(b.seats) : undefined, state: b.state || undefined, linkedTo: linkTo || undefined
      });
    }
    return { httpStatus: r.status, body: r.body };
  }

  if (DEVICE_ACTIONS.has(action)) {
    const r = await fabricCall('POST', '/admin/api/device', { action, deviceId: String(b.deviceId || '') });
    if (r.status === 200) await logEvent(null, 'ADMIN_FABRIC_DEVICE_' + action.toUpperCase(), { deviceId: String(b.deviceId || '').slice(0, 12) });
    return { httpStatus: r.status, body: r.body };
  }

  return { httpStatus: 400, body: { error: 'Unknown action: ' + action } };
}

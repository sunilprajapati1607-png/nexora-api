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
 *           Supabase, console key FS_ADMIN_KEY
 *   erp     Nexora MSME ERP — nexora-msme-erp-api, schema erp in the Fabric
 *           Supabase project, console key ERP_ADMIN_KEY
 *
 * Each remote software's console API answers only to its own key, which the
 * owner sets on that service to the SAME key as this console
 * (NEXORA_ADMIN_KEY), so one key opens them all. The per-software variable
 * here (FABRIC_STOCK_ADMIN_KEY, MSME_ERP_ADMIN_KEY) overrides it, should any
 * two ever need to differ.
 *
 * They all speak the same console API — /admin/api/companies, /company,
 * /device, /events — so this file is a table and one set of calls, not one
 * set per software. Jobwork has no licence yet (owner: "હમણાં બહાર રાખો")
 * and joins the table when it has one.
 */
import { q, logEvent } from './db.js';

export const PRODUCTS = [
  { id: 'weight', name: 'Nexora Bag Weight Calculation', short: 'Sales & Costing' },
  { id: 'fabric', name: 'Nexora Loom & Fabric Stock', short: 'Fabric Stock' },
  { id: 'erp', name: 'Nexora MSME ERP', short: 'MSME ERP' }
];

/* Everything that differs between one remote software and the next. */
const REMOTE = {
  fabric: {
    short: 'Fabric Stock',
    service: 'nexora-fabric-stock-api',
    remoteKey: 'FS_ADMIN_KEY',
    urlEnv: 'FABRIC_STOCK_URL', defaultUrl: 'https://nexora-fabric-stock-api.onrender.com',
    waitEnv: 'FABRIC_STOCK_WAIT_MS', keyEnv: 'FABRIC_STOCK_ADMIN_KEY'
  },
  erp: {
    short: 'MSME ERP',
    service: 'nexora-msme-erp-api',
    remoteKey: 'ERP_ADMIN_KEY',
    urlEnv: 'MSME_ERP_URL', defaultUrl: 'https://nexora-msme-erp-api.onrender.com',
    waitEnv: 'MSME_ERP_WAIT_MS', keyEnv: 'MSME_ERP_ADMIN_KEY'
  }
};

export const REMOTE_IDS = Object.keys(REMOTE);
const isRemote = (id) => Object.prototype.hasOwnProperty.call(REMOTE, id);

const urlOf = (id) => String(process.env[REMOTE[id].urlEnv] || REMOTE[id].defaultUrl).replace(/\/+$/, '');
/* A free Render service that has gone to sleep takes up to about a minute to wake. */
const waitOf = (id) => Math.max(2000, parseInt(process.env[REMOTE[id].waitEnv], 10) || 55000);
const keyOf = (id) => process.env[REMOTE[id].keyEnv] || process.env.NEXORA_ADMIN_KEY || '';

/* The two failures the console can explain, in that software's own words. The codes stay
   per-software (FABRIC_KEY, ERP_DOWN …) so a page that already knows one keeps working. */
const notConnected = (id) => ({
  error: id.toUpperCase() + '_KEY',
  message: REMOTE[id].short + ' did not accept the console key. On Render, open ' + REMOTE[id].service +
    ' → Environment and set ' + REMOTE[id].remoteKey + ' to the same key as this console, then try again.'
});
const asleep = (id) => ({
  error: id.toUpperCase() + '_DOWN',
  message: REMOTE[id].short + '\'s service did not answer — it may be waking up. Try again in a minute.'
});

/** Ask one software's console API. Never throws: { status, body } with body.error on a failure. */
export async function remoteCall(id, method, path, body) {
  if (!isRemote(id)) return { status: 400, body: { error: 'No such software: ' + id } };
  let r;
  try {
    r = await fetch(urlOf(id) + path, {
      method,
      headers: Object.assign({ 'x-admin-key': keyOf(id), accept: 'application/json' },
        body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(waitOf(id))
    });
  } catch (e) {
    return { status: 502, body: asleep(id) };
  }
  if (r.status === 403) return { status: 502, body: notConnected(id) };
  let out = null;
  try { out = await r.json(); } catch (e) { out = null; }
  if (!out || typeof out !== 'object') return { status: 502, body: asleep(id) };
  return { status: r.status, body: out };
}

/** The Fabric Stock call by its old name — plans and payments still ask for it this way. */
export const fabricCall = (method, path, body) => remoteCall('fabric', method, path, body);

/* GET /console/links — is each software's console API answering the console key? Only the word, never a
   company: it lets the key set on each service be checked without anybody reading it. Asked at most once in
   five minutes, whoever asks; the smallest console call there is (one event), its answer thrown away. */
let linkSeen = null;
export async function consoleLinks() {
  if (linkSeen && Date.now() - linkSeen.at < 5 * 60000) return linkSeen.out;
  const out = { checkedAt: new Date().toISOString() };
  await Promise.all(REMOTE_IDS.map(async (id) => {
    const r = await remoteCall(id, 'GET', '/admin/api/events?limit=1');
    out[id] = r.status === 200 ? 'connected'
      : r.body.error === id.toUpperCase() + '_KEY' ? 'key refused' : 'not answering';
  }));
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

/* Calendar days in IST, the way every one of these services counts a licence's days. */
const IST = 5.5 * 3600000;
const istDay = (ms) => Math.floor((ms + IST) / 86400000);

/** One remote company as the console shows it: its own record, plus its days and whose it is. */
function shown(id, c, owner, via) {
  const now = Date.now();
  const end = c.expiresAt ? new Date(c.expiresAt).getTime() : 0;
  const start = c.periodStartedAt || c.createdAt;
  const expired = !end || end < now;
  const daysLeft = end ? Math.max(0, istDay(end) - istDay(now)) : 0;
  return Object.assign({}, c, {
    product: id,
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

/** One remote software with its companies, each said to belong to a weight-calculation company or not. */
async function remoteProduct(id, ours, known) {
  const meta = PRODUCTS.find((p) => p.id === id);
  const out = Object.assign({}, meta, { ok: false, companies: [] });
  const r = await remoteCall(id, 'GET', '/admin/api/companies');
  if (r.status === 200 && Array.isArray(r.body.companies)) {
    const links = await linksOf(id);
    /* a GSTIN that belongs to exactly one weight-calculation company names it */
    const byGst = new Map();
    ours.forEach((x) => { const k = gstKey(x.gstin); byGst.set(k, byGst.has(k) ? '' : String(x.id)); });
    out.ok = true;
    out.companies = r.body.companies.filter((c) => !c.deletedAt).map((c) => {
      const rid = String(c.id);
      if (links.has(rid)) {
        const to = links.get(rid);
        return shown(id, c, to && known.has(to) ? to : null, 'hand');
      }
      const g = byGst.get(gstKey(c.gstin));
      return shown(id, c, g || null, 'gstin');
    });
  } else {
    out.error = r.body.error || id.toUpperCase() + '_DOWN';
    out.message = r.body.message || asleep(id).message;
  }
  return out;
}

/** GET /admin/api/products — every software the console looks after, each with its companies. */
export async function listProducts() {
  /* read our own companies once, however many remote softwares there are */
  const ours = await q(`SELECT id, gstin FROM companies WHERE deleted_at IS NULL AND gstin IS NOT NULL AND gstin <> ''`);
  const known = new Set((await q(`SELECT id FROM companies WHERE deleted_at IS NULL`)).map((x) => String(x.id)));
  const remotes = await Promise.all(REMOTE_IDS.map((id) => remoteProduct(id, ours, known)));
  return { products: [Object.assign({}, PRODUCTS[0], { ok: true })].concat(remotes) };
}

const COMPANY_ACTIONS = new Set(['create', 'update', 'suspend', 'resume', 'adminuser', 'usersignout', 'passcode']);
const DEVICE_ACTIONS = new Set(['revoke', 'restore']);

/** POST /admin/api/fabric | /admin/api/erp — { action, id, ... }. Returns { httpStatus, body }. */
export async function remoteAction(id, body) {
  if (!isRemote(id)) return { httpStatus: 400, body: { error: 'No such software: ' + id } };
  const EV = 'ADMIN_' + id.toUpperCase() + '_';
  const b = Object.assign({}, body || {});
  const action = String(b.action || '');

  /* the links are this console's own */
  if (action === 'link' || action === 'apart' || action === 'unlink') {
    const rid = String(parseInt(b.id, 10) || '');
    if (!rid) return { httpStatus: 400, body: { error: 'Which ' + REMOTE[id].short + ' company?' } };
    if (action === 'unlink') {
      await q(`DELETE FROM product_links WHERE product = $1 AND remote_id = $2`, [id, rid]);
    } else {
      let to = null;
      if (action === 'link') {
        to = parseInt(b.companyId, 10);
        const co = to ? (await q(`SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL`, [to]))[0] : null;
        if (!co) return { httpStatus: 404, body: { error: 'No such Sales & Costing company.' } };
      }
      await q(`INSERT INTO product_links (product, remote_id, company_id) VALUES ($1, $2, $3)
               ON CONFLICT (product, remote_id) DO UPDATE SET company_id = EXCLUDED.company_id, linked_at = now()`, [id, rid, to]);
    }
    await logEvent(null, EV + action.toUpperCase(), { remoteId: Number(rid), companyId: b.companyId ? Number(b.companyId) : null });
    return { httpStatus: 200, body: { ok: true } };
  }

  if (action === 'detail') {
    const r = await remoteCall(id, 'GET', '/admin/api/company?id=' + encodeURIComponent(parseInt(b.id, 10) || 0));
    return { httpStatus: r.status, body: r.body };
  }

  if (COMPANY_ACTIONS.has(action)) {
    /* "Start MSME ERP" on a weight-calculation company: made there, linked here */
    const linkTo = action === 'create' ? parseInt(b.linkTo, 10) || null : null;
    delete b.linkTo;
    const r = await remoteCall(id, 'POST', '/admin/api/company', b);
    if (r.status === 200 && linkTo && r.body.company && r.body.company.id != null) {
      await q(`INSERT INTO product_links (product, remote_id, company_id) VALUES ($1, $2, $3)
               ON CONFLICT (product, remote_id) DO UPDATE SET company_id = EXCLUDED.company_id, linked_at = now()`,
        [id, String(r.body.company.id), linkTo]);
    }
    if (r.status === 200) {
      await logEvent(null, EV + action.toUpperCase(), {
        remoteId: r.body.company ? Number(r.body.company.id) : (b.id != null ? Number(b.id) : null),
        name: b.name || undefined, days: b.days != null ? Number(b.days) : undefined,
        seats: b.seats != null ? Number(b.seats) : undefined, state: b.state || undefined, linkedTo: linkTo || undefined
      });
    }
    return { httpStatus: r.status, body: r.body };
  }

  if (DEVICE_ACTIONS.has(action)) {
    const r = await remoteCall(id, 'POST', '/admin/api/device', { action, deviceId: String(b.deviceId || '') });
    if (r.status === 200) await logEvent(null, EV + 'DEVICE_' + action.toUpperCase(), { deviceId: String(b.deviceId || '').slice(0, 12) });
    return { httpStatus: r.status, body: r.body };
  }

  return { httpStatus: 400, body: { error: 'Unknown action: ' + action } };
}

/** POST /admin/api/fabric by its old name. */
export const fabricAction = (body) => remoteAction('fabric', body);

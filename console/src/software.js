/**
 * Nexora Console — the softwares it looks after, and how each is reached (2026-11-07)
 * ----------------------------------------------------------------------
 * Owner: "console service alag krvi hoy to jethi baki tamam software service aema link kri sakay" → "kri do".
 *
 * The console is its own service now. Every Nexora software — Sales & Costing included — is reached the
 * same way: its own address and ITS OWN console key, kept here in this service's environment
 * (WEIGHT_KEY, FABRIC_KEY, ERP_KEY, CONSULT_KEY = the key each service already has). No software has
 * to share a key with another any more, and a software is added by one row here and one key on Render.
 *
 * Each software keeps its own service, database, licences, plans and demo rules. Nothing of one is
 * copied into another; the console asks each and shows the answers side by side.
 */
export const SOFTWARE = [
  { id: 'weight', name: 'Nexora Bag Weight Calculation', short: 'Sales & Costing', service: 'nexora-api',
    urlEnv: 'WEIGHT_URL', defaultUrl: 'https://nexora-api-55jv.onrender.com', keyEnv: 'WEIGHT_KEY', remoteKey: 'NEXORA_ADMIN_KEY' },
  { id: 'fabric', name: 'Nexora Loom & Fabric Stock', short: 'Fabric Stock', service: 'nexora-fabric-stock-api',
    urlEnv: 'FABRIC_URL', defaultUrl: 'https://nexora-fabric-stock-api.onrender.com', keyEnv: 'FABRIC_KEY', remoteKey: 'FS_ADMIN_KEY' },
  { id: 'erp', name: 'Nexora MSME ERP', short: 'MSME ERP', service: 'nexora-msme-erp-api',
    urlEnv: 'ERP_URL', defaultUrl: 'https://nexora-msme-erp-api.onrender.com', keyEnv: 'ERP_KEY', remoteKey: 'ERP_ADMIN_KEY' },
  { id: 'consult', name: 'Nexora Consult', short: 'Nexora Consult', service: 'nexora-consult-api',
    urlEnv: 'CONSULT_URL', defaultUrl: 'https://nexora-consult-api.onrender.com', keyEnv: 'CONSULT_KEY', remoteKey: 'CONSULT_ADMIN_KEY' }
];
export const PRODUCTS = SOFTWARE.map((s) => ({ id: s.id, name: s.name, short: s.short }));
/* every software but Sales & Costing speaks the common console API (/admin/api/companies, /company, …) */
export const REMOTE_IDS = SOFTWARE.filter((s) => s.id !== 'weight').map((s) => s.id);
export const isRemote = (id) => REMOTE_IDS.indexOf(id) >= 0;
export const softwareOf = (id) => SOFTWARE.find((s) => s.id === id) || null;

export const urlOf = (id) => String(process.env[softwareOf(id).urlEnv] || softwareOf(id).defaultUrl).replace(/\/+$/, '');
export const keyOf = (id) => String(process.env[softwareOf(id).keyEnv] || '');
/* a free Render service that has gone to sleep takes up to about a minute to wake */
const waitOf = (id) => Math.max(1500, parseInt(process.env[id.toUpperCase() + '_WAIT_MS'], 10) || 55000);
const RETRY_MS = 4000;

export const notConnected = (id) => {
  const s = softwareOf(id);
  return keyOf(id)
    ? { error: id.toUpperCase() + '_KEY', message: s.short + ' did not accept its key. On Render, copy ' + s.remoteKey + ' from ' + s.service + ' → Environment into nexora-console-api as ' + s.keyEnv + ', then try again.' }
    : { error: id.toUpperCase() + '_KEY', message: s.short + '’s key is not set on the console service. On Render, copy ' + s.remoteKey + ' from ' + s.service + ' → Environment into nexora-console-api as ' + s.keyEnv + '.' };
};
export const asleep = (id) => ({
  error: id.toUpperCase() + '_DOWN',
  message: softwareOf(id).short + '’s service did not answer — it may be waking up. Try again in a minute.'
});

/**
 * Ask one software's service. Never throws: { status, body } with body.error on a failure.
 * `raw: true` returns the response itself (the pass-through for Sales & Costing's own console calls).
 */
export async function softwareCall(id, method, path, body, opts) {
  const o = opts || {};
  const key = keyOf(id);
  if (!key) return { status: 502, body: notConnected(id) };
  const ctl = new AbortController();
  const until = Date.now() + (o.wait || waitOf(id));
  const timer = setTimeout(() => ctl.abort(), o.wait || waitOf(id));
  try {
    const headers = Object.assign({ 'x-admin-key': key, accept: 'application/json' }, o.headers || {});
    let payload;
    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof body === 'string' || body instanceof Uint8Array) payload = body;
      else { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    }
    /* 2026-11-09 — A FREE SERVICE THAT IS ASLEEP. While Render wakes it, its front door answers 429 / 502 / 503 /
       504 by itself (not JSON — the request never reached the service). Those are asked again every few seconds
       until the service answers or the wait runs out; a POST is safe to repeat because it never arrived. An
       answer from the service itself (JSON, e.g. its own TOO_MANY) is never repeated. */
    let r;
    for (let n = 0; ; n++) {
      r = await fetch(urlOf(id) + path, { method, headers, body: payload, signal: ctl.signal, redirect: 'manual' });
      const waking = [429, 502, 503, 504].includes(r.status) && !/json/i.test(r.headers.get('content-type') || '');
      const pause = Math.min(RETRY_MS, 500 * (n + 1));
      if (!waking || Date.now() + pause > until) break;
      try { await r.arrayBuffer(); } catch (e) { /* drained */ }
      await new Promise((ok) => setTimeout(ok, pause));
    }
    if (o.raw) return { status: r.status, response: r };
    let out = null;
    try { out = await r.json(); } catch (e) { out = null; }
    if (r.status === 401 || r.status === 403) return { status: 502, body: notConnected(id) };
    if (!out || typeof out !== 'object') return { status: 502, body: asleep(id) };
    return { status: r.status, body: out };
  } catch (e) {
    return { status: 502, body: asleep(id) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Nexora Console service — integrity (2026-11-07)
 * Sales & Costing, Fabric Stock, MSME ERP and Nexora Consult are each played by a small local service with
 * its OWN key; the console's own tables live in a throw-away Postgres (NEXORA_TEST_DB). Nothing live is touched.
 * Run: node test/console-test.mjs   (via scratchpad pgtest/run.mjs for the database)
 */
import http from 'node:http';

const DB = process.env.NEXORA_TEST_DB;
process.env.DATABASE_URL = DB;
process.env.CONSOLE_ADMIN_KEY = 'console-key-0123456789-abcdef';
const KEYS = { weight: 'weight-own-key', fabric: 'fabric-own-key-xyz', erp: 'erp-own-key-123', consult: 'consult-own-key-0123456789' };
['WEIGHT', 'FABRIC', 'ERP', 'CONSULT'].forEach((s) => { process.env[s + '_WAIT_MS'] = '2500'; });

const day = 86400000, iso = (n) => new Date(Date.now() + n * day).toISOString();
const seen = { weight: [], fabric: [], erp: [], consult: [] };
const state = { weightDown: false };
const W = {
  companies: [
    { id: 1, name: 'Alpha Sacks', gstin: '24AAAAA0001A1Z1', plan: 'PRO', state: 'LICENSED', is_demo: false, expires_at: iso(100) },
    { id: 2, name: 'Beta Bags', gstin: '27BBBBB0002B1Z2', plan: 'STANDARD', state: 'DEMO', is_demo: true, expires_at: iso(4) },
    { id: 3, name: 'Gone Ltd', gstin: '24GGGGG0003G1Z3', plan: 'PRO', state: 'LICENSED', is_demo: false, expires_at: iso(50), deleted_at: iso(-1) }
  ],
  settings: { trialDays: 15, demoGraceDays: 0, signupsOpen: true, expiredMode: 'READONLY' },
  events: [{ at: iso(-0.5), event: 'ADMIN_COMPANY_UPDATE', device_id: null, detail: { id: 1 } }]
};
const R = {
  fabric: { settings: { trialDays: 7, demoGraceDays: 0, demoSeats: 3, signupsOpen: true, expiredMode: 'READONLY' },
    companies: [{ id: 11, name: 'Alpha Sacks', gstin: '24aaaaa0001a1z1', state: 'LICENSED', plan: 'STANDARD', expiresAt: iso(200), people: 2, devices: 1 }] },
  erp: { settings: { trialDays: 14, demoGraceDays: 2, demoSeats: 5, signupsOpen: false, expiredMode: 'HARDSTOP' },
    companies: [{ id: 21, name: 'Echo Mills', gstin: '24EEEEE0005E1Z5', state: 'DEMO', plan: 'STANDARD', expiresAt: iso(6), people: 1, devices: 1 }] },
  consult: { settings: { trialDays: 10, demoGraceDays: 1, demoSeats: 2, signupsOpen: true, expiredMode: 'READONLY' },
    companies: [{ id: 31, name: 'Echo Mills', gstin: '24EEEEE0005E1Z5', state: 'LICENSED', plan: 'FIRM', planName: 'Firm', expiresAt: iso(300), people: 3, devices: 2 }] }
};

function standIn(id) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (o, s, type) => { res.writeHead(s || 200, { 'content-type': type || 'application/json' }); res.end(type ? o : JSON.stringify(o)); };
      seen[id].push({ method: req.method, url: req.url, key: req.headers['x-admin-key'], body: raw, console: req.headers['x-console'] });
      if (id === 'weight' && state.weightDown) { req.socket.destroy(); return; }
      if (id === 'weight' && req.url === '/admin') return send('<html>Enter the admin key (NEXORA_ADMIN_KEY on the service).</html>', 200, 'text/html; charset=utf-8');
      if (id === 'weight' && req.url === '/logo.png') return send('PNG', 200, 'image/png');
      if (req.headers['x-admin-key'] !== KEYS[id]) return send({ error: 'Not allowed.' }, 403);
      const body = raw ? JSON.parse(raw) : {};
      const u = req.url;
      if (id === 'weight') {
        if (u === '/admin/api/licences') return send({ companies: W.companies, licences: [] });
        if (u === '/admin/api/plans?software=weight') return send({ software: [{ id: 'weight', ok: true, supported: true, plans: [{ code: 'PRO', name: 'Pro' }, { code: 'STANDARD', name: 'Standard' }], features: [] }] });
        if (u === '/admin/api/software-settings?software=weight') return send({ software: [{ id: 'weight', ok: true, settings: W.settings }] });
        if (u === '/admin/api/software-settings' && req.method === 'POST') { Object.assign(W.settings, body); delete W.settings.software; return send({ ok: true, id: 'weight', settings: W.settings }); }
        if (u.startsWith('/admin/api/events')) return send({ events: W.events });
        if (u === '/admin/api/company' && req.method === 'POST') {
          const c = W.companies.find((x) => x.id === body.id);
          if (!c) return send({ error: 'No such company.' }, 404);
          if (body.action === 'extend' || body.action === 'licence') { c.expires_at = new Date(new Date(c.expires_at).getTime() + body.days * day).toISOString(); c.is_demo = false; }
          return send({ ok: true, company: c });
        }
        if (u === '/admin/api/inquiries') return send({ inquiries: [{ id: 5, name: 'Website visitor' }] });
        if (u === '/admin/api/broadcast' && req.method === 'POST') return send({ ok: true, echo: body });
        return send({ error: 'No such console call.' }, 404);
      }
      const S = R[id];
      if (u === '/admin/api/companies') return send({ companies: S.companies });
      if (u.startsWith('/admin/api/events')) return send({ events: [] });
      if (u.startsWith('/admin/api/company?id=')) { const c = S.companies.find((x) => x.id === Number(u.split('=')[1])); return c ? send(c) : send({ error: 'No such company.' }, 404); }
      if (u === '/admin/api/company' && req.method === 'POST') {
        if (body.action === 'create') { const c = { id: 99, name: body.name, state: 'DEMO', expiresAt: iso(body.days || 7) }; S.companies.push(c); return send({ ok: true, company: c }); }
        const c = S.companies.find((x) => x.id === Number(body.id)); if (!c) return send({ error: 'No such company.' }, 404);
        if (body.days) c.expiresAt = iso(body.days); if (body.state) c.state = body.state; if (body.action === 'suspend') c.state = 'SUSPENDED';
        return send({ ok: true, company: c });
      }
      if (u === '/admin/api/settings' && req.method === 'POST') { Object.assign(S.settings, body); return send({ ok: true, settings: Object.assign({ sessionMinutes: 30 }, S.settings) }); }
      if (u === '/admin/api/plans') return id === 'consult' ? send({ error: 'No such console call.' }, 404) : send({ plans: [{ code: 'STANDARD', name: 'Standard' }], features: [] });
      return send({ error: 'No such console call.' }, 404);
    });
  });
}
const srv = {};
for (const id of Object.keys(KEYS)) {
  srv[id] = standIn(id);
  await new Promise((r) => srv[id].listen(0, '127.0.0.1', r));
  process.env[id.toUpperCase() + '_URL'] = 'http://127.0.0.1:' + srv[id].address().port;
  process.env[id.toUpperCase() + '_KEY'] = KEYS[id];
}

const app = (await import('../src/index.js')).default;
const { q, ensureSchema } = await import('../src/db.js');
await ensureSchema();
await q(`TRUNCATE console.product_links, console.customer_payments, console.events RESTART IDENTITY`);

let pass = 0, fail = 0;
const ok = (l, c, got) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (c ? '' : '   got: ' + JSON.stringify(got).slice(0, 300))); c ? pass++ : fail++; };
const CK = process.env.CONSOLE_ADMIN_KEY;
const call = async (path, opts = {}) => {
  const h = Object.assign({ 'x-forwarded-for': opts.ip || '10.0.0.1' }, opts.key === null ? {} : { 'x-admin-key': opts.key || CK }, opts.body ? { 'content-type': 'application/json' } : {}, opts.headers || {});
  const r = await app.fetch(new Request('https://console.test' + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined }));
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch (e) { b = t; }
  return { status: r.status, body: b, headers: r.headers };
};
const clear = () => Object.keys(seen).forEach((k) => { seen[k].length = 0; });
const allSeen = () => Object.keys(seen).flatMap((k) => seen[k].map((s) => Object.assign({ to: k }, s)));

console.log('\nTHE CONSOLE KEY');
clear();
let r = await call('/admin/api/products', { key: null });
ok('no key → 401, and no software was asked', r.status === 401 && allSeen().length === 0, [r.status, allSeen()]);
r = await call('/admin/api/inquiries', { key: KEYS.weight });
ok('Sales & Costing\'s own key is not the console key → 401', r.status === 401 && allSeen().length === 0, r);
for (let i = 0; i < 10; i++) await call('/admin/api/products', { key: 'wrong-wrong-wrong-' + i, ip: '10.9.9.9' });
r = await call('/admin/api/products', { ip: '10.9.9.9' });
ok('10 wrong keys from one address → it waits, even with the right key', r.status === 429, r);
r = await call('/admin/api/products', { ip: '10.0.0.2' });
ok('…another address is not shut out', r.status === 200, r.status);
const wrong = await q(`SELECT count(*)::int AS n FROM console.events WHERE event = 'CONSOLE_KEY_WRONG'`);
ok('every wrong key is in the console\'s own log', wrong[0].n >= 10, wrong);
const saveKey = process.env.CONSOLE_ADMIN_KEY; process.env.CONSOLE_ADMIN_KEY = 'short-key-15chr';
r = await call('/admin/api/products', { key: 'short-key-15chr' });
ok('a console key under 16 characters is never accepted (NOT_SET_UP)', r.status === 503 && r.body.error === 'NOT_SET_UP', r);
process.env.CONSOLE_ADMIN_KEY = saveKey;

console.log('\nEACH SOFTWARE IS REACHED WITH ITS OWN KEY — the console key never leaves');
clear();
r = await call('/admin/api/products');
ok('products: weight, fabric, erp, consult — all connected', r.status === 200 && r.body.products.map((p) => p.id + ':' + p.ok).join() === 'weight:true,fabric:true,erp:true,consult:true', r.body.products);
ok('each service was asked with its own key only', allSeen().every((s) => s.key === KEYS[s.to]), allSeen().map((s) => s.to + ':' + s.key));
ok('*** the console key was sent to no software ***', !allSeen().some((s) => s.key === CK), allSeen());
const fab = r.body.products.find((p) => p.id === 'fabric').companies[0];
ok('a Fabric company with the same GSTIN (other case) belongs to Alpha Sacks', fab.companyId === '1' && fab.linkedBy === 'gstin', fab);
ok('Echo Mills (ERP + Consult, no Sales & Costing) is not given a weight company', r.body.products.find((p) => p.id === 'erp').companies[0].companyId === null, r.body.products[2]);

const keep = process.env.ERP_KEY; process.env.ERP_KEY = 'erp-old-wrong-key';
r = await call('/admin/api/products');
const erp = r.body.products.find((p) => p.id === 'erp');
ok('ERP refusing its key → ok:false ERP_KEY, "copy ERP_ADMIN_KEY … as ERP_KEY"', erp.ok === false && erp.error === 'ERP_KEY' && /ERP_ADMIN_KEY/.test(erp.message) && /ERP_KEY/.test(erp.message), erp);
ok('…the other three still answer', r.body.products.filter((p) => p.ok).length === 3, r.body.products.map((p) => p.ok));
process.env.ERP_KEY = ''; r = await call('/admin/api/products');
ok('ERP with no key set → says the key is not set, and ERP was not asked', /not set/.test(r.body.products.find((p) => p.id === 'erp').message), r.body.products[2]);
process.env.ERP_KEY = keep;

console.log('\nSALES & COSTING\'S OWN CALLS ARE PASSED ON');
clear();
r = await call('/admin/api/inquiries', { headers: { 'x-console': 'android' } });
ok('GET /admin/api/inquiries → Sales & Costing\'s answer, as it is', r.status === 200 && r.body.inquiries[0].name === 'Website visitor', r);
ok('…asked with Sales & Costing\'s key, the console app named', seen.weight[0].key === KEYS.weight && seen.weight[0].console === 'android', seen.weight);
r = await call('/admin/api/broadcast', { body: { text: 'Hello plants' } });
ok('a POST is passed on with its body', r.status === 200 && r.body.echo.text === 'Hello plants', r);
r = await call('/admin/api/nothing-here');
ok('an unknown call gets Sales & Costing\'s own 404', r.status === 404 && r.body.error === 'No such console call.', r);
r = await call('/admin', { key: null });
ok('/admin (the page) needs no key and says which key to type here', r.status === 200 && /CONSOLE_ADMIN_KEY on nexora-console-api/.test(r.body) && !/NEXORA_ADMIN_KEY on the service/.test(r.body), r.body);
r = await call('/logo.png', { key: null });
ok('/logo.png comes through', r.status === 200 && r.headers.get('content-type') === 'image/png', r.status);
state.weightDown = true;
r = await call('/admin/api/inquiries');
ok('Sales & Costing asleep → 502 WEIGHT_DOWN in plain words, no crash', r.status === 502 && r.body.error === 'WEIGHT_DOWN', r);
state.weightDown = false;

console.log('\nACTIONS AND LINKS');
clear();
r = await call('/admin/api/consult', { body: { action: 'suspend', id: 31 } });
ok('a Consult action goes to Consult only, with Consult\'s key', r.status === 200 && seen.consult.length === 1 && seen.consult[0].key === KEYS.consult && !seen.fabric.length && !seen.erp.length, allSeen());
r = await call('/admin/api/erp', { body: { action: 'link', id: 21, companyId: 2 } });
ok('link ERP Echo → Beta Bags (a real Sales & Costing company)', r.status === 200, r);
r = await call('/admin/api/products');
ok('…Echo\'s ERP company now belongs to Beta Bags, by hand', r.body.products.find((p) => p.id === 'erp').companies[0].companyId === '2' && r.body.products.find((p) => p.id === 'erp').companies[0].linkedBy === 'hand', r.body.products[2]);
r = await call('/admin/api/erp', { body: { action: 'link', id: 21, companyId: 3 } });
ok('linking to a deleted Sales & Costing company is refused', r.status === 404, r);
r = await call('/admin/api/erp', { body: { action: 'drop-table' } });
ok('an unknown action is refused here, not passed on', r.status === 400, r);
r = await call('/admin/api/fabric', { body: { action: 'create', name: 'New Fab', days: 7, linkTo: 1 } });
ok('Start Fabric Stock for Alpha: made there, linked here, linkTo not sent on', r.status === 200 && !JSON.parse(seen.fabric.find((s) => s.method === 'POST').body).linkTo, seen.fabric);

console.log('\nPAYMENTS — the ledger is the console\'s own; a renewal happens on the software\'s own service');
clear();
r = await call('/admin/api/payments', { body: { action: 'add', software: 'weight', companyId: 2, amount: '15,000', extendDays: 365, mode: 'UPI' } });
ok('Beta Bags (a demo) paid ₹15,000 + a year → recorded, licensed on Sales & Costing', r.status === 200 && r.body.payment.amount === 15000 && seen.weight.some((s) => s.url === '/admin/api/company' && JSON.parse(s.body).action === 'licence' && JSON.parse(s.body).days === 365), [r.body, seen.weight]);
ok('…plan name read from Sales & Costing\'s plans', r.body.payment.planName === 'Standard', r.body.payment);
r = await call('/admin/api/payments', { body: { action: 'add', software: 'consult', remoteId: 31, amount: 18000, extendDays: 365 } });
ok('Consult payment + a year → renewed on Consult (its own key)', r.status === 200 && seen.consult.some((s) => s.method === 'POST' && s.key === KEYS.consult && JSON.parse(s.body).action === 'update'), seen.consult);
r = await call('/admin/api/payments', { body: { action: 'add', software: 'erp', remoteId: 21, amount: 0 } });
ok('no amount → refused', r.status === 400, r);
r = await call('/admin/api/payments', { body: { action: 'add', software: 'jobwork', amount: 10 } });
ok('an unknown software → refused', r.status === 400, r);
r = await call('/admin/api/payments', { body: { action: 'add', software: 'weight', companyId: 3, amount: 10 } });
ok('a deleted Sales & Costing company cannot be paid for', r.status === 404, r);
r = await call('/admin/api/payments');
ok('the list: 2 payments, ₹33,000, by software weight 15000 / consult 18000', r.body.totals.count === 2 && r.body.totals.amount === 33000 && r.body.totals.bySoftware.weight === 15000 && r.body.totals.bySoftware.consult === 18000, r.body.totals);
const pid = r.body.payments.find((p) => p.software === 'consult').id;
r = await call('/admin/api/payments', { body: { action: 'delete', id: pid } });
r = await call('/admin/api/payments');
ok('a deleted payment leaves the list and the totals (kept, marked)', r.body.totals.count === 1 && r.body.totals.amount === 15000, r.body.totals);
const kept = await q(`SELECT count(*)::int AS n FROM console.customer_payments`);
ok('…but is never erased', kept[0].n === 2, kept);

console.log('\nDEMO RULES AND PLANS — each software\'s own');
r = await call('/admin/api/software-settings');
ok('four answers: 15 · 7 · 14 · 10 demo days', r.body.software.map((s) => s.settings.trialDays).join() === '15,7,14,10', r.body);
clear();
r = await call('/admin/api/software-settings', { body: { software: 'erp', trialDays: 21 } });
ok('ERP 14 → 21 on ERP only, with ERP\'s key', r.status === 200 && R.erp.settings.trialDays === 21 && !seen.fabric.length && !seen.consult.length && seen.erp.every((s) => s.key === KEYS.erp), [R.erp.settings, allSeen()]);
r = await call('/admin/api/software-settings', { body: { software: 'weight', trialDays: 20 } });
ok('Sales & Costing 15 → 20 on its own service', r.status === 200 && W.settings.trialDays === 20, W.settings);
for (const [l, b] of [['0 days', { software: 'fabric', trialDays: 0 }], ['61 days for a remote', { software: 'fabric', trialDays: 61 }], ['demo seats for Sales & Costing', { software: 'weight', demoSeats: 3 }], ['"ten" days', { software: 'consult', trialDays: 'ten' }], ['nothing', { software: 'erp' }]]) {
  r = await call('/admin/api/software-settings', { body: b }); ok('refused: ' + l, r.status === 400, r);
}
r = await call('/admin/api/plans');
ok('plans: Sales & Costing from its own service, Consult says "no plans yet"', r.body.software.map((s) => s.id).join() === 'weight,fabric,erp,consult' && r.body.software[0].plans.length === 2 && r.body.software[3].supported === false, r.body.software.map((s) => s.id + ':' + s.supported));

console.log('\nTHE ACTIVITY LIST');
r = await call('/admin/api/events?limit=50');
ok('Sales & Costing\'s events and the console\'s, newest first', r.status === 200 && r.body.events.some((e) => e.event === 'ADMIN_COMPANY_UPDATE') && r.body.events.some((e) => e.event === 'ADMIN_PAYMENT_ADD' && e.source === 'console'), r.body.events.map((e) => e.event));
ok('…in time order', r.body.events.every((e, i, a) => i === 0 || String(a[i - 1].at) >= String(e.at)), r.body.events.map((e) => e.at));
ok('…payments and settings changes name the console they came from', r.body.events.filter((e) => e.source === 'console' && /PAYMENT_ADD|ERP_SETTINGS/.test(e.event)).every((e) => e.detail && e.detail.via), r.body.events.filter((e) => e.source));

console.log('\n/console/links (no key, no company)');
r = await call('/console/links', { key: null });
ok('each software: connected', ['weight', 'fabric', 'erp', 'consult'].every((k) => r.body[k] === 'connected') && !JSON.stringify(r.body).includes('Alpha'), r.body);

Object.values(srv).forEach((s) => s.close());
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

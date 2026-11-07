/**
 * Nexora API — Nexora Consult in the console, and each software's own demo rules (2026-11-07)
 * ===========================================================================================
 * Owner: "aama msme erp ane consult aap badhu seperate kryu che? darek na subscription demo days badhu
 * seperate rahese" → "Yes, add them".
 *
 * Fabric Stock, MSME ERP and Nexora Consult are each played by a small local service with the same
 * console routes (/admin/api/companies, /settings …) and its OWN key and OWN settings, so nothing live
 * is touched and nothing of one can leak into another.
 *
 * Run:  node software-settings-test.mjs      (needs a Postgres — NEXORA_TEST_DB)
 */
import http from 'node:http';

process.env.DATABASE_URL = process.env.NEXORA_TEST_DB || 'postgresql://nexora_app:test@127.0.0.1:5432/nexora?sslmode=disable';
process.env.NEXORA_TOKEN_SECRET = 'test-secret-abc-0123456789';
process.env.NEXORA_ADMIN_KEY = 'short-console-k';                       /* 15 characters, like the live one */
process.env.NEXORA_CONSULT_ADMIN_KEY = 'consult-own-key-0123456789abcdef';
['FABRIC_STOCK_WAIT_MS', 'MSME_ERP_WAIT_MS', 'NEXORA_CONSULT_WAIT_MS'].forEach((k) => { process.env[k] = '2500'; });

const day = 86400000;
/* one stand-in per software: its own key, its own settings, its own companies, its own log of calls */
function standIn(id, key, settings, companies) {
  const s = { id, key, settings: Object.assign({}, settings), companies, seen: [], mode: 'ok' };
  s.srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (s.mode === 'down') { req.socket.destroy(); return; }
      const send = (o, st) => { res.writeHead(st || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      /* Consult's own rule: a key under 16 characters is never accepted */
      if (req.headers['x-admin-key'] !== s.key || (id === 'consult' && String(req.headers['x-admin-key'] || '').length < 16)) return send({ error: 'Not allowed.' }, 403);
      const body = raw ? JSON.parse(raw) : null;
      s.seen.push({ method: req.method, url: req.url, body });
      if (req.url === '/admin/api/companies') return send({ companies: s.companies });
      if (req.url.startsWith('/admin/api/events')) return send({ events: [] });
      if (req.url === '/admin/api/settings' && req.method === 'POST') {
        Object.keys(body || {}).forEach((k) => { s.settings[k] = body[k]; });
        return send({ ok: true, settings: Object.assign({ sessionMinutes: 30, secretThing: 'not-for-the-console' }, s.settings) });
      }
      if (req.url === '/admin/api/company' && req.method === 'POST') return send({ ok: true, company: s.companies[0] });
      send({ error: 'No such console call.' }, 404);
    });
  });
  return s;
}
const co = (id, name, gstin, state, days) => ({ id, name, gstin, state, isDemo: state === 'DEMO', seats: 2, plan: 'STANDARD',
  expiresAt: new Date(Date.now() + days * day).toISOString(), createdAt: new Date().toISOString(), people: 1, devices: 1 });
const FAB = standIn('fabric', process.env.NEXORA_ADMIN_KEY, { trialDays: 7, demoGraceDays: 0, demoSeats: 3, signupsOpen: true, expiredMode: 'READONLY' }, [co(1, 'River Fab', '24AAAAA1111A1Z1', 'LICENSED', 100)]);
const ERP = standIn('erp', process.env.NEXORA_ADMIN_KEY, { trialDays: 14, demoGraceDays: 2, demoSeats: 5, signupsOpen: false, expiredMode: 'HARDSTOP' }, [co(5, 'Mill ERP', null, 'DEMO', 6)]);
const CON = standIn('consult', process.env.NEXORA_CONSULT_ADMIN_KEY, { trialDays: 10, demoGraceDays: 1, demoSeats: 2, signupsOpen: true, expiredMode: 'READONLY' }, [co(7, 'Shah & Associates', '24CCCCC3333C1Z3', 'DEMO', 9), co(8, 'Mehta Tax LLP', null, 'LICENSED', 300)]);
for (const s of [FAB, ERP, CON]) await new Promise((r) => s.srv.listen(0, '127.0.0.1', r));
process.env.FABRIC_STOCK_URL = 'http://127.0.0.1:' + FAB.srv.address().port;
process.env.MSME_ERP_URL = 'http://127.0.0.1:' + ERP.srv.address().port;
process.env.NEXORA_CONSULT_URL = 'http://127.0.0.1:' + CON.srv.address().port;

const app = (await import('./src/index.js')).default;
const { q } = await import('./src/db.js');

let pass = 0, fail = 0;
const ok = (l, c, got) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (c ? '' : '   got: ' + JSON.stringify(got).slice(0, 400))); c ? pass++ : fail++; };
const call = async (path, opts = {}) => {
  const r = await app.fetch(new Request('https://x' + path, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.stringify(opts.body) : undefined }));
  let b; try { b = await r.json(); } catch (e) { b = 'HTML/text'; }
  return { status: r.status, body: b };
};
const AK = { 'x-admin-key': process.env.NEXORA_ADMIN_KEY, 'content-type': 'application/json' };
const prod = (r, id) => (r.body.products || []).find((p) => p.id === id) || {};
const sw = (r, id) => (r.body.software || []).find((p) => p.id === id) || {};
const clear = () => [FAB, ERP, CON].forEach((s) => { s.seen.length = 0; });

await call('/health');
await q(`TRUNCATE licences, companies, company_users, activation_log RESTART IDENTITY CASCADE`);
await q(`DELETE FROM product_links`);
await q(`DELETE FROM settings WHERE key IN ('trial_days','demo_grace_days','signups_open','expired_mode')`);
let r = await call('/admin/api/company', { method: 'POST', headers: AK, body: { action: 'create', name: 'Shah & Associates', seats: 2, days: 365, gstin: '24ccccc3333c1z3' } });
const SHAH = r.body.company;

console.log('\nNEXORA CONSULT IS THE FOURTH SOFTWARE');
r = await call('/admin/api/products', { headers: AK });
ok('products: weight, fabric, erp, consult — in that order', (r.body.products || []).map((p) => p.id).join() === 'weight,fabric,erp,consult', (r.body.products || []).map((p) => p.id));
ok('Consult answers with its companies', prod(r, 'consult').ok === true && prod(r, 'consult').companies.length === 2, prod(r, 'consult'));
ok('Consult was asked with ITS OWN key, not the 15-character console key', CON.seen.length > 0, CON.seen);
ok('a Consult company with the same GSTIN belongs to the Sales & Costing company', String((prod(r, 'consult').companies.find((c) => c.id === 7) || {}).companyId) === String(SHAH.id), prod(r, 'consult').companies);
ok('…and one without stays Consult only', (prod(r, 'consult').companies.find((c) => c.id === 8) || {}).companyId === null, prod(r, 'consult').companies);
ok('the other software are not mixed in: Fabric 1, ERP 1', prod(r, 'fabric').companies.length === 1 && prod(r, 'erp').companies.length === 1, [prod(r, 'fabric').companies.length, prod(r, 'erp').companies.length]);

delete process.env.NEXORA_CONSULT_ADMIN_KEY;
r = await call('/admin/api/products', { headers: AK });
ok('without its own key, Consult says CONSULT_KEY and how to fix it on Render', prod(r, 'consult').ok === false && prod(r, 'consult').error === 'CONSULT_KEY' && /NEXORA_CONSULT_ADMIN_KEY/.test(prod(r, 'consult').message), prod(r, 'consult'));
ok('…while the three others still work', prod(r, 'fabric').ok && prod(r, 'erp').ok && prod(r, 'weight').ok, r.body.products.map((p) => p.id + ':' + p.ok));
r = await call('/console/links');
ok('/console/links names Consult too ("key refused")', r.body.consult === 'key refused' && r.body.fabric === 'connected', r.body);
process.env.NEXORA_CONSULT_ADMIN_KEY = 'consult-own-key-0123456789abcdef';

clear();
r = await call('/admin/api/consult', { method: 'POST', headers: AK, body: { action: 'suspend', id: 8 } });
ok('a Consult action goes to Consult only', r.status === 200 && CON.seen.length === 1 && FAB.seen.length === 0 && ERP.seen.length === 0, [CON.seen, FAB.seen, ERP.seen]);
const ev = await q(`SELECT event FROM activation_log WHERE event = 'ADMIN_CONSULT_SUSPEND'`);
ok('…and is written in the Activity list', ev.length === 1, ev);

console.log('\nEACH SOFTWARE KEEPS ITS OWN DEMO RULES');
r = await call('/admin/api/software-settings');
ok('no console key → refused, nobody asked', (r.status === 401 || r.status === 403) && CON.seen.length === 1, r);
clear();
r = await call('/admin/api/software-settings', { headers: AK });
ok('all four answer, each its own', r.status === 200 && (r.body.software || []).map((s) => s.id).join() === 'weight,fabric,erp,consult', r.body);
ok('Sales & Costing: 7 demo days (this service)', sw(r, 'weight').settings.trialDays === 7, sw(r, 'weight'));
ok('Fabric 7, ERP 14, Consult 10 — never one number for all', sw(r, 'fabric').settings.trialDays === 7 && sw(r, 'erp').settings.trialDays === 14 && sw(r, 'consult').settings.trialDays === 10, r.body.software);
ok('ERP\'s own: 2 offline days, 5 demo seats, sign-ups closed, hard stop', sw(r, 'erp').settings.demoGraceDays === 2 && sw(r, 'erp').settings.demoSeats === 5 && sw(r, 'erp').settings.signupsOpen === false && sw(r, 'erp').settings.expiredMode === 'HARDSTOP', sw(r, 'erp'));
ok('only the demo rules come back — nothing else a service keeps', !JSON.stringify(r.body).includes('secretThing') && !('sessionMinutes' in sw(r, 'fabric').settings), r.body.software);
ok('reading changed nothing anywhere (an empty ask)', [FAB, ERP, CON].every((s) => s.seen.every((x) => x.url !== '/admin/api/settings' || Object.keys(x.body || {}).length === 0)), [FAB.seen, ERP.seen, CON.seen]);

clear();
r = await call('/admin/api/software-settings', { method: 'POST', headers: AK, body: { software: 'erp', trialDays: 21 } });
ok('ERP demo days 14 → 21', r.status === 200 && r.body.settings.trialDays === 21 && ERP.settings.trialDays === 21, r);
ok('…changed on ERP only — Fabric and Consult untouched', FAB.settings.trialDays === 7 && CON.settings.trialDays === 10 && FAB.seen.length === 0 && CON.seen.length === 0, [FAB.settings, CON.settings]);
ok('…and only trialDays travelled', ERP.seen.some((x) => x.body && JSON.stringify(x.body) === '{"trialDays":21}'), ERP.seen);
const ev2 = await q(`SELECT detail FROM activation_log WHERE event = 'ADMIN_ERP_SETTINGS'`);
ok('…written in the Activity list, before and after', ev2.length === 1 && /14/.test(JSON.stringify(ev2[0].detail)) && /21/.test(JSON.stringify(ev2[0].detail)), ev2);

r = await call('/admin/api/software-settings', { method: 'POST', headers: AK, body: { software: 'consult', trialDays: 30, demoSeats: 4, signupsOpen: false } });
ok('Consult: 30 days, 4 seats, sign-ups off — on Consult', r.status === 200 && CON.settings.trialDays === 30 && CON.settings.demoSeats === 4 && CON.settings.signupsOpen === false, CON.settings);

clear();
for (const [label, body] of [['0 demo days', { software: 'fabric', trialDays: 0 }], ['61 demo days', { software: 'fabric', trialDays: 61 }], ['letters for days', { software: 'fabric', trialDays: 'ten' }],
  ['31 offline days', { software: 'fabric', demoGraceDays: 31 }], ['0 demo seats', { software: 'fabric', demoSeats: 0 }], ['a made-up "when it ends"', { software: 'fabric', expiredMode: 'DELETE' }],
  ['nothing to change', { software: 'fabric' }], ['an unknown software', { software: 'jobwork', trialDays: 7 }], ['a field that is not a demo rule', { software: 'fabric', sessionMinutes: 1 }]]) {
  r = await call('/admin/api/software-settings', { method: 'POST', headers: AK, body });
  ok('refused: ' + label, r.status === 400, r);
}
ok('…and none of them reached Fabric Stock', FAB.seen.length === 0 && FAB.settings.trialDays === 7, FAB.seen);

r = await call('/admin/api/software-settings', { method: 'POST', headers: AK, body: { software: 'weight', trialDays: 15, demoGraceDays: 1 } });
ok('Sales & Costing demo days 7 → 15 on this service', r.status === 200 && r.body.settings.trialDays === 15 && r.body.settings.demoGraceDays === 1, r);
r = await call('/admin/api/software-settings', { headers: AK });
ok('…read back: weight 15, fabric 7, erp 21, consult 30', [sw(r, 'weight'), sw(r, 'fabric'), sw(r, 'erp'), sw(r, 'consult')].map((s) => s.settings.trialDays).join() === '15,7,21,30', r.body.software);
r = await call('/admin/api/software-settings', { method: 'POST', headers: AK, body: { software: 'weight', trialDays: 0 } });
ok('refused: Sales & Costing 0 demo days', r.status === 400, r);
r = await call('/admin/api/software-settings', { method: 'POST', headers: { 'x-admin-key': 'wrong-wrong-wrong-wrong', 'content-type': 'application/json' }, body: { software: 'erp', trialDays: 60 } });
ok('a wrong console key cannot change any demo rule', (r.status === 401 || r.status === 403) && ERP.settings.trialDays === 21, r);

ERP.mode = 'down';
r = await call('/admin/api/software-settings', { headers: AK });
ok('ERP asleep → "not answering", the others still shown', sw(r, 'erp').ok === false && /ERP_DOWN/.test(sw(r, 'erp').error) && sw(r, 'consult').ok === true, r.body.software);
r = await call('/admin/api/software-settings', { method: 'POST', headers: AK, body: { software: 'erp', trialDays: 9 } });
ok('…and a change to a sleeping ERP is said to fail, not pretended', r.status !== 200, r);
ERP.mode = 'ok';

for (const s of [FAB, ERP, CON]) s.srv.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

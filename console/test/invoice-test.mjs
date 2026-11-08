/**
 * Invoices — with GST and without, for a payment or a service (2026-11-08).
 * A stand-in Sales & Costing service answers the GSTIN; the console's tables live in a throw-away Postgres.
 * Run: node test/invoice-test.mjs  (via scratchpad pgtest/run.mjs)
 */
import http from 'node:http';
process.env.DATABASE_URL = process.env.NEXORA_TEST_DB;
process.env.CONSOLE_ADMIN_KEY = 'console-key-0123456789-abcdef';
process.env.WEIGHT_KEY = 'weight-own-key';
const w = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/admin/api/licences') return res.end(JSON.stringify({ companies: [{ id: 1, name: 'Alpha Sacks', gstin: '24AAAAA0001A1Z1', plan: 'PRO', seats: 5 }] }));
  res.end('{}');
});
await new Promise((r) => w.listen(0, '127.0.0.1', r));
process.env.WEIGHT_URL = 'http://127.0.0.1:' + w.address().port;

const app = (await import('../src/index.js')).default;
const { q, ensureSchema } = await import('../src/db.js');
const { inWords, fyOf } = await import('../src/invoices.js');
await ensureSchema();
await q(`TRUNCATE console.invoices, console.invoice_counters, console.customer_payments RESTART IDENTITY`);
await q(`DELETE FROM console.settings`);

let pass = 0, fail = 0;
const ok = (l, c, got) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (c ? '' : '   got: ' + JSON.stringify(got).slice(0, 300))); c ? pass++ : fail++; };
const call = async (path, body) => {
  const r = await app.fetch(new Request('https://c.test' + path, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'x-admin-key': process.env.CONSOLE_ADMIN_KEY }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }));
  return { status: r.status, body: await r.json() };
};
const make = (b) => call('/admin/api/invoices', Object.assign({ action: 'create' }, b));
const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const FY = fyOf(today);
const svc = (extra) => Object.assign({ software: 'weight', companyId: 1, gst: true, customer: { name: 'Alpha Sacks', gstin: '24AAAAA0001A1Z1', address: 'GIDC, Ahmedabad' },
  lines: [{ description: 'Sales & Costing — Pro plan, 1 year', qty: 2, rate: 10000 }] }, extra || {});

console.log('\nWORDS AND YEARS');
ok('₹23,600 → Rupees Twenty Three Thousand Six Hundred Only', inWords(23600) === 'Rupees Twenty Three Thousand Six Hundred Only', inWords(23600));
ok('₹1,23,45,678 in lakh and crore', inWords(12345678) === 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only', inWords(12345678));
ok('31 Mar 2026 is 2025-26, 1 Apr 2026 is 2026-27', fyOf('2026-03-31') === '2025-26' && fyOf('2026-04-01') === '2026-27', [fyOf('2026-03-31'), fyOf('2026-04-01')]);

console.log('\nSETTINGS FIRST');
let r = await make(svc());
ok('no settings → an invoice is refused (NOT_SET_UP)', r.status === 409 && r.body.error === 'NOT_SET_UP', r);
for (const [l, b] of [['a wrong GSTIN', { gstin: '24ABC' }], ['a wrong IFSC', { ifsc: 'HDFC1' }], ['a 15% GST rate', { gstRate: 15 }], ['the same prefix twice', { prefixGst: 'NXR' }], ['a wrong PAN', { pan: '123' }]]) {
  r = await call('/admin/api/invoice-settings', b); ok('refused: ' + l, r.status === 400, r);
}
r = await call('/admin/api/invoice-settings', { sellerName: 'Nexora', address: 'Ahmedabad, Gujarat', stateCode: '24' });
ok('name + address + state → ready, without a GSTIN', r.status === 200 && r.body.ready === true && r.body.settings.stateName === 'Gujarat', r.body);
r = await make(svc());
ok('…a GST invoice still needs your GSTIN (NO_GSTIN)', r.status === 409 && r.body.error === 'NO_GSTIN', r);
r = await call('/admin/api/invoice-settings', { gstin: '24abcde1234f1z5', bankName: 'HDFC Bank', ifsc: 'hdfc0001234' });
ok('GSTIN saved upper-case; the state follows it (24)', r.body.settings.gstin === '24ABCDE1234F1Z5' && r.body.settings.stateCode === '24' && r.body.settings.ifsc === 'HDFC0001234', r.body.settings);

console.log('\nWITH GST');
r = await make(svc());
let v = r.body.invoice;
ok('same state: 2 × ₹10,000 + CGST 9% ₹1,800 + SGST 9% ₹1,800 = ₹23,600', r.status === 200 && v.taxable === 20000 && v.cgst === 1800 && v.sgst === 1800 && v.igst === 0 && v.total === 23600 && v.intraState === true, v);
ok('number NX/' + FY + '/0001, SAC 997331, in words', v.number === 'NX/' + FY + '/0001' && v.lines[0].sac === '997331' && v.totalWords === 'Rupees Twenty Three Thousand Six Hundred Only', v);
ok('the seller is kept with the invoice (a later settings change does not alter it)', v.seller.gstin === '24ABCDE1234F1Z5' && v.placeOfSupply === '24 Gujarat', v.seller);
r = await make(svc({ customer: { name: 'Mumbai Mills', gstin: '27BBBBB0002B1Z2' } }));
v = r.body.invoice;
ok('another state (27 Maharashtra): IGST 18% ₹3,600, number 0002', v.igst === 3600 && v.cgst === 0 && v.igstRate === 18 && v.intraState === false && v.number.endsWith('/0002') && v.placeOfSupply === '27 Maharashtra', v);
r = await make(svc({ inclusive: true, lines: [{ description: 'Renewal', qty: 1, rate: 24000 }] }));
v = r.body.invoice;
ok('₹24,000 including GST → taxable ₹20,338.98 + tax ₹3,661.02', v.taxable === 20338.98 && Math.round((v.cgst + v.sgst) * 100) === 366102 && v.total === 24000, v);
r = await make(svc({ lines: [{ description: 'Odd', qty: 1, rate: 100.3 }] }));
v = r.body.invoice;
ok('₹100.30 + 18% = ₹118.35 → ₹118 with round-off −₹0.35', v.total === 118 && v.roundOff === -0.35, v);

console.log('\nWITHOUT GST, AND RECEIPTS');
r = await make(svc({ gst: false }));
v = r.body.invoice;
ok('without GST: ₹20,000, no tax at all, its own series NXB/' + FY + '/0001', v.total === 20000 && v.cgst === 0 && v.sgst === 0 && v.igst === 0 && v.number === 'NXB/' + FY + '/0001', v);
r = await make(svc({ kind: 'RECEIPT', gst: false }));
ok('a receipt: NXR/' + FY + '/0001', r.body.invoice.number === 'NXR/' + FY + '/0001' && r.body.invoice.kind === 'RECEIPT', r.body.invoice);

console.log('\nFOR A PAYMENT');
const pay = (await q(`INSERT INTO console.customer_payments (software, company_id, customer_name, plan, plan_name, kind, amount, paid_on, valid_from, valid_to, note)
                      VALUES ('weight', 1, 'Alpha Sacks', 'PRO', 'Pro', 'RENEWAL', 24000, $1::date, $1::date, ($1::date + 365), 'Pro · 7 users (2 extra)') RETURNING id`, [today]))[0];
r = await make({ paymentId: Number(pay.id), gst: true });
v = r.body.invoice;
ok('the payment becomes the line; the amount includes GST by default', r.status === 200 && v.lines.length === 1 && /Pro plan/.test(v.lines[0].description) && v.inclusive === true && v.total === 24000, v);
ok('…the customer and the GSTIN come from the payment and Sales & Costing', v.customer.name === 'Alpha Sacks' && v.customer.gstin === '24AAAAA0001A1Z1' && v.paymentId === Number(pay.id), v.customer);
r = await call('/admin/api/invoices?paymentId=' + pay.id);
ok('the payment\'s invoices can be listed', r.body.invoices.length === 1, r.body);
r = await make({ paymentId: 99999, gst: true });
ok('a payment that does not exist → refused', r.status === 404, r);

console.log('\nWHAT IS REFUSED');
for (const [l, b] of [['a date in the future', svc({ date: '2099-01-01' })], ['no lines', svc({ lines: [] })], ['a line without a description', svc({ lines: [{ description: ' ', qty: 1, rate: 5 }] })],
  ['a minus rate', svc({ lines: [{ description: 'x', qty: 1, rate: -5 }] })], ['quantity 0', svc({ lines: [{ description: 'x', qty: 0, rate: 5 }] })],
  ['a total of 0', svc({ lines: [{ description: 'x', qty: 1, rate: 0 }] })], ['a wrong customer GSTIN', svc({ customer: { name: 'X', gstin: '99XYZ' } })],
  ['no customer name', svc({ customer: { name: '' } })], ['an unknown software', svc({ software: 'jobwork' })]]) {
  r = await make(b); ok('refused: ' + l, r.status === 400 || r.status === 404, r);
}

console.log('\nCANCEL — never edit, never delete');
const first = (await call('/admin/api/invoices?gst=yes')).body.invoices.find((x) => x.number === 'NX/' + FY + '/0001');
r = await call('/admin/api/invoices', { action: 'cancel', id: first.id });
ok('cancel without a reason → refused', r.status === 400, r);
r = await call('/admin/api/invoices', { action: 'cancel', id: first.id, reason: 'Wrong plan' });
ok('cancelled with a reason; the number stays', r.status === 200 && r.body.invoice.cancelledAt && r.body.invoice.number === first.number, r.body.invoice);
r = await call('/admin/api/invoices', { action: 'cancel', id: first.id, reason: 'again' });
ok('cancelling twice → refused', r.status === 404, r);
r = await make(svc());
ok('the next number continues — a cancelled number is never reused', r.body.invoice.number === 'NX/' + FY + '/0006', r.body.invoice.number);
r = await make(svc({ date: '2026-03-31' }));
ok('dated in the earlier year → that year\'s own series starts at 0001', r.body.invoice.number === 'NX/2025-26/0001' && r.body.invoice.fy === '2025-26', r.body.invoice);

console.log('\nFIVE AT ONCE');
const many = await Promise.all([1, 2, 3, 4, 5].map(() => make(svc({ gst: false }))));
const nums = many.map((x) => x.body.invoice.number).sort();
ok('five invoices at the same moment get five different numbers, none skipped', new Set(nums).size === 5 && nums[0].endsWith('/0002') && nums[4].endsWith('/0006'), nums);

r = await call('/admin/api/invoices?gst=no');
ok('list: without GST only', r.body.invoices.every((x) => x.gst === false) && r.body.invoices.length === 7, r.body.invoices.length);   /* 6 bills + the receipt */
const evs = await q(`SELECT event FROM console.events WHERE event LIKE 'ADMIN_INVOICE%'`);
ok('every invoice made or cancelled is in the Activity list', evs.filter((e) => e.event === 'ADMIN_INVOICE_CREATE').length >= 12 && evs.some((e) => e.event === 'ADMIN_INVOICE_CANCEL'), evs.length);

w.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

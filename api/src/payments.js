/**
 * Nexora API — what each customer has paid, for which software and plan, and the validity it bought (2026-10-08)
 * ----------------------------------------------------------------------
 * Owner: "customer ni validity payment kyare aavyu kya plan nu kayo plan
 * expire thay che aena record". This is the owner's own ledger, kept by the
 * console: a payment names its customer, its software, the plan it was for,
 * the amount, when it came and how (UPI, bank, cash, cheque), a reference
 * (UTR, cheque or invoice number) and the validity it covers. Recording one
 * can renew the licence in the same step ("+ extend"): Weight Calc here,
 * Fabric Stock through its own service (products.js). A payment is never
 * erased: Delete marks it, and the Activity list keeps who did what.
 *
 *   GET  /admin/api/payments?software=&companyId=&fabricId=&from=&to=
 *        { payments: [...], totals: { count, amount, bySoftware } }
 *   POST /admin/api/payments  { action: add | update | delete, ... }
 */
import { q, logEvent, getSettings } from './db.js';
import { companyAction } from './admin.js';
import { fabricCall } from './products.js';
import { cleanPlan } from './plans.js';

const KINDS = ['NEW', 'RENEWAL', 'EXTRA_USERS', 'UPGRADE', 'OTHER'];
const MODES = ['UPI', 'BANK', 'CASH', 'CHEQUE', 'CARD', 'OTHER'];
const IST = 5.5 * 3600000;
const istDay = (ms) => Math.floor((ms + IST) / 86400000);
const isoDay = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) || s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const d = m[1].length === 4 ? m[1] + '-' + m[2] + '-' + m[3] : m[3] + '-' + m[2] + '-' + m[1];
  return Number.isNaN(Date.parse(d + 'T00:00:00Z')) ? null : d;
};
const istToday = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const money = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 100000000 ? Math.round(n * 100) / 100 : null;
};
const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null;

function out(r) {
  return {
    id: Number(r.id), software: r.software, companyId: r.company_id != null ? String(r.company_id) : null,
    fabricId: r.fabric_id || null, customer: r.customer_name, plan: r.plan, planName: r.plan_name, kind: r.kind,
    amount: r.amount != null ? Number(r.amount) : null, paidOn: r.paid_on, mode: r.mode, reference: r.reference,
    validFrom: r.valid_from, validTo: r.valid_to, note: r.note, createdAt: r.created_at, via: r.via || null
  };
}

export async function listPayments(params) {
  const p = params || {};
  const where = ['deleted_at IS NULL'], vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('$?', '$' + vals.length)); };
  if (p.software === 'weight' || p.software === 'fabric') add('software = $?', p.software);
  if (p.companyId) add('company_id = $?', parseInt(p.companyId, 10) || 0);
  if (p.fabricId) add('fabric_id = $?', String(p.fabricId));
  if (isoDay(p.from)) add('paid_on >= $?::date', isoDay(p.from));
  if (isoDay(p.to)) add('paid_on <= $?::date', isoDay(p.to));
  const rows = await q(`SELECT *, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
                               to_char(valid_to, 'YYYY-MM-DD') AS valid_to
                          FROM customer_payments WHERE ${where.join(' AND ')}
                         ORDER BY customer_payments.paid_on DESC, customer_payments.id DESC LIMIT 2000`, vals);
  const payments = rows.map(out);
  const bySoftware = {};
  let amount = 0;
  payments.forEach((x) => { amount += x.amount || 0; bySoftware[x.software] = Math.round(((bySoftware[x.software] || 0) + (x.amount || 0)) * 100) / 100; });
  return { payments, totals: { count: payments.length, amount: Math.round(amount * 100) / 100, bySoftware } };
}

/* the renewal asked for with the payment: Weight Calc through its own company actions, Fabric Stock through its
   service. Returns { validTo, warning } — a renewal that did not happen leaves the payment recorded and says so. */
async function renew(b, cust) {
  const asked = parseInt(b.extendDays, 10);
  if (!(asked > 0)) return {};
  const days = Math.min(3660, asked);
  if (b.software === 'weight') {
    const r = await companyAction({ id: cust.companyId, action: cust.isDemo ? 'licence' : 'extend', days });
    if (r && r.error) return { warning: 'The payment is recorded, but the licence was not renewed: ' + r.error };
    const co = (await q(`SELECT to_char((expires_at AT TIME ZONE INTERVAL '+05:30')::date, 'YYYY-MM-DD') AS d FROM companies WHERE id = $1`, [cust.companyId]))[0];
    return { validTo: co ? co.d : null };
  }
  /* Fabric Stock sets a new period from today, so the days still left go with the days paid for */
  const now = Date.now();
  const left = cust.expiresAt && new Date(cust.expiresAt).getTime() > now && cust.state !== 'DEMO'
    ? Math.max(0, istDay(new Date(cust.expiresAt).getTime()) - istDay(now)) : 0;
  const body = { action: 'update', id: parseInt(cust.fabricId, 10), days: left + days };
  if (cust.state === 'DEMO') body.state = 'LICENSED';
  const r = await fabricCall('POST', '/admin/api/company', body);
  if (r.status !== 200) return { warning: 'The payment is recorded, but Fabric Stock was not renewed: ' + (r.body.message || r.body.error || 'no answer') };
  return { validTo: r.body.company && r.body.company.expiresAt ? new Date(new Date(r.body.company.expiresAt).getTime() + IST).toISOString().slice(0, 10) : null };
}

/* who the payment is from: a Weight Calc company here, or a Fabric Stock company there (and the Weight Calc
   company it belongs to, when the console shows them as one customer) */
async function customerOf(b) {
  if (b.software === 'weight') {
    const co = (await q(`SELECT id, name, plan, is_demo, deleted_at FROM companies WHERE id = $1`, [parseInt(b.companyId, 10) || 0]))[0];
    if (!co || co.deleted_at) return null;
    const s = await getSettings();
    const code = cleanPlan(co.plan, s);
    const pl = (s.plans || []).find((x) => x.code === code);
    return { companyId: Number(co.id), name: co.name, plan: code, planName: pl ? pl.name : code, isDemo: co.is_demo === true };
  }
  if (b.software === 'fabric') {
    const r = await fabricCall('GET', '/admin/api/company?id=' + encodeURIComponent(parseInt(b.fabricId, 10) || 0));
    if (r.status !== 200 || !r.body || !r.body.name) return { error: r.body && (r.body.message || r.body.error) };
    const link = (await q(`SELECT company_id FROM product_links WHERE product = 'fabric' AND remote_id = $1`, [String(r.body.id)]))[0];
    return { companyId: b.companyId ? parseInt(b.companyId, 10) : (link && link.company_id ? Number(link.company_id) : null),
      fabricId: String(r.body.id), name: r.body.name, plan: String(r.body.plan || 'STANDARD').toUpperCase(),
      planName: r.body.planName || (String(r.body.plan || 'Standard').charAt(0) + String(r.body.plan || 'Standard').slice(1).toLowerCase()),
      expiresAt: r.body.expiresAt, state: r.body.state };
  }
  return null;
}

export async function paymentAction(body) {
  const b = Object.assign({}, body || {});
  const action = String(b.action || '');

  if (action === 'add') {
    if (b.software !== 'weight' && b.software !== 'fabric') return { httpStatus: 400, body: { error: 'Which software is it for?' } };
    const amount = money(b.amount);
    if (amount === null || amount <= 0) return { httpStatus: 400, body: { error: 'Enter the amount received.' } };
    const paidOn = isoDay(b.paidOn) || istToday();
    const cust = await customerOf(b);
    if (!cust || cust.error) return { httpStatus: 404, body: { error: (cust && cust.error) || 'No such customer for that software.' } };
    const done = await renew(b, cust);
    const validTo = isoDay(b.validTo) || done.validTo || null;
    const validFrom = isoDay(b.validFrom) || (b.extendDays ? paidOn : null);
    const row = (await q(`INSERT INTO customer_payments (software, company_id, fabric_id, customer_name, plan, plan_name, kind, amount,
                                 paid_on, mode, reference, valid_from, valid_to, note, via)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12::date,$13::date,$14,$15)
                          RETURNING *, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
                                    to_char(valid_to, 'YYYY-MM-DD') AS valid_to`,
      [b.software, cust.companyId || null, cust.fabricId || null, cust.name, text(b.plan, 24) ? String(b.plan).toUpperCase() : cust.plan,
        text(b.planName, 40) || cust.planName, KINDS.includes(String(b.kind)) ? b.kind : 'RENEWAL', amount, paidOn,
        MODES.includes(String(b.mode)) ? b.mode : 'OTHER', text(b.reference, 60), validFrom, validTo, text(b.note, 300), text(b.via, 20)]))[0];
    await logEvent(null, 'ADMIN_PAYMENT_ADD', { software: b.software, companyId: cust.companyId || undefined, fabricId: cust.fabricId || undefined,
      amount, paidOn, plan: row.plan, extendDays: b.extendDays ? Number(b.extendDays) : undefined, validTo });
    return { httpStatus: 200, body: Object.assign({ ok: true, payment: out(row) }, done.warning ? { warning: done.warning } : {}) };
  }

  const id = parseInt(b.id, 10);
  const was = id ? (await q(`SELECT * FROM customer_payments WHERE id = $1 AND deleted_at IS NULL`, [id]))[0] : null;
  if (!was) return { httpStatus: 404, body: { error: 'No such payment.' } };

  if (action === 'update') {
    const sets = [], vals = [id];
    const put = (col, v, cast) => { vals.push(v); sets.push(col + ' = $' + vals.length + (cast || '')); };
    if (b.amount !== undefined) { const a = money(b.amount); if (a === null || a <= 0) return { httpStatus: 400, body: { error: 'Enter the amount received.' } }; put('amount', a); }
    if (b.paidOn !== undefined && isoDay(b.paidOn)) put('paid_on', isoDay(b.paidOn), '::date');
    if (b.mode !== undefined) put('mode', MODES.includes(String(b.mode)) ? b.mode : 'OTHER');
    if (b.kind !== undefined) put('kind', KINDS.includes(String(b.kind)) ? b.kind : 'OTHER');
    if (b.reference !== undefined) put('reference', text(b.reference, 60));
    if (b.note !== undefined) put('note', text(b.note, 300));
    if (b.validFrom !== undefined) put('valid_from', isoDay(b.validFrom), '::date');
    if (b.validTo !== undefined) put('valid_to', isoDay(b.validTo), '::date');
    if (!sets.length) return { httpStatus: 400, body: { error: 'Nothing to change.' } };
    const row = (await q(`UPDATE customer_payments SET ${sets.join(', ')} WHERE id = $1
                          RETURNING *, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
                                    to_char(valid_to, 'YYYY-MM-DD') AS valid_to`, vals))[0];
    await logEvent(null, 'ADMIN_PAYMENT_UPDATE', { id, changed: Object.keys(b).filter((k) => k !== 'action' && k !== 'id') });
    return { httpStatus: 200, body: { ok: true, payment: out(row) } };
  }
  if (action === 'delete') {
    await q(`UPDATE customer_payments SET deleted_at = now() WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_PAYMENT_DELETE', { id, customer: was.customer_name, amount: Number(was.amount), software: was.software });
    return { httpStatus: 200, body: { ok: true } };
  }
  return { httpStatus: 400, body: { error: 'Unknown action: ' + action } };
}

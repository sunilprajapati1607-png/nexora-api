/**
 * The owner's payments ledger (moved here from nexora-api on 2026-11-07): what each customer paid, for
 * which software and plan, and the validity it bought. Recording one can renew the licence in the same
 * step — on that software's own service. A payment is never erased: Delete marks it.
 *
 *   GET  /admin/api/payments?software=&companyId=&fabricId=&from=&to=
 *   POST /admin/api/payments  { action: add | update | delete, ... }
 */
import { q, logEvent } from './db.js';
import { PRODUCTS, isRemote, softwareCall } from './software.js';
import { weightCompanies, weightPlans, forgetWeight } from './weight.js';

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
const SEL = `*, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to`;

function out(r) {
  return {
    id: Number(r.id), software: r.software, companyId: r.company_id != null ? String(r.company_id) : null,
    fabricId: r.fabric_id || null, remoteId: r.fabric_id || null, customer: r.customer_name, plan: r.plan, planName: r.plan_name, kind: r.kind,
    amount: r.amount != null ? Number(r.amount) : null, paidOn: r.paid_on, mode: r.mode, reference: r.reference,
    validFrom: r.valid_from, validTo: r.valid_to, note: r.note, createdAt: r.created_at, via: r.via || null
  };
}

export async function listPayments(params) {
  const p = params || {};
  const where = ['deleted_at IS NULL'], vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('$?', '$' + vals.length)); };
  if (p.software === 'weight' || isRemote(p.software)) add('software = $?', p.software);
  if (p.companyId) add('company_id = $?', parseInt(p.companyId, 10) || 0);
  if (p.fabricId || p.remoteId) add('fabric_id = $?', String(p.remoteId || p.fabricId));
  if (isoDay(p.from)) add('paid_on >= $?::date', isoDay(p.from));
  if (isoDay(p.to)) add('paid_on <= $?::date', isoDay(p.to));
  const rows = await q(`SELECT ${SEL} FROM console.customer_payments WHERE ${where.join(' AND ')}
                         ORDER BY customer_payments.paid_on DESC, customer_payments.id DESC LIMIT 2000`, vals);
  const payments = rows.map(out);
  const bySoftware = {};
  let amount = 0;
  payments.forEach((x) => { amount += x.amount || 0; bySoftware[x.software] = Math.round(((bySoftware[x.software] || 0) + (x.amount || 0)) * 100) / 100; });
  return { payments, totals: { count: payments.length, amount: Math.round(amount * 100) / 100, bySoftware } };
}

/* the renewal asked for with the payment, on that software's own service. A renewal that did not happen
   leaves the payment recorded and says so. */
async function renew(b, cust) {
  const asked = parseInt(b.extendDays, 10);
  if (!(asked > 0)) return {};
  const days = Math.min(3660, asked);
  if (b.software === 'weight') {
    const r = await softwareCall('weight', 'POST', '/admin/api/company', { id: Number(cust.companyId), action: cust.isDemo ? 'licence' : 'extend', days });
    if (r.status !== 200 || (r.body && r.body.error)) return { warning: 'The payment is recorded, but the licence was not renewed: ' + (r.body.message || r.body.error || 'no answer') };
    const w = await weightCompanies(true);
    const co = w.companies.find((c) => c.id === String(cust.companyId));
    return { validTo: co && co.expiresAt ? new Date(new Date(co.expiresAt).getTime() + IST).toISOString().slice(0, 10) : null };
  }
  const now = Date.now();
  const left = cust.expiresAt && new Date(cust.expiresAt).getTime() > now && cust.state !== 'DEMO'
    ? Math.max(0, istDay(new Date(cust.expiresAt).getTime()) - istDay(now)) : 0;
  const body = { action: 'update', id: parseInt(cust.remoteId, 10), days: left + days };
  if (cust.state === 'DEMO') body.state = 'LICENSED';
  const soft = PRODUCTS.find((p) => p.id === b.software);
  const r = await softwareCall(b.software, 'POST', '/admin/api/company', body);
  if (r.status !== 200) return { warning: 'The payment is recorded, but ' + (soft ? soft.short : b.software) + ' was not renewed: ' + (r.body.message || r.body.error || 'no answer') };
  return { validTo: r.body.company && r.body.company.expiresAt ? new Date(new Date(r.body.company.expiresAt).getTime() + IST).toISOString().slice(0, 10) : null };
}

async function customerOf(b) {
  if (b.software === 'weight') {
    const w = await weightCompanies(true);
    const co = w.companies.find((c) => c.id === String(parseInt(b.companyId, 10) || ''));
    if (!co) return w.ok ? null : { error: w.message || 'Sales & Costing did not answer.' };
    const plans = await weightPlans();
    const pl = (plans.plans || []).find((x) => x.code === co.plan);
    return { companyId: Number(co.id), name: co.name, plan: co.plan, planName: pl ? pl.name : co.plan.charAt(0) + co.plan.slice(1).toLowerCase(), isDemo: co.isDemo };
  }
  if (isRemote(b.software)) {
    const rid = parseInt(b.remoteId != null ? b.remoteId : b.fabricId, 10) || 0;
    const r = await softwareCall(b.software, 'GET', '/admin/api/company?id=' + encodeURIComponent(rid));
    if (r.status !== 200 || !r.body || !r.body.name) return { error: r.body && (r.body.message || r.body.error) };
    const link = (await q(`SELECT company_id FROM console.product_links WHERE product = $1 AND remote_id = $2`, [b.software, String(r.body.id)]))[0];
    return { companyId: b.companyId ? parseInt(b.companyId, 10) : (link && link.company_id ? Number(link.company_id) : null),
      remoteId: String(r.body.id), name: r.body.name, plan: String(r.body.plan || 'STANDARD').toUpperCase(),
      planName: r.body.planName || (String(r.body.plan || 'Standard').charAt(0) + String(r.body.plan || 'Standard').slice(1).toLowerCase()),
      expiresAt: r.body.expiresAt, state: r.body.state };
  }
  return null;
}

export async function paymentAction(body, who) {
  const b = Object.assign({}, body || {});
  const action = String(b.action || '');
  if (action === 'add') {
    if (b.software !== 'weight' && !isRemote(b.software)) return { httpStatus: 400, body: { error: 'Which software is it for?' } };
    const amount = money(b.amount);
    if (amount === null || amount <= 0) return { httpStatus: 400, body: { error: 'Enter the amount received.' } };
    const paidOn = isoDay(b.paidOn) || istToday();
    const cust = await customerOf(b);
    if (!cust || cust.error) return { httpStatus: 404, body: { error: (cust && cust.error) || 'No such customer for that software.' } };
    const done = await renew(b, cust);
    const validTo = isoDay(b.validTo) || done.validTo || null;
    const validFrom = isoDay(b.validFrom) || (b.extendDays ? paidOn : null);
    const row = (await q(`INSERT INTO console.customer_payments (software, company_id, fabric_id, customer_name, plan, plan_name, kind, amount,
                                 paid_on, mode, reference, valid_from, valid_to, note, via)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12::date,$13::date,$14,$15) RETURNING ${SEL}`,
      [b.software, cust.companyId || null, cust.remoteId || null, cust.name, text(b.plan, 24) ? String(b.plan).toUpperCase() : cust.plan,
        text(b.planName, 40) || cust.planName, KINDS.includes(String(b.kind)) ? b.kind : 'RENEWAL', amount, paidOn,
        MODES.includes(String(b.mode)) ? b.mode : 'OTHER', text(b.reference, 60), validFrom, validTo, text(b.note, 300), text(b.via, 20)]))[0];
    if (b.software === 'weight') forgetWeight();
    await logEvent('ADMIN_PAYMENT_ADD', { software: b.software, companyId: cust.companyId || undefined, remoteId: cust.remoteId || undefined,
      amount, paidOn, plan: row.plan, extendDays: b.extendDays ? Number(b.extendDays) : undefined, validTo, via: who });
    return { httpStatus: 200, body: Object.assign({ ok: true, payment: out(row) }, done.warning ? { warning: done.warning } : {}) };
  }
  const id = parseInt(b.id, 10);
  const was = id ? (await q(`SELECT * FROM console.customer_payments WHERE id = $1 AND deleted_at IS NULL`, [id]))[0] : null;
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
    const row = (await q(`UPDATE console.customer_payments SET ${sets.join(', ')} WHERE id = $1 RETURNING ${SEL}`, vals))[0];
    await logEvent('ADMIN_PAYMENT_UPDATE', { id, changed: Object.keys(b).filter((k) => k !== 'action' && k !== 'id'), via: who });
    return { httpStatus: 200, body: { ok: true, payment: out(row) } };
  }
  if (action === 'delete') {
    await q(`UPDATE console.customer_payments SET deleted_at = now() WHERE id = $1`, [id]);
    await logEvent('ADMIN_PAYMENT_DELETE', { id, customer: was.customer_name, amount: Number(was.amount), software: was.software, via: who });
    return { httpStatus: 200, body: { ok: true } };
  }
  return { httpStatus: 400, body: { error: 'Unknown action: ' + action } };
}

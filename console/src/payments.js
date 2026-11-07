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
import { remotePlanBlock } from './products.js';

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
  if (/-/.test(String(v == null ? '' : v))) return null;          /* a minus amount is never read as a plus one */
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

/* ---- a payment BY PLAN (owner 2026-11-07: "when we can add payment as per plan so it can add days accordingly …
   plan pn add krva jema ketla user, per extra user price") ----
   The plan says how long one period runs (days, 365 when not set), its price for the first year and for a renewal,
   how many users it includes and the price of each user beyond them. */
const PLAN_DAYS = 365;
async function planOf(software, code) {
  const block = software === 'weight' ? await weightPlans(true) : await remotePlanBlock(software);
  const plans = (block && block.plans) || [];
  return { block, plan: plans.find((p) => String(p.code).toUpperCase() === String(code || '').toUpperCase()) || null, plans };
}
async function currentOf(b) {
  if (b.software === 'weight') {
    const w = await weightCompanies(true);
    const co = w.companies.find((c) => c.id === String(parseInt(b.companyId, 10) || ''));
    return co ? { plan: co.plan, seats: co.seats, isDemo: co.isDemo } : null;
  }
  const rid = parseInt(b.remoteId != null ? b.remoteId : b.fabricId, 10) || 0;
  const r = await softwareCall(b.software, 'GET', '/admin/api/company?id=' + encodeURIComponent(rid));
  return r.status === 200 && r.body && r.body.name ? { plan: String(r.body.plan || 'STANDARD').toUpperCase(), seats: parseInt(r.body.seats, 10) || 1, isDemo: r.body.state === 'DEMO' } : null;
}

/** What a payment by plan comes to — nothing is changed. */
export async function quote(b) {
  if (b.software !== 'weight' && !isRemote(b.software)) return { httpStatus: 400, body: { error: 'Which software is it for?' } };
  const cur = await currentOf(b);
  if (!cur) return { httpStatus: 404, body: { error: 'No such customer for that software.' } };
  const { plan, plans } = await planOf(b.software, b.plan || cur.plan);
  if (!plan) return { httpStatus: 404, body: { error: 'There is no plan ' + String(b.plan || cur.plan) + ' for this software.' + (plans.length ? '' : ' Make its plans under Software & plans first.') } };
  const kind = KINDS.includes(String(b.kind)) ? String(b.kind) : (cur.isDemo ? 'NEW' : 'RENEWAL');
  const users = Math.max(1, Math.min(500, parseInt(b.users, 10) || cur.seats || plan.usersIncluded || 1));
  const periods = Math.max(1, Math.min(10, parseInt(b.periods, 10) || 1));
  const included = plan.usersIncluded != null ? Number(plan.usersIncluded) : users;
  const extraPrice = plan.extraUserPrice != null ? Number(plan.extraUserPrice) : null;
  const one = plan.days != null ? Number(plan.days) : PLAN_DAYS;
  let unitPrice, extraUsers, extraAmount, days, amount;
  if (kind === 'EXTRA_USERS') {
    /* more users on the period already paid: only the users beyond what the licence has now, no days */
    extraUsers = Math.max(0, users - cur.seats);
    unitPrice = 0; days = 0;
    extraAmount = extraPrice != null ? extraUsers * extraPrice : null;
    amount = extraAmount;
  } else {
    extraUsers = Math.max(0, users - included);
    const first = plan.priceFirst != null ? Number(plan.priceFirst) : null, renew = plan.priceRenewal != null ? Number(plan.priceRenewal) : null;
    unitPrice = kind === 'NEW' ? (first != null ? first : renew) : (renew != null ? renew : first);
    extraAmount = extraUsers ? (extraPrice != null ? extraUsers * extraPrice : null) : 0;
    days = one * periods;
    amount = unitPrice != null && extraAmount != null ? Math.round((unitPrice + extraAmount) * periods * 100) / 100 : null;
  }
  const note = amount == null ? 'This plan has no price set for that — type the amount.' : null;
  return { httpStatus: 200, body: { ok: true, software: b.software, kind, users, periods, extraUsers, unitPrice, extraUserPrice: extraPrice, extraAmount, days, amount, note,
    currentPlan: cur.plan, currentSeats: cur.seats,
    plan: { code: plan.code, name: plan.name, days: one, priceFirst: plan.priceFirst != null ? Number(plan.priceFirst) : null, priceRenewal: plan.priceRenewal != null ? Number(plan.priceRenewal) : null,
      usersIncluded: plan.usersIncluded != null ? Number(plan.usersIncluded) : null, extraUserPrice: extraPrice } } };
}

/* the plan and the users the payment is for, set on the software's own service before its days are added */
async function applyPlan(b, q) {
  const warn = [];
  const planChanged = q.plan.code !== q.currentPlan, usersChanged = q.users !== q.currentSeats;
  if (!planChanged && !usersChanged) return warn;
  if (b.software === 'weight') {
    const id = Number(parseInt(b.companyId, 10));
    if (planChanged) { const r = await softwareCall('weight', 'POST', '/admin/api/company', { id, action: 'plan', plan: q.plan.code }); if (r.status !== 200 || r.body.error) warn.push('the plan was not changed: ' + (r.body.message || r.body.error)); }
    if (usersChanged) { const r = await softwareCall('weight', 'POST', '/admin/api/company', { id, action: 'seats', seats: q.users }); if (r.status !== 200 || r.body.error) warn.push('the users were not changed: ' + (r.body.message || r.body.error)); }
    forgetWeight();
  } else {
    const body = { action: 'update', id: parseInt(b.remoteId != null ? b.remoteId : b.fabricId, 10) };
    if (planChanged) body.plan = q.plan.code;
    if (usersChanged) body.seats = q.users;
    const r = await softwareCall(b.software, 'POST', '/admin/api/company', body);
    if (r.status !== 200) warn.push('the plan and users were not changed: ' + (r.body.message || r.body.error || 'no answer'));
  }
  return warn;
}

export async function paymentAction(body, who) {
  const b = Object.assign({}, body || {});
  const action = String(b.action || '');
  if (action === 'quote') return quote(b);
  if (action === 'add' && b.byPlan) {
    const qr = await quote(b);
    if (qr.httpStatus !== 200) return qr;
    const qq = qr.body;
    const typed = b.amount !== undefined && b.amount !== null && String(b.amount).trim() !== '' ? money(b.amount) : null;
    if (b.amount !== undefined && b.amount !== null && String(b.amount).trim() !== '' && (typed === null || typed <= 0)) return { httpStatus: 400, body: { error: 'Enter the amount received.' } };
    const amount = typed != null ? typed : qq.amount;
    if (amount == null || amount <= 0) return { httpStatus: 400, body: { error: qq.note || 'Enter the amount received.' } };
    const warns = await applyPlan(b, qq);
    const out = await paymentAction(Object.assign({}, b, { byPlan: false, amount, plan: qq.plan.code, planName: qq.plan.name, kind: qq.kind,
      extendDays: qq.days > 0 ? qq.days : undefined,
      note: b.note || (qq.plan.name + ' · ' + qq.users + ' user' + (qq.users === 1 ? '' : 's') + (qq.periods > 1 ? ' · ' + qq.periods + ' periods' : '') + (qq.extraUsers ? ' (' + qq.extraUsers + ' extra)' : '')) }), who);
    if (out.httpStatus === 200) {
      out.body.quote = qq;
      if (warns.length) out.body.warning = [out.body.warning].concat(warns.map((w) => 'The payment is recorded, but ' + w)).filter(Boolean).join(' ');
    }
    return out;
  }
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

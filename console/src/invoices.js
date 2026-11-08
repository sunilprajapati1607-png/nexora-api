/**
 * Invoices — for a payment or for a service, with GST or without (owner 2026-11-08: "payment and service na
 * invoice design krva with and without gst print pn").
 *
 * All money maths is done here and kept with the invoice, so every console shows the same figures:
 *  - with GST: tax at the rate in the settings (18 by default); CGST + SGST when the seller and the customer are
 *    in the same state (the first two digits of each GSTIN, or the customer's state), IGST otherwise.
 *    "Amounts include GST" back-calculates the taxable value from the total.
 *  - without GST: no tax at all, a plain bill.
 *  - the total is rounded to the rupee and the round-off shown; the total is written in words (lakh, crore).
 * Numbers run per series and per financial year (April–March, Indian time): NX/2026-27/0001 with GST,
 * NXB/… without, NXR/… for a receipt. An invoice is never edited or deleted — only cancelled, its number kept.
 */
import { q, logEvent } from './db.js';
import { softwareOf, isRemote, softwareCall } from './software.js';
import { weightCompanies } from './weight.js';

const IST = 5.5 * 3600000;
export const STATES = { '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory' };
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, n);
const istToday = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const isoDay = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) ? v : null; };
export const fyOf = (day) => { const [y, m] = day.split('-').map(Number); const s = m >= 4 ? y : y - 1; return s + '-' + String((s + 1) % 100).padStart(2, '0'); };

/* ---- amount in words, Indian numbering ---- */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
const three = (n) => (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n));
export function inWords(amount) {
  let n = Math.floor(Math.abs(Number(amount) || 0));
  if (!n) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push((crore >= 100 ? inWords(crore).replace(/^Rupees | Only$/g, '') : two(crore)) + ' Crore');
  if (lakh) parts.push(two(lakh) + ' Lakh');
  if (thousand) parts.push(two(thousand) + ' Thousand');
  if (n) parts.push(three(n));
  return 'Rupees ' + parts.join(' ') + ' Only';
}

/* ---- the seller's details, filled once ---- */
const DEFAULTS = { sac: '997331', gstRate: 18, prefixGst: 'NX', prefixPlain: 'NXB', prefixReceipt: 'NXR' };
const FIELDS = { sellerName: 80, legalName: 120, gstin: 15, address: 400, stateCode: 2, phone: 40, email: 80, website: 80, pan: 10, bankName: 80, accountName: 80,
  accountNumber: 30, ifsc: 11, upi: 60, sac: 8, prefixGst: 8, prefixPlain: 8, prefixReceipt: 8, terms: 1200, footer: 300, signatory: 80 };
export async function getSettings() {
  const row = (await q(`SELECT value FROM console.settings WHERE key = 'invoice'`))[0];
  const s = Object.assign({}, DEFAULTS, row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {});
  if (!s.stateCode && s.gstin) s.stateCode = String(s.gstin).slice(0, 2);
  s.stateName = STATES[s.stateCode] || '';
  return { settings: s, ready: !!(s.sellerName && s.address && s.stateCode) };
}
export async function saveSettings(b, who) {
  const out = {};
  for (const [k, n] of Object.entries(FIELDS)) if (b[k] !== undefined) out[k] = txt(b[k], n);
  if (out.gstin) { out.gstin = out.gstin.toUpperCase(); if (!GSTIN_RE.test(out.gstin)) return { httpStatus: 400, body: { error: 'That GSTIN is not in the right form (15 characters, e.g. 24ABCDE1234F1Z5).' } }; out.stateCode = out.gstin.slice(0, 2); }
  if (out.stateCode && !STATES[out.stateCode]) return { httpStatus: 400, body: { error: 'Unknown state code ' + out.stateCode + '.' } };
  if (out.ifsc) { out.ifsc = out.ifsc.toUpperCase(); if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(out.ifsc)) return { httpStatus: 400, body: { error: 'That IFSC is not in the right form (e.g. HDFC0001234).' } }; }
  if (out.pan) { out.pan = out.pan.toUpperCase(); if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(out.pan)) return { httpStatus: 400, body: { error: 'That PAN is not in the right form.' } }; }
  for (const p of ['prefixGst', 'prefixPlain', 'prefixReceipt']) if (out[p] !== undefined && !/^[A-Z0-9-]{1,8}$/i.test(out[p])) return { httpStatus: 400, body: { error: 'A number prefix may have letters, digits and - only.' } };
  if (b.gstRate !== undefined) { const r = Number(b.gstRate); if (![0, 5, 12, 18, 28].includes(r)) return { httpStatus: 400, body: { error: 'GST rate must be 0, 5, 12, 18 or 28.' } }; out.gstRate = r; }
  const cur = (await getSettings()).settings;
  const next = Object.assign({}, cur, out); delete next.stateName;
  if ([next.prefixGst, next.prefixPlain, next.prefixReceipt].map((x) => String(x).toUpperCase()).filter((x, i, a) => a.indexOf(x) !== i).length) return { httpStatus: 400, body: { error: 'Each kind of number needs its own prefix.' } };
  await q(`INSERT INTO console.settings (key, value) VALUES ('invoice', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_at = now()`, [JSON.stringify(next)]);
  await logEvent('ADMIN_INVOICE_SETTINGS', { changed: Object.keys(out), via: who });
  return { httpStatus: 200, body: Object.assign({ ok: true }, await getSettings()) };
}

/* ---- the maths ---- */
export function compute({ lines, gst, inclusive, rate, sellerState, buyerState }) {
  const rows = lines.map((l) => ({ description: l.description, sac: l.sac, qty: l.qty, rate: r2(l.rate), amount: r2(l.qty * l.rate) }));
  const sum = r2(rows.reduce((a, l) => a + l.amount, 0));
  const intra = !buyerState || buyerState === sellerState;
  let taxable = sum, tax = 0;
  if (gst && rate > 0) {
    if (inclusive) { taxable = r2(sum / (1 + rate / 100)); tax = r2(sum - taxable); } else tax = r2(sum * rate / 100);
  }
  const half = r2(tax / 2);
  const t = { taxable, cgstRate: 0, cgst: 0, sgstRate: 0, sgst: 0, igstRate: 0, igst: 0 };
  if (gst && tax) {
    if (intra) Object.assign(t, { cgstRate: rate / 2, cgst: half, sgstRate: rate / 2, sgst: r2(tax - half) });
    else Object.assign(t, { igstRate: rate, igst: tax });
  }
  const gross = r2(taxable + tax);
  const total = Math.round(gross);
  return Object.assign(t, { lines: rows, intraState: intra, tax, roundOff: r2(total - gross), total, totalWords: inWords(total) });
}

function out(r) {
  const j = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const n = (v) => (v == null ? null : Number(v));
  return { id: Number(r.id), number: r.number, series: r.series, kind: r.kind, gst: r.gst, date: r.day_text, fy: r.fy, paymentId: r.payment_id != null ? Number(r.payment_id) : null,
    software: r.software, companyId: r.company_id != null ? String(r.company_id) : null, remoteId: r.remote_id || null,
    seller: j(r.seller), customer: j(r.customer), lines: j(r.lines), inclusive: r.inclusive, taxable: n(r.taxable),
    cgstRate: n(r.cgst_rate), cgst: n(r.cgst), sgstRate: n(r.sgst_rate), sgst: n(r.sgst), igstRate: n(r.igst_rate), igst: n(r.igst),
    roundOff: n(r.round_off), total: n(r.total), totalWords: r.total_words, intraState: r.intra, placeOfSupply: r.place, notes: r.notes,
    cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason, createdAt: r.created_at };
}
const SEL = `*, to_char(day, 'YYYY-MM-DD') AS day_text`;

export async function listInvoices(p) {
  const where = ['TRUE'], vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('$?', '$' + vals.length)); };
  if (p.paymentId) add('payment_id = $?', parseInt(p.paymentId, 10) || 0);
  if (p.software && softwareOf(p.software)) add('software = $?', p.software);
  if (p.companyId) add('company_id = $?', parseInt(p.companyId, 10) || 0);
  if (p.remoteId) add('remote_id = $?', String(p.remoteId));
  if (isoDay(p.from)) add('day >= $?::date', p.from);
  if (isoDay(p.to)) add('day <= $?::date', p.to);
  if (p.gst === 'yes' || p.gst === 'no') add('gst = $?', p.gst === 'yes');
  const rows = await q(`SELECT ${SEL} FROM console.invoices WHERE ${where.join(' AND ')} ORDER BY invoices.day DESC, invoices.id DESC LIMIT 1000`, vals);
  return { invoices: rows.map(out) };
}

async function gstinOf(software, companyId, remoteId) {
  if (software === 'weight') { const w = await weightCompanies(); const c = w.companies.find((x) => x.id === String(companyId)); return c ? c.gstin : ''; }
  if (isRemote(software) && remoteId) { const r = await softwareCall(software, 'GET', '/admin/api/company?id=' + encodeURIComponent(remoteId)); return r.status === 200 ? (r.body.gstin || '') : ''; }
  return '';
}

export async function invoiceAction(body, who) {
  const b = body || {};
  if (b.action === 'cancel') {
    const id = parseInt(b.id, 10) || 0;
    const reason = txt(b.reason, 200);
    if (!reason) return { httpStatus: 400, body: { error: 'Say why it is cancelled.' } };
    const row = (await q(`UPDATE console.invoices SET cancelled_at = now(), cancel_reason = $2 WHERE id = $1 AND cancelled_at IS NULL RETURNING ${SEL}`, [id, reason]))[0];
    if (!row) return { httpStatus: 404, body: { error: 'No such invoice, or it is cancelled already.' } };
    await logEvent('ADMIN_INVOICE_CANCEL', { id, number: row.number, reason, via: who });
    return { httpStatus: 200, body: { ok: true, invoice: out(row) } };
  }
  if (b.action !== 'create') return { httpStatus: 400, body: { error: 'Unknown action: ' + b.action } };

  const { settings: S, ready } = await getSettings();
  if (!ready) return { httpStatus: 409, body: { error: 'NOT_SET_UP', message: 'Fill Invoice Settings first: your company name, address and state.' } };
  const kind = b.kind === 'RECEIPT' ? 'RECEIPT' : 'INVOICE';
  const gst = b.gst === true;
  if (gst && !S.gstin) return { httpStatus: 409, body: { error: 'NO_GSTIN', message: 'A GST invoice needs your GSTIN in Invoice Settings.' } };
  const day = isoDay(b.date) || istToday();
  if (day > istToday()) return { httpStatus: 400, body: { error: 'An invoice cannot be dated in the future.' } };

  /* the payment it is for, when it is for one */
  let pay = null;
  if (b.paymentId) {
    pay = (await q(`SELECT *, to_char(valid_from, 'YYYY-MM-DD') AS vf, to_char(valid_to, 'YYYY-MM-DD') AS vt FROM console.customer_payments WHERE id = $1 AND deleted_at IS NULL`, [parseInt(b.paymentId, 10) || 0]))[0];
    if (!pay) return { httpStatus: 404, body: { error: 'No such payment.' } };
  }
  const software = pay ? pay.software : String(b.software || '');
  if (!softwareOf(software)) return { httpStatus: 400, body: { error: 'Which software is it for?' } };
  const companyId = pay ? pay.company_id : (b.companyId ? parseInt(b.companyId, 10) : null);
  const remoteId = pay ? pay.fabric_id : (b.remoteId != null ? String(b.remoteId) : null);

  /* the customer */
  const c = b.customer || {};
  const customer = { name: txt(c.name || (pay && pay.customer_name), 120), gstin: txt(c.gstin, 15).toUpperCase(), address: txt(c.address, 400),
    email: txt(c.email, 80), phone: txt(c.phone, 40), stateCode: txt(c.stateCode, 2) };
  if (!customer.gstin && c.gstin === undefined) customer.gstin = String(await gstinOf(software, companyId, remoteId) || '').toUpperCase();
  if (!customer.name) return { httpStatus: 400, body: { error: 'Whose invoice is it? Give the customer\'s name.' } };
  if (customer.gstin && !GSTIN_RE.test(customer.gstin)) return { httpStatus: 400, body: { error: 'The customer\'s GSTIN is not in the right form.' } };
  if (!customer.stateCode && customer.gstin) customer.stateCode = customer.gstin.slice(0, 2);
  if (customer.stateCode && !STATES[customer.stateCode]) return { httpStatus: 400, body: { error: 'Unknown state code ' + customer.stateCode + '.' } };
  customer.stateName = STATES[customer.stateCode] || '';

  /* the lines: as given, or the payment's own */
  let lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length && pay) {
    const sw = softwareOf(pay.software);
    lines = [{ description: (sw ? sw.name : pay.software) + ' — ' + (pay.plan_name || pay.plan || 'licence') + ' plan' + (pay.vf && pay.vt ? ' (' + pay.vf + ' to ' + pay.vt + ')' : '') + (pay.note ? ' · ' + pay.note : ''), qty: 1, rate: Number(pay.amount) }];
  }
  if (!lines.length || lines.length > 30) return { httpStatus: 400, body: { error: 'An invoice needs 1 to 30 lines.' } };
  const clean = [];
  for (const l of lines) {
    const d = txt(l.description, 300), qty = Number(l.qty), rate = Number(l.rate);
    if (!d) return { httpStatus: 400, body: { error: 'Every line needs a description.' } };
    if (!(qty > 0 && qty <= 100000)) return { httpStatus: 400, body: { error: 'The quantity must be more than 0.' } };
    if (!(rate >= 0 && rate <= 100000000) || /-/.test(String(l.rate))) return { httpStatus: 400, body: { error: 'A rate cannot be below 0.' } };
    clean.push({ description: d, sac: txt(l.sac || S.sac, 8), qty, rate });
  }
  const inclusive = b.inclusive !== undefined ? b.inclusive === true : !!pay;
  const rate = gst ? Number(S.gstRate) : 0;
  const m = compute({ lines: clean, gst, inclusive, rate, sellerState: S.stateCode, buyerState: customer.stateCode });
  if (!(m.total > 0)) return { httpStatus: 400, body: { error: 'The invoice total must be more than 0.' } };

  const series = kind === 'RECEIPT' ? S.prefixReceipt : gst ? S.prefixGst : S.prefixPlain;
  const fy = fyOf(day);
  const seq = (await q(`INSERT INTO console.invoice_counters (series, fy, last) VALUES ($1, $2, 1)
                         ON CONFLICT (series, fy) DO UPDATE SET last = console.invoice_counters.last + 1 RETURNING last`, [series, fy]))[0].last;
  const number = series + '/' + fy + '/' + String(seq).padStart(4, '0');
  const seller = Object.assign({}, S);
  const place = (customer.stateCode || S.stateCode) + ' ' + (STATES[customer.stateCode || S.stateCode] || '');
  const row = (await q(`INSERT INTO console.invoices (number, series, kind, gst, fy, seq, day, payment_id, software, company_id, remote_id, seller, customer, lines,
                          inclusive, taxable, cgst_rate, cgst, sgst_rate, sgst, igst_rate, igst, round_off, total, total_words, intra, place, notes, via)
                        VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING ${SEL}`,
    [number, series, kind, gst, fy, Number(seq), day, pay ? pay.id : null, software, companyId || null, remoteId || null, JSON.stringify(seller), JSON.stringify(customer),
      JSON.stringify(m.lines), inclusive, m.taxable, m.cgstRate, m.cgst, m.sgstRate, m.sgst, m.igstRate, m.igst, m.roundOff, m.total, m.totalWords, m.intraState, place,
      txt(b.notes, 500) || null, who || null]))[0];
  await logEvent('ADMIN_INVOICE_CREATE', { id: Number(row.id), number, kind, gst, total: m.total, paymentId: pay ? Number(pay.id) : undefined, via: who });
  return { httpStatus: 200, body: { ok: true, invoice: out(row) } };
}

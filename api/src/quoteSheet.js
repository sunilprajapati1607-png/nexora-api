/**
 * Nexora Mobile — a quotation made on the phone, as a printed page  (4.67.16)
 * ======================================================================
 *   "in android app user can create quotation from calculation also"
 *
 * The phone lays out nothing and adds up nothing. It sends the quotation it
 * is making; this answers with its number (the company's own series), its
 * totals and the page to print — which the phone turns into the PDF it sends
 * on WhatsApp.
 *
 *   · THE TOTALS are the desktop's own: calculation/quoteMath.js, vendored and
 *     run in the same vm context as the weight engine (weigh.js desktopOver),
 *     so a quotation made on the phone adds up exactly as one made on a
 *     computer. Nothing here recomputes a figure.
 *   · THE NUMBER is the company's document series (docSeries.js), past every
 *     quotation number the company has used.
 *   · THE PAGE follows the computer's sheet — letterhead, buyer, items, tax,
 *     specification, terms, signature — with the same labels and the same
 *     "not an invoice" line, in the company's units and currency. It has no
 *     bag drawings (those are drawn by the computer's window); when the
 *     quotation is next saved on a computer, the computer's own page replaces
 *     this one.
 *   · NO COST is ever on it: nothing costed is read here.
 */
import { q } from './db.js';
import { desktopOver } from './weigh.js';

const MASTERS = ['nexora.org.v1', 'nexora.units.v1', 'nexora.meshunit.v1', 'nexora.docseries.v1', 'nexora.quote.terms.v1'];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qnum = (v) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Number(v));
function fmt(n, d) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  const k = d != null ? d : 2;
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: k, maximumFractionDigits: k });   // 4.72.0 (audit 66) — as the computer prints
}
/* Indian dates, in Indian time: the service's clock is UTC */
function dmy(v) {
  const t = new Date(v || Date.now());
  if (isNaN(t)) return '—';
  const ist = new Date(t.getTime() + 19800000);
  const p = (x) => String(x).padStart(2, '0');
  return p(ist.getUTCDate()) + '-' + p(ist.getUTCMonth() + 1) + '-' + ist.getUTCFullYear();
}
function properCase(s) { return String(s || '').toLowerCase().replace(/(^|[\s(+/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(\d)l\b/gi, '$1L'); }

/** The computer's specification lines (app.js QUOTE_SPEC), read the same way, in the company's units. */
function specLines(U) {
  return [
    { id: 'construction', label: 'Construction', read: (c) => properCase((c && c.structure) || '') },
    { id: 'size', label: 'Size', read: (c) => U.pair(((c && c.inputs) || {}).WIDTH, ((c && c.inputs) || {}).LENGTH) || '' },
    { id: 'gusset', label: 'Bottom / gusset', read: (c) => (qnum(((c && c.inputs) || {}).PATCH) ? U.text(((c && c.inputs) || {}).PATCH) : '') },
    { id: 'fabric', label: 'Body fabric', read: (c) => (qnum(((c && c.inputs) || {})['BD FAB GSM']) ? fmt(c.inputs['BD FAB GSM'], 0) + ' g/m²' : '') },
    { id: 'patchfab', label: 'Patch / valve fabric', read: (c) => (qnum(((c && c.inputs) || {})['FLT FAB GSM']) ? fmt(c.inputs['FLT FAB GSM'], 0) + ' g/m²' : '') },
    { id: 'mesh', label: 'Mesh', read: (c) => {
      const i = (c && c.inputs) || {};
      if (!qnum(i['M.WARP']) && !qnum(i['M.WEFT'])) return '';
      return U.meshShow(qnum(i['M.WARP']) || 0) + ' × ' + U.meshText(qnum(i['M.WEFT']) || 0);
    } },
    { id: 'coating', label: 'Coating', read: (c) => (qnum(((c && c.inputs) || {})['BD CT GSM']) ? fmt(c.inputs['BD CT GSM'], 0) + ' g/m²' : '') },
    { id: 'bopp', label: 'BOPP film', read: (c) => (qnum(((c && c.inputs) || {})['BD BOP MIC']) ? fmt(c.inputs['BD BOP MIC'], 0) + ' µm' : '') },
    { id: 'metallised', label: 'Metallised film', read: (c) => (qnum(((c && c.inputs) || {})['BD MT MIC']) ? fmt(c.inputs['BD MT MIC'], 0) + ' µm' : '') },
    /* the target, not the computed weight — as the computer quotes it */
    { id: 'weight', label: 'Bag weight', read: (c) => {
      const target = c && qnum(c.targetWeight);
      if (target) return fmt(target, 1) + ' g';
      const net = c && c.result && qnum(c.result.netWeight);
      return net ? fmt(net, 1) + ' g' : '';
    } },
    { id: 'liner', label: 'Liner', read: (c) => {
      const i = (c && c.inputs) || {};
      if (!qnum(i['LNR WIDTH']) && !qnum(i['LNR MC'])) return '';
      return [U.pair(i['LNR WIDTH'], i['LNR LENGTH']), qnum(i['LNR MC']) ? fmt(i['LNR MC'], 0) + ' µm' : ''].filter(Boolean).join(' · ');
    } },
    { id: 'handle', label: 'Handle', read: (c) => U.pair(((c && c.inputs) || {})['H.WIDTH'], ((c && c.inputs) || {})['H.LENGTH']) || '' }
  ];
}

/** What arrives from the phone, kept to what a quotation holds. */
function cleanQuote(x) {
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const o = x && typeof x === 'object' ? x : {};
  return {
    quoteNumber: o.quoteNumber ? s(o.quoteNumber, 40) : null,
    date: s(o.date, 40) || new Date().toISOString(),
    customer: s(o.customer, 160), customerAddress: s(o.customerAddress, 400), customerGstin: s(o.customerGstin, 20).toUpperCase(),
    reference: s(o.reference, 160),
    items: (Array.isArray(o.items) ? o.items : []).slice(0, 30).map((it) => ({
      id: s(it && it.id, 40), calcId: it && it.calcId ? s(it.calcId, 80) : null, itemName: s(it && it.itemName, 160),
      quantity: qnum(it && it.quantity), rate: qnum(it && it.rate),
      basis: ['BAG', 'K', 'KG'].indexOf(it && it.basis) > -1 ? it.basis : 'BAG',
      /* 4.72.0 (audit 69) — the weight a per-kg line was quoted at; quoteMath prices it on this before the calculation's */
      gramsAtQuote: qnum(it && it.gramsAtQuote),
      text: (it && it.text && typeof it.text === 'object') ? it.text : {}
    })),
    charges: (Array.isArray(o.charges) ? o.charges : []).slice(0, 10).map((c) => ({ label: s(c && c.label, 80), amount: qnum(c && c.amount) })),
    gstRate: qnum(o.gstRate) == null ? 18 : qnum(o.gstRate), interState: !!o.interState,
    validityDays: qnum(o.validityDays), payment: s(o.payment, 300), delivery: s(o.delivery, 300), notes: s(o.notes, 1000),
    terms: (Array.isArray(o.terms) ? o.terms : []).slice(0, 40).map((t) => s(t, 40)),
    termsText: {}
  };
}

async function mastersOf(companyId) {
  const rows = await q(`SELECT id, body FROM sync_records WHERE company_id = $1 AND kind = 'master' AND deleted = false AND id IN ($2, $3, $4, $5, $6)`,
    [companyId].concat(MASTERS));
  const out = {};
  rows.forEach((r) => { out[r.id] = r.body; });
  return out;
}

/** The terms library the company's administrator keeps (a shared master since 4.67.16). */
function termsOf(masters) {
  const list = Array.isArray(masters['nexora.quote.terms.v1']) ? masters['nexora.quote.terms.v1'] : [];
  return list.filter((t) => t && typeof t.text === 'string' && t.id).map((t) => ({ id: String(t.id), text: t.text, on: t.on !== false }));
}

/** GET /v1/quote/form — what the phone's quotation form offers. */
export async function quoteForm(companyId) {
  const m = await mastersOf(companyId);
  const org = m['nexora.org.v1'] || {};
  return { httpStatus: 200, body: { terms: termsOf(m), currency: org.currency || 'Rs', defaults: { gstRate: 18, validityDays: 7, basis: 'BAG' } } };
}

/** Build the page (exported for the tests, which build one with no database). */
export function sheetWith(d, masters, quote, byId) {
  const U = d.NexoraUnits;
  const org = masters['nexora.org.v1'] || {};
  const rs = (v, k) => (org.currency ? org.currency + ' ' : 'Rs ') + fmt(Number(v) || 0, k == null ? 2 : k);
  const t = JSON.parse(JSON.stringify(d.NexoraQuoteMath.quoteTotals(quote, byId)));
  const lib = termsOf(masters);
  const clauses = quote.terms.map((id) => (lib.filter((x) => x.id === id)[0] || {}).text || quote.termsText[id]).filter(Boolean);
  const validTill = quote.validityDays != null ? dmy(new Date(new Date(quote.date).getTime() + Number(quote.validityDays) * 86400000)) : null;
  const SPEC = specLines(U);
  const specOf = (item) => {
    const calc = item.calcId ? byId[item.calcId] : null;
    const subject = calc || { structure: '', inputs: {}, result: null, targetWeight: null };
    return SPEC.map((line) => {
      const typed = item.text && item.text[line.id];
      const v = typed != null && String(typed).trim() !== '' ? String(typed).trim() : line.read(subject);
      return { label: line.label, value: v };
    }).filter((r) => r.value);
  };
  const nameOf = (item, i) => item.itemName || (item.calcId && byId[item.calcId] && (byId[item.calcId].itemName || byId[item.calcId].itemCode)) || 'Item ' + (i + 1);

  const cell = 'padding:7px 8px;border-bottom:1px solid #d9dde5;vertical-align:top;';
  const th = 'padding:7px 8px;text-align:left;border-bottom:2px solid #1a2233;font-size:11px;text-transform:uppercase;letter-spacing:.04em;';
  const r = 'text-align:right;';
  const h3 = 'font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:18px 0 6px;padding-bottom:4px;border-bottom:1px solid #1a2233;';

  const itemRows = quote.items.map((item, i) => {
    const it = t.rows[i];
    const summary = specOf(item).slice(0, 3).map((x) => x.label + ' ' + x.value).join(' · ');
    return '<tr><td style="' + cell + '">' + (i + 1) + '</td>' +
      '<td style="' + cell + '"><b>' + esc(nameOf(item, i)) + '</b>' + (summary ? '<br/><span style="font-size:10.5px;color:#555">' + esc(summary) + '</span>' : '') + '</td>' +
      '<td style="' + cell + r + '">' + fmt(it.qty, 0) + '</td>' +
      '<td style="' + cell + r + '">' + rs(item.rate || 0, 3) + '<br/><span style="font-size:10px;color:#666">' + esc(it.basisLabel) + '</span></td>' +
      '<td style="' + cell + r + '">' + rs(it.amount) + '</td></tr>';
  }).join('');
  const taxRows = t.gstRate
    ? (quote.interState
        ? '<tr><td style="' + cell + '">IGST @ ' + t.gstRate + '%</td><td style="' + cell + r + '">' + rs(t.tax) + '</td></tr>'
        : '<tr><td style="' + cell + '">CGST @ ' + (t.gstRate / 2) + '%</td><td style="' + cell + r + '">' + rs(t.half) + '</td></tr>' +
          '<tr><td style="' + cell + '">SGST @ ' + (t.gstRate / 2) + '%</td><td style="' + cell + r + '">' + rs(t.half) + '</td></tr>') +
      '<tr><td style="' + cell + '">Total tax</td><td style="' + cell + r + '">' + rs(t.tax) + '</td></tr>'
    : '<tr><td style="' + cell + '">GST</td><td style="' + cell + r + '">Nil</td></tr>';
  const blocks = quote.items.map((item, i) => {
    const spec = specOf(item);
    if (!spec.length) return '';
    return '<div style="break-inside:avoid;margin-top:10px"><div style="font-weight:600;font-size:12px;margin-bottom:4px">' + (i + 1) + '. ' + esc(nameOf(item, i).toUpperCase()) + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;column-gap:18px">' +
      spec.map((x) => '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eceff4;font-size:11.5px"><span>' + esc(x.label) + '</span><span style="text-align:right">' + esc(x.value) + '</span></div>').join('') +
      '</div></div>';
  }).join('');
  const contact = [org.phone, org.email].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');

  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>@page { size: A4; margin: 12mm; } html, body { margin: 0; background: #fff; color: #111; font-family: "Segoe UI", Roboto, Arial, sans-serif; font-size: 12px; } ' +
    'table { width: 100%; border-collapse: collapse; } tr { break-inside: avoid; page-break-inside: avoid; }</style></head><body>' +
    '<div class="print-sheet ps-quote">' +
    '<div class="ps-header" style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a2233;padding-bottom:8px">' +
      '<div style="display:flex;gap:10px;align-items:center">' + (org.logo ? '<img src="' + esc(org.logo) + '" alt="" style="height:46px"/>' : '') +
        '<div><div style="font-size:20px;font-weight:800;letter-spacing:.02em">' + esc(org.company || 'NEXORA') + '</div>' +
        '<div style="font-size:12px;font-weight:700;letter-spacing:.3em">QUOTATION</div>' +
        (org.address ? '<div style="font-size:10.5px;color:#444">' + esc(org.address) + '</div>' : '') +
        (contact ? '<div style="font-size:10.5px;color:#444">' + contact + '</div>' : '') +
        (org.gstin ? '<div style="font-size:10.5px;color:#444"><b>GSTIN:</b> ' + esc(org.gstin) + '</div>' : '') + '</div></div>' +
      '<div style="text-align:right;font-size:11.5px">Quotation: <b>' + esc(quote.quoteNumber || '') + '</b><br/>Date: ' + esc(dmy(quote.date)) + '<br/>' +
        (validTill ? 'Valid to: <b>' + esc(validTill) + '</b><br/>' : '') + (quote.reference ? 'Your ref: ' + esc(quote.reference) : '') + '</div>' +
    '</div>' +
    '<table style="margin-top:12px;border:1px solid #d9dde5"><tbody>' +
      '<tr><td style="' + cell + 'width:22%">Quotation to</td><td style="' + cell + '"><b>' + esc(quote.customer || '—') + '</b></td></tr>' +
      (quote.customerAddress ? '<tr><td style="' + cell + '">Address</td><td style="' + cell + '">' + esc(quote.customerAddress) + '</td></tr>' : '') +
      (quote.customerGstin ? '<tr><td style="' + cell + '">Buyer GSTIN</td><td style="' + cell + '">' + esc(quote.customerGstin) + '</td></tr>' : '') +
    '</tbody></table>' +
    '<div style="' + h3 + '">Items</div>' +
    '<table><thead><tr><th style="' + th + 'width:26px">#</th><th style="' + th + '">Item</th><th style="' + th + r + 'width:90px">Quantity</th>' +
      '<th style="' + th + r + 'width:110px">Rate</th><th style="' + th + r + 'width:120px">Amount</th></tr></thead><tbody>' + itemRows +
      (t.chargeTotal ? '<tr><td style="' + cell + '" colspan="4">Goods</td><td style="' + cell + r + '">' + rs(t.goods) + '</td></tr>' +
        t.charges.map((c) => '<tr><td style="' + cell + '"></td><td style="' + cell + '">' + esc(String(c.label || '').trim() || 'Other charge') + '</td><td style="' + cell + '"></td><td style="' + cell + '"></td><td style="' + cell + r + '">' + rs(Number(c.amount) || 0) + '</td></tr>').join('') : '') +
      '<tr><td colspan="4" style="' + cell + 'font-weight:700">Subtotal</td><td style="' + cell + r + 'font-weight:700">' + rs(t.subtotal) + '</td></tr>' +
    '</tbody></table>' +
    '<div style="' + h3 + '">Tax and total</div>' +
    '<table><tbody><tr><td style="' + cell + 'width:68%">Subtotal</td><td style="' + cell + r + '">' + rs(t.subtotal) + '</td></tr>' + taxRows +
      '<tr><td style="' + cell + 'font-weight:700;font-size:13px">Grand total</td><td style="' + cell + r + 'font-weight:700;font-size:13px">' + rs(t.grand) + '</td></tr>' +
      /* 4.72.0 (audit 66) — the amount in words, as the computer's sheet prints it, for rupees only */
      ((/^(|rs\.?|inr|₹)$/i.test(String(org.currency || '').trim()) && d.NexoraQuoteMath.inWords && d.NexoraQuoteMath.inWords(t.grand))
        ? '<tr><td colspan="2" style="' + cell + '">Amount in words: ' + esc(d.NexoraQuoteMath.inWords(t.grand)) + '</td></tr>' : '') +
      '</tbody></table>' +
    (blocks ? '<div style="' + h3 + '">Specification</div>' + blocks : '') +
    ((quote.payment || quote.delivery || quote.validityDays != null)
      ? '<div style="' + h3 + '">Terms</div><table><tbody>' +
        (quote.validityDays != null ? '<tr><td style="' + cell + 'width:32%">Price valid for</td><td style="' + cell + '">' + quote.validityDays + ' day' + (Number(quote.validityDays) === 1 ? '' : 's') + (validTill ? ' — to ' + esc(validTill) : '') + '</td></tr>' : '') +
        (quote.payment ? '<tr><td style="' + cell + '">Payment</td><td style="' + cell + '">' + esc(quote.payment) + '</td></tr>' : '') +
        (quote.delivery ? '<tr><td style="' + cell + '">Delivery</td><td style="' + cell + '">' + esc(quote.delivery) + '</td></tr>' : '') +
        '</tbody></table>' : '') +
    (quote.notes ? '<p style="font-size:11px;margin-top:10px">' + esc(quote.notes) + '</p>' : '') +
    (clauses.length ? '<div style="' + h3 + '">Terms &amp; Conditions</div><ol style="font-size:10.5px;padding-left:18px;margin:4px 0">' + clauses.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ol>' : '') +
    '<p style="font-size:10.5px;color:#666;margin-top:10px">This is a quotation, not an invoice. Prices hold for the validity above and are subject to confirmation at the time of order.</p>' +
    '<div style="display:flex;justify-content:space-around;margin-top:40px;font-size:11px"><div style="border-top:1px solid #111;width:180px;text-align:center;padding-top:4px">Prepared By</div>' +
      '<div style="border-top:1px solid #111;width:180px;text-align:center;padding-top:4px">Authorised Signatory</div></div>' +
    '</div></body></html>';

  const termsText = {};
  quote.terms.forEach((id) => { const x = lib.filter((y) => y.id === id)[0]; if (x) termsText[id] = x.text; });
  return { totals: { goods: t.goods, chargeTotal: t.chargeTotal, subtotal: t.subtotal, gstRate: t.gstRate, tax: t.tax, half: t.half, grand: t.grand, bags: t.bags,
    rows: t.rows.map((x) => ({ qty: x.qty, amount: x.amount, basisLabel: x.basisLabel })) }, html, termsText };
}

/** POST /v1/quote/sheet — number (when it has none), totals and the page, for a quotation made on the phone. */
export async function quoteSheet(companyId, user, raw) {
  const quote = cleanQuote(raw);
  if (!quote.items.length) return { httpStatus: 400, body: { error: 'NO_ITEMS', message: 'Add at least one bag to the quotation.' } };
  const masters = await mastersOf(companyId);
  const d = desktopOver(masters);
  if (!quote.quoteNumber) {
    const used = (await q(`SELECT body->>'quoteNumber' AS n FROM sync_records WHERE company_id = $1 AND kind = 'quote'`, [companyId]))
      .map((x) => x.n).filter(Boolean);
    quote.quoteNumber = d.NexoraDocSeries.next('quote', used, new Date(Date.now() + 19800000).getUTCFullYear());
  }
  const ids = quote.items.map((it) => it.calcId).filter(Boolean);
  const byId = {};
  /* only bags this person may see — scope OWN sees their own, as in every list */
  for (const id of ids) {
    const row = (await q(`SELECT id, body, owner_id FROM sync_records WHERE company_id = $1 AND kind = 'calc' AND deleted = false AND id = $2`, [companyId, id]))[0];
    if (row && (user.scope === 'ALL' || row.owner_id == null || Number(row.owner_id) === Number(user.id))) byId[row.id] = row.body;
  }
  const out = sheetWith(d, masters, quote, byId);
  return { httpStatus: 200, body: { ok: true, quoteNumber: quote.quoteNumber, totals: out.totals, termsText: out.termsText, html: out.html } };
}

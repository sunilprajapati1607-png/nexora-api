/**
 * Nexora — a quotation's arithmetic, in one place  (4.67.16)
 * ======================================================================
 *   "in android app user can create quotation from calculation also"
 *
 * A quotation made on the phone must add up exactly as one made on the
 * computer. So the two functions that do the adding — one row, then the
 * whole document — live here, and the application (app.js), the service
 * (server/vendor, for Nexora Mobile's /v1/quote/sheet) and nothing else use
 * them. They are the functions app.js had, moved, not rewritten: one
 * computation, every display.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexoraQuoteMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const qnum = (v) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Number(v));

  /* 4.72.0 (audit #74) — money as it is PRINTED: to the paisa, half away from zero. toFixed(8) first folds the
     binary noise of a product such as 2.469 × 5,000 back onto the decimal it stands for, and the second toFixed
     does the same for × 100, so 308.625 rounds to 308.63 as it is written on paper. */
  function round2(v) {
    const x = Number(v);
    if (!isFinite(x)) return 0;
    const a = Math.abs(Number(x.toFixed(8)));
    const r = Math.round(Number((a * 100).toFixed(6))) / 100;
    return x < 0 ? -r : r;
  }

  /* 4.72.0 — A SAVED QUOTATION NEVER CHANGES ITS TOTALS. The paisa arithmetic below (audit #74) applies to a
     quotation dated from the moment 4.72.0 was finished; one dated before keeps, to the paisa, the arithmetic it
     was printed with (quoteTotalsBefore472). Reopened or reprinted on any computer, phone or the service, an old
     quotation shows exactly what its buyer was sent. No date = a quotation being made now. */
  const PAISA_FROM = '2026-10-02T09:30:00.000Z';
  function paisaMath(q) {
    const d = String((q && q.date) || '');
    return !d || d >= PAISA_FROM;
  }

  /** One row’s arithmetic. */
  function itemTotals(item, calc, opts) {
    const rate = Number(item.rate) || 0;
    const qty = Number(item.quantity) || 0;
    /* 4.71.0 (audit) — a saved quotation keeps the weight it was quoted at (gramsAtQuote): the calculation edited
       later must not change an amount the buyer already has on paper. Rows saved before 4.71.0 have none and read
       the calculation as before. */
    const frozen = qnum(item.gramsAtQuote);
    const grams = frozen !== null && frozen > 0 ? frozen
      : item.calcId && calc && calc.result ? (Number(calc.result.netWeight) || 0)
      : (qnum(parseFloat(String((item.text && item.text.weight) || ''))) || 0);
    const kg = (grams * qty) / 1000;
    let amount = 0;
    if (item.basis === 'BAG') amount = rate * qty;
    else if (item.basis === 'K') amount = rate * (qty / 1000);
    else if (item.basis === 'KG') amount = rate * kg;
    /* 4.72.0 (audit #74) — a row's amount is printed to the paisa, so it is kept to the paisa: the rows on the
       sheet then add up to the subtotal on the sheet */
    if (!(opts && opts.paise === false)) amount = round2(amount);
    return { qty, kg, grams, amount,
      basisLabel: item.basis === 'BAG' ? 'per bag' : item.basis === 'K' ? 'per 1,000 bags' : 'per kg' };
  }

  /** The document’s arithmetic: every row, then the tax on the sum. */
  function quoteTotals(q, byId) {
    if (!paisaMath(q)) return quoteTotalsBefore472(q, byId);
    const rows = (q.items || []).map((item) => itemTotals(item, byId[item.calcId]));
    const goods = round2(rows.reduce((a, r) => a + r.amount, 0));
    /* Freight and packing are taxable supplies, so they join the
       subtotal BEFORE the tax rather than being added at the end. */
    const charges = (q.charges || []).filter((c) => c && (String(c.label || '').trim() || Number(c.amount)));
    const chargeTotal = round2(charges.reduce((a, c) => a + round2(Number(c.amount) || 0), 0));
    const subtotal = round2(goods + chargeTotal);
    const gstRate = Number(q.gstRate) || 0;
    /* 4.72.0 (audit #74) — the tax as it is printed. Within the state CGST and SGST are each half the rate on the
       subtotal, each rounded to the paisa, and the total tax IS the two of them: 308.63 + 308.63 = 617.26, never
       617.25 under them. Outside the state IGST is the whole rate, rounded once. The grand total is the printed
       subtotal plus the printed tax. (Nexora Mobile prints `half` twice and `tax` under it, so it adds up too.) */
    const half = round2(subtotal * gstRate / 200);
    const tax = q.interState ? round2(subtotal * gstRate / 100) : round2(half * 2);
    return { rows, goods, charges, chargeTotal, subtotal, gstRate, tax,
      half: half, grand: round2(subtotal + tax),
      bags: rows.reduce((a, r) => a + r.qty, 0) };
  }

  /** The arithmetic every quotation dated before 4.72.0 was printed with — kept exactly (see PAISA_FROM). */
  function quoteTotalsBefore472(q, byId) {
    const rows = (q.items || []).map((item) => itemTotals(item, byId[item.calcId], { paise: false }));
    const goods = rows.reduce((a, r) => a + r.amount, 0);
    const charges = (q.charges || []).filter((c) => c && (String(c.label || '').trim() || Number(c.amount)));
    const chargeTotal = charges.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    const subtotal = goods + chargeTotal;
    const gstRate = Number(q.gstRate) || 0;
    const tax = subtotal * (gstRate / 100);
    return { rows, goods, charges, chargeTotal, subtotal, gstRate, tax,
      half: tax / 2, grand: subtotal + tax,
      bags: rows.reduce((a, r) => a + r.qty, 0) };
  }

  /* ---- 4.72.0 (audit #66) — the grand total in words, the Indian way -------------------------------------
     "Rupees One Lakh Fifty-Seven Thousand Five Hundred and Fifty Paise Only": crore, lakh, thousand, hundred,
     as a buyer's accounts desk reads it. The sheet prints it only where the money is rupees. */
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''); }
  function below1000(n) {
    const h = Math.floor(n / 100), r = n % 100;
    return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? below100(r) : '');
  }
  function indianWords(n) {
    if (!n) return 'Zero';
    const out = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) out.push((crore >= 1000 ? indianWords(crore) : below1000(crore)) + ' Crore');
    if (lakh) out.push(below100(lakh) + ' Lakh');
    if (thousand) out.push(below100(thousand) + ' Thousand');
    if (n) out.push(below1000(n));
    return out.join(' ');
  }
  /** The amount in words, to the paisa ('' for anything that is not a sensible amount). */
  function inWords(amount) {
    if (amount === null || amount === undefined || amount === '' || !isFinite(Number(amount))) return '';
    const v = round2(amount);
    if (!(v >= 0) || v >= 1e15) return '';
    const rupees = Math.floor(v);
    const paise = Math.round((v - rupees) * 100);
    return 'Rupees ' + indianWords(rupees) + (paise ? ' and ' + below100(paise) + ' Paise' : '') + ' Only';
  }

  return { qnum: qnum, round2: round2, itemTotals: itemTotals, quoteTotals: quoteTotals, inWords: inWords,
    paisaMath: paisaMath, PAISA_FROM: PAISA_FROM };
});

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

  /** One row’s arithmetic. */
  function itemTotals(item, calc) {
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
    return { qty, kg, grams, amount,
      basisLabel: item.basis === 'BAG' ? 'per bag' : item.basis === 'K' ? 'per 1,000 bags' : 'per kg' };
  }

  /** The document’s arithmetic: every row, then the tax on the sum. */
  function quoteTotals(q, byId) {
    const rows = (q.items || []).map((item) => itemTotals(item, byId[item.calcId]));
    const goods = rows.reduce((a, r) => a + r.amount, 0);
    /* Freight and packing are taxable supplies, so they join the
       subtotal BEFORE the tax rather than being added at the end. */
    const charges = (q.charges || []).filter((c) => c && (String(c.label || '').trim() || Number(c.amount)));
    const chargeTotal = charges.reduce((a, c) => a + (Number(c.amount) || 0), 0);
    const subtotal = goods + chargeTotal;
    const gstRate = Number(q.gstRate) || 0;
    const tax = subtotal * (gstRate / 100);
    return { rows, goods, charges, chargeTotal, subtotal, gstRate, tax,
      half: tax / 2, grand: subtotal + tax,
      bags: rows.reduce((a, r) => a + r.qty, 0) };
  }

  return { qnum: qnum, itemTotals: itemTotals, quoteTotals: quoteTotals };
});

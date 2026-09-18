/**
 * Nexora API — the costing engine, server side
 * ----------------------------------------------------------------------
 * These are the SAME modules the app has always used, byte for byte —
 * `bomEngine`, `bomReconcile`, `stageBasis`. They were written as pure
 * functions with no DOM and no storage (project rule #32), which is the
 * only reason this file can exist at all: the engine lifts onto the
 * server unchanged, so a route costed here and a route costed in the old
 * local build produce identical numbers.
 *
 * WHAT CROSSES THE WIRE
 * The engine takes FUNCTIONS — rateOf(code), procName(code) and so on —
 * and functions cannot travel as JSON. So the client sends its master
 * data as plain lookup tables and this file rebuilds the closures around
 * them:
 *
 *     client  →  { rates: {...}, names: {...}, procRates: {...}, … }
 *                 the plant's OWN data, which it already has
 *     server  →  the formulas, which it does not
 *
 * That split is the whole point. Prices, materials and routes belong to
 * the customer and stay on their machine. The arithmetic that turns them
 * into a cost per bag belongs to Nexora and never leaves this process.
 */
import BomEngine from '../vendor/bomEngine.js';
import BomReconcile from '../vendor/bomReconcile.js';
import StageBasis from '../vendor/stageBasis.js';

function table(obj) {
  const t = (obj && typeof obj === 'object') ? obj : {};
  return (code) => (Object.prototype.hasOwnProperty.call(t, code) ? t[code] : null);
}
function tableOr(obj, fallback) {
  const t = (obj && typeof obj === 'object') ? obj : {};
  return (code) => (Object.prototype.hasOwnProperty.call(t, code) ? t[code] : fallback(code));
}

/**
 * @param payload {
 *   bags, bagWeightG, basis, orderBags, steps, sections, qtyRounding,
 *   masters: { rates, names, uoms, procRates, procNames, procResources, groups,
 *              procProduces },
 *   view:      { mode:'EACH'|'FINAL', value }        optional
 *   components: [{name, qtyPerBagKg, lenPerBagM}]    optional, for reconcile
 * }
 */
export function runBom(payload) {
  const p = payload || {};
  const m = p.masters || {};

  const rateOf = table(m.rates);
  const nameOf = tableOr(m.names, (c) => c);
  const uomOf = tableOr(m.uoms, () => 'KG');
  const procRate = tableOr(m.procRates, () => 0);
  const procName = tableOr(m.procNames, (c) => c);
  const groupOf = tableOr(m.groups, () => '');
  /* 4.36.0 — what each process turns out. The reconciliation needs it to
     report the running metres of web the plant MAKES; without it there is
     simply no web line, which is what an older client that does not send
     this will get. */
  const producesOf = tableOr(m.procProduces, () => '');
  const procResources = (m.procResources && typeof m.procResources === 'object')
    ? (code) => (Object.prototype.hasOwnProperty.call(m.procResources, code) ? m.procResources[code] : null)
    : undefined;

  const opts = {
    bags: p.bags, bagWeightG: p.bagWeightG, basis: p.basis, orderBags: p.orderBags,
    steps: p.steps, sections: p.sections,
    rateOf, nameOf, uomOf, procRate, procName
  };
  if (procResources) opts.procResources = procResources;
  if (p.qtyRounding !== undefined && p.qtyRounding !== null) opts.qtyRounding = p.qtyRounding;

  const result = BomEngine.build(opts);

  let view = null;
  if (result && result.ok && p.view && p.view.mode) {
    view = StageBasis.apply({ result, view: p.view });
  }

  let reconcile = null;
  if (result && result.ok) {
    reconcile = BomReconcile.build({
      result, groupOf, nameOf, producesOf,
      components: Array.isArray(p.components) ? p.components : [],
      /* The bag count the reconciliation reports against is the one the
         ROLL-UP actually costed — result.totals.bags — not the order
         quantity that was sent in.

         These are the same number on the ORDER basis, which is why the
         local-vs-server equivalence check passed: it only ever exercised
         that basis. On any other basis (a typed bag count, or finished
         kilograms) they diverge, and the costed card then showed the
         right TOTAL divided by the wrong bag count. Reported from a live
         screen: header Rs 9.334/bag over 18,378 basis bags, costed card
         Rs 1.715 over the 100,000-bag order. */
      bags: result.totals.bags
    });
  }

  return { result, view, reconcile };
}

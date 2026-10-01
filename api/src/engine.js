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

/* ---- 4.71.0 (audit, C2) — THE RATE THE CLIENT COULD NOT SEND -----------
   A person who may not see costs is sent the price master EMPTY (sync.js
   pull), so their computer has no rate to put in masters.rates — yet their
   BOM must still cost exactly as anybody else's. The service fills each
   missing rate from the company's OWN stored price master, by the rule
   the desktop itself uses. */
function todayIso() { return new Date().toISOString().slice(0, 10); }
/** app/src/storage/rmStore.js priceOn(), line for line: the price in force
 *  on a date is the highest version whose effectiveFrom is on or before it
 *  (a version dated in the future is stored but not yet in force); null
 *  when the material has never been priced. `book` is the stored
 *  nexora.rm.price.v1 body: { [code]: [{ version, rate, effectiveFrom }] }. */
export function priceOnFrom(book, code, asOf) {
  const when = asOf || todayIso();
  const all = (book && typeof book === 'object') ? book : {};
  const h = Object.prototype.hasOwnProperty.call(all, code) ? all[code] : null;
  const list = (Array.isArray(h) ? h : []).filter((p) => p && p.effectiveFrom <= when);
  if (!list.length) return null;
  return list.reduce((best, p) => (p.version > best.version ? p : best), list[0]);
}
/** rmStore.js currentRate(): the rate in force today, or null. */
export function currentRateFrom(book, code) {
  const p = priceOnFrom(book, code);
  return p ? p.rate : null;
}
/** The material codes this costing will ask a rate for that the payload
 *  has none for (absent, or null). Empty: nothing for the service to fill,
 *  and the price master is not even read. */
export function missingRates(payload) {
  const p = payload || {};
  const m = p.masters || {};
  const rates = (m.rates && typeof m.rates === 'object') ? m.rates : {};
  const has = (c) => Object.prototype.hasOwnProperty.call(rates, c) && rates[c] !== null && rates[c] !== undefined;
  const out = {};
  Object.keys(rates).forEach((c) => { if (!has(c)) out[c] = true; });
  const secs = p.sections;
  const list = Array.isArray(secs) ? secs : (secs && typeof secs === 'object' ? Object.keys(secs).map((k) => secs[k]) : []);
  list.forEach((s) => (s && Array.isArray(s.lines) ? s.lines : []).forEach((l) => {
    if (l && l.rm && l.src !== 'SFG' && !has(l.rm)) out[String(l.rm)] = true;
  }));
  (Array.isArray(p.steps) ? p.steps : []).forEach((st) => { if (st && st.rm && !has(st.rm)) out[String(st.rm)] = true; });
  return Object.keys(out);
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
export function runBom(payload, priceBook, how) {
  const p = payload || {};
  const m = p.masters || {};

  /* 4.71.0 — a rate the payload carries is used as it always was; one it
     lacks comes from the company's stored price master when the caller
     passed it (index.js, /v1/bom). Each code so filled is remembered, so a
     caller who may not see prices is not handed them back (hideFilledRates). */
  const sent = table(m.rates);
  const rates = (m.rates && typeof m.rates === 'object') ? m.rates : {};
  const filled = {};
  const rateOf = priceBook
    ? (code) => {
        if (Object.prototype.hasOwnProperty.call(rates, code) && rates[code] !== null && rates[code] !== undefined) return rates[code];
        const r = currentRateFrom(priceBook, code);
        if (r !== null && r !== undefined) filled[code] = true;
        return r;
      }
    : sent;
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

  const out = { result, view, reconcile };
  if (how && how.hideFilled && Object.keys(filled).length) hideFilledRates(out, filled);
  return out;
}

/** 4.71.0 (audit) — "prices to VIEW_COST only". The engine writes the rate
 *  it costed each line with into the answer (l.rate, l.masterRate, a bought-in
 *  stage's buyRate, the reconciliation's materials[].rate) — so a BOM sent
 *  with its rates left empty would hand the company's whole price list back
 *  to a person who is not allowed to see it, one line per material. Every
 *  rate that came from the stored price master is taken out again (null,
 *  with rateHidden: true so a screen can say "hidden" rather than "no
 *  price"); a rate the caller sent, or typed onto the row, is theirs and
 *  stays. The COSTS stay: the BOM must cost as anybody else's (C2), and the
 *  desktop shows no money to such a person anyway.
 *  KNOWN LIMIT (raised for the owner in the 4.71.0 review): a line's cost ÷ its kg is still its rate
 *  — hiding that would mean not costing the BOM at all. */
function hideFilledRates(out, filled) {
  const isFilled = (c) => c !== null && c !== undefined && Object.prototype.hasOwnProperty.call(filled, c);
  const stageLists = [];
  if (out.result && Array.isArray(out.result.stages)) stageLists.push(out.result.stages);
  if (out.view && Array.isArray(out.view.stages)) stageLists.push(out.view.stages);   /* the EACH/FINAL view copies the lines */
  stageLists.forEach((list) => list.forEach((s) => {
    if (!s) return;
    if (s.sourcing === 'BUY' && isFilled(s.buyRm)) { s.buyRate = null; s.rateHidden = true; }
    (Array.isArray(s.lines) ? s.lines : []).forEach((l) => {
      if (!l || l.src === 'SFG' || !isFilled(l.rm)) return;
      l.masterRate = null;
      if (l.rateSource === 'master') l.rate = null;
      l.rateHidden = true;
    });
  }));
  if (out.reconcile && Array.isArray(out.reconcile.materials)) {
    out.reconcile.materials.forEach((mt) => { if (mt && isFilled(mt.code)) { mt.rate = null; mt.rateHidden = true; } });
  }
  if (out.result && typeof out.result === 'object') out.result.ratesHidden = true;
}

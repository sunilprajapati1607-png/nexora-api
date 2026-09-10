/**
 * Nexora — Stage view basis: the same BOM, shown per stage
 * ----------------------------------------------------------------------
 * "BOM is based on 1000 kg / bags / order bags. Every stage should be
 *  treated as an option: every stage as 1000 kg, or every stage as per the
 *  final BOM quantity. Say the BOM on final quantity will produce tape
 *  700 kg, then fabric 675 kg after waste, then the third stage adds
 *  fabric + RM + BOPP so it reaches 1050 kg, and the last stage gives
 *  1000 kg. In the second scenario the user chooses 1000 kg for every
 *  stage. But this will not affect our per-kg cost, per-bag cost and
 *  per-order cost."
 *
 * TWO WAYS TO READ ONE BOM
 *
 *   FINAL (cascade)   what the ORDER needs. Quantities walk back from the
 *                     finished bags, so each stage makes exactly what the
 *                     stage after it takes — 700 → 675 → 1050 → 1000.
 *                     This is what you buy against.
 *
 *   EACH (per stage)  what ONE RUN of each stage needs. Every stage is
 *                     shown for the same output quantity — 1000 kg of tape,
 *                     1000 kg of fabric, 1000 kg of laminate — which is the
 *                     standard-BOM form: comparable between stages, and the
 *                     sheet you hand to a machine.
 *
 * WHY THE COSTS CANNOT MOVE
 * This module **recomputes nothing**. It takes the roll-up the BOM engine
 * already produced and multiplies one stage's quantities by
 *
 *     factor = the quantity you want to see  ÷  what that stage makes
 *
 * Every quantity and every cost on that stage carries the same factor, so
 * cost per kilogram — cost ÷ kilograms — is mathematically unchanged. Cost
 * per bag and cost for the order are not touched at all: they stay with the
 * cascade, because they are properties of the ORDER, and an order does not
 * change because you chose to read its sheet differently.
 *
 * That is the guarantee the user asked for, and it is a guarantee rather
 * than a hope: it falls out of scaling one stage by one number.
 *
 * THE ONE THING WORTH SAYING OUT LOUD
 * A line entered as ABS ("kg, fixed" — a flat quantity for the whole
 * order) is pro-rated in the EACH view like everything else. It has to be:
 * a sheet claiming to describe a 1000 kg run must show what a 1000 kg run
 * consumes, and a fixed order quantity contributes its share of that. Such
 * lines are listed in `prorated` so the screen can say so rather than let
 * somebody discover it.
 *
 * Pure and synchronous — no DOM, no storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexoraStageBasis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) { const x = Number(v); return isFinite(x) ? x : 0; }

  var MODES = { FINAL: 'FINAL', EACH: 'EACH' };
  var DEFAULT_EACH_KG = 1000;

  /** What the user chose, cleaned up. An absent or unusable choice is the
   *  cascade — the view every version before this one had. */
  function resolve(view) {
    if (!view || view.mode !== MODES.EACH) {
      return { mode: MODES.FINAL, value: 0, label: 'The final quantity — what the order needs', auto: true };
    }
    var v = num(view.value) > 0 ? num(view.value) : DEFAULT_EACH_KG;
    return { mode: MODES.EACH, value: v, label: 'Every stage for ' + v + ' kg of its own output', auto: false };
  }

  /**
   * @param {object} opts
   *   result   the BOM engine's build() result (must be ok)
   *   view     {mode:'FINAL'|'EACH', value:<kg>}
   *
   * @returns {object}
   *   mode, value, label
   *   stages   [{index, factor, outputKg, grossKg, wasteKg, inputKg,
   *             materialCost, processCost, inputCost, outputCost,
   *             costPerKg, lines[], resourceCosts[]}]
   *   prorated [{stage, line}]   ABS lines shown as their share
   *   skipped  [{stage, why}]    a stage that makes nothing cannot be scaled
   *   invariant {costPerKgUnchanged:boolean, worst:number}
   */
  function apply(opts) {
    var result = opts && opts.result;
    var view = resolve(opts && opts.view);

    if (!result || !result.ok) {
      return { ok: false, mode: view.mode, value: view.value, label: view.label,
        stages: [], prorated: [], skipped: [], invariant: { costPerKgUnchanged: true, worst: 0 } };
    }

    var prorated = [], skipped = [];
    var worst = 0;

    var stages = result.stages.map(function (s) {
      /* The cascade is the source of truth, so FINAL is a straight copy
         with a factor of exactly 1 — the same code path, no special case
         that could drift from it. */
      var factor = 1;
      if (view.mode === MODES.EACH && !s.beforeWall) {
        if (!(num(s.outputKg) > 0)) {
          skipped.push({ stage: s.index, processName: s.processName,
            why: 'this stage makes nothing, so there is no run to show 1,000 kg of' });
        } else {
          factor = view.value / num(s.outputKg);
        }
      }

      var lines = (s.lines || []).map(function (l) {
        if (view.mode === MODES.EACH && factor !== 1 && l.basis === 'ABS' && !l.invalid) {
          prorated.push({ stage: s.index, processName: s.processName, name: l.name });
        }
        return Object.assign({}, l, { kg: num(l.kg) * factor, cost: num(l.cost) * factor });
      });
      var resourceCosts = s.resourceCosts
        ? s.resourceCosts.map(function (r) { return Object.assign({}, r, { cost: num(r.cost) * factor }); })
        : s.resourceCosts;

      var out = Object.assign({}, s, {
        factor: factor,
        outputKg: num(s.outputKg) * factor,
        grossKg: num(s.grossKg) * factor,
        wasteKg: num(s.wasteKg) * factor,
        inputKg: num(s.inputKg) * factor,
        purchasedKg: num(s.purchasedKg) * factor,
        addedKg: num(s.addedKg) * factor,
        materialCost: num(s.materialCost) * factor,
        processCost: num(s.processCost) * factor,
        inputCost: num(s.inputCost) * factor,
        outputCost: num(s.outputCost) * factor,
        wasteValue: num(s.wasteValue) * factor,
        lines: lines,
        resourceCosts: resourceCosts,
        inputFrom: (s.inputFrom || []).map(function (f) {
          return Object.assign({}, f, { kg: num(f.kg) * factor });
        })
      });
      /* Cost per kilogram is the invariant this whole feature rests on, so
         it is RE-DERIVED from the scaled figures rather than copied. If
         scaling ever broke it, this would show it rather than hide it. */
      out.costPerKg = out.outputKg > 0 ? out.outputCost / out.outputKg : 0;
      out.ratePerKg = out.grossKg > 0 ? out.processCost / out.grossKg : num(s.ratePerKg);
      var drift = Math.abs(out.costPerKg - num(s.costPerKg));
      if (drift > worst) worst = drift;
      return out;
    });

    return {
      ok: true,
      mode: view.mode,
      value: view.value,
      label: view.label,
      stages: stages,
      prorated: prorated,
      skipped: skipped,
      /* The order's own figures never move — they belong to the cascade,
         and are passed through untouched so a screen showing the per-stage
         view still reports the true cost per bag and cost for the order. */
      totals: result.totals,
      invariant: { costPerKgUnchanged: worst < 0.000001, worst: worst }
    };
  }

  return { apply: apply, resolve: resolve, MODES: MODES, DEFAULT_EACH_KG: DEFAULT_EACH_KG };
});

/**
 * Nexora — BOM reconciliation: one costed list, matching the roll-up
 * ----------------------------------------------------------------------
 * The defect this fixes, in the user's words: "both cost are different —
 * that should not happen… both last section cost and this window cost
 * should match."
 *
 * WHY THEY DIFFERED
 * The two tables answered the same question with different arithmetic:
 *
 *   route roll-up   quantities walk BACK from the order, and every stage's
 *                   waste compounds — fabric for a laminating line that
 *                   loses 3% must itself be 3% more than the bag needs.
 *   per-line table  took the bag's own component weights and applied ONE
 *                   stage's waste to them.
 *
 * On a real route that is a 1.3% gap, and no amount of rate-fiddling
 * closes it, because the kilograms themselves disagree. Two independent
 * computations of the same number will always drift.
 *
 * So this module does not compute anything twice. It READS the roll-up
 * the BOM engine already produced and presents it as a procurement list:
 * every material with the kilograms and cost the roll-up actually used,
 * every stage's conversion cost, and a total that equals the roll-up's
 * total BY CONSTRUCTION rather than by luck.
 *
 * WHAT A LINE IS WORTH
 * A material line is worth what it was bought for — its own rate, never a
 * cumulative stage cost. The user put it exactly right: "body coating cost
 * should be minus weaving fabric cost". Coating is what LAMINATION adds;
 * the fabric it is laid onto belongs to weaving and is already counted
 * there. Adding a stage's cumulative cost to a material line double-counts
 * everything upstream of it.
 *
 *   total = Σ material lines (own rate)  +  Σ conversion per stage
 *         = the roll-up's total
 *
 * WHAT THE BAG NEEDS BUT NO STAGE ADDS
 * The calculation knows a bag contains yarn; the route only costs what a
 * stage actually consumes. If no stage adds yarn, the honest answer is not
 * to invent a cost — it is to say so: "yarn is in every bag but no process
 * adds it." That is the message, not a number.
 *
 * Pure and synchronous — no DOM, no storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexoraBomReconcile = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) { const x = Number(v); return isFinite(x) ? x : 0; }
  function fmtN(v, d) { return Number(v).toFixed(d === undefined ? 2 : d); }

  /* A bag component the weight calculation knows about, and the material
     group that would supply it. Used only to ASK whether some stage adds
     it — never to price anything. */
  /* `web: true` marks a component that is bought and issued by LENGTH as
     well as by weight — film, fabric, tape, liner. Those are the only rows
     that can honestly carry a metres figure; granules and yarn are weight
     only, and are left blank rather than given an invented length. */
  var COMPONENT_GROUPS = [
    { re: /fabric \(ul\)/i, groups: ['GRANULE', 'MASTERBATCH', 'ADDITIVE'], sfgOk: true },
    { re: /coating/i, groups: ['GRANULE', 'MASTERBATCH', 'ADDITIVE'] },
    { re: /bopp film/i, groups: ['BOPP FILM'], web: true },
    { re: /metallised film/i, groups: ['METALLISED FILM'], web: true },
    { re: /^ink$/i, groups: ['INK'] },
    { re: /^adhesive$/i, groups: ['ADHESIVE'] },
    { re: /handle/i, groups: ['HANDLE'] },
    { re: /yarn|thread/i, groups: ['YARN'] },
    { re: /liner/i, groups: ['LINER'], web: true },
    { re: /backseam granules/i, groups: ['PASTING GRANULE'] },
    { re: /creep tape|pull tape/i, groups: ['TAPE'], web: true },
    { re: /fabric/i, groups: ['FABRIC', 'WOVEN FABRIC'], web: true, sfgOk: true }
  ];

  /**
   * @param {object} opts
   *   result       the BOM engine's build() result (must be ok)
   *   groupOf(rm)  → the material's group/category
   *   nameOf(rm)   → display name
   *   components   [{name, qtyPerBagKg, lenPerBagM}] from the calculation,
   *                used ONLY to report what nothing costs and to carry
   *                running metres through for procurement
   *   bags         the bag count the BOM is costed for
   *
   * @returns {object}
   *   materials [{code, name, kg, cost, rate, stages[], metres, metresPerKg}]
   *   conversion [{stage, processName, kg, ratePerKg, cost}]
   *   totals {material, process, total, perBag}
   *   missing [{name, gramsPerBag, groups[]}]   in the bag, costed by nothing
   *   check {routeTotal, listedTotal, diff, matches}
   */
  function build(opts) {
    var result = opts && opts.result;
    var groupOf = (opts && opts.groupOf) || function () { return ''; };
    var nameOf = (opts && opts.nameOf) || function (c) { return c; };
    var components = (opts && opts.components) || [];
    var bags = num(opts && opts.bags);

    if (!result || !result.ok) {
      return { ok: false, reason: 'The route BOM has not costed successfully, so there is nothing to reconcile.',
        materials: [], conversion: [], totals: { material: 0, process: 0, total: 0, perBag: 0 },
        missing: [], check: { routeTotal: 0, listedTotal: 0, diff: 0, matches: false } };
    }

    /* ---- 1. every material the route actually consumes ---------------
       A material used at two stages is ONE procurement line: you buy it
       once. Its stages are listed so the line stays traceable. */
    var byCode = {};
    var order = [];
    result.stages.forEach(function (s) {
      if (s.beforeWall) return;
      // A bought-in stage is a purchase in its own right.
      if (s.sourcing === 'BUY') {
        if (!s.buyRm) return;
        var bk = s.buyRm;
        if (!byCode[bk]) { byCode[bk] = { code: bk, name: nameOf(bk), kg: 0, cost: 0, stages: [], bought: true }; order.push(bk); }
        byCode[bk].kg += num(s.purchasedKg);
        byCode[bk].cost += num(s.materialCost);
        byCode[bk].stages.push(s.processName);
        return;
      }
      (s.lines || []).forEach(function (l) {
        if (l.invalid || l.src === 'SFG' || !l.rm) return;   // SFG is not bought — it is made upstream
        var k = l.rm;
        if (!byCode[k]) { byCode[k] = { code: k, name: nameOf(k), kg: 0, cost: 0, stages: [] }; order.push(k); }
        byCode[k].kg += num(l.kg);
        byCode[k].cost += num(l.cost);
        if (byCode[k].stages.indexOf(s.processName) < 0) byCode[k].stages.push(s.processName);
      });
    });
    var materials = order.map(function (k) {
      var m = byCode[k];
      m.rate = m.kg > 0 ? m.cost / m.kg : 0;      // its OWN rate, never a stage's cumulative cost
      m.group = groupOf(k);
      return m;
    });

    /* ---- 1b. running metres, where the material IS a running web ------
       "add metre in this table where applicable."

       Film, fabric, tape and liner are bought and issued by LENGTH as well
       as by weight, and the weight calculation already knows how many
       metres of each go into one bag. Granules and yarn are not — they are
       bought by weight only — so they get no metres rather than a made-up
       number.

       The arithmetic is a proportion, not a new formula: the components a
       material supplies need `lenPerBag` metres and `kgPerBag` kilograms
       per bag, and the route is buying `m.kg` kilograms. Metres are in the
       same ratio as the kilograms:

           metres = Σ lenPerBag × ( m.kg ÷ Σ kgPerBag )

       So a material grossed 7% by compounding waste carries 7% more
       metres, automatically and for the same stated reason. */
    var lengthGroups = {};
    COMPONENT_GROUPS.forEach(function (r) {
      if (!r.web) return;
      r.groups.forEach(function (g) { lengthGroups[g] = lengthGroups[g] || []; lengthGroups[g].push(r); });
    });
    materials.forEach(function (m) {
      var rules = lengthGroups[String(m.group || '').toUpperCase()];
      if (!rules || !rules.length) return;                  // not a running web — no metres, by design
      var len = 0, kg = 0;
      components.forEach(function (c) {
        var hit = rules.some(function (r) { return r.re.test(c.name); });
        if (!hit) return;
        len += num(c.lenPerBagM);
        kg += num(c.qtyPerBagKg);
      });
      if (!(len > 0) || !(kg > 0)) return;                  // the calculation has no length for it
      m.metresPerKg = len / kg;
      m.metres = m.kg * m.metresPerKg;
      m.metreBasis = fmtN(len) + ' m per bag over ' + fmtN(kg, 4) + ' kg per bag';
    });

    /* ---- 2. conversion, stage by stage ------------------------------ */
    var conversion = result.stages.filter(function (s) {
      return !s.beforeWall && s.sourcing !== 'BUY' && num(s.processCost) !== 0;
    }).map(function (s) {
      return { stage: s.index, process: s.process, processName: s.processName, kg: num(s.grossKg),
        ratePerKg: num(s.ratePerKg), cost: num(s.processCost),
        resources: (s.resourceCosts || []).map(function (r) { return r.name; }) };
    });

    var matTotal = materials.reduce(function (t, m) { return t + m.cost; }, 0);
    var procTotal = conversion.reduce(function (t, c) { return t + c.cost; }, 0);
    var listed = matTotal + procTotal;
    var routeTotal = num(result.totals && result.totals.totalCost);
    var residuals = attribute(result);

    /* ---- 3. what the bag contains that nothing costs ----------------
       Only components with real weight, and only when NO stage consumes a
       material of a group that could supply them. */
    var groupsUsed = {};
    materials.forEach(function (m) { if (m.group) groupsUsed[String(m.group).toUpperCase()] = true; });
    var hasSfg = result.stages.some(function (s) {
      return !s.beforeWall && (s.lines || []).some(function (l) { return l.src === 'SFG' && !l.invalid; });
    });

    var missing = [];
    components.forEach(function (c) {
      var g = num(c.qtyPerBagKg) * 1000;                  // grams per bag
      if (!(g > 0.0001)) return;
      var rule = null;
      for (var i = 0; i < COMPONENT_GROUPS.length; i++) {
        if (COMPONENT_GROUPS[i].re.test(c.name)) { rule = COMPONENT_GROUPS[i]; break; }
      }
      if (!rule) return;                                   // not something we can place — say nothing
      if (rule.sfgOk && hasSfg) return;                    // fabric arrives as an earlier stage's output
      var covered = rule.groups.some(function (x) { return groupsUsed[x]; });
      if (!covered) {
        missing.push({ name: c.name, gramsPerBag: g, kgForOrder: (g * bags) / 1000, groups: rule.groups });
      }
    });

    return {
      ok: true,
      materials: materials,
      conversion: conversion,
      totals: {
        material: matTotal, process: procTotal, total: listed,
        perBag: bags > 0 ? listed / bags : 0
      },
      missing: missing,
      /* The list is built FROM the roll-up, so this is a self-check that
         the reading is complete — not an independent calculation. A
         difference means a stage's cost is not represented here, which is
         a defect in this module, and it says so rather than hiding it. */
      check: {
        routeTotal: routeTotal,
        listedTotal: listed,
        diff: listed - routeTotal,
        matches: Math.abs(listed - routeTotal) < 0.01,
        /* When they DON'T agree, say which stage and why — a bare
           difference is not something a costing clerk can act on. */
        residuals: residuals.filter(function (r) { return Math.abs(r.residual) >= 0.005; })
      }
    };
  }

  /* ------------------------------------------------------------------
     WHERE A DIFFERENCE COMES FROM

     The roll-up's total is the LAST stage's output cost, and every earlier
     stage reaches it by being consumed — implicitly (the stage before me)
     or explicitly (an "earlier stage" row naming it). So:

         listed − roll-up  =  Σ ( what a stage cost − what was claimed of it )

     which is an identity, not an estimate. A stage that is fully consumed
     contributes nothing. A stage that is NOT contributes exactly its own
     shortfall, and that is the figure to report, against its name.

     Three things leave a stage under-claimed, and they need different
     answers, so they are told apart rather than lumped together:
       ORPHAN    nothing downstream draws from it at all
       PARTIAL   less of its output is drawn than it makes
       OVERRIDE  a rate is typed onto the row that draws it, so the row
                 pays a different price than the stage actually cost
     And one leaves it over-claimed:
       OVERDRAWN more is drawn from it than it makes — usually a stage
                 taken both implicitly and by name.
  ------------------------------------------------------------------ */
  function attribute(result) {
    var stages = result.stages || [];
    var claimCost = [], claimKg = [], byOverride = [], claimants = [];
    stages.forEach(function () { claimCost.push(0); claimKg.push(0); byOverride.push(null); claimants.push([]); });

    var prevIdx = -1;
    stages.forEach(function (s, i) {
      if (s.beforeWall) return;
      if (s.sourcing === 'BUY') { prevIdx = i; return; }   // buys nothing from upstream
      if (s.explicitInput) {
        (s.lines || []).forEach(function (l) {
          if (l.invalid || l.src !== 'SFG') return;
          var j = l.sfgStep;
          if (!(j >= 0 && j < stages.length)) return;
          claimCost[j] += num(l.cost);
          claimKg[j] += num(l.kg);
          claimants[j].push({ by: s.processName, kg: num(l.kg), cost: num(l.cost), explicit: true });
          if (l.rateSource === 'override') {
            byOverride[j] = { by: s.processName, typed: num(l.rate), kg: num(l.kg) };
          }
        });
      } else if (prevIdx > -1 && num(s.inputCost) !== 0) {
        claimCost[prevIdx] += num(s.inputCost);
        claimKg[prevIdx] += num(s.inputKg);
        claimants[prevIdx].push({ by: s.processName, kg: num(s.inputKg), cost: num(s.inputCost), explicit: false });
      }
      prevIdx = i;
    });

    var lastCostedIdx = -1;
    stages.forEach(function (s, i) { if (!s.beforeWall) lastCostedIdx = i; });

    var out = [];
    stages.forEach(function (s, i) {
      if (s.beforeWall || i === lastCostedIdx) return;
      var made = num(s.outputCost);
      var taken = claimCost[i];
      var residual = made - taken;
      var kind, why;
      var made_kg = num(s.outputKg), took_kg = claimKg[i];
      /* The cause is decided before the sign: a typed rate can leave a step
         under-paid or over-paid, and either way the row to correct is the
         same one. Only then does the sign decide the wording. */
      var byPosition = claimants[i].filter(function (c) { return !c.explicit && c.kg < 0.05; })[0];
      var byName = claimants[i].filter(function (c) { return c.explicit && c.kg > 0.05; })[0];

      if (!(made_kg > 0.0001)) {
        kind = 'ORPHAN';
        why = 'no later step takes its output, so everything it costs stops here. '
            + 'Point the step that should consume it at this stage, or remove it from the route.';
      } else if (byPosition && byName) {
        kind = 'BYPASSED';
        why = byPosition.by + ' takes this step\'s whole cost simply because it comes next in the route, '
            + 'while drawing no material from it \u2014 and ' + byName.by + ' draws ' + fmtN(byName.kg)
            + ' kg from it by name. Add an "Earlier stage" row to ' + byPosition.by
            + ' naming the step it really works on.';
      } else if (byOverride[i] && took_kg >= made_kg - 0.05) {
        kind = 'OVERRIDE';
        why = byOverride[i].by + ' draws it at a typed rate of ' + fmtN(byOverride[i].typed, 3)
            + ' / kg, while this step actually costs ' + fmtN(num(s.costPerKg), 3)
            + ' / kg. Clear the typed rate on that row to let it follow the stage.';
      } else if (took_kg < made_kg - 0.05) {
        kind = 'PARTIAL';
        why = 'it makes ' + fmtN(made_kg) + ' kg but only ' + fmtN(took_kg)
            + ' kg is drawn forward, so the cost of the rest stops here.';
      } else if (took_kg > made_kg + 0.05) {
        kind = 'OVERDRAWN';
        why = 'it makes ' + fmtN(made_kg) + ' kg but ' + fmtN(took_kg)
            + ' kg is drawn from it, so its cost is carried forward more than once. '
            + 'A step is most likely taking it both by name and by position.';
      } else if (residual > 0) {
        kind = 'UNCLAIMED';
        why = 'part of what it costs is not drawn forward by any later step.';
      } else {
        kind = 'DOUBLE';
        why = 'its cost is carried forward more than once \u2014 by '
            + claimants[i].map(function (c) { return c.by; }).join(' and ') + '.';
      }
      out.push({
        stage: i + 1, processName: s.processName,
        outputCost: made, claimedCost: taken, residual: residual,
        outputKg: num(s.outputKg), claimedKg: claimKg[i],
        kind: kind, why: why
      });
    });
    return out;
  }

  return { build: build, COMPONENT_GROUPS: COMPONENT_GROUPS };
});

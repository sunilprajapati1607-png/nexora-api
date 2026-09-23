/**
 * Nexora — Route BOM & cost roll-up engine
 * ----------------------------------------------------------------------
 * Turns a route into a costed, section-wise BOM.
 *
 * The rule the user stated: "tape is cost, but fabric is created from tape,
 * so fabric cost will be tape + fabric making process cost." That is a
 * roll-up along the route — each stage carries the cost of everything that
 * came before it, plus what it adds itself.
 *
 *   stage cost = cost of the input stage
 *              + raw material added at this stage
 *              + this stage's own process (resource) cost
 *
 * Quantities run BACKWARDS from the order, cost runs FORWARDS to the bag:
 *
 *      order (bags × bag weight)          ← known
 *        ↑ divided up by waste, stage by stage
 *      granules at the very start
 *        ↓ priced, then each stage adds its own material + resources
 *      cost per bag
 *
 * Five bases for a line, because not everything is a share of mass:
 *   PCT       — % of this stage's gross quantity (granules, coating, film)
 *   PER1000   — kg per 1000 bags (yarn, handle, liner, zipper — per-piece
 *               items whose consumption follows bag count, not weight)
 *   PERBAG_G  — grams per bag, taken straight from the weight calculation.
 *               This is what links the two engines: the calculation already
 *               knows the body base-fabric, coating, BOPP, metallised, patch,
 *               valve, yarn, liner and tape weights per bag, so the BOM can
 *               use them instead of anyone re-typing a percentage.
 *   PART_G    — grams per bag of a NAMED figure from the calculation
 *               (partWeights.js: a part’s fabric, coating, BOPP
 *               component, whole part…), grossed by this stage’s waste,
 *               so the stage is issued what it must be FED rather than
 *               what comes out the far end. Added 4.53.0.
 *   ABS       — an absolute kg figure for the whole order.
 *
 * A line's material is either a raw material (src RM) or the OUTPUT OF AN
 * EARLIER STAGE (src SFG). Choosing "tape" inside weaving is an SFG line:
 * its rate is not a purchase price, it is the cost per kg tape came out at,
 * which is how the roll-up is made visible rather than implicit. A stage
 * with no SFG line still takes its input from the stage before it, exactly
 * as it did before, so nothing built on the old shape changes.
 *
 * Any line may carry a rate OVERRIDE — a price typed for this order that
 * beats the RM price master, for a spot purchase or a quote.
 *
 * WASTE, INCLUDING LAMINATION LUMS, IS A LOSS — NEVER A CREDIT.
 * Confirmed by the user: lums are part of lamination waste and are taken
 * at zero cost recovery. So nothing is credited back into the mix. The
 * material that becomes waste still entered the machine, so it is still
 * paid for; the good output simply has to carry it. That falls out of the
 * arithmetic already — the whole gross is costed, and only the output is
 * divided into — but the money lost that way is now reported per stage and
 * for the order, because a figure that only exists implicitly is a figure
 * nobody acts on.
 *
 *   waste value = stage output cost × (waste kg ÷ gross kg)
 *
 * A stage marked BUY is bought in rather than made. It is a wall in the
 * roll-up: it has no input stage and no process cost, because the price
 * paid already contains both. Stages upstream of it are reported as
 * "not costed — bought in at <stage>" rather than silently dropped.
 *
 * CALCULATION BASIS (0.11.0)
 * Everything above is worked out for a NUMBER OF BAGS. That number normally
 * comes from the calculation's own order quantity, but a costing is often
 * wanted on a standard basis instead — "per 1000 bags", "per 1000 kg" — so
 * two quotations can be compared without doing arithmetic in your head.
 *
 * The basis is therefore an INPUT the engine carries and reports, not a
 * number the UI works out and passes silently:
 *
 *   ORDER  bags = the calculation's bag quantity          ← default, automatic
 *   BAGS   bags = the value typed
 *   KG     bags = value × 1000 ÷ bag weight (g)           ← finished kilograms
 *
 * `totals.basis` comes back carrying the mode, the value, the resolved bag
 * count and finished kg, and two plain sentences saying WHERE the figure
 * came from and HOW it was worked out — so the screen can show its
 * provenance instead of an unexplained number.
 *
 * Omitting `basis` entirely behaves exactly as before: the order quantity
 * is used. Cost per bag and cost per kg are unaffected by the basis (the
 * whole roll-up scales linearly), which is itself a useful check.
 *
 * RESOURCE BASES (0.16.0)
 * Not every conversion cost is per kilogram. Manpower on a bag machine is
 * paid by the bag, a packing crew by the thousand bags, an extruder's
 * power by the kilogram. Charging all three per kg forces a hand
 * conversion that changes with every bag weight.
 *
 *   KG       cost × the kilograms passing through the stage (its GROSS,
 *            because resources are consumed on the waste too)
 *   BAG      cost × the number of bags the BOM is costed for
 *   PER1000  cost × (bags ÷ 1000)
 *
 * A resource with no basis is read as KG, so nothing built before this
 * changes. `stage.ratePerKg` is still reported and is now the EFFECTIVE
 * per-kg rate (processCost ÷ gross), so a bag-based resource still shows
 * up in every per-kg figure the screen already displays.
 *
 * Pure and synchronous — no DOM, no storage. Same result in the browser,
 * in Electron and in a future Android build.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexoraBomEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) { const x = Number(v); return isFinite(x) ? x : 0; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  /* The workbook rounds every issued quantity to 0.1 and every per-1000
     figure to 0.01 — mirrored here rather than rounding to whole units. */
  function mround(v, step) { return Math.round(v / step) * step; }

  /**
   * @param {object} opts
   *   steps        [{p, src, rm}]            the route, already normalised
   *   sections     { "<i>|<code>": {wastePct, lines:[{rm, basis, value}]} }
   *   bags         order quantity in bags
   *   bagWeightG   net bag weight in grams (from the calculation engine)
   *   rateOf(code) → number|null             current RM rate, null if unpriced
   *   nameOf(code) → string                  RM display name
   *   uomOf(code)  → string
   *   procRate(code) → number                process resource cost per kg
   *   procName(code) → string
   *   qtyRounding  the step every issued quantity is rounded to, in kg.
   *                Defaults to 0.1 — the workbook's own step, and what
   *                every version before 1.0.0 hard-coded. It comes from
   *                the Constants Master now ("BOM ISSUE QUANTITY
   *                ROUNDING") so a plant that issues in whole kilograms,
   *                or to 0.001, can say so.
   */
  function build(opts) {
    const steps = (opts.steps || []).slice();
    const sections = opts.sections || {};
    const orderBags = num(opts.bags);
    const bagWeightG = num(opts.bagWeightG);
    // What the whole BOM is being costed for. Defaults to the order.
    const basis = resolveBasis(opts.basis, orderBags, bagWeightG);
    const bags = basis.bags;
    const rateOf = opts.rateOf || (() => null);
    const nameOf = opts.nameOf || ((c) => c);
    const uomOf = opts.uomOf || (() => 'KG');
    const procRate = opts.procRate || (() => 0);
    const procName = opts.procName || ((c) => c);
    const procResources = opts.procResources || null;
    /* A rounding step of 0 or a negative one would destroy every quantity,
       so an unusable value falls back to the step this engine always used. */
    const qtyStep = num(opts.qtyRounding) > 0 ? num(opts.qtyRounding) : 0.1;

    const warnings = [];
    const errors = [];
    const n = steps.length;

    if (!n) errors.push('This construction has no route. Link one in Process & Route Master.');
    if (bags <= 0) {
      errors.push(basis.mode === 'ORDER'
        ? 'Order quantity (bag quantity) must be greater than zero.'
        : 'The BOM basis value must be greater than zero.');
    }
    if (bagWeightG <= 0) errors.push('Bag weight must be greater than zero — the calculation has to be valid first.');

    const BASES = { PCT: 1, PER1000: 1, PERBAG_G: 1, PART_G: 1, ABS: 1 };
    const BASES_RES = { KG: 1, BAG: 1, PER1000: 1 };
    const stages = steps.map((st, i) => {
      const key = i + '|' + st.p;
      const cfg = sections[key] || {};
      return {
        index: i,
        process: st.p,
        /* A step may carry a label so the same process can run more than
           once in one route on different material (body / patch / valve).
           It is display only — the section key is still "<i>|<code>". */
        label: st.label || '',
        processName: procName(st.p) + (st.label ? ' — ' + st.label : ''),
        sourcing: st.src === 'BUY' ? 'BUY' : 'MAKE',
        buyRm: st.rm || null,
        wastePct: num(cfg.wastePct),
        // undefined = "use every resource defined on the process"; an array
        // = the resources picked for this section specifically.
        resources: cfg.resources === undefined ? undefined : (cfg.resources || []),
        lines: (cfg.lines || []).map((l) => {
          const src = l.src === 'SFG' ? 'SFG' : 'RM';
          return {
            src: src,
            rm: l.rm || null,
            sfgStep: l.sfgStep === undefined || l.sfgStep === null ? null : Number(l.sfgStep),
            name: src === 'SFG' ? '' : nameOf(l.rm),
            uom: src === 'SFG' ? 'KG' : uomOf(l.rm),
            label: l.label || '',
            basis: BASES[l.basis] ? l.basis : 'PCT',
            value: num(l.value),
            rateOverride: (l.rate === undefined || l.rate === null || l.rate === '') ? null : num(l.rate)
          };
        }),
        key: key
      };
    });
    stages.forEach((s) => {
      s.lines.forEach((l) => {
        if (l.src === 'SFG') {
          const ref = stages[l.sfgStep];
          l.name = ref ? ref.processName + ' output' : 'unknown stage';
          if (!ref || l.sfgStep >= s.index) {
            warnings.push(s.processName + ': a stage can only take material from a stage BEFORE it — that line is ignored.');
            l.invalid = true;
          }
        }
      });
    });

    if (errors.length) {
      return { ok: false, errors, warnings, stages: [], totals: null };
    }

    // ---- 1. quantities, walked BACKWARDS from the finished order --------
    const fgKg = (bags * bagWeightG) / 1000;

    // The last BUY stage is where the roll-up stops; anything before it is
    // contained in what was purchased.
    let wallAt = -1;
    for (let i = n - 1; i >= 0; i--) { if (stages[i].sourcing === 'BUY') { wallAt = i; break; } }

    // Demand accumulates: the final stage must make the order, and every
    // stage that names an earlier stage's output adds to that stage's
    // demand. A stage can therefore feed two later stages — patch/valve
    // slitting and body lamination both drawing on the same fabric.
    const demand = stages.map(() => 0);
    if (n) demand[n - 1] = fgKg;

    /* 4.53.0 — PART_G: grams per bag of a named figure from the weight
       calculation (a part's fabric, coating, BOPP component…), GROSSED
       by this stage's waste.

         "1000 lamination required in 3l: 600kg fabric, 100kg bopp and
          rest 300kg rm — if it will push as per substract weight then i
          don't have issue"

       Those 600/100/300 are what ENDS UP in the laminate. To hand 1,000
       kg of good laminate to the next stage at 3 % waste the machine
       must be FED 1,030.9 kg, so it must be issued 618.6 / 103.1 /
       309.3. A line stating the finished content and never grossing it
       leaves the stage short by exactly its waste — every time.

       This falls out identically to the layer percentages the Suggest
       button already produces, which is the check: a part weight that is
       60 % of the part, and a PCT line typed as 60, issue the same
       kilograms to the last decimal (`partbom.test.js`).

       PERBAG_G is NOT changed. It is the basis every existing BOM,
       recipe and workflow was built on — yarn, handle, liner, easy-open
       tapes — and moving it would move saved costings. A new basis moves
       nothing that exists. */
    /* 4.58.6 — …AND BY THE WASTE OF EVERY STAGE AFTER IT.

         "cost hamesa first tab na last stage nu j ganavu joiye"

       Grams per bag are what ends up in the FINISHED bag. A stage that
       sits before segregation and packing, which lose some bags too, must
       make enough for those losses as well — or the last stage hands over
       fewer kilograms than the order, and the cost per kilogram read at
       block bottom is not the cost per kilogram of the bag.

       So a PART_G line is grossed by its own yield AND the yields of the
       stages its output passes through on the way to the bag, followed
       exactly as the material flows: a stage that names the stage it
       takes from sends its factor there, one that does not sends it to
       the stage before it. On the last stage the factor is its own yield
       only — exactly what 4.53.0 did — so a PART_G line there, or on a
       route with no waste after it, issues what it always issued. */
    const reach = downstreamFactors(stages);
    function qtyOf(l, grossKg, wastePct, i) {
      if (l.basis === 'PCT') return grossKg * (l.value / 100);
      if (l.basis === 'PER1000') return (bags / 1000) * l.value;
      if (l.basis === 'PERBAG_G') return (bags * l.value) / 1000;
      if (l.basis === 'PART_G') return ((bags * l.value) / 1000) * reach[i];
      return l.value;                       // ABS — kg for the whole order
    }

    for (let i = n - 1; i >= 0; i--) {
      const s = stages[i];
      s.outputKg = demand[i];

      if (s.wastePct >= 100) {
        errors.push(s.processName + ': waste of ' + s.wastePct + '% is not possible.');
        s.wastePct = 0;
      }
      // Waste is a loss on what passes through, so the gross that must be
      // fed in is the output divided by the yield — never output × (1+w),
      // which under-states it.
      s.grossKg = s.outputKg / (1 - s.wastePct / 100);
      s.wasteKg = s.grossKg - s.outputKg;

      let addedKg = 0, sfgKg = 0, hasSfg = false;
      s.lines.forEach((l) => {
        if (l.invalid) { l.kg = 0; return; }
        l.kg = mround(qtyOf(l, s.grossKg, s.wastePct, i), qtyStep);
        if (l.src === 'SFG') {
          hasSfg = true; sfgKg += l.kg;
          demand[l.sfgStep] += l.kg;        // pull it from that stage
        } else {
          addedKg += l.kg;
        }
      });
      s.addedKg = addedKg;

      if (s.sourcing === 'BUY') {
        s.inputKg = 0;
        s.purchasedKg = s.grossKg;
      } else if (hasSfg) {
        // The input is stated explicitly, so it is no longer implied.
        s.inputKg = sfgKg;
        s.explicitInput = true;
        s.purchasedKg = 0;
        /* WHICH stages it was taken from — reported, not guessed (1.1.0).
           "cost from earlier stage can be stage 3, can be stage 5 also."
           A stage may name more than one; all of them are listed so the
           screen can say exactly where the input came from. */
        s.inputFrom = s.lines.filter((l) => l.src === 'SFG' && !l.invalid)
          .map((l) => ({ index: l.sfgStep, kg: l.kg, explicit: true }));
      } else {
        s.inputKg = Math.max(0, s.grossKg - addedKg);
        s.purchasedKg = 0;
        if (i > 0) demand[i - 1] += s.inputKg;
        /* Nothing was stated, so the material is taken from whatever stage
           happens to sit before this one in the route. That is a sensible
           default on a straight line and a GUESS on a converging one —
           either way the screen must be able to name it, which it could
           not before 1.1.0. */
        if (i > 0 && s.inputKg > 0) s.inputFrom = [{ index: i - 1, kg: s.inputKg, explicit: false }];
      }

      s.beforeWall = wallAt > -1 && i < wallAt;
    }

    /* Name every input source now that the stages exist, and say plainly
       when a stage is guessing. On a route where some stage DOES name its
       source, "the one before me in the list" stops being obviously right:
       a body-lamination step sitting after a patch-slitting step would
       take the patch as its input purely because of list order. */
    const anyExplicit = stages.some((s) => s.explicitInput);
    stages.forEach((s) => {
      if (!s.inputFrom) return;
      s.inputFrom.forEach((f) => {
        const ref = stages[f.index];
        f.processName = ref ? ref.processName : 'unknown stage';
        f.stepLabel = 'Stage ' + (f.index + 1) + ' — ' + f.processName;
      });
      if (!s.explicitInput && anyExplicit && !s.beforeWall && s.sourcing === 'MAKE') {
        warnings.push(s.processName + ' takes its input from ' + s.inputFrom[0].stepLabel +
          ' only because that step comes before it in the route. Other steps name their source explicitly, so if this one should take a different stage, add an "Earlier stage" row to its section and choose it.');
      }
    });

    /* A stage nothing draws from makes nothing. That happens the moment a
       later stage is pointed at a different source — the step in between
       is left out of the route without being removed from it, and every
       figure on it silently goes to zero. Better said than discovered. */
    stages.forEach((s, i) => {
      if (s.beforeWall || i === n - 1) return;
      if (s.outputKg > 0.0001) return;
      warnings.push(s.processName + ' makes nothing: no later stage takes its output, so every quantity on it is zero. '
        + 'Point the stage that should consume it at ' + ('Stage ' + (i + 1) + ' — ' + s.processName) + ', or remove the step from the route.');
    });

    // First costed stage must supply its own mass entirely from its recipe.
    const firstCosted = stages.findIndex((s) => !s.beforeWall);
    if (firstCosted > -1) {
      const s = stages[firstCosted];
      if (s.sourcing === 'MAKE' && s.inputKg > 0.05) {
        warnings.push(s.processName + ' is the first stage, so its recipe should account for all of its material — '
          + fmtKg(s.inputKg) + ' kg is currently unaccounted for. Add the missing raw material, or mark an earlier stage as bought in.');
      }
    }

    // ---- 2. cost, walked FORWARDS to the bag ----------------------------
    let prevOutCost = 0;
    let totalMaterial = 0, totalProcess = 0, totalWaste = 0;
    const unpriced = [];

    stages.forEach((s) => {
      if (s.beforeWall) {
        s.note = 'Not costed — bought in at ' + stages[wallAt].processName + '.';
        s.materialCost = 0; s.processCost = 0; s.inputCost = 0; s.outputCost = 0; s.costPerKg = 0;
        s.wasteValue = 0;
        return;
      }

      let material = 0, sfgCost = 0;
      if (s.sourcing === 'BUY') {
        const rate = s.buyRm ? rateOf(s.buyRm) : null;
        s.buyRate = rate;
        if (!s.buyRm) warnings.push(s.processName + ' is marked bought in but no purchased material is chosen for it.');
        else if (rate === null) unpriced.push(s.buyRm);
        material = s.grossKg * num(rate);
        s.purchasedName = s.buyRm ? nameOf(s.buyRm) : null;
        s.inputCost = 0;
        s.processCost = 0;
      } else {
        s.lines.forEach((l) => {
          if (l.invalid) { l.rate = 0; l.cost = 0; return; }
          if (l.src === 'SFG') {
            // An SFG line is priced at what that stage actually cost per kg
            // — this is the roll-up, made explicit and visible.
            const ref = stages[l.sfgStep];
            l.rate = l.rateOverride !== null ? l.rateOverride : (ref ? ref.costPerKg : 0);
            l.rateSource = l.rateOverride !== null ? 'override' : 'stage';
            l.cost = l.kg * num(l.rate);
            sfgCost += l.cost;
          } else {
            const master = rateOf(l.rm);
            l.rate = l.rateOverride !== null ? l.rateOverride : master;
            l.rateSource = l.rateOverride !== null ? 'override' : 'master';
            l.masterRate = master;
            if (l.rate === null) unpriced.push(l.rm);
            l.cost = l.kg * num(l.rate);
            material += l.cost;
          }
        });
        s.inputCost = s.explicitInput ? sfgCost : prevOutCost;
        // Resources: the ones picked for this section, or every resource on
        // the process when the section has not narrowed them.
        s.resourceLines = s.resources === undefined ? null : s.resources;
        const resList = s.resources === undefined
          ? (procResources ? procResources(s.process) : null)
          : s.resources;

        if (resList) {
          /* Each resource charges on its own basis. Per-kg resources are
             consumed on what passes through the machine — the GROSS, waste
             included; per-bag and per-1000 resources follow the bag count
             the BOM is being costed for. */
          s.resourceCosts = resList.map((r) => {
            const basis = BASES_RES[r.basis] ? r.basis : 'KG';
            const rate = num(r.costPerKg);
            const cost = basis === 'KG' ? s.grossKg * rate
                       : basis === 'BAG' ? bags * rate
                       : (bags / 1000) * rate;
            return { name: r.name, type: r.type, basis: basis, rate: rate, cost: cost };
          });
          s.processCost = s.resourceCosts.reduce((t, r) => t + r.cost, 0);
        } else {
          // No resource list available — the pre-0.16.0 path, per kg only.
          s.resourceCosts = null;
          s.processCost = s.grossKg * num(procRate(s.process));
        }
        /* Reported as the EFFECTIVE per-kg rate, so a per-bag resource is
           still visible in every per-kg figure the UI already shows. */
        s.ratePerKg = s.grossKg > 0 ? s.processCost / s.grossKg : 0;
      }

      s.materialCost = material;
      s.outputCost = s.inputCost + s.materialCost + s.processCost;
      s.costPerKg = s.outputKg > 0 ? s.outputCost / s.outputKg : 0;
      /* What the scrap cost. Not deducted from anything — it is already
         inside outputCost, carried by the good output. Reported so the
         loss is visible rather than buried in a higher cost per kg. */
      s.wasteValue = s.grossKg > 0 ? s.outputCost * (s.wasteKg / s.grossKg) : 0;
      totalWaste += s.wasteValue;
      totalMaterial += s.materialCost;
      totalProcess += s.processCost;
      prevOutCost = s.outputCost;
      s.consumedExplicitly = false;
    });

    const uniqueUnpriced = unpriced.filter((c, i) => c && unpriced.indexOf(c) === i);
    if (uniqueUnpriced.length) {
      warnings.push(uniqueUnpriced.length + ' material(s) have no price version, so they are costing as zero: '
        + uniqueUnpriced.map(nameOf).join(', ') + '. Set a price in RM Master.');
    }
    const noRate = stages.filter((s) => !s.beforeWall && s.sourcing === 'MAKE' && !num(s.ratePerKg));
    if (noRate.length) {
      warnings.push(noRate.length + ' process(es) have no resource rate, so they add no conversion cost: '
        + noRate.map((s) => s.processName).join(', ') + '. Set rates in Process & Route Master.');
    }

    /* The order's cost is the FINAL stage's output cost. Every earlier
       stage reaches it either implicitly (input cost) or explicitly (an SFG
       line), so adding stages up would double count. */
    const lastCosted = stages.filter((s) => !s.beforeWall).pop();
    const totalCost = lastCosted ? lastCosted.outputCost : 0;
    return {
      ok: true,
      errors,
      warnings,
      stages,
      wallAt,
      totals: {
        basis: basis,
        fgKg: fgKg,
        bags: bags,
        orderBags: orderBags,
        materialCost: totalMaterial,
        processCost: totalProcess,
        wasteValue: totalWaste,
        totalCost: totalCost,
        costPerBag: bags > 0 ? totalCost / bags : 0,
        costPerKg: fgKg > 0 ? totalCost / fgKg : 0
      }
    };
  }

  /** 4.58.6 — for each stage, the kilograms it must be fed per kilogram of
   *  finished bag: 1 ÷ (its yield × the yields downstream of it). Walked
   *  backwards along the flow: a stage with an "earlier stage" row sends
   *  its factor to that stage, one without sends it to the stage before.
   *  The first (latest) consumer decides; a stage nothing draws from
   *  counts from the finished bag. Waste of 100 % or more is read as 0,
   *  the same as the roll-up reads it. */
  function downstreamFactors(stages) {
    const n = stages.length;
    const into = stages.map(() => null);
    const out = stages.map(() => 1);
    if (n) into[n - 1] = 1;
    for (let i = n - 1; i >= 0; i--) {
      const s = stages[i];
      const w = num(s.wastePct);
      const y = w > 0 && w < 100 ? 1 - w / 100 : 1;
      const f = (into[i] === null ? 1 : into[i]) / y;
      out[i] = f;
      const sfg = (s.lines || []).filter((l) => l.src === 'SFG' && !l.invalid && l.sfgStep !== null && l.sfgStep < i);
      if (sfg.length) sfg.forEach((l) => { if (into[l.sfgStep] === null) into[l.sfgStep] = f; });
      else if (i > 0 && into[i - 1] === null) into[i - 1] = f;
    }
    return out;
  }

  /* ---- the calculation basis -------------------------------------------
     Turns {mode, value} into the bag count everything else is built from,
     and says in words where that came from and how — a number on a costing
     sheet that cannot be traced is a number nobody trusts. */
  const BASIS_MODES = { ORDER: 1, BAGS: 1, KG: 1 };
  function resolveBasis(input, orderBags, bagWeightG) {
    const wanted = input && BASIS_MODES[input.mode] ? input.mode : 'ORDER';
    const typed = input && input.value !== undefined && input.value !== null && input.value !== ''
      ? num(input.value) : null;
    // A mode that needs a value but has none falls back to the order, so a
    // half-finished header never produces a silently wrong quantity.
    const mode = (wanted !== 'ORDER' && !(typed > 0)) ? 'ORDER' : wanted;

    if (mode === 'ORDER') {
      return {
        mode: 'ORDER', value: orderBags, unit: 'bags',
        bags: orderBags, fgKg: (orderBags * bagWeightG) / 1000,
        label: 'Order quantity',
        auto: true,
        fellBack: wanted !== 'ORDER',
        source: 'Bag quantity on the saved calculation, and the bag weight the weight calculation produced.',
        formula: n(orderBags) + ' bags × ' + n(bagWeightG, 3) + ' g ÷ 1000 = ' + n((orderBags * bagWeightG) / 1000) + ' kg finished'
      };
    }
    if (mode === 'BAGS') {
      return {
        mode: 'BAGS', value: typed, unit: 'bags',
        bags: typed, fgKg: (typed * bagWeightG) / 1000,
        label: 'Per ' + n(typed) + ' bags',
        auto: false, fellBack: false,
        source: 'Typed on the BOM header. The saved calculation orders ' + n(orderBags) + ' bags.',
        formula: n(typed) + ' bags × ' + n(bagWeightG, 3) + ' g ÷ 1000 = ' + n((typed * bagWeightG) / 1000) + ' kg finished'
      };
    }
    const bags = bagWeightG > 0 ? (typed * 1000) / bagWeightG : 0;
    return {
      mode: 'KG', value: typed, unit: 'kg finished',
      bags: bags, fgKg: typed,
      label: 'Per ' + n(typed) + ' kg finished',
      auto: false, fellBack: false,
      source: 'Typed on the BOM header, converted with the bag weight from the weight calculation.',
      formula: n(typed) + ' kg × 1000 ÷ ' + n(bagWeightG, 3) + ' g = ' + n(bags) + ' bags'
    };
  }
  function n(v, dp) {
    const d = dp === undefined ? 2 : dp;
    const r = Math.round(num(v) * Math.pow(10, d)) / Math.pow(10, d);
    return r.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
  }

  function fmtKg(v) { return (Math.round(v * 100) / 100).toFixed(2); }

  return { build, resolveBasis, downstreamFactors, helpers: { mround, r3 } };
});

/**
 * Nexora — Bag Weight Calculation Engine
 * ----------------------------------------------------------------------
 * Every formula in this file is a direct translation of a real, working
 * formula recovered from the legacy AppSheet app definition (see project
 * doc "reverse-engineering-notes.md"). Nothing here is invented or
 * guessed — each function is annotated with the original AppSheet column
 * name it replaces, so it can be checked back against the source.
 *
 * Pipeline (per component: BODY / TOP PATCH / BOTTOM PATCH / VALVE / HANDLE):
 *   SIZE (mm)  ->  AREA (mm^2)  ->  WEIGHT (g), split into
 *       coating layer + BOPP layer + metallised layer + base-fabric layer
 * Then: RESULT WEIGHT = sum of every component's weight
 *       (body + top patch + bottom patch + valve + handle + yarn/thread
 *        + liner + backseam granules + easy-open tapes)
 *
 * This engine is pure, synchronous, deterministic JavaScript with no DOM
 * or storage dependency, so the exact same result is produced in the
 * browser, inside Electron, and inside a Capacitor Android build
 * (spec requirement: identical result across all three platforms).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexoraEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- AppSheet-semantics helpers -----------------------------------
  // In the legacy sheet, a blank/empty input is treated as "no value"
  // (ISBLANK/ISNOTBLANK checks) but behaves as 0 once used in a sum.
  function isBlank(v) {
    return v === undefined || v === null || v === '';
  }
  function isNotBlank(v) {
    return !isBlank(v);
  }
  // Numeric coercion used inside arithmetic (blank -> 0, like AppSheet sums)
  function n(v) {
    if (isBlank(v)) return 0;
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  // Numeric coercion used inside comparisons where blank must stay "not a number"
  // (matches AppSheet: a blank Number compares as less than any positive number)
  function nOrBlank(v) {
    if (isBlank(v)) return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  }
  function round1(v) {
    // Reproduces the repeated legacy pattern ROUND(x*10)/10
    return Math.round(v * 10) / 10;
  }
  function upper(v) {
    return isBlank(v) ? v : String(v).trim().toUpperCase();
  }
  function eq(a, b) {
    return upper(a) === b;
  }

  /**
   * @param {object} input   raw technical inputs (legacy field codes as keys)
   * @param {object} opts
   * @param {object} opts.constants     { "DESCRIPTION": value, ... } technical constants master
   * @param {object} opts.construction  construction record from NexoraConstructions (fields{} flags)
   * @returns {object} full structured result incl. trace of every derived value
   */
  function calculate(input, opts) {
    opts = opts || {};
    const K = opts.constants || {};
    const construction = opts.construction || { fields: {} };
    const flags = construction.fields || {};
    const errors = [];
    const warnings = [];
    const info = [];
    const trace = {};

    function T(field, label, formula, value, inputsUsed) {
      trace[field] = { label, formula, value, inputs: inputsUsed || {} };
      return value;
    }
    /* 4.55.0 — which constants this bag actually read. A note kept
       beside the answer, never consulted while computing it: a workflow
       records what it is built on, and "the Constants Master" is not an
       answer — the names are. */
    const constantsUsed = {};
    function K_(desc) {
      constantsUsed[desc] = true;
      if (K[desc] === undefined) {
        warnings.push('Technical constant "' + desc + '" is not configured — treated as 0. Set it in Constants Master.');
        return 0;
      }
      return K[desc];
    }
    /* A ratio or allowance that USED to be written into the formula (1.0.0).
       It now reads from the Constants Master like everything else — but a
       missing entry falls back to the number the formula carried before,
       never to zero. An engine that silently multiplies by 0 because a
       constant is absent is far worse than one that quietly behaves as it
       always did, so the fallback is always the old hard-coded value. */
    function KD_(desc, hardCodedBefore) {
      constantsUsed[desc] = true;
      const v = K[desc];
      if (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) return hardCodedBefore;
      return Number(v);
    }

    // ---- 1. Raw inputs (with basic validation, spec §36) -------------
    const WIDTH = nOrBlank(input.WIDTH);
    const LENGTH = nOrBlank(input.LENGTH);
    const PATCH = nOrBlank(input.PATCH);
    const VALVE = nOrBlank(input.VALVE);
    const EX_VALVE = nOrBlank(input['EX-VALVE']);
    const BOTTOM_FOLD = input['BOTTOM FOLD'];
    const HAMMING = input.HAMMING;
    const BACKSEAM = input.BACKSEAM;
    const EASY_OPEN = input['EASY OPEN'];
    const HANDLE = input.HANDLE;
    const H_WIDTH = nOrBlank(input['H.WIDTH']);
    const H_LENGTH = nOrBlank(input['H.LENGTH']);
    const M_WARP = nOrBlank(input['M.WARP']);
    const M_WEFT = nOrBlank(input['M.WEFT']);
    const BD_FAB_GSM = nOrBlank(input['BD FAB GSM']);
    const FLT_FAB_GSM = nOrBlank(input['FLT FAB GSM']);
    const BD_CT_GSM = nOrBlank(input['BD CT GSM']);
    const FLT_CT_GSM = nOrBlank(input['FLT CT GSM']);
    const BD_BOP_MIC = nOrBlank(input['BD BOP MIC']);
    const BD_MT_MIC = nOrBlank(input['BD MT MIC']);
    const PTC_BOP_MIC = nOrBlank(input['PTC BOP MIC']);
    const PTC_MT_MIC = nOrBlank(input['PTC MT MIC']);
    const BD_CT_SD = input['BD CT SD'];
    const PTC_CT_SD = input['PTC CT SD'];
    const BD_BOP_SD = input['BD BOP SD'];
    const BD_MT_SD = input['BD MT SD'];
    const PTC_BOP_SD = input['PTC BOP SD'];
    const PTC_MT_SD = input['PTC MT SD'];
    const DSB = nOrBlank(input.DSB);
    const DSTP = nOrBlank(input.DSTP);
    const DSBP = nOrBlank(input.DSBP);
    /* 4.34.0 — TRIMMING AND OVERLAP ARE MILL CONSTANTS, NOT PER-BAG ENTRIES.
       These three were read from the input and from nowhere else, and no
       screen in the application ever sets them. So in every real calculation
       they were 0, and three figures were quietly short:

         patch fabric size   (PATCH-5)*6 + TR    630 instead of 660
         valve fabric size   (PATCH*2+OV)*2 + TRV 470 instead of 500
         valve width         PATCH*2 + OV        200 instead of 215

       The suites never caught it because they pass TR: 30, TRV: 30, OV: 15
       by hand — which are exactly the values in the Constants Master. A
       fixture that supplies what the product cannot is a fixture that hides
       the defect it was meant to find.

       Blank now means "use the constant", which is what the Constants Master
       is for and what makes these adjustable per mill. A value that IS
       present still wins, INCLUDING a typed 0 — a bag genuinely cut without
       trimming is expressed that way, and negatives.test.js asserts it
       ("zero is a real answer for a trim"). That is why this tests isBlank
       and not falsiness.

       BACKSEAM OVERLAP was the fourth of this family and was migrated to the
       constant some releases ago; BODY WIDTH reads K[BACKSEAM OVERLAP]. Its
       input read lingered here, unused, and is gone. */
    const constOr = (raw, desc, hardCodedBefore) => (isBlank(raw) ? KD_(desc, hardCodedBefore) : n(raw));
    const TR = constOr(input.TR, 'FLAT TRIMMING', 30);
    const TRV = constOr(input.TRV, 'FLAT TRIMMING VALVE', 30);
    const OV = constOr(input.OV, 'VALVE OVERLAP', 15);
    /* 4.59.0 — the pinch-bottom bag: a pinched end, a gusset, and across
       the mouth a zipper and/or a pinch easy-open strip. */
    const PINCH = input.PINCH;
    const GUSSET = nOrBlank(input.GUSSET);
    const ZIPPER = input.ZIPPER;
    const PINCH_EO = input['PINCH EASY OPEN'];
    const LNR_WIDTH = nOrBlank(input['LNR WIDTH']);
    const LNR_LENGTH = nOrBlank(input['LNR LENGTH']);
    const LNR_BTM_SEAL = n(input['LNR BTM SEAL']);
    const LNR_MC = nOrBlank(input['LNR MC']);
    // Ink/Adhesive are structure-level optional (tick mark in Structure Master:
    // fields['INK GSM'] / fields['ADHESIVE GSM']). When the construction does not
    // have the tick, these must contribute ZERO weight — not the default constant —
    // even if a BOPP/metallised micron value is present on that construction.
    const INK_GSM = flags['INK GSM'] ? (isBlank(input['INK GSM']) ? K_('INK GSM') : n(input['INK GSM'])) : 0;
    const ADHESIVE_GSM = flags['ADHESIVE GSM'] ? (isBlank(input['ADHESIVE GSM']) ? K_('ADHESIVE GSM') : n(input['ADHESIVE GSM'])) : 0;

    /* ---- EVERY NUMBER MUST BE A NUMBER, AND NONE MAY BE NEGATIVE ------
       (4.24.0)

       Until now a value that was not a number was quietly read as zero,
       and a negative one was quietly used. Neither crashed and neither
       produced NaN — which is precisely the danger. PATCH -100 returned
       70.49 g and PATCH "abc" returned 75.60 g, both with no error at
       all, and a plausible wrong weight becomes a plausible wrong price
       on a quotation. A costing engine must refuse what it cannot
       honestly compute.

       There is no field in bag manufacture where a negative is
       meaningful: a width, a length, a GSM, a micron, a mesh count, a
       trim allowance, a drum size, a target weight and a tolerance are
       all zero or more. Zero itself stays legitimate — a trim of 0 is a
       real answer — and the required-field checks below still insist on
       more than zero where more than zero is required.

       Blank is untouched. A blank optional field is not an error and
       never was; only a value that is PRESENT is judged. */
    const NUMERIC_INPUTS = [
      'WIDTH', 'LENGTH', 'PATCH', 'VALVE', 'EX-VALVE',
      'H.WIDTH', 'H.LENGTH', 'M.WARP', 'M.WEFT',
      'BD FAB GSM', 'FLT FAB GSM', 'BD CT GSM', 'FLT CT GSM',
      'BD BOP MIC', 'BD MT MIC', 'PTC BOP MIC', 'PTC MT MIC',
      'DSB', 'DSTP', 'DSBP', 'TR', 'TRV', 'BKSMOV', 'OV',
      'LNR WIDTH', 'LNR LENGTH', 'LNR BTM SEAL', 'LNR MC',
      'INK GSM', 'ADHESIVE GSM', 'GUSSET',
      'TARGET WEIGHT', 'DOWNSIDE %', 'UPSIDE %'
    ];
    NUMERIC_INPUTS.forEach((key) => {
      const raw = input[key];
      if (isBlank(raw)) return;
      const x = Number(raw);
      if (!Number.isFinite(x)) {
        errors.push(key + ' must be a number — "' + String(raw) + '" is not one.');
      } else if (x < 0) {
        errors.push(key + ' cannot be negative.');
      }
    });

    /* ---- Required-field errors (spec §36 Error level) ------------------
       A field can only be required if the construction HAS it (1.0.0).

       The reported defect: a liner-only bag was refused for a missing
       WIDTH, LENGTH and BD FAB GSM — none of which exist on that
       construction. Its Structure Master entry carries the liner's own
       width, length and micron and nothing else, and those are what its
       weight is made of. Demanding a bag width from a product that is not
       a bag was simply wrong.

       So each requirement is now gated on the construction's own field
       flags. Every other construction in the master carries WIDTH, LENGTH
       and BD FAB GSM, so for all of them this is exactly the check it was
       before — verified construction by construction in the golden test.
       Whatever the construction DOES have, it still must have. */
    const has = (f) => !!flags[f];
    if (has('WIDTH') && (isBlank(WIDTH) || WIDTH <= 0)) errors.push('WIDTH is required and must be greater than 0.');
    if (has('LENGTH') && (isBlank(LENGTH) || LENGTH <= 0)) errors.push('LENGTH is required and must be greater than 0.');
    if (has('BD FAB GSM') && (isBlank(BD_FAB_GSM) || BD_FAB_GSM <= 0)) errors.push('BD FAB GSM (body fabric GSM) is required and must be greater than 0.');

    /* A liner-only construction is defined by what it has, not by its
       name: liner fields and no body fabric. Nothing else supplies its
       weight, so its own dimensions become the required ones. On a bag
       that merely CONTAINS a liner the body still carries the weight, so
       a blank liner there stays a blank liner, not an error. */
    const linerOnly = has('LNR WIDTH') && !has('BD FAB GSM');
    if (linerOnly) {
      if (isBlank(LNR_WIDTH) || LNR_WIDTH <= 0) errors.push('LNR WIDTH (liner width) is required and must be greater than 0.');
      if (isBlank(LNR_LENGTH) || LNR_LENGTH <= 0) errors.push('LNR LENGTH (liner length) is required and must be greater than 0.');
      if (isBlank(LNR_MC) || LNR_MC <= 0) errors.push('LNR MC (liner micron) is required and must be greater than 0.');
    }

    /* 4.61.0 — "pinch ma backseam compalsary che ane gusset size pan
       compalsary che". A pinch-bottom bag is a backseamed, gusseted tube;
       a construction that offers PINCH requires both. */
    if (has('PINCH') && !eq(BACKSEAM, 'YES')) {
      errors.push('BACKSEAM must be YES on a pinch-bottom bag — it is a backseamed tube.');
    }
    if (has('GUSSET') && (isBlank(GUSSET) || GUSSET <= 0)) {
      errors.push('GUSSET is required and must be greater than 0.');
    }

    /* 4.59.0 — "500mm width and 100mm gusset will cover 400mm zipper
       because 100 will be collaps inside gusset". A gusset as wide as the
       bag leaves nothing for the zipper to run across. */
    if ((eq(ZIPPER, 'YES') || eq(PINCH_EO, 'YES')) && isNotBlank(GUSSET) && isNotBlank(WIDTH) && GUSSET >= WIDTH) {
      errors.push('GUSSET must be less than WIDTH — the zipper and the easy-open strip run over WIDTH minus GUSSET.');
    }

    // ---- 2. Fold / hamming size lookups -------------------------------
    const BTM_FOLD_SZ = T('BTM FOLD SZ', 'Bottom fold size',
      'IFS(BOTTOM FOLD="SINGLE", K[SINGLE FOLD SIZE]; BOTTOM FOLD="DOUBLE", K[DOUBLE FOLD SIZE])',
      eq(BOTTOM_FOLD, 'SINGLE') ? K_('SINGLE FOLD SIZE') : eq(BOTTOM_FOLD, 'DOUBLE') ? K_('DOUBLE FOLD SIZE') : 0,
      { BOTTOM_FOLD });

    const HAMMING_SZ = T('HAMMING SZ', 'Hamming size',
      'IFS(HAMMING="SINGLE", K[SINGLE HAMMING SIZE]; HAMMING="DOUBLE", K[DOUBLE HAMMING SIZE])',
      eq(HAMMING, 'SINGLE') ? K_('SINGLE HAMMING SIZE') : eq(HAMMING, 'DOUBLE') ? K_('DOUBLE HAMMING SIZE') : 0,
      { HAMMING });

    const MESH = T('MESH', 'Mesh (avg warp/weft)', '(M.WEFT + M.WARP) / 2', (n(M_WEFT) + n(M_WARP)) / 2, { M_WARP, M_WEFT });

    // ---- 3. Patch overlap (OP) & cut length ---------------------------
    const OP = T('OP', 'Patch overlap', 'IFS(VALVE<1,K[OPEN BAGS]; BD BOP MIC<1,K[FLEXO]; VALVE>0 AND BD BOP MIC>0,K[BOPP])',
      (function () {
        const valve = n(VALVE);
        const bopMic = n(BD_BOP_MIC);
        if (valve < 1) return K_('PATCH OVERLAP FOR OPEN BAGS');
        if (bopMic < 1) return K_('PATCH OVER LAP FOR FLEXO');
        if (valve > 0 && bopMic > 0) return K_('PATCH OVERLAP FOR BOPP');
        return 0;
      })(), { VALVE, BD_BOP_MIC });

    /* 4.59.0 — "cut length is when user select pinch=yes it will add 50mm
       like 600+50 with cutlength=650". The 50 is the plant's, so it lives
       in the Constants Master; a bag with no PINCH answer adds nothing. */
    const PINCH_SZ = T('PINCH SZ', 'Pinch allowance', 'IF(PINCH="YES", K[PINCH ALLOWANCE], 0)',
      eq(PINCH, 'YES') ? KD_('PINCH ALLOWANCE', 50) : 0, { PINCH });

    const CUT_LENGTH = T('CUT LENGTH', 'Cut length',
      'IFS(PATCH<1 AND VALVE<1, LENGTH+fold+hamming; VALVE<1, LENGTH+PATCH/2+OP+hamming; PATCH>1 AND VALVE>1, LENGTH+PATCH+OP) + PINCH SZ',
      (function () {
        const patch = n(PATCH), valve = n(VALVE);
        let base;
        if (patch < 1 && valve < 1) base = n(LENGTH) + BTM_FOLD_SZ + HAMMING_SZ;
        else if (valve < 1) base = n(LENGTH) + patch / 2 + OP + HAMMING_SZ;
        else base = n(LENGTH) + patch + OP; // 3rd branch; also the fallback — no legacy branch covers patch<=1<valve
        return PINCH_SZ > 0 ? base + PINCH_SZ : base;
      })(), { WIDTH, LENGTH, PATCH, VALVE, OP, BTM_FOLD_SZ, HAMMING_SZ, PINCH_SZ });

    // ---- 4. Thread / yarn defaults (construction-flag driven) --------
    const YARN_WT = flags['YARN WT'] ? K_('YARN WEIGHT FOR 1000MM') : undefined;
    const HANDLE_WT_DEFAULT = flags['HANDLE'] ? K_('HANDLE WEIGHT 25X250') : undefined;
    const CTN_YARN_WT = flags['CTN YARN WT'] ? K_('COTTOM YARN WEIGHT FOR 1000MM') : undefined;

    // ---- 5. Liner ------------------------------------------------------
    const LNR_CUT_LENGTH = T('LNR CUT LENGTH', 'Liner cut length', 'LNR LENGTH + LNR BTM SEAL', n(LNR_LENGTH) + LNR_BTM_SEAL, { LNR_LENGTH, LNR_BTM_SEAL });
    const LNR_GZ = T('LNR GZ', 'Liner gauge', 'LNR MC * K[LINER MICRON TO GAUGE FACTOR]',
      n(LNR_MC) * KD_('LINER MICRON TO GAUGE FACTOR', 4), { LNR_MC });
    const LNR_WT = T('LNR WT', 'Liner weight (g)', 'ROUND((LNR GZ/K[LINER GAUGE WEIGHT DIVISOR])*(LNR WIDTH/25.4)*(LNR CUT LENGTH/25.4)*10)/10',
      isBlank(LNR_WIDTH) ? 0 : round1((LNR_GZ / (KD_('LINER GAUGE WEIGHT DIVISOR', 3300) || 3300)) * (n(LNR_WIDTH) / 25.4) * (LNR_CUT_LENGTH / 25.4)), { LNR_GZ, LNR_WIDTH, LNR_CUT_LENGTH });

    // ---- 6. Denier (reporting only, not part of RESULT WEIGHT) --------
    /* Denier's own factors are the plant's tape practice, not physics —
       only the 9 (denier is grams per 9,000 m) is fixed. */
    /* 4.32.0 — the physical relation, on the owner's instruction after a
       check: Denier = GSM x 228.6 / (warp mesh + weft mesh), the same denier
       in both directions; 228.6 = 9000 m per denier / 39.37 in per m. The
       legacy (GSM/500 x 610 x 9) / avg mesh x 40 gave 3070 for a 70 GSM 10x10
       fabric that is 800. Reporting only — the weight is untouched. */
    const DNR_F = KD_('DENIER FACTOR', 228.6) || 228.6;
    const DNR_STEP = KD_('DENIER ROUNDING STEP', 10) || 10;
    const MESH_SUM = n(M_WARP) + n(M_WEFT);
    const BODY_DNR = T('BODY DNR', 'Body denier', 'ROUND(BD FAB GSM*K[DENIER FACTOR]/(M.WARP+M.WEFT)/K[DNR STEP])*K[DNR STEP]',
      MESH_SUM > 0 ? Math.round((n(BD_FAB_GSM) * DNR_F / MESH_SUM) / DNR_STEP) * DNR_STEP : 0, { BD_FAB_GSM, M_WARP, M_WEFT });
    const FLAT_DNR = T('FLAT DNR', 'Flat denier', 'ROUND(FLT FAB GSM*K[DENIER FACTOR]/(M.WARP+M.WEFT)/K[DNR STEP])*K[DNR STEP]',
      MESH_SUM > 0 ? Math.round((n(FLT_FAB_GSM) * DNR_F / MESH_SUM) / DNR_STEP) * DNR_STEP : 0, { FLT_FAB_GSM, M_WARP, M_WEFT });

    // ---- 7. Coating/BOPP/metallised GSM, side-adjusted ----------------
    const BD_CT_GSM_SD = T('BD CT GSM SD', 'Body coating total GSM', 'IF(BD CT SD="ONE", BD CT GSM/2, BD CT GSM)',
      eq(BD_CT_SD, 'ONE') ? n(BD_CT_GSM) / 2 : n(BD_CT_GSM), { BD_CT_GSM, BD_CT_SD });
    const PTC_CT_GSM_SD = T('PTC CT GSM SD', 'Patch/valve coating total GSM', 'IF(PTC CT SD="ONE", FLT CT GSM, FLT CT GSM*2)',
      eq(PTC_CT_SD, 'ONE') ? n(FLT_CT_GSM) : n(FLT_CT_GSM) * 2, { FLT_CT_GSM, PTC_CT_SD });

    /* Micron → GSM. The density factor belongs to the plant's film, not to
       the app: "BOPP micron to GSM as 0.90 or 0.92 something". BOPP and
       metallised are separate constants so the two can differ. */
    const BOP_F = KD_('BOPP MICRON TO GSM FACTOR', 0.92);
    const MET_F = KD_('METALLISED MICRON TO GSM FACTOR', 0.92);
    /* 4.53.0 — THE FILM IS THE FILM; THE INK IS THE INK.

         "wait if u treating adhesive as seperate then bopp ink gsm
          will be also seperate everywhere"

       The same fault the adhesive had in 4.52.0, one layer along. The
       print ink was added INTO the BOPP film’s GSM, and it weighed
       correctly there — but a kilogram of ink was then bought as a
       kilogram of film, from a supplier who does not sell ink.

       So the film carries only the film, and the ink is a figure of
       its own that the BOM can see, share out and cost. NOT ONE GRAM
       MOVES: what left BD BOP MIC GSM SD arrives in BD INK GSM SD,
       over the same area, and the body total below adds both.

       It exists exactly where it existed before — only on a bag that
       HAS a BOPP film, because that is what the ink is printed on. A
       blank micron still means no film and no ink. The structure tick
       still decides whether there is any ink at all (INK_GSM is 0
       without it), so an unprinted laminate is unchanged. */
    const BD_BOP_MIC_GSM_SD = T('BD BOP MIC GSM SD', 'Body BOPP film GSM',
      'IF(BD BOP MIC blank,"", IF(BD BOP SD="ONE", MIC/2*K[BOPP FACTOR], MIC*K[BOPP FACTOR]))',
      isBlank(BD_BOP_MIC) ? 0 : (eq(BD_BOP_SD, 'ONE') ? (n(BD_BOP_MIC) / 2) * BOP_F : n(BD_BOP_MIC) * BOP_F),
      { BD_BOP_MIC, BD_BOP_SD });
    const BD_INK_GSM_SD = T('BD INK GSM SD', 'Body print ink GSM',
      'IF(BD BOP MIC blank, 0, INK GSM)',
      isBlank(BD_BOP_MIC) ? 0 : INK_GSM,
      { BD_BOP_MIC, INK_GSM });
    /* 4.52.0 — THE FILM IS THE FILM; THE GLUE IS THE GLUE.

         "adhesive proccess ma bopp sathe metalic adhesive thay che
          chemical thi"

       The adhesive of a dry lamination used to be added INTO the
       metallised film's GSM, and it weighed correctly there — but a
       kilogram of it was then bought as metallised film. The plant buys
       two things: film by the kilogram, and adhesive by the kilogram.

       So the film now carries only the film, and the adhesive is a
       figure of its own that the BOM can see and cost. NOT ONE GRAM
       MOVES: what left BD MT MIC GSM SD arrives in BD ADH GSM SD, over
       the same area, and the body total below adds both.

       It exists exactly where it existed before — only on a bag that
       has a metallised film, because that is the lamination the glue is
       for. A blank micron still means no film and no glue. */
    const BD_MT_MIC_GSM_SD = T('BD MT MIC GSM SD', 'Body metallised film GSM',
      'IF(BD MT MIC blank,"", IF(BD MT SD="ONE", MIC/2*K[METALLISED FACTOR], MIC*K[METALLISED FACTOR]))',
      isBlank(BD_MT_MIC) ? 0 : (eq(BD_MT_SD, 'ONE') ? (n(BD_MT_MIC) / 2) * MET_F : n(BD_MT_MIC) * MET_F),
      { BD_MT_MIC, BD_MT_SD });
    const BD_ADH_GSM_SD = T('BD ADH GSM SD', 'Body lamination adhesive GSM',
      'IF(BD MT MIC blank, 0, ADHESIVE GSM)',
      isBlank(BD_MT_MIC) ? 0 : ADHESIVE_GSM,
      { BD_MT_MIC, ADHESIVE_GSM });
    const PTC_BOP_MIC_GSM_SD = T('PTC BOP MIC GSM SD', 'Patch BOPP film GSM',
      'IF(PTC BOP MIC blank,"", IF(PTC BOP SD="ONE", MIC*K[BOPP FACTOR], MIC*2*K[BOPP FACTOR]))',
      isBlank(PTC_BOP_MIC) ? 0 : (eq(PTC_BOP_SD, 'ONE') ? n(PTC_BOP_MIC) * BOP_F : (n(PTC_BOP_MIC) * 2) * BOP_F),
      { PTC_BOP_MIC, PTC_BOP_SD });
    const PTC_INK_GSM_SD = T('PTC INK GSM SD', 'Patch print ink GSM',
      'IF(PTC BOP MIC blank, 0, INK GSM)',
      isBlank(PTC_BOP_MIC) ? 0 : INK_GSM,
      { PTC_BOP_MIC, INK_GSM });
    const PTC_MT_MIC_GSM_SD = T('PTC MT MIC GSM SD', 'Patch metallised film GSM',
      'IF(PTC MT MIC blank,"", IF(PTC MT SD="ONE", MIC*K[METALLISED FACTOR], MIC*2*K[METALLISED FACTOR]))',
      isBlank(PTC_MT_MIC) ? 0 : (eq(PTC_MT_SD, 'ONE') ? n(PTC_MT_MIC) * MET_F : (n(PTC_MT_MIC) * 2) * MET_F),
      { PTC_MT_MIC, PTC_MT_SD });
    const PTC_ADH_GSM_SD = T('PTC ADH GSM SD', 'Patch lamination adhesive GSM',
      'IF(PTC MT MIC blank, 0, ADHESIVE GSM)',
      isBlank(PTC_MT_MIC) ? 0 : ADHESIVE_GSM,
      { PTC_MT_MIC, ADHESIVE_GSM });

    // ---- 8. Patch/valve strip counts -----------------------------------
    const NPS = T('NPS', 'No. of patch strips', 'IF(PATCH>K[PATCH STRIP WIDTH LIMIT], K[PATCH STRIPS ABOVE LIMIT], K[PATCH STRIP])',
      n(PATCH) > KD_('PATCH STRIP WIDTH LIMIT', 115) ? KD_('PATCH STRIPS ABOVE LIMIT', 4) : KD_('PATCH STRIP', 6), { PATCH });
    const NVS = T('NVS', 'No. of valve strips', 'IF(VALVE>0,K[VALVE STRIP],"")', n(VALVE) > 0 ? K_('VALVE STRIP') : 0, { VALVE });

    // ---- 9. Body / patch / valve / handle sizes (Stage C1) -------------
    const BODY_WIDTH = T('BODY WIDTH', 'Body width', 'IF(BACKSEAM="YES", (WIDTH*2+K[BACKSEAM OVERLAP])/2, WIDTH)',
      eq(BACKSEAM, 'YES') ? ((n(WIDTH) * 2) + K_('BACKSEAM OVERLAP')) / 2 : n(WIDTH), { WIDTH, BACKSEAM });
    const BODY_LENGTH = T('BODY LENGTH', 'Body length', 'IF(DSB not blank, DSB, CUT LENGTH)', isNotBlank(DSB) ? DSB : CUT_LENGTH, { DSB, CUT_LENGTH });

    const PTC_ALLOW = KD_('PATCH SIZE ALLOWANCE', 5);
    const T_PTC_WIDTH = T('T PTC WIDTH', 'Top patch width', 'IF(VALVE blank,"", PATCH-K[PATCH SIZE ALLOWANCE])', isBlank(VALVE) ? undefined : n(PATCH) - PTC_ALLOW, { VALVE, PATCH });
    const T_PTC_LENGTH = T('T PTC LENGTH', 'Top patch length', 'IF(VALVE blank,"", (WIDTH+EX-VALVE)-PATCH-K[PATCH SIZE ALLOWANCE])',
      isBlank(VALVE) ? undefined : (n(WIDTH) + n(EX_VALVE)) - n(PATCH) - PTC_ALLOW, { WIDTH, EX_VALVE, PATCH, VALVE });
    const B_PTC_WIDTH = T('B PTC WIDTH', 'Bottom patch width', 'IF(PATCH blank,"", PATCH-K[PATCH SIZE ALLOWANCE])', isBlank(PATCH) ? undefined : n(PATCH) - PTC_ALLOW, { PATCH });
    const B_PTC_LENGTH = T('B PTC LENGTH', 'Bottom patch length', 'IF(PATCH blank,"", WIDTH-(PATCH+K[PATCH SIZE ALLOWANCE]))', isBlank(PATCH) ? undefined : n(WIDTH) - (n(PATCH) + PTC_ALLOW), { WIDTH, PATCH });
    const V_DEPTH = T('V DEPTH', 'Valve depth', 'IF(VALVE blank,"", VALVE+EX-VALVE)', isBlank(VALVE) ? undefined : n(VALVE) + n(EX_VALVE), { VALVE, EX_VALVE });
    const V_WIDTH = T('V WIDTH', 'Valve width', 'IF(VALVE blank,"", PATCH*2+OV)', isBlank(VALVE) ? undefined : n(PATCH) * 2 + OV, { VALVE, PATCH, OV });
    const HANDLE_WIDTH = T('HANDLE WIDTH', 'Handle width', 'IF(HANDLE="YES", H.WIDTH, "")', eq(HANDLE, 'YES') ? n(H_WIDTH) : undefined, { HANDLE, H_WIDTH });
    const HANDLE_LENGTH = T('HANDLE LENGTH', 'Handle length', 'IF(HANDLE="YES", H.LENGTH, "")', eq(HANDLE, 'YES') ? n(H_LENGTH) : undefined, { HANDLE, H_LENGTH });

    const YTS = T('YTS', 'Yarn top-stitching length', 'IF(HAMMING or HANDLE not blank, WIDTH, "")', (isNotBlank(HAMMING) || isNotBlank(HANDLE)) ? n(WIDTH) : 0, { HAMMING, HANDLE, WIDTH });
    const YBS = T('YBS', 'Yarn bottom-stitching length', 'IF(BOTTOM FOLD not blank, WIDTH, "")', isNotBlank(BOTTOM_FOLD) ? n(WIDTH) : 0, { BOTTOM_FOLD, WIDTH });
    const BEG = T('BEG', 'Backseam granules (per-metre basis)', 'IF(BACKSEAM="YES", K[BACKSEAM GRANUAL PER METER], "")', eq(BACKSEAM, 'YES') ? K_('BACKSEAM GRANUAL PER METER') : 0, { BACKSEAM });
    const EZ_EXTEND = eq(EASY_OPEN, 'YES') ? (BODY_WIDTH + K_('EASYOPEN CREEP PULL EXTEND')) : 0;
    const EZCY = T('EZCY', 'Easy-open cotton yarn length', 'IF(EASY OPEN="YES", BODY WIDTH+K[EXTEND], "")', EZ_EXTEND, { EASY_OPEN, BODY_WIDTH });
    const EZCTP = T('EZCTP', 'Easy-open creep tape length', 'same as EZCY', EZ_EXTEND, { EASY_OPEN, BODY_WIDTH });
    const EZPTP = T('EZPTP', 'Easy-open pull tape length', 'same as EZCY', EZ_EXTEND, { EASY_OPEN, BODY_WIDTH });
    /* 4.59.0 — across the mouth of a pinch-bottom bag, over the width the
       gusset does not fold away: 500 wide with a 100 gusset is 400. */
    const MOUTH_RUN = Math.max(0, n(WIDTH) - n(GUSSET));
    const ZIP_LEN = T('ZIP LEN', 'Zipper length', 'IF(ZIPPER="YES", WIDTH-GUSSET, 0)', eq(ZIPPER, 'YES') ? MOUTH_RUN : 0, { ZIPPER, WIDTH, GUSSET });
    const PEO_LEN = T('PEO LEN', 'Pinch easy-open strip length', 'IF(PINCH EASY OPEN="YES", WIDTH-GUSSET, 0)', eq(PINCH_EO, 'YES') ? MOUTH_RUN : 0, { PINCH_EO, WIDTH, GUSSET });

    // C1 (component sizes, resolved against drum-size overrides)
    const BWC1 = BODY_WIDTH;
    const BLC1 = isBlank(DSB) ? CUT_LENGTH : DSB;
    const TPWC1 = T_PTC_WIDTH;
    const TPLC1 = isNotBlank(DSTP) ? DSTP / K_('PATCH REPEAT') : T_PTC_LENGTH;
    const BPWC1 = B_PTC_WIDTH;
    const BPLC1 = isBlank(DSBP) ? B_PTC_LENGTH : DSBP / K_('PATCH REPEAT');
    const VDC1 = isBlank(V_DEPTH) ? undefined : V_DEPTH;
    const VWC1 = isBlank(V_WIDTH) ? undefined : V_WIDTH;
    const HW1C1 = HANDLE_WIDTH;
    const HL1C1 = HANDLE_LENGTH;

    // ---- 10. Component areas (Stage C2) --------------------------------
    const MBC2 = T('MBC2', 'Body area (mm^2)', 'IF(BWC1 blank, BODY WIDTH*BODY LENGTH, BWC1*BLC1) * 2',
      (isBlank(BWC1) ? n(BODY_WIDTH) * n(BODY_LENGTH) : n(BWC1) * n(BLC1)) * 2, { BWC1, BLC1, BODY_WIDTH, BODY_LENGTH });
    const TPC2 = T('TPC2', 'Top patch area (mm^2)', 'IF(TPLC1 blank, T PTC WIDTH*T PTC LENGTH, TPWC1*TPLC1)',
      isBlank(TPLC1) ? n(T_PTC_WIDTH) * n(T_PTC_LENGTH) : n(TPWC1) * n(TPLC1), { TPWC1, TPLC1, T_PTC_WIDTH, T_PTC_LENGTH });
    const BPC2 = T('BPC2', 'Bottom patch area (mm^2)', 'IF(BPLC1 blank, B PTC WIDTH*B PTC LENGTH, BPWC1*BPLC1)',
      isBlank(BPLC1) ? n(B_PTC_WIDTH) * n(B_PTC_LENGTH) : n(BPWC1) * n(BPLC1), { BPWC1, BPLC1, B_PTC_WIDTH, B_PTC_LENGTH });
    const VC2 = T('VC2', 'Valve area (mm^2)', 'VDC1 * VWC1', n(VDC1) * n(VWC1), { VDC1, VWC1 });
    const HC2 = T('HC2', 'Handle area (mm^2)', 'HW1C1 * HL1C1', n(HW1C1) * n(HL1C1), { HW1C1, HL1C1 });

    const YTSC2 = T('YTSC2', 'Yarn top-stitch weight (pre-scale, g)', 'IF(HANDLE="YES", K[YARN]/1000*YTS, K[YARN]/1000*YTS/K[NO-HANDLE FACTOR])',
      eq(HANDLE, 'YES') ? (K_('YARN WEIGHT FOR 1000MM') / 1000) * YTS
        : ((K_('YARN WEIGHT FOR 1000MM') / 1000) * YTS) / (KD_('YARN TOP STITCH FACTOR WITHOUT HANDLE', 1.5) || 1.5), { HANDLE, YTS });
    const YBSC2 = T('YBSC2', 'Yarn bottom-stitch weight (pre-scale, g)', 'K[YARN]/1000*YBS', (K_('YARN WEIGHT FOR 1000MM') / 1000) * YBS, { YBS });
    const LC2 = LNR_WT;
    const BSC2 = BEG;
    const EZCYC2 = T('EZCYC2', 'Easy-open yarn weight (pre-scale, g)', 'IF(EASY OPEN="YES", K[COTTON YARN]/1000*EZCY, "")',
      eq(EASY_OPEN, 'YES') ? (K_('COTTOM YARN WEIGHT FOR 1000MM') / 1000) * EZCY : 0, { EASY_OPEN, EZCY });
    const PCTPC2 = T('PCTPC2', 'Pull/creep tape weight (pre-scale, g)', 'IF(EZCTP>0,K[CREEP]/1000*EZCTP,0) + IF(EZPTP>0,K[PULL]/1000*EZPTP,0)',
      (EZCTP > 0 ? (K_('CREEP TAPE 1000MM WEIGHT') / 1000) * EZCTP : 0) + (EZPTP > 0 ? (K_('PULL TAPE 1000MM WEIGHT') / 1000) * EZPTP : 0), { EZCTP, EZPTP });

    // ---- 11. Component weight layers: coating(C4) / BOPP(C5) / metallised(C6) / base fabric(C7) ----
    const backseamYes = eq(BACKSEAM, 'YES');
    const CT_ALLOW = KD_('BODY COATING WIDTH ALLOWANCE', 10);
    const LAM_TRIM = KD_('BODY LAMINATION TRIM ALLOWANCE', 5);
    const MBC4 = T('MBC4', 'Body coating weight (g)', 'BD CT GSM SD/1e6 * IF(BACKSEAM="YES", MBC2, ((BWC1+K[COATING ALLOWANCE])*BLC1)*2)',
      (BD_CT_GSM_SD / 1000000) * (backseamYes ? MBC2 : ((n(BWC1) + CT_ALLOW) * n(BLC1)) * 2), { BD_CT_GSM_SD, MBC2, BWC1, BLC1, BACKSEAM });
    const TPC4 = T('TPC4', 'Top patch coating weight (g)', 'PTC CT GSM SD/1e6 * TPC2', (PTC_CT_GSM_SD / 1000000) * TPC2, { PTC_CT_GSM_SD, TPC2 });
    const BPC4 = T('BPC4', 'Bottom patch coating weight (g)', 'PTC CT GSM SD/1e6 * BPC2', (PTC_CT_GSM_SD / 1000000) * BPC2, { PTC_CT_GSM_SD, BPC2 });
    const VC4 = T('VC4', 'Valve coating weight (g)', 'PTC CT GSM SD/1e6 * VC2', (PTC_CT_GSM_SD / 1000000) * VC2, { PTC_CT_GSM_SD, VC2 });

    const bodyAlt = ((n(BWC1) - LAM_TRIM) * n(BLC1)) * 2;
    const bodyDefault = ((n(BWC1) + CT_ALLOW) * n(BLC1)) * 2;
    const MBC5 = T('MBC5', 'Body BOPP weight (g)', 'BD BOP MIC GSM SD/1e6 * IF(BACKSEAM="YES", (BWC1-5)*BLC1*2, (BWC1+10)*BLC1*2)',
      (BD_BOP_MIC_GSM_SD / 1000000) * (backseamYes ? bodyAlt : bodyDefault), { BD_BOP_MIC_GSM_SD, BWC1, BLC1, BACKSEAM });
    const TPC5 = T('TPC5', 'Top patch BOPP weight (g)', 'PTC BOP MIC GSM SD/1e6 * TPC2', (PTC_BOP_MIC_GSM_SD / 1000000) * TPC2, { PTC_BOP_MIC_GSM_SD, TPC2 });
    const BPC5 = T('BPC5', 'Bottom patch BOPP weight (g)', 'PTC BOP MIC GSM SD/1e6 * BPC2', (PTC_BOP_MIC_GSM_SD / 1000000) * BPC2, { PTC_BOP_MIC_GSM_SD, BPC2 });

    const MBC6 = T('MBC6', 'Body metallised weight (g)', 'BD MT MIC GSM SD/1e6 * IF(BACKSEAM="YES", (BWC1-5)*BLC1*2, (BWC1+10)*BLC1*2)',
      (BD_MT_MIC_GSM_SD / 1000000) * (backseamYes ? bodyAlt : bodyDefault), { BD_MT_MIC_GSM_SD, BWC1, BLC1, BACKSEAM });
    const TPC6 = T('TPC6', 'Top patch metallised weight (g)', 'PTC MT MIC GSM SD/1e6 * TPC2', (PTC_MT_MIC_GSM_SD / 1000000) * TPC2, { PTC_MT_MIC_GSM_SD, TPC2 });
    const BPC6 = T('BPC6', 'Bottom patch metallised weight (g)', 'PTC MT MIC GSM SD/1e6 * BPC2', (PTC_MT_MIC_GSM_SD / 1000000) * BPC2, { PTC_MT_MIC_GSM_SD, BPC2 });

    /* 4.52.0 — the glue of the dry lamination, over exactly the area
       its film covers, so the two together weigh what the film alone
       weighed before. */
    const MBC10 = T('MBC10', 'Body lamination adhesive weight (g)',
      'BD ADH GSM SD/1e6 * IF(BACKSEAM="YES", (BWC1-5)*BLC1*2, (BWC1+10)*BLC1*2)',
      (BD_ADH_GSM_SD / 1000000) * (backseamYes ? bodyAlt : bodyDefault), { BD_ADH_GSM_SD, BWC1, BLC1, BACKSEAM });
    const TPC10 = T('TPC10', 'Top patch lamination adhesive weight (g)', 'PTC ADH GSM SD/1e6 * TPC2',
      (PTC_ADH_GSM_SD / 1000000) * TPC2, { PTC_ADH_GSM_SD, TPC2 });
    const BPC10 = T('BPC10', 'Bottom patch lamination adhesive weight (g)', 'PTC ADH GSM SD/1e6 * BPC2',
      (PTC_ADH_GSM_SD / 1000000) * BPC2, { PTC_ADH_GSM_SD, BPC2 });

    /* 4.53.0 — the print ink, over exactly the area its film covers,
       so film and ink together weigh what the film alone weighed. */
    const MBC11 = T('MBC11', 'Body print ink weight (g)',
      'BD INK GSM SD/1e6 * IF(BACKSEAM="YES", (BWC1-5)*BLC1*2, (BWC1+10)*BLC1*2)',
      (BD_INK_GSM_SD / 1000000) * (backseamYes ? bodyAlt : bodyDefault), { BD_INK_GSM_SD, BWC1, BLC1, BACKSEAM });
    const TPC11 = T('TPC11', 'Top patch print ink weight (g)', 'PTC INK GSM SD/1e6 * TPC2',
      (PTC_INK_GSM_SD / 1000000) * TPC2, { PTC_INK_GSM_SD, TPC2 });
    const BPC11 = T('BPC11', 'Bottom patch print ink weight (g)', 'PTC INK GSM SD/1e6 * BPC2',
      (PTC_INK_GSM_SD / 1000000) * BPC2, { PTC_INK_GSM_SD, BPC2 });

    const MBC7 = T('MBC7', 'Body base-fabric weight (g)', 'BD FAB GSM/1e6 * MBC2', (n(BD_FAB_GSM) / 1000000) * MBC2, { BD_FAB_GSM, MBC2 });
    const TPC7 = T('TPC7', 'Top patch base-fabric weight (g)', 'FLT FAB GSM/1e6 * TPC2', (n(FLT_FAB_GSM) / 1000000) * TPC2, { FLT_FAB_GSM, TPC2 });
    const BPC7 = T('BPC7', 'Bottom patch base-fabric weight (g)', 'FLT FAB GSM/1e6 * BPC2', (n(FLT_FAB_GSM) / 1000000) * BPC2, { FLT_FAB_GSM, BPC2 });
    const VC7 = T('VC7', 'Valve base-fabric weight (g)', 'FLT FAB GSM/1e6 * VC2', (n(FLT_FAB_GSM) / 1000000) * VC2, { FLT_FAB_GSM, VC2 });

    // ---- 12. Component totals (Stage C3) --------------------------------
    const MBC3 = T('MBC3', 'Body total weight (g)', 'MBC4+MBC5+MBC6+MBC7+MBC10+MBC11', MBC4 + MBC5 + MBC6 + MBC7 + MBC10 + MBC11, { MBC4, MBC5, MBC6, MBC7, MBC10, MBC11 });
    const TPC3 = T('TPC3', 'Top patch total weight (g)', 'TPC4+TPC5+TPC6+TPC7+TPC10+TPC11', TPC4 + TPC5 + TPC6 + TPC7 + TPC10 + TPC11, { TPC4, TPC5, TPC6, TPC7, TPC10, TPC11 });
    const BPC3 = T('BPC3', 'Bottom patch total weight (g)', 'BPC4+BPC5+BPC6+BPC7+BPC10+BPC11', BPC4 + BPC5 + BPC6 + BPC7 + BPC10 + BPC11, { BPC4, BPC5, BPC6, BPC7, BPC10, BPC11 });
    const VC3 = T('VC3', 'Valve total weight (g)', 'VC4+VC7', VC4 + VC7, { VC4, VC7 });
    const HC3 = T('HC3', 'Handle weight (g)', '(K[HANDLE WEIGHT 25X250]/K[HANDLE REFERENCE AREA])*HC2*1000',
      (K_('HANDLE WEIGHT 25X250') / (KD_('HANDLE REFERENCE AREA', 6250) || 6250)) * HC2 * 1000, { HC2 });
    const YC3 = T('YC3', 'Yarn/thread weight (g)', '(YTSC2+YBSC2)*1000', (YTSC2 + YBSC2) * 1000, { YTSC2, YBSC2 });
    const BSC3 = T('BSC3', 'Backseam granules weight (g)', '(BSC2/1000)*BLC1', (n(BSC2) / 1000) * n(BLC1), { BSC2, BLC1 });
    const PCTPC3 = T('PCTPC3', 'Easy-open tapes+yarn weight (g)', 'IF(EASY OPEN="YES", (EZCYC2+PCTPC2)*1000, 0)',
      eq(EASY_OPEN, 'YES') ? (EZCYC2 + PCTPC2) * 1000 : 0, { EZCYC2, PCTPC2 });
    /* 4.59.0 — two parts, two weights: the zipper (the whole assembly,
       tracker included) and the pinch easy-open strip. */
    const ZC3 = T('ZC3', 'Zipper weight (g)', 'ZIP LEN * K[ZIPPER WEIGHT PER MM]',
      ZIP_LEN > 0 ? ZIP_LEN * KD_('ZIPPER WEIGHT PER MM', 0.045) : 0, { ZIP_LEN });
    const PEOC3 = T('PEOC3', 'Pinch easy-open strip weight (g)', 'PEO LEN * K[PINCH EASY OPEN STRIP WEIGHT PER MM]',
      PEO_LEN > 0 ? PEO_LEN * KD_('PINCH EASY OPEN STRIP WEIGHT PER MM', 0.002) : 0, { PEO_LEN });

    // ---- 13. Reporting-only GPM figures (not part of RESULT WEIGHT) ----
    /* Trimming belongs to a cut that happens. A bag with no patch has no
       patch fabric and therefore no patch trimming, and the same for the
       valve — before 4.34.0 that fell out of the arithmetic only because TR
       and TRV were always 0, which stopped being true the moment they began
       reading the Constants Master. Now it is said rather than implied. */
    const PATCH_FAB_SIZE = T('PATCH FAB SIZE', 'Patch fabric size', 'IF(PATCH blank, 0, (B PTC WIDTH*NPS)+TR)',
      isBlank(PATCH) ? 0 : n(B_PTC_WIDTH) * NPS + TR, { PATCH, B_PTC_WIDTH, NPS, TR });
    const VALVE_FAB_SIZE = T('VALVE FAB SIZE', 'Valve fabric size', 'IF(VALVE blank, 0, ((PATCH*2+OV)*NVS)+TRV)',
      isBlank(VALVE) ? 0 : ((n(PATCH) * 2 + OV) * NVS) + TRV, { VALVE, PATCH, OV, NVS, TRV });

    const MBC8 = T('MBC8', 'Body UL GPM', 'IF(BACKSEAM="YES", (BD FAB GSM/1000)*((BWC1*2)+K[BACKSEAM LAMI TRIM]), (BD FAB GSM/500)*BWC1)',
      backseamYes
        ? round1((n(BD_FAB_GSM) / 1000) * ((n(BWC1) * 2) + K_('BACKSEAM LAMINATION TRIMING')))
        : round1((n(BD_FAB_GSM) / 500) * n(BWC1)), { BD_FAB_GSM, BWC1, BACKSEAM });
    const TPC8 = T('TPC8', 'T.P. UL GPM', 'FLT FAB GSM/1000 * PATCH FAB SIZE', round1((n(FLT_FAB_GSM) / 1000) * PATCH_FAB_SIZE), { FLT_FAB_GSM, PATCH_FAB_SIZE });
    const BPC8 = T('BPC8', 'B.P. UL GPM', 'FLT FAB GSM/1000 * PATCH FAB SIZE', round1((n(FLT_FAB_GSM) / 1000) * PATCH_FAB_SIZE), { FLT_FAB_GSM, PATCH_FAB_SIZE });
    const VC8 = T('VC8', 'Valve UL GPM', 'FLT FAB GSM/1000 * VALVE FAB SIZE', round1((n(FLT_FAB_GSM) / 1000) * VALVE_FAB_SIZE), { FLT_FAB_GSM, VALVE_FAB_SIZE });

    /* 4.52.0, extended in 4.53.0 — the adhesive AND the ink are part of
       the laminated web. Taking either out of the film’s GSM must not
       take it off the metre coming off the machine. */
    const MBC9 = T('MBC9', 'Body LAMI GPM', '((BD FAB GSM+BD CT GSM SD+BD BOP MIC GSM SD+BD INK GSM SD+BD MT MIC GSM SD+BD ADH GSM SD)/500)*BWC1',
      round1(((n(BD_FAB_GSM) + BD_CT_GSM_SD + BD_BOP_MIC_GSM_SD + BD_INK_GSM_SD + BD_MT_MIC_GSM_SD + BD_ADH_GSM_SD) / 500) * n(BWC1)), { BD_FAB_GSM, BD_CT_GSM_SD, BD_BOP_MIC_GSM_SD, BD_INK_GSM_SD, BD_MT_MIC_GSM_SD, BD_ADH_GSM_SD, BWC1 });
    const TPC9 = T('TPC9', 'T.P. LAMI GPM', 'IF(TPC2<1,0,((FLT FAB GSM+coating+bopp+ink+met+adhesive)/1000)*PATCH FAB SIZE)',
      TPC2 < 1 ? 0 : round1((((n(FLT_FAB_GSM) + PTC_CT_GSM_SD + PTC_BOP_MIC_GSM_SD + PTC_INK_GSM_SD + PTC_MT_MIC_GSM_SD + PTC_ADH_GSM_SD) / 1000)) * PATCH_FAB_SIZE), { FLT_FAB_GSM, PTC_CT_GSM_SD, PTC_BOP_MIC_GSM_SD, PTC_INK_GSM_SD, PTC_MT_MIC_GSM_SD, PTC_ADH_GSM_SD, PATCH_FAB_SIZE, TPC2 });
    const BPC9 = T('BPC9', 'B.P. LAMI GPM', 'IF(BPC2<1,0,((FLT FAB GSM+coating+bopp+ink+met+adhesive)/1000)*PATCH FAB SIZE)',
      BPC2 < 1 ? 0 : round1((((n(FLT_FAB_GSM) + PTC_CT_GSM_SD + PTC_BOP_MIC_GSM_SD + PTC_INK_GSM_SD + PTC_MT_MIC_GSM_SD + PTC_ADH_GSM_SD) / 1000)) * PATCH_FAB_SIZE), { FLT_FAB_GSM, PTC_CT_GSM_SD, PTC_BOP_MIC_GSM_SD, PTC_INK_GSM_SD, PTC_MT_MIC_GSM_SD, PTC_ADH_GSM_SD, PATCH_FAB_SIZE, BPC2 });
    const VC9 = T('VC9', 'Valve LAMI GPM', 'IF(VC2<1,0,((FLT FAB GSM+PTC CT GSM SD)/1000)*VALVE FAB SIZE)',
      VC2 < 1 ? 0 : round1(((n(FLT_FAB_GSM) + PTC_CT_GSM_SD) / 1000) * VALVE_FAB_SIZE), { FLT_FAB_GSM, PTC_CT_GSM_SD, VALVE_FAB_SIZE, VC2 });

    // ---- 14. RESULT WEIGHT ---------------------------------------------
    /* The zipper and the strip are added only when there is one, so every
       bag without them sums in exactly the order it always did. */
    const RESULT_BASE = MBC3 + TPC3 + BPC3 + VC3 + HC3 + YC3 + LNR_WT + BSC3 + PCTPC3;
    const RESULT_WEIGHT = T('RESULT WEIGHT', 'Calculated bag weight (g)',
      'MBC3 + TPC3 + BPC3 + VC3 + HC3 + YC3 + LNR WT + BSC3 + PCTPC3 + ZC3 + PEOC3',
      (ZC3 > 0 || PEOC3 > 0) ? RESULT_BASE + ZC3 + PEOC3 : RESULT_BASE,
      { MBC3, TPC3, BPC3, VC3, HC3, YC3, LNR_WT, BSC3, PCTPC3, ZC3, PEOC3 });

    // ---- 15. Target / tolerance / variance -----------------------------
    const targetWeight = nOrBlank(input['TARGET WEIGHT']);
    /* 4.50.0 — AN EMPTY BOX IS NOT A TOLERANCE OF ZERO.

       The test was `!== undefined`, and the form stores an empty string
       when the box is cleared rather than dropping the key. So clearing
       Downside % handed the engine '', which n() reads as 0, and the
       band collapsed onto the target: every bag that was not EXACTLY on
       target reported as out of tolerance, and the 2 % default could
       never come back without typing it again.

       Blank means "not given" everywhere else in this engine — that is
       what isBlank() is for — and it means it here too. A typed 0 is
       still a real answer: somebody who wants no tolerance at all can
       still say so. */
    const downsidePct = n(isNotBlank(input['DOWNSIDE %']) ? input['DOWNSIDE %'] : KD_('DEFAULT DOWNSIDE %', 2));
    const upsidePct = n(isNotBlank(input['UPSIDE %']) ? input['UPSIDE %'] : KD_('DEFAULT UPSIDE %', 2));
    const minWeight = isNotBlank(targetWeight) ? targetWeight * (1 - downsidePct / 100) : undefined;
    const maxWeight = isNotBlank(targetWeight) ? targetWeight * (1 + upsidePct / 100) : undefined;
    const variance = isNotBlank(targetWeight) ? RESULT_WEIGHT - targetWeight : undefined;
    const variancePct = isNotBlank(targetWeight) && targetWeight !== 0 ? (variance / targetWeight) * 100 : undefined;

    if (isNotBlank(targetWeight) && isNotBlank(minWeight) && isNotBlank(maxWeight)) {
      if (RESULT_WEIGHT < minWeight || RESULT_WEIGHT > maxWeight) {
        warnings.push('Calculated weight (' + RESULT_WEIGHT.toFixed(2) + ' g) is outside the tolerance band [' + minWeight.toFixed(2) + ' – ' + maxWeight.toFixed(2) + ' g].');
      }
    }
    if (isBlank(targetWeight)) {
      info.push('No target weight entered — variance and tolerance band cannot be shown.');
    }

    // ---- 16. Component-wise breakdown table (spec §20) ------------------
    const components = [
      { name: 'Body (fabric+coating+BOPP+metallised)', weight: MBC3 },
      { name: 'Top patch', weight: TPC3 },
      { name: 'Bottom patch', weight: BPC3 },
      { name: 'Valve', weight: VC3 },
      { name: 'Handle', weight: HC3 },
      { name: 'Yarn / thread', weight: YC3 },
      { name: 'Liner', weight: LNR_WT },
      { name: 'Backseam granules', weight: BSC3 },
      { name: 'Easy-open tapes', weight: PCTPC3 },
      { name: 'Zipper', weight: ZC3 },
      { name: 'Pinch easy-open strip', weight: PEOC3 }
    ].filter((c) => c.weight && c.weight > 0.0001);

    const totalForPct = components.reduce((s, c) => s + c.weight, 0) || 1;
    components.forEach((c) => { c.percent = (c.weight / totalForPct) * 100; });

    return {
      netWeight: RESULT_WEIGHT,
      grossWeight: RESULT_WEIGHT, // wastage applied at BOM stage (Stage 2), not weight stage
      targetWeight,
      minWeight,
      maxWeight,
      variance,
      variancePercent: variancePct,
      components,
      reporting: { BODY_DNR, FLAT_DNR, MBC8, TPC8, BPC8, VC8, MBC9, TPC9, BPC9, VC9 },
      derived: {
        BTM_FOLD_SZ, HAMMING_SZ, MESH, OP, CUT_LENGTH, BODY_WIDTH, BODY_LENGTH,
        T_PTC_WIDTH, T_PTC_LENGTH, B_PTC_WIDTH, B_PTC_LENGTH, V_DEPTH, V_WIDTH,
        HANDLE_WIDTH, HANDLE_LENGTH, BWC1, BLC1, TPWC1, TPLC1, BPWC1, BPLC1, VDC1, VWC1,
        MBC2, TPC2, BPC2, VC2, HC2, NPS, NVS, PATCH_FAB_SIZE, VALVE_FAB_SIZE,
        PINCH_SZ, GUSSET: n(GUSSET), ZIP_LEN, PEO_LEN
      },
      trace,
      /* The constants that played a part in THIS bag, in name order. */
      constantsUsed: Object.keys(constantsUsed).sort(),
      warnings,
      errors,
      info
    };
  }

  return { calculate, helpers: { isBlank, isNotBlank, n, nOrBlank, round1 } };
});

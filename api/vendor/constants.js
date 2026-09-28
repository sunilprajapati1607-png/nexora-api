/**
 * Nexora — Technical Constants Master
 * Source: recovered from the legacy AppSheet "DEFAULT" table (25 rows).
 * These are the same real production values the legacy system used —
 * NOT invented. Each formula in calculationEngine.js references these
 * by DESCRIPTION, exactly like the original AppSheet formulas did via
 * ANY(SELECT(DEFAULT[VALUE],[DESCRIPTION]="...")).
 *
 * This is a live, editable master in the running app (see constantsStore.js) —
 * this file only supplies the seed/default values on first run.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexoraConstants = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const SEED_CONSTANTS = [
    { key: 1, description: 'INK GSM', value: 1.5, unit: 'g/m2', group: 'BOPP' },
    { key: 2, description: 'ADHESIVE GSM', value: 2.5, unit: 'g/m2', group: 'BOPP' },
    { key: 3, description: 'SINGLE FOLD SIZE', value: 40, unit: 'mm', group: 'STITCHING' },
    { key: 4, description: 'DOUBLE FOLD SIZE', value: 65, unit: 'mm', group: 'STITCHING' },
    { key: 5, description: 'SINGLE HAMMING SIZE', value: 25, unit: 'mm', group: 'HAMMING' },
    { key: 6, description: 'DOUBLE HAMMING SIZE', value: 50, unit: 'mm', group: 'HAMMING' },
    { key: 7, description: 'VALVE OVERLAP', value: 15, unit: 'mm', group: 'BLOCK BOTTOM' },
    { key: 8, description: 'PATCH OVERLAP FOR OPEN BAGS', value: 15, unit: 'mm', group: 'BLOCK BOTTOM' },
    { key: 9, description: 'PATCH OVER LAP FOR FLEXO', value: 25, unit: 'mm', group: 'BLOCK BOTTOM' },
    { key: 10, description: 'PATCH OVERLAP FOR BOPP', value: 30, unit: 'mm', group: 'BLOCK BOTTOM' },
    { key: 11, description: 'PATCH REPEAT', value: 2, unit: 'count', group: 'BLOCK BOTTOM' },
    { key: 12, description: 'VALVE STRIP', value: 2, unit: 'count', group: 'BLOCK BOTTOM' },
    { key: 13, description: 'PATCH STRIP', value: 6, unit: 'count', group: 'BLOCK BOTTOM' },
    { key: 14, description: 'FLAT TRIMMING', value: 30, unit: 'mm', group: 'BLOCK BOTTOM' },
    { key: 15, description: 'FLAT TRIMMING VALVE', value: 30, unit: 'mm', group: 'BLOCK BOTTOM' },
    { key: 16, description: 'YARN WEIGHT FOR 1000MM', value: 0.002, unit: 'g/mm', group: 'STITCHING' },
    { key: 17, description: 'COTTOM YARN WEIGHT FOR 1000MM', value: 0.0007, unit: 'g/mm', group: 'STITCHING' },
    { key: 18, description: 'HANDLE WEIGHT 25X250', value: 0.004, unit: 'kg / reference handle', group: 'HANDLE',
      notes: 'The weight of one 25 x 250 mm handle, in KILOGRAMS: 0.004 = 4 g. A handle of another size scales by area from HANDLE REFERENCE AREA. (Before 4.50.0 this said g/mm2, which is what it is divided by, not what it is.)' },
    { key: 19, description: 'BACKSEAM OVERLAP', value: 50, unit: 'mm', group: 'BACKSEAM' },
    { key: 20, description: 'BACKSEAM GRANUAL PER METER', value: 4, unit: 'g/m', group: 'BACKSEAM' },
    { key: 21, description: 'EASYOPEN CREEP PULL EXTEND', value: 45, unit: 'mm', group: 'EASY OPEN' },
    { key: 22, description: 'CREEP TAPE 1000MM WEIGHT', value: 0.005, unit: 'g/mm', group: 'EASY OPEN' },
    { key: 23, description: 'PULL TAPE 1000MM WEIGHT', value: 0.002, unit: 'g/mm', group: 'EASY OPEN' },
    { key: 24, description: 'BACKSEAM LAMINATION TRIMING', value: 30, unit: 'mm', group: 'BACKSEAM' },
    { key: 25, description: 'BACKSEAM LINER SIZE', value: 10, unit: 'mm', group: 'BACKSEAM', notes: 'LINER BACKSEAM BAGS' },

    /* ------------------------------------------------------------------
       1.0.0 — the ratios that used to be written INTO the formulas.
       ------------------------------------------------------------------
       "every formula engine where there is a default conversion or value
        or ratio that can be fetched from constants — like BOPP micron to
        GSM as 0.90 or 0.92 — I need that value to come from a constant so
        user by user they can change it."

       Every value below is EXACTLY the number the engine used before, so
       an existing installation calculates identically after the upgrade.
       Changing one here changes every calculation from that moment on —
       which is the point: a plant whose BOPP runs at 0.90 sets 0.90 once,
       instead of carrying a 0.92 that is not theirs.

       What is deliberately NOT here: real unit conversions (25.4 mm/inch,
       1,000,000 mm² per m², the 9,000 m in a denier). Those are physics,
       not plant practice, and making them editable would only allow the
       arithmetic to be broken. */
    { key: 26, description: 'BOPP MICRON TO GSM FACTOR', value: 0.92, unit: 'g/m2 per micron', group: 'FILM',
      notes: 'BOPP film density factor: GSM = micron x this. 0.92 is standard BOPP; some films run 0.90.' },
    { key: 27, description: 'METALLISED MICRON TO GSM FACTOR', value: 0.92, unit: 'g/m2 per micron', group: 'FILM',
      notes: 'Metallised film density factor, kept separate from BOPP so the two can differ.' },

    { key: 28, description: 'LINER MICRON TO GAUGE FACTOR', value: 4, unit: 'gauge/micron', group: 'LINER',
      notes: 'Liner gauge = micron x this (1 micron = 4 gauge).' },
    { key: 29, description: 'LINER GAUGE WEIGHT DIVISOR', value: 3300, unit: 'divisor', group: 'LINER',
      notes: 'Liner weight = (gauge / this) x (width in inches) x (cut length in inches).' },

    { key: 30, description: 'PATCH STRIP WIDTH LIMIT', value: 115, unit: 'mm', group: 'BLOCK BOTTOM',
      notes: 'A patch wider than this is cut in fewer strips across the web.' },
    { key: 31, description: 'PATCH STRIPS ABOVE LIMIT', value: 4, unit: 'count', group: 'BLOCK BOTTOM',
      notes: 'Strips used when the patch is wider than PATCH STRIP WIDTH LIMIT; at or below it, PATCH STRIP is used.' },
    { key: 32, description: 'PATCH SIZE ALLOWANCE', value: 5, unit: 'mm', group: 'BLOCK BOTTOM',
      notes: 'Trim allowance taken off patch width/length when the patch is cut.' },

    { key: 33, description: 'BODY COATING WIDTH ALLOWANCE', value: 10, unit: 'mm', group: 'LAMINATION',
      notes: 'Extra width the coating covers beyond the body width (non-backseam bags).' },
    { key: 34, description: 'BODY LAMINATION TRIM ALLOWANCE', value: 5, unit: 'mm', group: 'LAMINATION',
      notes: 'Width taken off the body for BOPP/metallised on a backseam bag.' },

    { key: 35, description: 'HANDLE REFERENCE AREA', value: 6250, unit: 'mm2', group: 'HANDLE',
      notes: 'The area HANDLE WEIGHT 25X250 was measured over (25 x 250 mm). Handle weight scales from it.' },
    { key: 36, description: 'YARN TOP STITCH FACTOR WITHOUT HANDLE', value: 1.5, unit: 'divisor', group: 'STITCHING',
      notes: 'Top-stitch yarn is divided by this when the bag has no handle (a handle bag stitches heavier).' },

    /* 4.32.0 — the denier formula is the physical one:
         Denier = GSM x 228.6 / (warp mesh + weft mesh)   (same denier both ways)
         GSM    = (warp denier x warp mesh + weft denier x weft mesh) / 228.6
       228.6 = 9000 m per denier / 39.37 inches per meter. The legacy
       DENIER GSM DIVISOR / LENGTH FACTOR / MESH FACTOR (500 / 610 / 40 over
       the AVERAGE mesh) reported 3070 denier for a 70 GSM 10x10 fabric that
       is 800; they are retired. */
    { key: 37, description: 'DENIER FACTOR', value: 228.6, unit: 'factor', group: 'DENIER',
      notes: 'Denier = GSM x this / (warp mesh + weft mesh). 228.6 = 9000 m per denier / 39.37 in per m; a plant that allows for crimp may set a little more.' },
    { key: 40, description: 'DENIER ROUNDING STEP', value: 10, unit: 'denier', group: 'DENIER',
      notes: 'Denier is reported to the nearest multiple of this.' },

    { key: 41, description: 'DEFAULT DOWNSIDE %', value: 2, unit: '%', group: 'TOLERANCE',
      notes: 'Minimum-weight tolerance used when a calculation does not state its own.' },
    { key: 42, description: 'DEFAULT UPSIDE %', value: 2, unit: '%', group: 'TOLERANCE',
      notes: 'Maximum-weight tolerance used when a calculation does not state its own.' },

    { key: 43, description: 'BOM ISSUE QUANTITY ROUNDING', value: 0.1, unit: 'kg', group: 'BOM',
      notes: 'Every issued quantity on a BOM line is rounded to this step. 0.1 kg matches the costing workbook; set 1 to issue whole kilograms.' },

    /* 4.31.0 — "add bopp density 0.91 ... so user can adjust". The ink
       assumption turns film micron into area per kilogram with the film's
       density; it was a fixed 0.91 on the service. Plants differ a little. */
    { key: 44, description: 'BOPP FILM DENSITY', value: 0.91, unit: 'g/cm3', group: 'FILM',
      notes: 'Density of BOPP film. The ink assumption uses it to turn micron into square meters per kilogram of film: m2/kg = 1000 / (micron x density).' },

    /* 4.59.0 — the pinch-bottom bag. "add these two zipper weight per
       meter=0.045 gram, pinch eazy open strip per meter=0.002 gram in
       constant as default weight"; the owner confirmed both are grams per
       MILLIMETER, and that 0.045 is the whole zipper assembly (zipper and
       its tracker). The zipper and the easy-open strip are two different
       things with two different weights. */
    { key: 45, description: 'PINCH ALLOWANCE', value: 50, unit: 'mm', group: 'PINCH',
      notes: 'Pinch bottom: added to the cut length when PINCH = YES (600 + 50 = 650).' },
    { key: 46, description: 'ZIPPER WEIGHT PER MM', value: 0.045, unit: 'g/mm', group: 'PINCH',
      notes: 'The whole zipper assembly — zipper and its tracker — in grams per millimeter of zipper. 0.045 = 45 g per meter.' },
    { key: 47, description: 'PINCH EASY OPEN STRIP WEIGHT PER MM', value: 0.002, unit: 'g/mm', group: 'PINCH',
      notes: 'The pinch easy-open strip, in grams per millimeter. Separate from the old easy-open creep and pull tapes.' }
  ];

  /* 4.31.0 — where each constant is read, in the plant's words. Shown under
     the name in the Constants Master, so nobody changes a number without
     knowing what moves. Keyed by description; a custom constant says
     where it is LINKED instead. */
  const USED_IN = {
    'INK GSM': 'Body BOPP GSM: added once to the film GSM when the bag is printed (weight engine, BOPP block).',
    'ADHESIVE GSM': 'Body metallised GSM: added once to the film GSM for the lamination adhesive.',
    'SINGLE FOLD SIZE': 'Stitching: the cut-length allowance for a single-fold top or bottom.',
    'DOUBLE FOLD SIZE': 'Stitching: the cut-length allowance for a double-fold top or bottom.',
    'SINGLE HAMMING SIZE': 'Hemming: the allowance for a single hem.',
    'DOUBLE HAMMING SIZE': 'Hemming: the allowance for a double hem.',
    'VALVE OVERLAP': 'Block bottom: added to the valve length to make the valve cut length.',
    'PATCH OVERLAP FOR OPEN BAGS': 'Block bottom, open-mouth bag: added to the patch size to make the patch cut length.',
    'PATCH OVER LAP FOR FLEXO': 'Block bottom, flexo-printed bag: the patch overlap used instead of the open-bag one.',
    'PATCH OVERLAP FOR BOPP': 'Block bottom, BOPP-laminated bag: the patch overlap used instead of the open-bag one.',
    'PATCH REPEAT': 'Block bottom: how many patches a bag carries (top and bottom).',
    'VALVE STRIP': 'Block bottom: how many valve strips are cut across the web.',
    'PATCH STRIP': 'Block bottom: how many patch strips are cut across the web when the patch is at or below PATCH STRIP WIDTH LIMIT.',
    'FLAT TRIMMING': 'Block bottom: trim taken off the flat (patch) fabric width.',
    'FLAT TRIMMING VALVE': 'Block bottom: trim taken off the valve fabric width.',
    'YARN WEIGHT FOR 1000MM': 'Stitching: grams of sewing yarn per millimeter of seam — every stitched seam and the top stitch.',
    'COTTOM YARN WEIGHT FOR 1000MM': 'Stitching: grams of cotton yarn per millimeter where cotton is used.',
    'HANDLE WEIGHT 25X250': 'Handle: the weight of one reference handle in kilograms (0.004 = 4 g over 25 x 250 mm); a handle of another size scales from it by area.',
    'BACKSEAM OVERLAP': 'Backseam bag: the overlap added to the body width for the seam.',
    'BACKSEAM GRANUAL PER METER': 'Backseam bag: grams of seam granule per meter of seam.',
    'EASYOPEN CREEP PULL EXTEND': 'Easy-open: extra length of creep and pull tape beyond the bag width.',
    'CREEP TAPE 1000MM WEIGHT': 'Easy-open: grams of creep tape per millimeter.',
    'PULL TAPE 1000MM WEIGHT': 'Easy-open: grams of pull tape per millimeter.',
    'BACKSEAM LAMINATION TRIMING': 'Backseam bag: lamination trim taken off the width.',
    'BACKSEAM LINER SIZE': 'Backseam bag with liner: the liner allowance.',
    'BOPP MICRON TO GSM FACTOR': 'Body BOPP GSM = micron x this (per side). The film density factor of the lamination.',
    'METALLISED MICRON TO GSM FACTOR': 'Body metallised GSM = micron x this (per side).',
    'LINER MICRON TO GAUGE FACTOR': 'Liner: gauge = micron x this, before the liner weight is worked out.',
    'LINER GAUGE WEIGHT DIVISOR': 'Liner weight = (gauge / this) x width in inches x cut length in inches.',
    'PATCH STRIP WIDTH LIMIT': 'Block bottom: a patch wider than this is cut in PATCH STRIPS ABOVE LIMIT strips instead of PATCH STRIP.',
    'PATCH STRIPS ABOVE LIMIT': 'Block bottom: strips across the web for a patch wider than PATCH STRIP WIDTH LIMIT.',
    'PATCH SIZE ALLOWANCE': 'Block bottom: trim taken off the patch width and length when the patch is cut.',
    'BODY COATING WIDTH ALLOWANCE': 'Coating: extra width the coating covers beyond the body width (non-backseam bags).',
    'BODY LAMINATION TRIM ALLOWANCE': 'Lamination: width taken off the body for BOPP or metallised film on a backseam bag.',
    'HANDLE REFERENCE AREA': 'Handle: the area (mm2) HANDLE WEIGHT 25X250 was measured over.',
    'YARN TOP STITCH FACTOR WITHOUT HANDLE': 'Stitching: the top-stitch yarn is divided by this when the bag has no handle.',
    'DENIER FACTOR': 'Denier: body denier = GSM x this / (warp mesh + weft mesh), flat denier the same from the flat GSM. Also the GSM <-> DNR calculator. 228.6 = 9000 m per denier / 39.37 in per m.',
    'DENIER ROUNDING STEP': 'Denier: the reported denier is rounded to a multiple of this.',
    'DEFAULT DOWNSIDE %': 'Tolerance: the minimum-weight band when a calculation does not state its own.',
    'DEFAULT UPSIDE %': 'Tolerance: the maximum-weight band when a calculation does not state its own.',
    'BOM ISSUE QUANTITY ROUNDING': 'BOM: every issued quantity on a BOM line is rounded up to this step (kg).',
    'BOPP FILM DENSITY': 'Ink assumption: film area per kilogram = 1000 / (micron x this). Sent to the service with every ink estimate on a BOPP bag.',
    'PINCH ALLOWANCE': 'Pinch bottom: added to the cut length when PINCH = YES.',
    'ZIPPER WEIGHT PER MM': 'Pinch bottom zipper: weight = (WIDTH - GUSSET) x this. The whole assembly, tracker included.',
    'PINCH EASY OPEN STRIP WEIGHT PER MM': 'Pinch easy-open strip: weight = (WIDTH - GUSSET) x this.'
  };

  function toLookup(list) {
    const map = {};
    list.forEach((c) => { map[c.description] = c.value; });
    return map;
  }

  return {
    SEED_CONSTANTS,
    USED_IN,
    toLookup
  };
});

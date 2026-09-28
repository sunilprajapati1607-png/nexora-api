/**
 * Nexora — Input Field Definitions
 * Maps each user-entered technical field to: which tab it lives in, its
 * label (from the legacy glossary), its input type, and the STRUCTURE
 * flag key that decides whether it's shown for the selected construction
 * (construction-aware form, spec §8 — no REFRESH button, fields simply
 * show/hide as soon as a construction is picked).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexoraFieldDefs = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const ENUM_YN = ['YES', 'NO'];

  const TABS = [
    { id: 'dimensions', label: 'Dimensions' },
    { id: 'fabric', label: 'Fabric & Lamination' },
    { id: 'liner', label: 'Liner' },
    { id: 'handle', label: 'Handle & Stitching' },
    { id: 'easyopen', label: 'Easy-Open & Backseam' },
    { id: 'pinch', label: 'Pinch & Zipper' },
    { id: 'advanced', label: 'Drum & Trim (Advanced)' }
  ];

  // flagKey: the key in construction.fields{} that gates visibility.
  // Always-on fields use flagKey: null.
  //
  // group (1.0.0): a finer heading INSIDE a tab, used by the Structure
  // Master so "Fabric & Lamination" is no longer one undivided block of
  // eighteen tick-boxes — "in structure master separate field for fabric
  // & lamination as fabric / lamination / bopp". The calculation form
  // still lays out by `tab`, so the form the operator uses is unchanged.
  const FIELDS = [
    // ---- Dimensions ----
    { key: 'WIDTH', tab: 'dimensions', label: 'Width', unit: 'mm', type: 'number', flagKey: 'WIDTH', required: true },
    { key: 'LENGTH', tab: 'dimensions', label: 'Length', unit: 'mm', type: 'number', flagKey: 'LENGTH', required: true },
    { key: 'PATCH', tab: 'dimensions', label: 'Patch', unit: 'mm', type: 'number', flagKey: 'PATCH' },
    { key: 'VALVE', tab: 'dimensions', label: 'Valve Depth', unit: 'mm', type: 'number', flagKey: 'VALVE' },
    { key: 'EX-VALVE', tab: 'dimensions', label: 'Extended Valve', unit: 'mm', type: 'number', flagKey: 'EX-VALVE' },
    { key: 'BOTTOM FOLD', tab: 'dimensions', label: 'Bottom Fold', type: 'enum', options: ['SINGLE', 'DOUBLE'], flagKey: 'BOTTOM FOLD' },
    { key: 'HAMMING', tab: 'dimensions', label: 'Hamming', type: 'enum', options: ['SINGLE', 'DOUBLE'], flagKey: 'HAMMING' },
    { key: 'BACKSEAM', tab: 'dimensions', label: 'Backseam', type: 'enum', options: ENUM_YN, flagKey: 'BACKSEAM' },

    // ---- Fabric & Lamination ----
    { key: 'M.WARP', tab: 'fabric', group: 'Fabric', label: 'Mesh Warp', type: 'number', flagKey: 'M.WARP' },
    { key: 'M.WEFT', tab: 'fabric', group: 'Fabric', label: 'Mesh Weft', type: 'number', flagKey: 'M.WEFT' },
    { key: 'BD FAB GSM', tab: 'fabric', group: 'Fabric', label: 'Body Fabric GSM', unit: 'g/m²', type: 'number', flagKey: 'BD FAB GSM', required: true },
    { key: 'FLT FAB GSM', tab: 'fabric', group: 'Fabric', label: 'Flat (Patch/Valve) Fabric GSM', unit: 'g/m²', type: 'number', flagKey: 'FLT FAB GSM' },
    { key: 'BD CT GSM', tab: 'fabric', group: 'Lamination', label: 'Body Coating GSM', unit: 'g/m²', type: 'number', flagKey: 'BD CT GSM' },
    { key: 'BD CT SD', tab: 'fabric', group: 'Lamination', label: 'Body Coating Side', type: 'enum', options: ['ONE', 'TWO'], flagKey: 'BD CT SD' },
    { key: 'FLT CT GSM', tab: 'fabric', group: 'Lamination', label: 'Patch/Valve Coating GSM', unit: 'g/m²', type: 'number', flagKey: 'FLT CT GSM' },
    { key: 'PTC CT SD', tab: 'fabric', group: 'Lamination', label: 'Patch/Valve Coating Side', type: 'enum', options: ['ONE', 'TWO'], flagKey: 'PTC CT SD' },
    { key: 'BD BOP MIC', tab: 'fabric', group: 'BOPP', label: 'Body BOPP Micron', unit: 'µm', type: 'number', flagKey: 'BD BOP MIC' },
    { key: 'BD BOP SD', tab: 'fabric', group: 'BOPP', label: 'Body BOPP Side', type: 'enum', options: ['ONE', 'TWO'], flagKey: 'BD BOP SD' },
    { key: 'PTC BOP MIC', tab: 'fabric', group: 'BOPP', label: 'Patch/Valve BOPP Micron', unit: 'µm', type: 'number', flagKey: 'PTC BOP MIC' },
    { key: 'PTC BOP SD', tab: 'fabric', group: 'BOPP', label: 'Patch/Valve BOPP Side', type: 'enum', options: ['ONE', 'TWO'], flagKey: 'PTC BOP SD' },
    { key: 'BD MT MIC', tab: 'fabric', group: 'Metallised', label: 'Body Metallised Micron', unit: 'µm', type: 'number', flagKey: 'BD MT MIC' },
    { key: 'BD MT SD', tab: 'fabric', group: 'Metallised', label: 'Body Metallised Side', type: 'enum', options: ['ONE', 'TWO'], flagKey: 'BD MT SD' },
    { key: 'PTC MT MIC', tab: 'fabric', group: 'Metallised', label: 'Patch/Valve Metallised Micron', unit: 'µm', type: 'number', flagKey: 'PTC MT MIC' },
    { key: 'PTC MT SD', tab: 'fabric', group: 'Metallised', label: 'Patch/Valve Metallised Side', type: 'enum', options: ['ONE', 'TWO'], flagKey: 'PTC MT SD' },
    { key: 'INK GSM', tab: 'fabric', group: 'BOPP', label: 'Ink GSM (override default)', unit: 'g/m²', type: 'number', flagKey: 'INK GSM', placeholderFromConstant: 'INK GSM' },
    { key: 'ADHESIVE GSM', tab: 'fabric', group: 'Metallised', label: 'Adhesive GSM (override default)', unit: 'g/m²', type: 'number', flagKey: 'ADHESIVE GSM', placeholderFromConstant: 'ADHESIVE GSM' },

    // ---- Liner ----
    { key: 'LNR WIDTH', tab: 'liner', label: 'Liner Width', unit: 'mm', type: 'number', flagKey: 'LNR WIDTH' },
    { key: 'LNR LENGTH', tab: 'liner', label: 'Liner Length', unit: 'mm', type: 'number', flagKey: 'LNR LENGTH' },
    { key: 'LNR BTM SEAL', tab: 'liner', label: 'Liner Bottom Seal', unit: 'mm', type: 'number', flagKey: 'LNR BTM SEAL' },
    { key: 'LNR MC', tab: 'liner', label: 'Liner Micron', unit: 'µm', type: 'number', flagKey: 'LNR MC' },

    // ---- Handle & Stitching ----
    { key: 'HANDLE', tab: 'handle', label: 'Handle', type: 'enum', options: ENUM_YN, flagKey: 'HANDLE' },
    { key: 'H.WIDTH', tab: 'handle', label: 'Handle Width', unit: 'mm', type: 'number', flagKey: 'H.WIDTH' },
    { key: 'H.LENGTH', tab: 'handle', label: 'Handle Length', unit: 'mm', type: 'number', flagKey: 'H.LENGTH' },

    // ---- Easy Open & Backseam ----
    { key: 'EASY OPEN', tab: 'easyopen', label: 'Easy Open', type: 'enum', options: ENUM_YN, flagKey: 'EASY OPEN' },
    { key: 'CREEP', tab: 'easyopen', label: 'Creep', unit: 'mm', type: 'number', flagKey: 'CREEP' },
    { key: 'PULL', tab: 'easyopen', label: 'Pull', unit: 'mm', type: 'number', flagKey: 'PULL' },

    // ---- Pinch & Zipper (4.59.0) ----
    /* The pinch-bottom bag. PINCH = YES adds K[PINCH ALLOWANCE] to the cut
       length; the zipper and the pinch easy-open strip run across the
       mouth over WIDTH - GUSSET, the gusset folding inside. Two separate
       parts with two separate weights, and separate from the old
       easy-open creep and pull tapes above. */
    { key: 'PINCH', tab: 'pinch', label: 'Pinch', type: 'enum', options: ENUM_YN, flagKey: 'PINCH' },
    { key: 'GUSSET', tab: 'pinch', label: 'Gusset', unit: 'mm', type: 'number', flagKey: 'GUSSET', hint: 'Total gusset; the zipper and strip run over width minus gusset' },
    { key: 'ZIPPER', tab: 'pinch', label: 'Zipper', type: 'enum', options: ENUM_YN, flagKey: 'ZIPPER' },
    { key: 'PINCH EASY OPEN', tab: 'pinch', label: 'Pinch Easy Open', type: 'enum', options: ENUM_YN, flagKey: 'PINCH EASY OPEN' },

    // ---- Advanced / drum & trim overrides (manual, machine-specific) ----
    { key: 'DSB', tab: 'advanced', label: 'Drum Size — Body', unit: 'mm', type: 'number', flagKey: 'DSB', hint: 'Overrides computed body length when set' },
    { key: 'DSTP', tab: 'advanced', label: 'Drum Size — Top Patch', unit: 'mm', type: 'number', flagKey: 'DSTP' },
    { key: 'DSBP', tab: 'advanced', label: 'Drum Size — Bottom Patch', unit: 'mm', type: 'number', flagKey: 'DSBP' },
    { key: 'TR', tab: 'advanced', label: 'Patch Trimming', unit: 'mm', type: 'number', flagKey: 'TR' },
    { key: 'TRV', tab: 'advanced', label: 'Valve Trimming', unit: 'mm', type: 'number', flagKey: 'TRV' },
    { key: 'BKSMOV', tab: 'advanced', label: 'Backseam Trimming', unit: 'mm', type: 'number', flagKey: 'BKSMOV' },
    { key: 'OV', tab: 'advanced', label: 'Overlap (Valve width)', unit: 'mm', type: 'number', flagKey: 'OV' }
  ];

  return { TABS, FIELDS };
});

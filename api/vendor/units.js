/**
 * Nexora — the unit a plant measures in  (4.21.0)
 * ======================================================================
 * "add option in setting for input field in mm, cm, inch and all
 *  mechanism work base on this, user will select unit of input by self
 *  from setting" — "effect universally in every where".
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ----------------------------------------------------------------------
 * This is a LENS, not a conversion of the data. Every length Nexora
 * stores — in a saved calculation, in a constant, in a backup, in the
 * request that goes to the service — is and stays MILLIMETERS. The
 * engine is untouched, the formulas are untouched, and a calculation
 * saved by a plant working in inches is byte-for-byte the same record as
 * one saved by a plant working in millimeters.
 *
 * What changes is what is written on the glass and on the paper, and
 * what a typed figure is taken to mean. That is deliberate:
 *
 *   · a saved record must not be restated because somebody changed a
 *     display preference. History is history. Switch the unit back and
 *     every figure is exactly what it was
 *   · the weight engine is reverse-engineered from a workbook that works
 *     in millimeters, and a single formula changed to suit a display
 *     choice would put every bag weight in doubt
 *   · two machines in one plant can be set differently without their
 *     calculations disagreeing by a factor of 25.4
 *
 * ROUND TRIPS, AND WHY NOTHING DRIFTS
 * ----------------------------------------------------------------------
 * 600 mm is 23.622 in, and 23.622 in is 599.9988 mm — not 600. So a
 * figure that survived a round trip through inches would no longer be the
 * figure the plant typed.
 *
 * It never makes that trip. A form field is FILLED from the stored
 * millimeters and only writes back when a person actually edits it, so an
 * untouched WIDTH keeps its exact 600 for ever, whatever unit is on
 * screen. And the precision offered for entry is chosen so that what IS
 * retyped lands within two thousandths of a millimeter of where it
 * looked — four decimals, whose trailing zeros are trimmed away, so a
 * clean 600 mm still shows as a clean 23.622 in.
 *
 * WHAT IS A LENGTH AND WHAT IS NOT
 * ----------------------------------------------------------------------
 * Only pure lengths are converted. GSM (g/m²), micron, denier, grams per
 * meter, mesh counts and money are what they always were, in every unit
 * setting — they are not lengths, and dressing them up as inch-based
 * would be an invention rather than a translation. The two constants
 * expressed PER millimeter (yarn weight per mm, handle weight per mm²)
 * stay per millimeter too, and say so: they are machine settings read off
 * a supplier's sheet, and restating them helps nobody.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexoraUnits = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'nexora.units.v1';

  /**
   * perMm    how many of this unit make one millimeter
   * dp       decimals offered for ENTRY — chosen so a retyped figure
   *          lands within 0.002 mm of where it was shown. Trailing
   *          zeros are trimmed, so the extra places cost nothing to read
   * textDp   decimals for a figure being READ: a drawing wants "23.62 in",
   *          not "23.622 in"
   * step     the arrow-key step on a number box, in this unit
   */
  const UNITS = [
    { id: 'mm', label: 'mm', name: 'Millimeters', plural: 'millimeters', perMm: 1, dp: 1, textDp: 0, step: 1 },
    { id: 'cm', label: 'cm', name: 'Centimeters', plural: 'centimeters', perMm: 0.1, dp: 4, textDp: 1, step: 0.1 },
    { id: 'in', label: 'in', name: 'Inches', plural: 'inches', perMm: 1 / 25.4, dp: 4, textDp: 2, step: 0.05 }
  ];
  const BY_ID = {};
  UNITS.forEach((u) => { BY_ID[u.id] = u; });
  const DEFAULT_ID = 'mm';

  /* ------------------------------------------------------------------
     The setting itself
     ------------------------------------------------------------------ */
  let listeners = [];

  function get() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return DEFAULT_ID;
      const v = JSON.parse(raw);
      const id = v && typeof v === 'object' ? v.unit : v;
      return BY_ID[id] ? id : DEFAULT_ID;
    } catch (e) { return DEFAULT_ID; }
  }

  /** The whole definition, never null — an unknown id reads as millimeters. */
  function current() { return BY_ID[get()] || BY_ID[DEFAULT_ID]; }

  function set(id) {
    if (!BY_ID[id]) return false;
    try { localStorage.setItem(KEY, JSON.stringify({ unit: id })); } catch (e) { return false; }
    listeners.slice().forEach((fn) => { try { fn(id); } catch (e) { /* one bad listener must not stop the rest */ } });
    return true;
  }

  /** Called after the unit changes, so a screen can redraw itself. */
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  /* ------------------------------------------------------------------
     4.32.0 — how mesh is COUNTED. Stored and computed as tapes per inch
     always (the denier factor 228.6 = 9000 / 39.37 assumes it); shown
     and typed in whatever the plant counts in. A lens, like lengths.
     ------------------------------------------------------------------ */
  const MESH_KEY = 'nexora.meshunit.v1';
  const MESH_UNITS = [
    { id: 'in', label: 'per inch', name: 'Tapes per inch', perInch: 1, dp: 0 },
    { id: 'cm', label: 'per cm', name: 'Tapes per centimeter', perInch: 1 / 2.54, dp: 2 },
    { id: 'dm', label: 'per 10 cm', name: 'Tapes per 10 cm', perInch: 10 / 2.54, dp: 1 }
  ];
  const MESH_BY_ID = {};
  MESH_UNITS.forEach((u) => { MESH_BY_ID[u.id] = u; });
  /* 4.67.15 — the units are the COMPANY's (a shared master, set by the administrator), and a master
     travels as JSON. The count used to be kept bare ("cm"), which the sync cannot read, so it is
     read either way and, the first time, rewritten as JSON ("\"cm\"") so it can travel. */
  function meshGet() {
    try {
      const raw = localStorage.getItem(MESH_KEY);
      if (raw == null) return 'in';
      if (MESH_BY_ID[raw]) { try { localStorage.setItem(MESH_KEY, JSON.stringify(raw)); } catch (e) {} return raw; }
      const v = JSON.parse(raw);
      return MESH_BY_ID[v] ? v : 'in';
    } catch (e) { return 'in'; }
  }
  function meshCurrent() { return MESH_BY_ID[meshGet()] || MESH_BY_ID.in; }
  function meshSet(id) {
    if (!MESH_BY_ID[id]) return false;
    try { localStorage.setItem(MESH_KEY, JSON.stringify(id)); } catch (e) { return false; }
    listeners.slice().forEach((fn) => { try { fn(get()); } catch (e) { /* one bad listener must not stop the rest */ } });
    return true;
  }
  const meshLabel = () => meshCurrent().label;
  const meshIsInch = () => meshGet() === 'in';
  /** tapes per inch (stored) → the counted unit, tidy for a box */
  function meshForInput(perInch) {
    const n = Number(perInch);
    if (perInch === '' || perInch == null || !isFinite(n)) return '';
    const u = meshCurrent();
    const p = Math.pow(10, u.dp + 2);
    return Math.round(n * u.perInch * p) / p;
  }
  /** the counted unit (typed) → tapes per inch, which is what is stored */
  function meshToInch(shown) {
    const n = Number(shown);
    if (shown === '' || shown == null || !isFinite(n)) return undefined;
    return Math.round((n / meshCurrent().perInch) * 10000) / 10000;
  }
  /** a mesh figure for reading, without its unit */
  function meshShow(perInch, dp) {
    const v = meshForInput(perInch);
    if (v === '') return '';
    const d = dp == null ? meshCurrent().dp : dp;
    return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toString();
  }
  /** a mesh figure for reading, with its unit */
  function meshText(perInch, dp) {
    const v = meshForInput(perInch);
    if (v === '') return '';
    const d = dp == null ? meshCurrent().dp : dp;
    return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toString() + ' ' + meshLabel();
  }


  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* nothing stored */ }
    listeners.slice().forEach((fn) => { try { fn(DEFAULT_ID); } catch (e) {} });
  }

  const isMm = () => get() === 'mm';
  const label = () => current().label;
  const name = () => current().name;
  const step = () => current().step;
  const dp = () => current().dp;

  /* ------------------------------------------------------------------
     Numbers
     ------------------------------------------------------------------ */
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };
  /* Away from float dust: 0.1+0.2 arithmetic has no place in a figure a
     plant is going to cut fabric to. */
  const tidy = (v, places) => {
    const p = Math.pow(10, places);
    return Math.round(v * p) / p;
  };

  /** Millimeters → the chosen unit. */
  function fromMm(vMm) {
    const n = num(vMm);
    if (n === null) return null;
    return n * current().perMm;
  }

  /** The chosen unit → millimeters, which is what is stored. */
  function toMm(v) {
    const n = num(v);
    if (n === null) return null;
    if (isMm()) return n;
    return tidy(n / current().perMm, 4);
  }

  /**
   * The value for a number box: exact in millimeters so an mm plant sees
   * precisely what it typed, and at entry precision otherwise. Trailing
   * zeros are trimmed — "23.6" reads better than "23.600".
   */
  function forInput(vMm) {
    const n = num(vMm);
    if (n === null) return '';
    if (isMm()) return String(n);
    return String(tidy(n * current().perMm, current().dp));
  }

  /**
   * A figure to be read, without its unit.
   *
   * Asked for a number of decimals, it gives exactly that many — a
   * column of figures has to line up. Asked for none, it tidies: a
   * caption reads better as "60 cm" than "60.0 cm", while "23.62 in"
   * keeps the decimals it needs.
   */
  function fmt(vMm, mmDecimals) {
    const n = num(vMm);
    if (n === null) return null;
    const u = current();
    if (mmDecimals != null) {
      /* The extra places are what stops a conversion losing precision the
         caller asked for: one decimal of millimeters is two of
         centimeters and three of inches. */
      const d = mmDecimals + (u.id === 'mm' ? 0 : u.id === 'cm' ? 1 : 2);
      return tidy(n * u.perMm, d).toFixed(Math.max(0, d));
    }
    return String(tidy(n * u.perMm, u.textDp));
  }

  /** A figure to be read, with its unit: "600 mm", "60 cm", "23.62 in". */
  function text(vMm, mmDecimals) {
    const s = fmt(vMm, mmDecimals);
    return s === null ? null : s + ' ' + current().label;
  }

  /** "600 × 900 mm" — one unit for the pair, as a drawing writes it. */
  function pair(aMm, bMm, mmDecimals) {
    const a = fmt(aMm, mmDecimals), b = fmt(bMm, mmDecimals);
    if (a === null && b === null) return null;
    if (a === null || b === null) return text(a === null ? bMm : aMm, mmDecimals);
    return a + ' × ' + b + ' ' + current().label;
  }

  /* Areas. The engine works in mm², and one square inch is 645.16 mm². */
  const areaLabel = () => current().label + '²';
  function areaFromMm2(vMm2) {
    const n = num(vMm2);
    if (n === null) return null;
    const f = current().perMm;
    return n * f * f;
  }
  function areaText(vMm2, decimals) {
    const n = areaFromMm2(vMm2);
    if (n === null) return null;
    const d = decimals == null ? (isMm() ? 0 : 2) : decimals;
    return tidy(n, d).toFixed(Math.max(0, d)) + ' ' + areaLabel();
  }

  /**
   * The unit a field label should carry. A field defined in millimeters
   * follows the setting; everything else — GSM, micron, g/m — is what it
   * always was.
   */
  function labelFor(definedUnit) {
    return definedUnit === 'mm' ? current().label : definedUnit;
  }
  const isLength = (definedUnit) => definedUnit === 'mm';

  return {
    MESH_UNITS, meshGet, meshCurrent, meshSet, meshLabel, meshIsInch, meshForInput, meshShow, meshToInch, meshText,
    UNITS, KEY, DEFAULT_ID,
    get, set, current, onChange, reset,
    isMm, label, name, step, dp,
    fromMm, toMm, forInput, fmt, text, pair,
    areaLabel, areaFromMm2, areaText,
    labelFor, isLength
  };
});

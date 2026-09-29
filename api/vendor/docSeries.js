/**
 * Nexora — document number series
 * ----------------------------------------------------------------------
 *   "under setting window add new tab of document series, where user will
 *    decide all document number series prefix suffix include, calculation
 *    number, quotation number, rm master number will be base on group
 *    wise also bom number"
 *
 * Every plant already has its own way of numbering paper, and until now
 * Nexora simply imposed its own: CAL-2026-000001, QT-2026-000001. A plant
 * that numbers its costings PKG/COST/26/0001 had to keep two numbers in
 * its head for the same job — which is how the wrong one ends up on an
 * invoice.
 *
 * So a series is four decisions, and the same four for every kind:
 *
 *   prefix    what it starts with            CAL
 *   year      whether the year is in it      2026  (four digits or two)
 *   pad       how many digits the count has  000001
 *   suffix    what it ends with              /A, -REV, nothing
 *
 * WHAT THIS DOES NOT DO, deliberately:
 *
 *   It never renumbers anything. A number is minted once, written into
 *   the record, and is that record's name for ever — changing the series
 *   changes what the NEXT one is called and touches nothing already
 *   saved. A plant that renumbers its history cannot answer a question
 *   about last March.
 *
 *   It never restarts a count under a pattern that is already in use. The
 *   counter reads the numbers that match the CURRENT pattern and adds
 *   one, so switching prefix starts a fresh run under the new prefix and
 *   leaves the old run alone. That is what a plant means by "we changed
 *   our series in April".
 *
 * RM codes are not here: they are minted per GROUP by rmStore, which has
 * had its own prefix and padding since 4.11.0. The Settings tab shows
 * them beside these so the plant sees all of its numbering in one place,
 * and writes them through rmStore, where they belong.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexoraDocSeries = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'nexora.docseries.v1';

  /* The defaults ARE what Nexora did before this store existed, so an
     installation that never opens the tab numbers exactly as it always
     has — and an old record still matches the pattern that made it. */
  const DEFAULTS = {
    calc:  { prefix: 'CAL', year: true, yearDigits: 4, pad: 6, suffix: '' },
    quote: { prefix: 'QT',  year: true, yearDigits: 4, pad: 6, suffix: '' },
    bom:   { prefix: 'BOM', year: true, yearDigits: 4, pad: 6, suffix: '' },
    item:  { prefix: 'NX',  year: false, yearDigits: 4, pad: 5, suffix: '' },
    /* 4.68.0 — marketing: the enquiry (lead and enquiry are one record) */
    enquiry: { prefix: 'ENQ', year: true, yearDigits: 4, pad: 6, suffix: '' }
  };
  const KINDS = Object.keys(DEFAULTS);

  const LABELS = {
    calc:  'Calculation number',
    quote: 'Quotation number',
    bom:   'BOM number',
    item:  'Item code',
    enquiry: 'Enquiry number'
  };

  function read() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e) { return {}; }
  }

  /** One kind's settings, with every missing field read as its default. */
  function get(kind) {
    return normalise(kind, read()[kind] || {});
  }
  /* 4.58.1 — the same reading for settings that are only being TYPED, so
     the settings screen can show what the next number would be under a
     pattern before it is saved, through the very functions that mint. */
  function normalise(kind, v) {
    const d = DEFAULTS[kind] || DEFAULTS.calc;
    v = v || {};
    if (v.year != null && typeof v.year !== 'boolean') v = Object.assign({}, v, { year: !!v.year });
    return {
      prefix: clean(v.prefix != null ? v.prefix : d.prefix),
      year: v.year == null ? d.year : !!v.year,
      yearDigits: Number(v.yearDigits) === 2 ? 2 : 4,
      pad: bounded(v.pad == null ? d.pad : v.pad, 1, 12),
      suffix: clean(v.suffix != null ? v.suffix : d.suffix)
    };
  }

  function all() {
    const out = {};
    KINDS.forEach((k) => { out[k] = get(k); });
    return out;
  }

  /** A prefix or suffix is part of a document number, so it is kept to
   *  what a document number may contain: letters, digits, and the three
   *  separators plants actually use. Never silently emptied. */
  function clean(v) {
    return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9/_-]/g, '').slice(0, 12);
  }
  function bounded(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function set(kind, next) {
    if (!DEFAULTS[kind]) throw new Error('Unknown document kind: ' + kind);
    const cur = get(kind);
    const merged = {
      prefix: clean(next && next.prefix != null ? next.prefix : cur.prefix),
      year: next && next.year != null ? !!next.year : cur.year,
      yearDigits: next && Number(next.yearDigits) === 2 ? 2 : (next && next.yearDigits ? 4 : cur.yearDigits),
      pad: bounded(next && next.pad != null ? next.pad : cur.pad, 1, 12),
      suffix: clean(next && next.suffix != null ? next.suffix : cur.suffix)
    };
    if (!merged.prefix) {
      throw new Error('A prefix is required — it is what tells one kind of document from another.');
    }
    const store = read();
    store[kind] = merged;
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
    return merged;
  }

  function reset(kind) {
    const store = read();
    if (kind) delete store[kind]; else KINDS.forEach((k) => delete store[k]);
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
  }

  function yearPart(s, year) {
    const y = String(year == null ? new Date().getFullYear() : year);
    return s.yearDigits === 2 ? y.slice(-2) : y;
  }

  /** The number itself. The parts are joined with '-' as they always
   *  were; a plant that wants slashes puts them in its prefix. */
  function format(kind, n, year, pattern) {
    const s = pattern || get(kind);
    const parts = [s.prefix];
    if (s.year) parts.push(yearPart(s, year));
    parts.push(String(Math.max(0, Math.round(Number(n) || 0))).padStart(s.pad, '0'));
    let out = parts.join('-');
    if (s.suffix) out += '-' + s.suffix;
    return out;
  }

  /** What the count of an EXISTING number is, or null when that number
   *  was not made by the current pattern. This is the other half of
   *  "never restart a run that is in use": the counter only counts what
   *  it would itself have written. */
  function countOf(kind, value, year, pattern) {
    const s = pattern || get(kind);
    const v = String(value == null ? '' : value);
    let re = '^' + esc(s.prefix) + '-';
    if (s.year) re += esc(yearPart(s, year)) + '-';
    re += '(\\d{1,12})';
    re += s.suffix ? '-' + esc(s.suffix) + '$' : '$';
    const m = new RegExp(re).exec(v);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return isFinite(n) ? n : null;
  }

  /* 4.58.1 — "under setting document series system should show last
     number and next number" / "serial are serious matter".

     ONE walk over the numbers in use, and both answers come from it: the
     highest number the current pattern made (the LAST one issued) and
     that count plus one (the NEXT). next() is what every save calls, so
     the settings screen asking for the next number gets exactly the
     number the next save will write — there is no second calculation
     that could drift from the first. */
  function top(kind, existing, year, pattern) {
    let best = 0, value = null;
    (existing || []).forEach((v) => {
      const n = countOf(kind, v, year, pattern);
      if (n != null && n > best) { best = n; value = String(v); }
    });
    return { count: best, value: value };
  }

  /** The next number, given every number of that kind already in use. */
  function next(kind, existing, year, pattern) {
    return format(kind, top(kind, existing, year, pattern).count + 1, year, pattern);
  }

  /** The highest number already issued under the current pattern (this
   *  year's run, when the year is in the pattern), or null for none. */
  function last(kind, existing, year, pattern) {
    return top(kind, existing, year, pattern).value;
  }

  /** What one would look like, for the settings screen. Worked out from
   *  the draft directly — it no longer writes the draft into the store
   *  and takes it out again, which a save landing in between would have
   *  numbered by. */
  function sample(kind, draft, year) {
    return format(kind, 1, year, draft ? normalise(kind, draft) : null);
  }

  function esc(v) { return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  return {
    KINDS: KINDS, LABELS: LABELS, DEFAULTS: DEFAULTS,
    get: get, all: all, set: set, reset: reset,
    format: format, countOf: countOf, next: next, last: last, sample: sample, normalise: normalise
  };
});

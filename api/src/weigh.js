/**
 * Nexora Mobile — a bag weighed through the service, by the desktop's own engine
 * ======================================================================
 * Owner 2026-09-28: "mobile user can not create bom, they can create
 * calculation". The phone carries no formula (the plan the owner agreed:
 * weight and BOM are worked out on the service), so the phone sends the
 * construction and the inputs and this weighs them.
 *
 * It weighs them with THE DESKTOP'S OWN FILES — vendor/calculationEngine.js,
 * constructions.js, fieldDefs.js, constants.js, constantsStore.js and
 * structureStore.js, byte-for-byte copies kept in step by
 * tools/sync-server.js — run inside a fresh vm context whose localStorage
 * holds this company's synced masters (its constructions, its constants,
 * its constant links). So the phone's gram is the computer's gram: the
 * same construction ticks, the same constants, the same linked-constant
 * fill-in (engineInputFor in app.js, repeated below line for line), the
 * same engine. Nothing is re-implemented. "GRAM IS ALWAYS WIN."
 *
 * The number series is the company's (4.67.14: a shared master only the
 * administrator sets), so the next calculation number and item code are
 * minted here by the desktop's own docSeries.js over every number the
 * company has used. The units are the company's too (4.67.15): the phone
 * shows and takes lengths and mesh in them, and they are turned into
 * millimetres and tapes per inch here, by the desktop's own units.js,
 * before the engine sees them — exactly as the computer's form does.
 *
 * C8 (owner 2026-10-01): and the other way round — with solveGsm the target
 * weight is given and the body fabric GSM is found by the computer's own
 * search (solveGsmWith below).
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { q } from './db.js';

const FILES = ['constants.js', 'constructions.js', 'fieldDefs.js', 'constantsStore.js', 'structureStore.js', 'calculationEngine.js', 'docSeries.js', 'units.js',
  /* 4.67.16 — a quotation's arithmetic, for the quotations made on the phone (quoteSheet.js) */
  'quoteMath.js'];
const SCRIPTS = FILES.map((f) => new vm.Script(readFileSync(new URL('../vendor/' + f, import.meta.url), 'utf8'), { filename: 'vendor/' + f }));
export const WEIGH_MASTERS = ['nexora.constants.v1', 'nexora.constants.custom.v1', 'nexora.constants.links.v1', 'nexora.structures.v1',
  /* 4.67.14 — the company's document series, set by its administrator (owner 2026-09-28) */
  'nexora.docseries.v1',
  /* 4.67.15 — and its units ("unit will be one sided from company not base on user") */
  'nexora.units.v1', 'nexora.meshunit.v1'];
/* the fields counted in tapes (app.js AI_MESH_KEYS); every field defined in mm is a length */
const MESH_KEYS = { 'M.WARP': 1, 'M.WEFT': 1 };

/** The desktop's modules, over one company's masters. Fresh each time: nothing leaks between companies. */
export function desktopOver(masters) {
  const data = {};
  Object.keys(masters || {}).forEach((k) => {
    const v = masters[k];
    if (v !== undefined && v !== null) data[k] = typeof v === 'string' ? v : JSON.stringify(v);
  });
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
  const ctx = vm.createContext({ localStorage, console: { log() {}, warn() {}, error() {} } });
  SCRIPTS.forEach((s) => s.runInContext(ctx, { timeout: 2000 }));
  return ctx;
}

async function mastersOf(companyId) {
  const rows = await q(`SELECT id, body FROM sync_records WHERE company_id = $1 AND kind = 'master' AND deleted = false AND id IN ($2, $3, $4, $5, $6, $7, $8)`,
    [companyId].concat(WEIGH_MASTERS));
  const out = {};
  rows.forEach((r) => { out[r.id] = r.body; });
  return out;
}

/** What the phone's form needs: every construction with its active fields, and the fields themselves. */
export function formOf(d) {
  const lookup = d.NexoraConstantsStore.getLookup(d.NexoraConstants.SEED_CONSTANTS);
  const U = d.NexoraUnits;
  const fields = d.NexoraFieldDefs.FIELDS.map((f) => {
    const link = d.NexoraConstantsStore.getLinkForField(f.key);
    const linked = link && lookup[link] !== undefined ? lookup[link] : null;
    const isLen = f.unit === 'mm', isMesh = !!MESH_KEYS[f.key];
    return {
      key: f.key, label: f.label, type: f.type === 'enum' ? 'enum' : 'number', tab: f.tab,
      /* in the company's units, as its computers show them */
      unit: isMesh ? 'tapes ' + U.meshLabel() : isLen ? U.label() : (f.unit || ''),
      options: Array.isArray(f.options) ? f.options : [], required: !!f.required, always: f.flagKey === null,
      /* a blank field takes its linked constant's value, as on the computer (shown in the company's unit) */
      linked: linked == null ? null : isLen ? U.forInput(linked) : isMesh ? U.meshForInput(linked) : linked
    };
  });
  const constructions = d.NexoraStructureStore.getAll().map((c) => ({
    name: c.name, description: c.description || '',
    fields: d.NexoraFieldDefs.FIELDS.filter((f) => f.flagKey === null || (c.fields && c.fields[f.flagKey])).map((f) => f.key)
  }));
  return { tabs: d.NexoraFieldDefs.TABS, fields, constructions,
    units: { length: U.label(), lengthName: U.current().plural, mesh: U.meshLabel() } };
}

/** app.js engineInputFor(), the same lines: blank fields take their linked constant; the tolerance goes in. */
function engineInput(d, calc) {
  const merged = Object.assign({}, calc.inputs || {});
  const lookup = d.NexoraConstantsStore.getLookup(d.NexoraConstants.SEED_CONSTANTS);
  d.NexoraFieldDefs.FIELDS.forEach((f) => {
    if (merged[f.key] !== undefined && merged[f.key] !== '') return;
    const linkedConst = d.NexoraConstantsStore.getLinkForField(f.key);
    if (linkedConst && lookup[linkedConst] !== undefined) merged[f.key] = lookup[linkedConst];
  });
  return Object.assign(merged, { 'TARGET WEIGHT': calc.targetWeight, 'DOWNSIDE %': calc.downsidePct, 'UPSIDE %': calc.upsidePct });
}

/** The construction, the fields it shows, and the inputs typed in the company's units turned into what the
 *  computer's form stores. Shared by weighing and by C8's GSM search, so both read the units the same way. */
function prepared(d, c) {
  const construction = d.NexoraStructureStore.get(String(c.structure || ''));
  if (!construction) return { refusal: { httpStatus: 400, body: { error: 'NO_CONSTRUCTION', message: 'Pick a construction first.' } } };
  /* only the fields this construction shows, as the computer's form only offers those */
  const active = {};
  d.NexoraFieldDefs.FIELDS.forEach((f) => { if (f.flagKey === null || construction.fields[f.flagKey]) active[f.key] = true; });
  /* typed in the company's units: into millimetres and tapes per inch, as the computer's form stores them */
  const isLen = {}; d.NexoraFieldDefs.FIELDS.forEach((f) => { if (f.unit === 'mm') isLen[f.key] = true; });
  const inputs = {};
  Object.keys(c.inputs || {}).forEach((k) => {
    const v = c.inputs[k];
    if (!active[k] || v === null || v === undefined || v === '') return;
    if (typeof v === 'number' && c.units !== 'stored') {
      if (MESH_KEYS[k]) { const m = d.NexoraUnits.meshToInch(v); inputs[k] = m === undefined ? v : m; return; }
      if (isLen[k]) { const l = d.NexoraUnits.toMm(v); inputs[k] = l === null ? v : l; return; }
    }
    inputs[k] = typeof v === 'number' ? v : String(v).slice(0, 40);
  });
  return { construction, active, inputs };
}

/** The engine's answer as the phone is sent it. JSON round trip: out of the vm's realm, into plain objects. */
function plainResult(r) {
  return JSON.parse(JSON.stringify({
    netWeight: r.netWeight, minWeight: r.minWeight, maxWeight: r.maxWeight, variance: r.variance, variancePercent: r.variancePercent,
    components: r.components, derived: r.derived, reporting: r.reporting, trace: r.trace,
    errors: r.errors || [], warnings: r.warnings || []
  }));
}

/** The normal weighing of prepared inputs: one engine run, the tolerance band from the calculation's target. */
function weighPrepared(d, p, c) {
  const rec = { inputs: p.inputs, targetWeight: c.targetWeight, downsidePct: c.downsidePct, upsidePct: c.upsidePct };
  const r = d.NexoraEngine.calculate(engineInput(d, rec), { constants: d.NexoraConstantsStore.getLookup(d.NexoraConstants.SEED_CONSTANTS), construction: p.construction });
  return { httpStatus: 200, body: { ok: true, structure: p.construction.name, inputs: p.inputs, result: plainResult(r) } };
}

/** Weigh one bag over the given desktop modules. Exported for the tests, which weigh with no database.
 *  C8 (owner 2026-10-01) — with solveGsm: true the target weight is given and the body fabric GSM is found. */
export function weighWith(d, calc) {
  const c = calc && typeof calc === 'object' ? calc : {};
  if (c.solveGsm === true) return solveGsmWith(d, c);
  const p = prepared(d, c);
  if (p.refusal) return p.refusal;
  return weighPrepared(d, p, c);
}

/* ------------------------------------------------------------------
   C8 — WEIGHT IN, GSM OUT  (owner 2026-10-01: "mobile app has feature of
   gsm to weight and weight to gsm at calculation")
   ------------------------------------------------------------------
   The computer's Calculation, in Weight mode, takes a target bag weight
   and finds the Body Fabric GSM for it: app.js solveGsmFromWeight(), a
   bisection of BD FAB GSM over the unchanged engine. This is that search,
   line for line — the same bounds (5 and 400 g/m²), the same 60 steps or
   0.005 g/m² apart, the same rounding to 0.1, the same words when the
   target is out of reach — so the phone, which carries no formula, gets
   the computer's GSM. The bag is then weighed once more at that GSM,
   exactly as the computer recalculates its form after writing it in.
   It is a copy, not a shared file (app.js is the whole window), so
   weigh-test.mjs cuts solveGsmFromWeight() out of the desktop's app.js,
   runs that real text with stand-ins for the screen and checks this
   search gives the same GSM, gram and words — if the desktop's search
   ever changes, that test fails until this one follows. */
const GSM_KEY = 'BD FAB GSM';
const GSM_LO = 5, GSM_HI = 400;
/* the computer's fmt(n, 2): two decimals, grouped (en-IN, the plants' own; the same as en-US below 1,00,000) */
const g2 = (x) => Number(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** app.js bodyGpmOf(): the engine's own body GPM figure (reporting.MBC8, "Body UL GPM"), wherever it keeps it. */
export function bodyGpmOf(res) {
  const rep = res && res.reporting;
  if (!rep) return null;
  const pick = (x) => (x && typeof x === 'object') ? x.value : x;
  if (Array.isArray(rep)) {
    const hit = rep.find((x) => /body.*GPM/i.test(String(x.label || x.name || x.key || '')));
    return hit ? Number(pick(hit)) : null;
  }
  for (const k of Object.keys(rep)) {
    if (/^MBC8$|body.*GPM/i.test(k) || /body.*GPM/i.test(String((rep[k] && rep[k].label) || ''))) {
      const v = Number(pick(rep[k]));
      if (isFinite(v)) return v;
    }
  }
  return null;
}

function solveGsmWith(d, c) {
  const p = prepared(d, c);
  if (p.refusal) return p.refusal;
  if (!p.active[GSM_KEY]) return { httpStatus: 400, body: { error: 'NO_GSM_FIELD', message: 'This construction has no body fabric GSM to find.' } };
  /* a JSON number only (C8: "targetWeight not a number > 0 → NO_TARGET"); text such as "75", "1e2" or "0x46" is refused,
     not guessed at — the phone sends a number, or "" when nothing is typed */
  const target = typeof c.targetWeight === 'number' ? c.targetWeight : NaN;
  if (!(isFinite(target) && target > 0)) return { httpStatus: 400, body: { error: 'NO_TARGET', message: 'Type the target weight in grams.' } };
  /* any GSM sent is ignored: the search sets it */
  delete p.inputs[GSM_KEY];
  const opts = { constants: d.NexoraConstantsStore.getLookup(d.NexoraConstants.SEED_CONSTANTS), construction: p.construction };
  const rec = { inputs: p.inputs, targetWeight: c.targetWeight, downsidePct: c.downsidePct, upsidePct: c.upsidePct };
  const weightAt = (gsm) => {
    try {
      const r = d.NexoraEngine.calculate(Object.assign({}, engineInput(d, rec), { [GSM_KEY]: gsm }), opts);
      return (r && !(r.errors || []).length && isFinite(r.netWeight)) ? r.netWeight : null;
    } catch (e) { return null; }
  };
  let lo = GSM_LO, hi = GSM_HI;
  const wLo = weightAt(lo), wHi = weightAt(hi);
  if (wLo == null || wHi == null) {
    return { httpStatus: 422, body: { error: 'CANNOT_WEIGH', message: 'The bag cannot be weighed yet — fill in its sizes first, and the GSM follows.' } };
  }
  if (target < wLo) {
    return { httpStatus: 422, body: { error: 'TARGET_OUT_OF_REACH', reason: 'TOO_LIGHT', weightAtMin: wLo,
      message: 'Even at ' + lo + ' g/m² the bag weighs ' + g2(wLo) + ' g — its other parts alone exceed the target of ' + g2(target) + ' g.' } };
  }
  if (target > wHi) {
    return { httpStatus: 422, body: { error: 'TARGET_OUT_OF_REACH', reason: 'TOO_HEAVY', weightAtMax: wHi,
      message: 'Even at ' + hi + ' g/m² the bag weighs only ' + g2(wHi) + ' g — the target of ' + g2(target) + ' g is out of reach on fabric alone.' } };
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const w = weightAt(mid);
    if (w == null) break;
    if (w < target) lo = mid; else hi = mid;
    if (hi - lo < 0.005) break;
  }
  const gsm = Math.round(((lo + hi) / 2) * 10) / 10;
  /* weighed once more at that GSM, the ordinary way (the tolerance band from the target, as today) */
  p.inputs[GSM_KEY] = gsm;
  const out = weighPrepared(d, p, c);
  const res = out.body.result;
  out.body.solved = { ok: true, gsm, target, netWeight: res.netWeight, bodyGpm: bodyGpmOf(res) };
  return out;
}

/** The next calculation number and item code in the company's series, past every one it has used
 *  (the desktop's nextCalcNumber / nextItemCode, over the company's records instead of one computer's). */
export function numbersWith(d, usedCalc, usedItems, year) {
  return { calcNumber: d.NexoraDocSeries.next('calc', usedCalc, year), itemCode: d.NexoraDocSeries.next('item', usedItems) };
}

export async function calcNumbers(companyId) {
  const rows = await q(`SELECT body->>'calcNumber' AS n, body->>'itemCode' AS c FROM sync_records WHERE company_id = $1 AND kind = 'calc'`, [companyId]);
  const d = desktopOver(await mastersOf(companyId));
  const out = numbersWith(d, rows.map((r) => r.n).filter(Boolean), rows.map((r) => r.c).filter(Boolean), new Date().getFullYear());
  return { httpStatus: 200, body: JSON.parse(JSON.stringify(out)) };
}

/** 4.68.2 — Nexora Mobile: the next enquiry number in the company's series (the phone holds only the enquiries
 *  it may see, so it cannot find the free number itself — the computers use their stubs). */
export async function enquiryNumber(companyId) {
  const rows = await q(`SELECT body->>'enquiryNumber' AS n FROM sync_records WHERE company_id = $1 AND kind = 'enquiry'`, [companyId]);
  const d = desktopOver(await mastersOf(companyId));
  const n = d.NexoraDocSeries.next('enquiry', rows.map((r) => r.n).filter(Boolean), new Date().getFullYear());
  return { httpStatus: 200, body: { enquiryNumber: String(n) } };
}

export async function calcForm(companyId) {
  return { httpStatus: 200, body: formOf(desktopOver(await mastersOf(companyId))) };
}

export async function calcWeigh(companyId, calc) {
  return weighWith(desktopOver(await mastersOf(companyId)), calc);
}

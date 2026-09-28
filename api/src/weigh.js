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

/** Weigh one bag over the given desktop modules. Exported for the tests, which weigh with no database. */
export function weighWith(d, calc) {
  const c = calc && typeof calc === 'object' ? calc : {};
  const construction = d.NexoraStructureStore.get(String(c.structure || ''));
  if (!construction) return { httpStatus: 400, body: { error: 'NO_CONSTRUCTION', message: 'Pick a construction first.' } };
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
  const rec = { inputs, targetWeight: c.targetWeight, downsidePct: c.downsidePct, upsidePct: c.upsidePct };
  const r = d.NexoraEngine.calculate(engineInput(d, rec), { constants: d.NexoraConstantsStore.getLookup(d.NexoraConstants.SEED_CONSTANTS), construction });
  /* JSON round trip: out of the vm's realm, into plain objects */
  const out = JSON.parse(JSON.stringify({
    netWeight: r.netWeight, minWeight: r.minWeight, maxWeight: r.maxWeight, variance: r.variance, variancePercent: r.variancePercent,
    components: r.components, derived: r.derived, reporting: r.reporting, trace: r.trace,
    errors: r.errors || [], warnings: r.warnings || []
  }));
  return { httpStatus: 200, body: { ok: true, structure: construction.name, inputs, result: out } };
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

export async function calcForm(companyId) {
  return { httpStatus: 200, body: formOf(desktopOver(await mastersOf(companyId))) };
}

export async function calcWeigh(companyId, calc) {
  return weighWith(desktopOver(await mastersOf(companyId)), calc);
}

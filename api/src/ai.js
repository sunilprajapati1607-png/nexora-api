/**
 * Nexora service — Nexora AI (Google Gemini), phase 1: "check this BOM"
 * ======================================================================
 *   "hu tamne google studio ni api key aapu tame bom llm ane workflow
 *    model ma aene set kri ne workflow ane llm model ne easy kri sako?"
 *
 * What it does: reads the SHAPE of a BOM — the stages, where each takes
 * its input, which kinds of material each has, the waste, what each makes —
 * and says in plain words what looks wrong or worth checking. It never
 * computes a weight, a quantity or a cost; the engines do that. It only
 * suggests, and every answer is shown as "Nexora AI".
 *
 * What it is never sent: prices, rates, costs, customer or item names.
 * Recipes DO go (owner 2026-09-26, "reciepy javado"): each line's material,
 * its group, basis, value and kilograms — so recipe mistakes can be caught. The application builds a technical
 * summary, and clean() below keeps only the fields named here — whatever
 * else arrives is dropped before anything leaves this service. (On
 * Google's free tier what is sent may be used to improve its products.)
 *
 * The key lives only here: GEMINI_API_KEY on Render. The model comes from
 * GEMINI_MODEL (default gemini-2.5-flash-lite) and is checked against the
 * models the key can actually use, falling back to another Flash model, so
 * Google retiring one never needs a release.
 *
 * Limits: the free tier is shared by every plant, so each company gets
 * AI_DAILY_PER_COMPANY checks a day (default 60) and the service sends at
 * most AI_PER_MINUTE (default 10) a minute; beyond that it says "busy"
 * with the seconds to wait. Counters are in memory (reset on a restart).
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
/* 4.67.1 — live, Google answered: "gemini-2.5-flash-lite is no longer
   available to new users … use gemini-3.5-flash-lite". So the default is
   the newer one, and the choice below always prefers the NEWEST Flash-Lite
   (then Flash) the key lists — a model Google refuses is set aside and
   the one it names is tried in the same request. */
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const blocked = new Set();                       // models Google has refused this run
/** 'gemini-3.5-flash-lite' → a sort key: flash-lite before flash, newer first */
function rankOf(n) {
  const m = /^gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash)(?:-(\d{3}))?$/.exec(n);
  if (!m) return null;
  return (m[3] === 'flash-lite' ? 2e6 : 1e6) + Number(m[1]) * 1000 + Number(m[2] || 0) * 10 + (m[4] ? 0 : 1);
}
function bestOf(names) {
  return names.filter((n) => !blocked.has(n) && rankOf(n) !== null).sort((a, b) => rankOf(b) - rankOf(a))[0] || null;
}
export function _blocked() { return blocked; }
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 30000;

const key = () => String(process.env.GEMINI_API_KEY || '').trim();
export function aiConfigured() { return !!key(); }

/* never let the key into a message, a log or an answer */
function scrub(s) {
  let t = String(s || '');
  const k = key();
  if (k) t = t.split(k).join('[key]');
  return t.replace(/key=[A-Za-z0-9_\-]+/g, 'key=[key]').slice(0, 300);
}

/* ---- the model ---------------------------------------------------------- */
let model = { name: null, at: 0, error: null, available: [] };
let resolving = null;

async function gfetch(url, opts, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await f(url, Object.assign({}, opts, { signal: ctrl.signal,
      headers: Object.assign({ 'content-type': 'application/json', 'x-goog-api-key': key() }, (opts && opts.headers) || {}) }));
    const text = await r.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text.slice(0, 200) }; }
    return { ok: r.ok, status: r.status, body };
  } finally { clearTimeout(timer); }
}

/** Which model to use: the one asked for if the key has it, else a Flash that it has. */
export async function resolveModel(force, fetchImpl) {
  if (!aiConfigured()) return null;
  if (!force && model.name && Date.now() - model.at < MODEL_TTL_MS) return model.name;
  if (resolving) return resolving;
  resolving = (async () => {
    const wanted = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim().replace(/^models\//, '');
    try {
      const r = await gfetch(API + '/models?pageSize=200', { method: 'GET' }, fetchImpl);
      if (!r.ok) throw new Error('models list ' + r.status + ': ' + scrub(r.body && r.body.error && r.body.error.message));
      const names = ((r.body && r.body.models) || [])
        .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') > -1)
        .map((m) => String(m.name || '').replace(/^models\//, ''));
      const pick = (names.indexOf(wanted) > -1 && !blocked.has(wanted)) ? wanted : bestOf(names);
      model = { name: pick, at: Date.now(), error: pick ? (pick === wanted ? null : 'asked for ' + wanted + ', using ' + pick) : 'no usable model on this key', available: names.slice(0, 40) };
    } catch (e) {
      /* the list could not be read: try the model asked for anyway */
      model = { name: wanted, at: Date.now() - MODEL_TTL_MS + 5 * 60 * 1000, error: scrub(e && e.message), available: [] };
    } finally { resolving = null; }
    return model.name;
  })();
  return resolving;
}

/** For /health — cached, never waits on Google. */
export function aiStatus() {
  if (aiConfigured() && (!model.at || Date.now() - model.at > MODEL_TTL_MS)) resolveModel(false).catch(() => {});
  return { configured: aiConfigured(), model: model.name, note: model.error || null };
}

/* ---- limits ------------------------------------------------------------- */
const perCompany = new Map();        // companyId -> { day, n }
let recent = [];                     // times of the last minute's calls
const daily = () => Math.max(1, parseInt(process.env.AI_DAILY_PER_COMPANY, 10) || 60);
const perMinute = () => Math.max(1, parseInt(process.env.AI_PER_MINUTE, 10) || 10);
function today() { return new Date().toISOString().slice(0, 10); }
function take(companyId) {
  const now = Date.now();
  recent = recent.filter((t) => now - t < 60000);
  if (recent.length >= perMinute()) return { busy: Math.ceil((60000 - (now - recent[0])) / 1000) };
  const k = String(companyId || 'none');
  const c = perCompany.get(k);
  const d = today();
  const used = c && c.day === d ? c.n : 0;
  if (used >= daily()) return { spent: true, used };
  perCompany.set(k, { day: d, n: used + 1 });
  recent.push(now);
  return { left: daily() - used - 1 };
}
export function _resetLimits() { perCompany.clear(); recent = []; }

/* ---- what may be sent ---------------------------------------------------- */
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n || 80);
const nr = (v) => { const x = Number(v); return isFinite(x) ? Math.round(x * 100) / 100 : null; };
const list = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
export function clean(p) {
  const x = p && typeof p === 'object' ? p : {};
  return {
    construction: str(x.construction, 60),
    mode: x.mode === 'SPLIT' ? 'SPLIT' : 'WHOLE',
    part: str(x.part, 40),
    route: str(x.route, 80),
    bags: nr(x.bags),
    bagGrams: nr(x.bagGrams),
    parts: list(x.parts, 12).map((q) => ({ label: str(q && q.label, 40), grams: nr(q && q.grams), onTab: !!(q && q.onTab), routed: !!(q && q.routed) })),
    stages: list(x.stages, 30).map((s) => ({
      n: nr(s && s.n), process: str(s && s.process, 60), code: str(s && s.code, 30),
      sourcing: s && s.sourcing === 'BUY' ? 'BUY' : 'MAKE',
      wastePct: nr(s && s.wastePct), outputKg: nr(s && s.outputKg), grossKg: nr(s && s.grossKg), inputKg: nr(s && s.inputKg),
      from: list(s && s.from, 6).map(nr).filter((v) => v !== null),
      fromHow: ['chosen', 'assumed', 'own line', 'recipe', 'bought'].indexOf(s && s.fromHow) > -1 ? s.fromHow : '',
      makes: str(s && s.makes, 40), takes: list(s && s.takes, 6).map((t) => str(t, 30)),
      materialKinds: list(s && s.materialKinds, 12).map((t) => str(t, 30)),
      earlierStageRows: nr(s && s.earlierStageRows), partsTakenIn: list(s && s.partsTakenIn, 6).map((t) => str(t, 40)),
      resources: !!(s && s.resources),
      /* the recipe: material, group, basis, value, kg — never a rate or a cost */
      lines: list(s && s.lines, 20).map((l) => ({
        kind: ['RM', 'SFG', 'PART'].indexOf(l && l.kind) > -1 ? l.kind : 'RM',
        material: str(l && l.material, 60), group: str(l && l.group, 30),
        basis: ['PCT', 'PER1000', 'PERBAG_G', 'PART_G', 'ABS'].indexOf(l && l.basis) > -1 ? l.basis : '',
        value: nr(l && l.value), kg: nr(l && l.kg), fromStage: nr(l && l.fromStage)
      }))
    })),
    warnings: list(x.warnings, 15).map((w) => str(w, 300))
  };
}

const SYSTEM = [
  'You are Nexora AI, inside Nexora, software that plans PP/PE woven sack production (tape, weaving, BOPP printing and slitting, lamination, backseam, block/pinch bottom, stitching, finishing, packing).',
  'You are given the SHAPE of one bill of materials: its stages in route order, where each stage takes its input from, what kinds of material it adds, its waste %, and the kilograms each stage makes. You also see the recipe lines of each stage (material, group, basis, value, kg). You never see prices, rates or costs, and you must not guess any.',
  'Find planning problems and things worth checking, for example: a BOPP stage taking the woven fabric instead of film; BOPP printing with no BOPP film; lamination missing its fabric or its film; a stage that makes nothing; a stage whose input is only "assumed"; an unusually high waste (above about 8 %) or zero waste where the process always loses some; a part with no route; a stage bought in part way through; steps in an odd order; recipe problems — % of gross lines on one stage adding to well over or under 100 together with its earlier-stage rows, a coating or lamination stage with no granule, a tape stage with no masterbatch or filler where one is usual, the same material twice on one stage.',
  'Never recompute or correct the numbers — the engine is right about arithmetic. Say what to look at and what to change in Nexora (Edit section, Earlier stage row, Choose components, waste %).',
  'Answer ONLY with JSON: {"summary": string, "findings": [{"level": "problem" | "check" | "ok", "stage": number or null, "title": string, "detail": string, "fix": string}]}. At most 8 findings, most important first. If all looks right, one "ok" finding.'
].join(' ');

function promptFor(p, lang) {
  return langLine(lang, 'your reply') + 'BOM:\n' + JSON.stringify(p);
}

function readAnswer(body) {
  const parts = (((body && body.candidates) || [])[0] || {}).content;
  const text = ((parts && parts.parts) || []).map((x) => x.text || '').join('').trim();
  if (!text) return null;
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let out;
  try { out = JSON.parse(json); } catch (e) { return null; }
  const LEVELS = { problem: 1, check: 1, ok: 1 };
  return {
    summary: str(out && out.summary, 600),
    findings: list(out && out.findings, 8).map((f) => ({
      level: LEVELS[f && f.level] ? f.level : 'check',
      stage: (f && f.stage != null && isFinite(Number(f.stage))) ? Number(f.stage) : null,
      title: str(f && f.title, 160), detail: str(f && f.detail, 700), fix: str(f && f.fix, 400)
    })).filter((f) => f.title)
  };
}


/* ---- one call to Gemini, shared by every Nexora AI question ------------- */
async function ask(companyId, system, prompt, fetchImpl) {
  if (!aiConfigured()) return { fail: { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } } };
  const t = take(companyId);
  if (t.busy) return { fail: { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy — try again in ' + t.busy + ' seconds.' } } };
  if (t.spent) return { fail: { httpStatus: 429, body: { error: 'AI_DAILY', message: 'This company has used today’s ' + daily() + ' Nexora AI checks. They come back tomorrow.' } } };
  let name = await resolveModel(false, fetchImpl);
  if (!name) return { fail: { httpStatus: 503, body: { error: 'AI_MODEL', message: 'Nexora AI has no model it can use right now.' } } };
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: (prompt && prompt.contents) ? prompt.contents : [{ role: 'user', parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }],   /* text, parts (a recording + text), or a whole conversation */   /* text, or parts (a recording + text) */
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 2048 }
  });
  let r;
  /* 4.67.1 — a model Google has retired is set aside and the request is
     asked again, of the model Google names (or the newest the key lists),
     at most twice — the person never sees "no longer available" */
  for (let attempt = 0; ; attempt++) {
    try {
      r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', { method: 'POST', body: payload }, fetchImpl);
    } catch (e) {
      return { fail: { httpStatus: 504, body: { error: 'AI_TIMEOUT', message: 'Nexora AI did not answer in time. Try again.' } } };
    }
    const msg = String((r.body && r.body.error && r.body.error.message) || '');
    const gone = !r.ok && (r.status === 404 || /no longer available|not found|is not supported|deprecated/i.test(msg));
    if (!gone || attempt >= 2) break;
    blocked.add(name);
    const named = (msg.match(/models\/(gemini-[\w.\-]+)/g) || []).map((x) => x.replace(/^models\//, '')).filter((n) => n !== name && !blocked.has(n))[0];
    const next = named || await resolveModel(true, fetchImpl);
    if (!next || blocked.has(next)) break;
    name = next;
    model = Object.assign({}, model, { name: next, at: Date.now(), error: 'switched to ' + next + ' (Google retired the one before)' });
  }
  if (!r.ok) {
    const busy = r.status === 429;
    return { fail: { httpStatus: busy ? 429 : 502, body: { error: busy ? 'AI_BUSY' : 'AI_FAILED', retryAfter: busy ? 60 : undefined,
      message: busy ? 'Nexora AI is busy (Google’s limit) — try again in a minute.' : 'Nexora AI could not answer (' + r.status + '): ' + scrub(r.body && r.body.error && r.body.error.message) } } };
  }
  const parts = (((r.body && r.body.candidates) || [])[0] || {}).content;
  const text = ((parts && parts.parts) || []).map((x) => x.text || '').join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!json) return { fail: { httpStatus: 502, body: { error: 'AI_UNREADABLE', message: 'Nexora AI answered in a form Nexora could not read. Try again.' } } };
  return { json: json, model: name, left: t.left };
}

/** POST /v1/ai/check-bom — phase 1 */
export async function checkBom(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = clean(payload);
  if (!p.stages.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'There is no route on this BOM to check yet.' } };
  const a = await ask(companyId, SYSTEM, promptFor(p, lang), fetchImpl);
  if (a.fail) return a.fail;
  const ans = readAnswer({ candidates: [{ content: { parts: [{ text: JSON.stringify(a.json) }] } }] });
  if (!ans) return { httpStatus: 502, body: { error: 'AI_UNREADABLE', message: 'Nexora AI answered in a form Nexora could not read. Try again.' } };
  return { httpStatus: 200, body: Object.assign({ ok: true, model: a.model, left: a.left }, ans) };
}

/* ---- phase 2: a route (or a saved workflow) from plain words --------------
   "pahela phase 2 par jaiye". The user says what the bag is; Nexora AI picks
   the stages from THIS plant's own process master — nothing else is
   accepted — or points at a route or workflow the plant already has.
   Nothing is created here: the application shows the proposal and the user
   presses Create or Use. The recipes of a new route's stages are then filled
   by Nexora's own learning, marked as suggestions. */
export function cleanPlan(p) {
  const x = p && typeof p === 'object' ? p : {};
  const bag = x.bag && typeof x.bag === 'object' ? x.bag : {};
  return {
    text: str(x.text, 600),
    bag: {
      construction: str(bag.construction, 60), bagGrams: nr(bag.bagGrams), laminated: !!bag.laminated, lined: !!bag.lined,
      parts: list(bag.parts, 12).map((q) => ({ label: str(q && q.label, 40), grams: nr(q && q.grams) })),
      specs: list(bag.specs, 30).map((q) => ({ name: str(q && q.name, 30), value: str(q && q.value, 20) }))
    },
    processes: list(x.processes, 60).map((q) => ({ code: str(q && q.code, 30), name: str(q && q.name, 60),
      consumes: list(q && q.consumes, 8).map((c) => str(c, 30)), produces: str(q && q.produces, 40) })).filter((q) => q.code),
    routes: list(x.routes, 40).map((q) => ({ id: str(q && q.id, 60), name: str(q && q.name, 80), steps: list(q && q.steps, 30).map((c) => str(c, 30)), forThis: !!(q && q.forThis) })).filter((q) => q.id),
    workflows: list(x.workflows, 40).map((q) => ({ id: str(q && q.id, 60), name: str(q && q.name, 80), mode: q && q.mode === 'SPLIT' ? 'SPLIT' : 'WHOLE',
      routes: list(q && q.routes, 8).map((c) => str(c, 80)) })).filter((q) => q.id)
  };
}

const PLAN_SYSTEM = [
  'You are Nexora AI, inside Nexora, software that plans PP/PE woven sack production.',
  'Given a bag (its construction, parts and specification), what the user says about it, this plant’s PROCESS MASTER (code, name, what each consumes and produces), the plant’s saved ROUTES and saved WORKFLOWS, propose how to make the bag.',
  'Prefer, in this order: a saved workflow that fits (choice "workflow"); a saved route that fits (choice "route"); otherwise a new route (choice "new").',
  'A new route is an ordered list of process CODES taken ONLY from the process master, each code at most twice. Follow the material: each step should consume what an earlier step produces, or raw material (RM). A bag has BOPP printing and slitting stages only if it is BOPP laminated; the fabric (tape, weaving) and the film (BOPP printing, slitting) meet at lamination. Put lamination after both lines, then backseam or bottom forming, finishing and packing as the bag needs. Do not invent processes; if one is missing, say so in notes.',
  'You do not choose materials, quantities, prices or costs.',
  'Answer ONLY with JSON: {"summary": string, "choice": "workflow" | "route" | "new", "workflowId": string or null, "routeId": string or null, "route": {"name": string, "steps": [{"code": string, "why": string}]} or null, "notes": [string]}.'
].join(' ');

/** POST /v1/ai/plan-route — phase 2 */
export async function planRoute(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanPlan(payload);
  if (!p.processes.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'The process master is empty.' } };
  if (!p.text && !p.bag.construction) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say what the bag is first.' } };
  const m = mediaParts(payload);
  if (m.error) return m.error;
  const prompt = langLine(lang, 'summary, why and notes') +
    (m.audio ? 'The person describes the bag in the attached recording.\n' : '') + 'INPUT:\n' + JSON.stringify(p);
  const a = await ask(companyId, PLAN_SYSTEM, m.parts.concat([{ text: prompt }]), fetchImpl);
  if (a.fail) return a.fail;
  const j = a.json || {};
  const codes = {};
  p.processes.forEach((q) => { codes[q.code] = true; });
  const wfIds = {}; p.workflows.forEach((w) => { wfIds[w.id] = true; });
  const rtIds = {}; p.routes.forEach((r) => { rtIds[r.id] = true; });
  /* what the model says is checked against what was sent: an unknown code
     or id never reaches the application */
  const dropped = [];
  const seen = {};
  const steps = list(j.route && j.route.steps, 30).map((s) => ({ code: str(s && s.code, 30).toUpperCase(), why: str(s && s.why, 300) }))
    .filter((s) => {
      if (!codes[s.code]) { if (s.code) dropped.push(s.code); return false; }
      seen[s.code] = (seen[s.code] || 0) + 1;
      return seen[s.code] <= 2;
    });
  let choice = ['workflow', 'route', 'new'].indexOf(j.choice) > -1 ? j.choice : 'new';
  const workflowId = choice === 'workflow' && wfIds[j.workflowId] ? j.workflowId : null;
  const routeId = choice === 'route' && rtIds[j.routeId] ? j.routeId : null;
  if (choice === 'workflow' && !workflowId) choice = steps.length ? 'new' : 'none';
  if (choice === 'route' && !routeId) choice = steps.length ? 'new' : 'none';
  if (choice === 'new' && !steps.length) choice = 'none';
  return { httpStatus: 200, body: {
    ok: true, model: a.model, left: a.left, summary: str(j.summary, 600), choice: choice,
    workflowId: workflowId, routeId: routeId,
    route: choice === 'new' ? { name: str(j.route && j.route.name, 80) || 'Nexora AI route', steps: steps } : null,
    notes: list(j.notes, 6).map((n) => str(n, 300)).filter(Boolean)
      .concat(dropped.length ? ['Left out, not in the process master: ' + dropped.join(', ')] : [])
  } };
}

/* ---- phase 3: the bag's specification, spoken or typed --------------------
   "aapde ai ne voice thi bag structure size and length ane bija
    specificatin aapisu ane khutta ae jate pusile che athava dropdown ma
    pusse aevu rakhvanu che".
   The person speaks (or types) the bag; Gemini hears it and places it on
   THIS plant's constructions and fields — nothing else is accepted: an
   unknown construction, field or option is dropped, a number must be a
   number. What a required field still lacks is listed, so the application
   asks for it (a dropdown where the field has options). Nothing is saved
   and nothing is weighed here: the application fills the form, the engine
   weighs, the person saves. */

export function cleanFill(p) {
  const x = p && typeof p === 'object' ? p : {};
  const fields = list(x.fields, 80).map((f) => ({
    key: str(f && f.key, 30), label: str(f && f.label, 60), unit: str(f && f.unit, 12),
    type: f && f.type === 'enum' ? 'enum' : 'number', options: list(f && f.options, 12).map((o) => str(o, 20)), required: !!(f && f.required)
  })).filter((f) => f.key);
  const known = {}; fields.forEach((f) => { known[f.key] = true; });
  return {
    text: str(x.text, 800),
    constructions: list(x.constructions, 80).map((c) => ({ name: str(c && c.name, 60), description: str(c && c.description, 120),
      fields: list(c && c.fields, 80).map((k) => str(k, 30)).filter((k) => known[k]) })).filter((c) => c.name),
    fields: fields,
    current: { structure: str(x.current && x.current.structure, 60),
      inputs: Object.keys((x.current && x.current.inputs) || {}).filter((k) => known[k]).slice(0, 80)
        .reduce((o, k) => { const v = x.current.inputs[k]; if (v !== undefined && v !== null && v !== '') o[k] = typeof v === 'number' ? nr(v) : str(v, 20); return o; }, {}) }
  };
}

const FILL_SYSTEM = [
  'You are Nexora AI, inside Nexora, software that weighs PP/PE woven sacks.',
  'A person describes one bag, by voice or in writing, in English, Gujarati or Hindi (often mixed). Place what they say on the CONSTRUCTIONS and FIELDS given — nothing else.',
  'Units: dimensions in millimetres (convert inches ×25.4 and centimetres ×10), GSM in g/m², micron in µm, mesh as threads per inch (e.g. "10 by 10" → M.WARP 10, M.WEFT 10). Width and length are the bag’s flat width and length. Bag quantity is "bagQuantity".',
  'Choose the construction from the list by what they say (layers, laminated or not, block bottom, stitched, valve, liner, pinch). An enum field takes one of its options exactly.',
  'Put in "inputs" only what was actually said, never a guess. List in "missing" each field of the chosen construction that is required but not said, with a short question to ask.',
  'Answer ONLY with JSON: {"transcript": string, "construction": string or null, "inputs": {"FIELD KEY": number or string}, "bagQuantity": number or null, "missing": [{"key": string, "question": string}], "summary": string}.'
].join(' ');

export async function fillCalc(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanFill(payload);
  /* the voice, and — 4.67.0 — a photo, a drawing or a PDF of the bag */
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!m.parts.length && !p.text) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say, type or show the bag first.' } };
  if (!p.constructions.length || !p.fields.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'This plant has no constructions to choose from.' } };
  const intro = langLine(lang, 'summary and questions') +
    (m.audio ? 'The bag is described in the attached recording.\n' : '') +
    (m.files ? 'The bag is also shown in the attached ' + m.files + ' photo(s) or document(s) — a drawing, a specification sheet or a sample bag: read its sizes and specification carefully; a size printed on a drawing is in the unit written beside it.\n' : '') +
    (p.text ? 'The person typed: ' + p.text + '\n' : '') +
    'CONTEXT:\n' + JSON.stringify({ constructions: p.constructions, fields: p.fields, current: p.current });
  const a = await ask(companyId, FILL_SYSTEM, m.parts.concat([{ text: intro }]), fetchImpl);
  if (a.fail) return a.fail;
  const j = a.json || {};
  /* checked against what was sent */
  const byName = {}; p.constructions.forEach((c) => { byName[c.name.toUpperCase()] = c; });
  const con = j.construction && byName[String(j.construction).trim().toUpperCase()] ? byName[String(j.construction).trim().toUpperCase()] : null;
  const fieldOf = {}; p.fields.forEach((f) => { fieldOf[f.key] = f; });
  const allowed = con ? con.fields : Object.keys(fieldOf);
  const inputs = {}; const dropped = [];
  Object.keys((j.inputs && typeof j.inputs === 'object') ? j.inputs : {}).forEach((k) => {
    const f = fieldOf[k];
    const v = j.inputs[k];
    if (!f || allowed.indexOf(k) < 0) { dropped.push(k); return; }
    if (f.type === 'enum') {
      const hit = f.options.filter((o) => o.toUpperCase() === String(v).trim().toUpperCase())[0];
      if (hit) inputs[k] = hit; else dropped.push(k);
    } else {
      const n = Number(String(v).replace(/,/g, ''));
      if (isFinite(n) && n >= 0) inputs[k] = Math.round(n * 1000) / 1000; else dropped.push(k);
    }
  });
  const asked = {};
  list(j.missing, 20).forEach((m) => { if (m && fieldOf[m.key]) asked[m.key] = str(m.question, 200); });
  const missing = [];
  if (!con) missing.push({ key: '__construction', question: lang === 'gu' ? 'કયું construction?' : lang === 'hi' ? 'कौन सा construction?' : 'Which construction is it?', type: 'enum', options: p.constructions.map((c) => c.name) });
  (con ? con.fields : []).forEach((k) => {
    const f = fieldOf[k];
    if (!f || inputs[k] !== undefined || (p.current.inputs[k] !== undefined && p.current.structure === (con && con.name))) return;
    if (f.required || asked[k]) missing.push({ key: k, label: f.label, unit: f.unit, type: f.type, options: f.options, question: asked[k] || f.label + (f.unit ? ' (' + f.unit + ')' : '') + '?' });
  });
  const qty = Number(j.bagQuantity);
  return { httpStatus: 200, body: {
    ok: true, model: a.model, left: a.left, transcript: str(j.transcript, 800), summary: str(j.summary, 400),
    construction: con ? con.name : null, inputs: inputs, bagQuantity: isFinite(qty) && qty > 0 ? Math.round(qty) : null,
    missing: missing, dropped: dropped
  } };
}

/* ==========================================================================
   4.67.0 — MORE NEXORA AI: photos and documents, BOM changes by voice,
   the quotation letter, and the helper. Owner 2026-09-26: "all"; "speak ane
   type banne thavu joiye"; "gujrati hindi englsh".
   ========================================================================== */

/** The answer language, said the same way to every question. */
export function langLine(lang, what) {
  const w = what || 'your answer';
  if (lang === 'gu') return 'Write ' + w + ' in Gujarati (Gujarati script). Keep codes, material names, process names, field names and Nexora button names in English.\n';
  if (lang === 'hi') return 'Write ' + w + ' in Hindi (Devanagari script). Keep codes, material names, process names, field names and Nexora button names in English.\n';
  return 'Write ' + w + ' in plain English.\n';
}
export function pickLang(v) { return v === 'gu' || v === 'hi' ? v : 'en'; }

/* ---- what a person may attach: their voice, a photo, a drawing, a PDF ---- */
const MEDIA_TYPES = {
  'audio/wav': 1, 'audio/x-wav': 1, 'audio/mp3': 1, 'audio/mpeg': 1, 'audio/ogg': 1, 'audio/flac': 1, 'audio/aac': 1, 'audio/webm': 1,
  'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/heic': 1, 'application/pdf': 1
};
const MAX_MEDIA_B64 = 8 * 1024 * 1024;
/** The recording and the attachments of a request, checked, as Gemini parts. */
export function mediaParts(payload) {
  const x = payload && typeof payload === 'object' ? payload : {};
  const all = [].concat(x.audio && typeof x.audio === 'object' ? [x.audio] : [], Array.isArray(x.attachments) ? x.attachments.slice(0, 4) : []);
  let total = 0;
  const parts = [];
  for (const m of all) {
    const mime = String((m && m.mime) || '').toLowerCase().split(';')[0];
    const data = String((m && m.data) || '');
    if (!MEDIA_TYPES[mime] || !data) return { error: { httpStatus: 400, body: { error: 'MEDIA', message: 'That recording or file could not be read (use a photo, a PDF or the microphone).' } } };
    total += data.length;
    if (total > MAX_MEDIA_B64) return { error: { httpStatus: 413, body: { error: 'MEDIA_BIG', message: 'That is too much to send at once — a minute of speech, or a few photos.' } } };
    parts.push({ inlineData: { mimeType: mime, data: data } });
  }
  return { parts: parts, audio: all.some((m) => /^audio\//.test(String(m && m.mime))), files: all.filter((m) => !/^audio\//.test(String(m && m.mime))).length };
}

/* ---- BOM changes, said or typed -------------------------------------------
   "Lamination ma LD 10 taka umero", "slitting waste 4 karo". Nexora AI turns
   it into a list of changes on THIS BOM's stages and THIS plant's materials;
   the application shows them and the person accepts. It sees material codes,
   names and groups — never a price. */
export function cleanEdit(p) {
  const x = p && typeof p === 'object' ? p : {};
  return {
    text: str(x.text, 600),
    stages: list(x.stages, 30).map((s) => ({ n: nr(s && s.n), process: str(s && s.process, 60), code: str(s && s.code, 30), wastePct: nr(s && s.wastePct),
      lines: list(s && s.lines, 25).map((l, i) => ({ line: i + 1, kind: l && l.kind === 'SFG' ? 'SFG' : 'RM', material: str(l && l.material, 40), name: str(l && l.name, 60),
        basis: str(l && l.basis, 10), value: nr(l && l.value) })) })).filter((s) => s.n),
    materials: list(x.materials, 300).map((m) => ({ code: str(m && m.code, 40), name: str(m && m.name, 60), group: str(m && m.group, 30) })).filter((m) => m.code)
  };
}
const EDIT_SYSTEM = [
  'You are Nexora AI, inside Nexora, software that plans PP/PE woven sack production.',
  'A person tells you, by voice or in writing (English, Gujarati or Hindi), how to change the bill of materials whose STAGES are given (each with its recipe lines and waste). Turn it into changes.',
  'Changes you may make: {"op":"waste","stage":n,"value":percent}; {"op":"add","stage":n,"material":CODE,"basis":"PCT"|"PERBAG_G"|"PER1000"|"ABS","value":number}; {"op":"set","stage":n,"line":k,"value":number}; {"op":"remove","stage":n,"line":k}.',
  'Use only material CODES from the MATERIALS list (match by name or code, e.g. "LD" or "LD granule"), only stages and lines that exist. "percent" of a material is basis PCT (percent of the stage gross). Do not change anything that was not asked. Never invent a price.',
  'Answer ONLY with JSON: {"summary": string, "transcript": string, "changes": [ ... ], "notes": [string]}.'
].join(' ');
export async function editBom(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanEdit(payload);
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!p.stages.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'There is no route on this BOM to change.' } };
  if (!p.text && !m.parts.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say or type the change first.' } };
  const intro = langLine(lang, 'summary and notes') + (m.audio ? 'The change is said in the attached recording.' + (p.text ? ' Also typed: ' + p.text : '') : 'The change, typed: ' + p.text) +
    '\nBOM:\n' + JSON.stringify({ stages: p.stages, materials: p.materials });
  const a = await ask(companyId, EDIT_SYSTEM, m.parts.concat([{ text: intro }]), fetchImpl);
  if (a.fail) return a.fail;
  const j = a.json || {};
  const stageOf = {}; p.stages.forEach((s) => { stageOf[s.n] = s; });
  const matOf = {}; p.materials.forEach((x) => { matOf[x.code.toUpperCase()] = x; });
  const BASES = { PCT: 1, PERBAG_G: 1, PER1000: 1, ABS: 1, PART_G: 1 };
  const changes = [], refused = [];
  list(j.changes, 20).forEach((c) => {
    const st = stageOf[Number(c && c.stage)];
    const v = Number(c && c.value);
    if (!c || !st) { refused.push('stage ' + (c && c.stage)); return; }
    if (c.op === 'waste') { if (isFinite(v) && v >= 0 && v < 100) changes.push({ op: 'waste', stage: st.n, value: Math.round(v * 1000) / 1000 }); else refused.push('waste ' + c.value); return; }
    if (c.op === 'add') {
      const mat = matOf[String(c.material || '').toUpperCase()];
      if (!mat || !isFinite(v) || v < 0) { refused.push('add ' + c.material); return; }
      changes.push({ op: 'add', stage: st.n, material: mat.code, name: mat.name, basis: BASES[c.basis] ? c.basis : 'PCT', value: Math.round(v * 1000) / 1000 });
      return;
    }
    const line = Number(c.line);
    if ((c.op === 'set' || c.op === 'remove') && line >= 1 && line <= st.lines.length) {
      if (c.op === 'remove') { changes.push({ op: 'remove', stage: st.n, line: line }); return; }
      if (isFinite(v) && v >= 0) { changes.push({ op: 'set', stage: st.n, line: line, value: Math.round(v * 1000) / 1000 }); return; }
    }
    refused.push(String(c.op) + ' ' + (c.line || ''));
  });
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, summary: str(j.summary, 400), transcript: str(j.transcript, 600),
    changes: changes, notes: list(j.notes, 6).map((n) => str(n, 300)).filter(Boolean).concat(refused.length ? ['Not understood or not allowed: ' + refused.join(', ')] : []) } };
}

/* ---- the quotation, as a letter and a WhatsApp message --------------------
   Selling figures go (they are on the quotation the buyer receives); cost
   never; the buyer's name never — the letter says {{CUSTOMER}} and the
   application puts the name in. */
export function cleanQuote(p) {
  const x = p && typeof p === 'object' ? p : {};
  const q = x.quote && typeof x.quote === 'object' ? x.quote : {};
  return {
    text: str(x.text, 400),
    quote: {
      number: str(q.number, 40), date: str(q.date, 20), validDays: nr(q.validDays), currency: str(q.currency, 6) || 'INR',
      seller: str(q.seller, 80), sellerCity: str(q.sellerCity, 40),
      items: list(q.items, 30).map((i) => ({ description: str(i && i.description, 120), size: str(i && i.size, 60), quantity: nr(i && i.quantity), unit: str(i && i.unit, 12),
        rate: nr(i && i.rate), amount: nr(i && i.amount) })),
      terms: list(q.terms, 12).map((t) => ({ name: str(t && t.name, 40), value: str(t && t.value, 160) })),
      total: nr(q.total)
    }
  };
}
const QUOTE_SYSTEM = [
  'You are Nexora AI, inside Nexora, writing for a PP/PE woven sack manufacturer to its buyer.',
  'From the QUOTATION given, write a short, courteous covering letter (with a subject line) and a WhatsApp message. Use the figures exactly as given; do not add, round or invent any figure, term or promise.',
  'Address the buyer as {{CUSTOMER}} (the application puts the name in); sign as the seller given, or {{SELLER}} if none.',
  'Answer ONLY with JSON: {"subject": string, "letter": string, "whatsapp": string}.'
].join(' ');
export async function quoteLetter(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanQuote(payload);
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!p.quote.items.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'This quotation has no items yet.' } };
  const intro = langLine(lang, 'the letter and the message') + (m.audio ? 'The person also said what to stress, in the attached recording.' : '') +
    (p.text ? ' The person asks: ' + p.text : '') + '\nQUOTATION:\n' + JSON.stringify(p.quote);
  const a = await ask(companyId, QUOTE_SYSTEM, m.parts.concat([{ text: intro }]), fetchImpl);
  if (a.fail) return a.fail;
  const j = a.json || {};
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, subject: str(j.subject, 200), letter: str(j.letter, 4000), whatsapp: str(j.whatsapp, 1500) } };
}

/* ---- the helper: how do I…, what is… — from Nexora's own help ------------ */
export function cleanHelp(p) {
  const x = p && typeof p === 'object' ? p : {};
  return {
    text: str(x.text, 600), screen: str(x.screen, 40),
    topics: list(x.topics, 60).map((t) => ({ title: str(t && t.title, 160), where: str(t && t.where, 160), body: str(t && t.body, 4000) })).filter((t) => t.title),
    glossary: list(x.glossary, 200).map((g) => ({ term: str(g && g.term, 60), meaning: str(g && g.meaning, 400) })).filter((g) => g.term)
  };
}
const HELP_SYSTEM = [
  'You are Nexora AI, the helper inside Nexora (bag weight, BOM, costing and quotation software for PP/PE woven sacks).',
  'Answer the person’s question ONLY from the HELP TOPICS and GLOSSARY given. Say where in Nexora to go (menu, window, button). Keep it short, in steps when it is a how-to.',
  'If the answer is not in what is given, say so plainly and suggest the nearest topic — never invent a feature.',
  'Answer ONLY with JSON: {"transcript": string, "answer": string, "topics": [string]}.'
].join(' ');
export async function help(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanHelp(payload);
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!p.text && !m.parts.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say or type the question first.' } };
  const intro = langLine(lang, 'the answer') + (m.audio ? 'The question is in the attached recording.' + (p.text ? ' Also typed: ' + p.text : '') : 'The question: ' + p.text) +
    (p.screen ? '\nThe person is on the ' + p.screen + ' window.' : '') + '\nHELP:\n' + JSON.stringify({ topics: p.topics, glossary: p.glossary });
  const a = await ask(companyId, HELP_SYSTEM, m.parts.concat([{ text: intro }]), fetchImpl);
  if (a.fail) return a.fail;
  const j = a.json || {};
  const titles = {}; p.topics.forEach((t) => { titles[t.title] = true; });
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, transcript: str(j.transcript, 600), answer: str(j.answer, 3000),
    topics: list(j.topics, 5).map((t) => str(t, 160)).filter((t) => titles[t]) } };
}

/* ---- the conversation: follow-up questions in the same window --------------
   "chat with ai should be continues mode like user can ask other relevant
    question in current session". After a first answer, the window keeps
   talking: the person asks again (spoken or typed) and Nexora AI answers
   with the whole conversation so far and the same CONTEXT the window
   started from — cleaned by the same functions, so a follow-up can never
   carry a price, a rate, a cost or a name the first question could not. */
const CHAT_KINDS = {
  bom: (d) => clean(d),
  plan: (d) => cleanPlan(d),
  calc: (d) => cleanFill(d),
  edit: (d) => cleanEdit(d),
  quote: (d) => cleanQuote(d).quote,
  help: (d) => { const h = cleanHelp(d); return { topics: h.topics, glossary: h.glossary, screen: h.screen }; }
};
const CHAT_WHAT = {
  bom: 'the bill of materials (its stages, sources, recipes and waste)',
  plan: 'this bag and the plant’s process master, routes and workflows',
  calc: 'this bag, the plant’s constructions and their fields',
  edit: 'the bill of materials being changed',
  quote: 'this quotation (selling figures only) and its letter',
  help: 'Nexora’s own help topics and glossary'
};
const CHAT_SYSTEM = [
  'You are Nexora AI, inside Nexora, software for PP/PE woven sack plants (bag weight, BOM, costing, quotation).',
  'You are in a conversation that began in one Nexora window. Answer the person’s latest question using the CONTEXT and the conversation so far. Be short and practical; say where in Nexora to go when it helps.',
  'You never see prices, rates or costs and must not guess any. Never recompute weights or costs — Nexora’s engines do that. If the question needs something not in the CONTEXT, say so plainly.',
  'Answer ONLY with JSON: {"transcript": string, "answer": string}.'
].join(' ');
export function cleanChat(p) {
  const x = p && typeof p === 'object' ? p : {};
  const kind = CHAT_KINDS[x.kind] ? x.kind : 'help';
  return {
    kind: kind,
    text: str(x.text, 800),
    context: CHAT_KINDS[kind](x.context || {}),
    history: list(x.history, 16).map((h) => ({ role: h && h.role === 'model' ? 'model' : 'user', text: str(h && h.text, 1500) })).filter((h) => h.text)
  };
}
export async function chat(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanChat(payload);
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!p.text && !m.parts.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say or type the question first.' } };
  const contents = [{ role: 'user', parts: [{ text: 'CONTEXT — ' + CHAT_WHAT[p.kind] + ':\n' + JSON.stringify(p.context) }] },
    { role: 'model', parts: [{ text: '{"transcript":"","answer":"Understood. Ask me."}' }] }];
  p.history.forEach((h) => contents.push({ role: h.role, parts: [{ text: h.role === 'model' ? JSON.stringify({ transcript: '', answer: h.text }) : h.text }] }));
  contents.push({ role: 'user', parts: m.parts.concat([{ text: langLine(lang, 'the answer') + (m.audio ? 'The question is in the attached recording.' + (p.text ? ' Also typed: ' + p.text : '') : p.text) }]) });
  const a = await ask(companyId, CHAT_SYSTEM, { contents: contents }, fetchImpl);
  if (a.fail) return a.fail;
  const j = a.json || {};
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, transcript: str(j.transcript, 800), answer: str(j.answer, 3000) } };
}

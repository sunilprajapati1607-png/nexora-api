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
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const FALLBACKS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];
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
      const pick = names.indexOf(wanted) > -1 ? wanted
        : (FALLBACKS.filter((f) => names.indexOf(f) > -1)[0] || names.filter((n) => /flash/.test(n) && !/preview|exp|tts|image|live|audio/.test(n))[0] || null);
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
  const gu = lang === 'gu';
  return (gu
    ? 'Reply in Gujarati (Gujarati script). Keep process names, material kinds and Nexora button names in English.\n'
    : 'Reply in plain English.\n') + 'BOM:\n' + JSON.stringify(p);
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
  const name = await resolveModel(false, fetchImpl);
  if (!name) return { fail: { httpStatus: 503, body: { error: 'AI_MODEL', message: 'Nexora AI has no model it can use right now.' } } };
  let r;
  try {
    r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', {
      method: 'POST',
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }],   /* text, or parts (a recording + text) */
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 2048 }
      })
    }, fetchImpl);
  } catch (e) {
    return { fail: { httpStatus: 504, body: { error: 'AI_TIMEOUT', message: 'Nexora AI did not answer in time. Try again.' } } };
  }
  if (!r.ok) {
    if (r.status === 404) resolveModel(true, fetchImpl).catch(() => {});      // the model went away: look again
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
  const prompt = (lang === 'gu'
    ? 'Write summary, why and notes in Gujarati (Gujarati script); keep codes, process names and Nexora terms in English.\n'
    : 'Write in plain English.\n') + 'INPUT:\n' + JSON.stringify(p);
  const a = await ask(companyId, PLAN_SYSTEM, prompt, fetchImpl);
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
const AUDIO_TYPES = { 'audio/wav': 1, 'audio/x-wav': 1, 'audio/mp3': 1, 'audio/mpeg': 1, 'audio/ogg': 1, 'audio/flac': 1, 'audio/aac': 1, 'audio/webm': 1 };
const MAX_AUDIO_B64 = 3 * 1024 * 1024;

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
  const audio = payload && payload.audio && typeof payload.audio === 'object' ? payload.audio : null;
  const mime = audio ? String(audio.mime || '').toLowerCase().split(';')[0] : '';
  const data = audio ? String(audio.data || '') : '';
  if (audio && (!AUDIO_TYPES[mime] || !data)) return { httpStatus: 400, body: { error: 'AUDIO', message: 'That recording could not be read.' } };
  if (data.length > MAX_AUDIO_B64) return { httpStatus: 413, body: { error: 'AUDIO_LONG', message: 'That recording is too long — keep it under a minute.' } };
  if (!audio && !p.text) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say or type what the bag is first.' } };
  if (!p.constructions.length || !p.fields.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'This plant has no constructions to choose from.' } };
  const intro = (lang === 'gu'
    ? 'Write summary and questions in Gujarati (Gujarati script); keep field names and units in English.\n'
    : 'Write summary and questions in plain English.\n') +
    (audio ? 'The bag is described in the attached recording.' + (p.text ? ' The person also typed: ' + p.text : '') + '\n' : 'The person typed: ' + p.text + '\n') +
    'CONTEXT:\n' + JSON.stringify({ constructions: p.constructions, fields: p.fields, current: p.current });
  const a = await ask(companyId, FILL_SYSTEM, audio ? [{ inlineData: { mimeType: mime, data: data } }, { text: intro }] : intro, fetchImpl);
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
  if (!con) missing.push({ key: '__construction', question: lang === 'gu' ? 'કયું construction?' : 'Which construction is it?', type: 'enum', options: p.constructions.map((c) => c.name) });
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

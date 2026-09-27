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
/* 4.67.7 — "haju strong generative ai jevu banavo": the newest plain Flash the key lists (not
   Lite); GEMINI_MODEL_STRONG names another, or "off" keeps every question on the Lite model */
export function strongOf(names) {
  const env = String(process.env.GEMINI_MODEL_STRONG || '').trim().replace(/^models\//, '');
  if (env.toLowerCase() === 'off') return null;
  if (env) return names.indexOf(env) > -1 && !blocked.has(env) ? env : null;
  return names.filter((n) => !blocked.has(n) && /-flash(?:-\d{3})?$/.test(n) && rankOf(n) !== null).sort((a, b) => rankOf(b) - rankOf(a))[0] || null;
}
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 60000;              /* 4.67.6 — a question with the plant's whole memory takes longer */

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
let allNames = [];                   /* 4.67.8 — every model the key lists, the voice ones too */
let resolving = null;

async function gfetch(url, opts, fetchImpl, ms) {
  const f = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS);
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
      allNames = ((r.body && r.body.models) || []).map((m) => String(m.name || '').replace(/^models\//, ''));
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
/* 4.67.12 — "even in typing not responding": the strong model, busy (429) or slow on a large question,
   held every question 45 s and left the usual model 25 s — both ran out. Now it gets 12 s, and after
   it fails in any way it rests 15 minutes, so the next questions go straight to the quick model. */
const STRONG_MS = 12000;
const STRONG_REST_MS = 15 * 60 * 1000;
let strongRestUntil = 0;
export function _resetStrong() { strongRestUntil = 0; }
function readJson(r) {
  const parts = (((r.body && r.body.candidates) || [])[0] || {}).content;
  /* a thinking model may send its thought as a part of its own: only the answer's text is read */
  const text = ((parts && parts.parts) || []).filter((x) => !x.thought).map((x) => x.text || '').join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}
async function ask(companyId, system, prompt, fetchImpl, opts) {
  opts = opts || {};
  if (!aiConfigured()) return { fail: { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } } };
  const t = take(companyId);
  if (t.busy) return { fail: { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy — try again in ' + t.busy + ' seconds.' } } };
  if (t.spent) return { fail: { httpStatus: 429, body: { error: 'AI_DAILY', message: 'This company has used today’s ' + daily() + ' Nexora AI checks. They come back tomorrow.' } } };
  let name = await resolveModel(false, fetchImpl);
  if (!name) return { fail: { httpStatus: 503, body: { error: 'AI_MODEL', message: 'Nexora AI has no model it can use right now.' } } };
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: (prompt && prompt.contents) ? prompt.contents : [{ role: 'user', parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }],   /* text, parts (a recording + text), or a whole conversation */   /* text, or parts (a recording + text) */
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: opts.maxTokens || 2048 }
  });
  let r;
  /* the stronger model first (45 s), then the usual one (the rest of the minute) */
  const strong = opts.strong && Date.now() > strongRestUntil ? strongOf(model.available || []) : null;
  if (strong && strong !== name) {
    let rs = null;
    try { rs = await gfetch(API + '/models/' + encodeURIComponent(strong) + ':generateContent', { method: 'POST', body: payload }, fetchImpl, STRONG_MS); } catch (e) { rs = null; }
    if (rs && rs.ok) { const got = readJson(rs); if (got) return { json: got, model: strong, left: t.left }; }
    const sm = String((rs && rs.body && rs.body.error && rs.body.error.message) || '');
    if (rs && !rs.ok && (rs.status === 404 || /no longer available|not found|is not supported|deprecated/i.test(sm))) blocked.add(strong);
    strongRestUntil = Date.now() + STRONG_REST_MS;
  }
  /* 4.67.1 — a model Google has retired is set aside and the request is
     asked again, of the model Google names (or the newest the key lists),
     at most twice — the person never sees "no longer available" */
  for (let attempt = 0; ; attempt++) {
    try {
      /* after the stronger model had its 45 s, the usual one gets what is left of the application's 75 s */
      r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', { method: 'POST', body: payload }, fetchImpl, strong && strong !== name ? 58000 : TIMEOUT_MS);
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
  const json = readJson(r);
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
    type: f && f.type === 'enum' ? 'enum' : 'number', options: list(f && f.options, 12).map((o) => str(o, 20)), required: !!(f && f.required), optional: !!(f && f.optional)
  })).filter((f) => f.key);
  const known = {}; fields.forEach((f) => { known[f.key] = true; });
  return {
    text: str(x.text, 800),
    units: { length: str(x.units && x.units.length, 12) || 'mm', mesh: str(x.units && x.units.mesh, 24) || 'tapes per inch' },
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
  'Units: every field is in the unit FIELDS gives it — this plant\u2019s own (UNITS: sizes and mesh as the plant types them). Put what the person says EXACTLY in those units ("32 by 32" mesh → M.WARP 32, M.WEFT 32; "490 by 550" → width 490, length 550); convert only when the person names a different unit, and say so. GSM in g/m², micron in µm. Width and length are the bag\u2019s flat width and length. Bag quantity is "bagQuantity".',
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
    'CONTEXT:\n' + JSON.stringify({ units: p.units, constructions: p.constructions, fields: p.fields, current: p.current });
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
  /* 4.67.3 — no language switch: the language the person used */
  if (lang === 'auto') return 'Write ' + w + ' in the language the person used — English; Gujarati (even when typed in English letters) in Gujarati script; Hindi in Devanagari. If they said nothing in words, use English. Keep codes, material names, process names, field names and Nexora button names in English.\n';
  return 'Write ' + w + ' in plain English.\n';
}
export function pickLang(v) { return v === 'gu' || v === 'hi' || v === 'auto' ? v : 'en'; }

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

/* ==========================================================================
   4.67.3 — ONE NEXORA AI, ON EVERY WINDOW, THAT CAN DO THE WORK
   --------------------------------------------------------------------------
   Owner 2026-09-26: "ai derek screen par screen pramane react kre" · "ai
   koi pan window par thi biji window nu kam kri sakvu joiye like ... 1l
   stitch bag, 490x550 single fold 70 gram 40x40 ni meash nu calcualtion
   kri ne bom banavi ne cost kadhi nakh reciepy tape ni 80+20 rakhje" ·
   "ai fakt item name, customer name ne cost na joi sakvu joiye" ·
   "પગલાં બતાવે, એક Run" · "same window multi language ... user ne language
   switch na krvi pde" · "when i say target is 70 gram ai should work with
   weight to gsm module" · "make it more powerfull and more smarter".

   Nexora AI answers, and — when the person asks for work — returns STEPS
   from a fixed list. The application shows the steps; the person presses
   Run; the application does them with its own engines. The cost is worked
   out and shown on the person's screen; it never comes here. Every step is
   checked against what was sent: an unknown construction, field, process,
   route or material is dropped and said.
   ========================================================================== */
export const ASSIST_VIEWS = ['dashboard', 'calculation', 'history', 'bom', 'bomrecords', 'routes', 'rm', 'structures', 'constants',
  'quotation', 'quoterecords', 'compare', 'targetcost', 'priceimpact', 'workflows', 'settings', 'easycost'];
/* 4.67.7 — "observe our alll work of software make most of compitible with ai": what a window
   shows, as a small flat object of technical words and figures (never a name, a customer or a
   bag's cost — the application leaves them out; this keeps only short strings and numbers) */
function cleanView(v) {
  const o = {};
  if (!v || typeof v !== 'object') return o;
  Object.keys(v).slice(0, 30).forEach((k0) => {
    const k = str(k0, 30); const x = v[k0];
    if (typeof x === 'number' && isFinite(x)) o[k] = nr(x);
    else if (typeof x === 'boolean') o[k] = x;
    else if (typeof x === 'string') o[k] = str(x, 160);
    else if (Array.isArray(x)) o[k] = x.slice(0, 40).map((y) => (typeof y === 'number' ? nr(y) : str(y, 160)));
  });
  return o;
}
const ALLOWED = ['cost', 'calc', 'bom', 'route', 'rm', 'price', 'constants', 'quote', 'compare', 'targetcost', 'priceimpact', 'notes'];
const cleanSecs = (a) => list(a, 20).map((s) => ({ process: str(s && s.process, 30), wastePct: nr(s && s.wastePct),
      lines: list(s && s.lines, 12).map((l) => ({ material: str(l && l.material, 60), basis: str(l && l.basis, 10), value: nr(l && l.value), figure: str(l && l.figure, 30) })) })).filter((s) => s.process);
export function cleanAssist(p) {
  const x = p && typeof p === 'object' ? p : {};
  const n = x.now && typeof x.now === 'object' ? x.now : {};
  const c = n.calc && typeof n.calc === 'object' ? n.calc : {};
  const fill = cleanFill({ constructions: x.constructions, fields: x.fields, current: c, units: x.units });
  return {
    screen: ASSIST_VIEWS.indexOf(x.screen) > -1 ? x.screen : 'dashboard',
    text: str(x.text, 1200),
    history: list(x.history, 20).map((h) => ({ role: h && h.role === 'model' ? 'model' : 'user', text: str(h && h.text, 2500) })).filter((h) => h.text),
    units: fill.units,
    constructions: fill.constructions.map((c) => Object.assign({}, c, { needs: needsOf(c) })),
    fields: fill.fields,
    /* 4.67.10 — each process's own resources (conversion charges): name, type, basis, and the rate for a person who may see costs */
    processes: list(x.processes, 80).map((q) => Object.assign({ code: str(q && q.code, 30), name: str(q && q.name, 60) },
      Array.isArray(q && q.resources) ? { resources: list(q.resources, 12).map((r) => Object.assign({ name: str(r && r.name, 40), type: str(r && r.type, 30), basis: str(r && r.basis, 10) },
        r && r.rate != null ? { rate: nr(r.rate) } : {}, r && r.perBags ? { perBags: nr(r.perBags) } : {})).filter((r) => r.name) } : {})).filter((q) => q.code),
    resourceTypes: list(x.resourceTypes, 30).map((t) => str(t, 30)).filter(Boolean),
    routes: list(x.routes, 80).map((r) => ({ name: str(r && r.name, 80), steps: list(r && r.steps, 30).map((s) => str(s, 30)),
      constructions: list(r && r.constructions, 30).map((s) => str(s, 60)), stages: cleanSecs(r && r.stages) })).filter((r) => r.name),
    materials: list(x.materials, 300).map((m) => ({ code: str(m && m.code, 40), name: str(m && m.name, 60), group: str(m && m.group, 30), rate: nr(m && m.rate) })).filter((m) => m.code),
    rules: list(x.rules, 30).map((r) => str(r, 300)).filter(Boolean),
    voice: !!x.voice,
    /* 4.67.7 — the plant's saved work by NUMBER and technical figures (never an item name or a customer) */
    records: list(x.records, 60).map((r) => ({ n: str(r && r.n, 30), construction: str(r && r.construction, 60), width: nr(r && r.width), length: nr(r && r.length),
      gsm: nr(r && r.gsm), weight: nr(r && r.weight), target: nr(r && r.target), bags: nr(r && r.bags), status: str(r && r.status, 16), date: str(r && r.date, 10),
      bom: !!(r && r.bom), rev: nr(r && r.rev) })).filter((r) => r.n),
    boms: list(x.boms, 80).map((b) => ({ n: str(b && b.n, 30), calc: str(b && b.calc, 30), construction: str(b && b.construction, 60), route: str(b && b.route, 80),
      mode: str(b && b.mode, 10), date: str(b && b.date, 10) })).filter((b) => b.n),
    quotes: list(x.quotes, 60).map((q) => ({ n: str(q && q.n, 30), calcs: list(q && q.calcs, 10).map((c) => str(c, 30)), bags: nr(q && q.bags), items: nr(q && q.items),
      status: str(q && q.status, 16), date: str(q && q.date, 10) })).filter((q) => q.n),
    constants: list(x.constants, 150).map((c) => ({ name: str(c && c.name, 80), value: typeof (c && c.value) === 'number' ? nr(c.value) : str(c && c.value, 30), unit: str(c && c.unit, 20),
      group: str(c && c.group, 40) })).filter((c) => c.name),
    groups: list(x.groups, 40).map((g) => str(g, 40)).filter(Boolean),
    workflowList: list(x.workflowList, 60).map((w) => ({ name: str(w && w.name, 80), construction: str(w && w.construction, 60) })).filter((w) => w.name),
    allowed: (function (a) { a = a && typeof a === 'object' ? a : {}; const o = {}; ALLOWED.forEach((k) => { o[k] = a[k] !== false; }); return o; })(x.allowed),
    topics: list(x.topics, 120).map((t) => str(t, 80)).filter(Boolean),
    figures: list(x.figures, 80).map((f) => ({ key: str(f && f.key, 30).toUpperCase(), label: str(f && f.label, 60) })).filter((f) => f.key),
    /* what Nexora has learned from this plant's own saved work (routes used, workflows matched, usual recipes) */
    learned: (function (l) {
      l = l && typeof l === 'object' ? l : {};
      return {
        routeUse: list(l.routeUse, 30).map((r) => ({ name: str(r && r.name, 80), bags: nr(r && r.bags), constructions: list(r && r.constructions, 20).map((c) => str(c, 60)) })).filter((r) => r.name),
        workflows: list(l.workflows, 8).map((w) => ({ name: str(w && w.name, 80), construction: str(w && w.construction, 60), score: nr(w && w.score), fits: !!(w && w.fits),
          reasons: list(w && w.reasons, 4).map((t) => str(t, 160)), blockers: list(w && w.blockers, 3).map((t) => str(t, 160)) })).filter((w) => w.name),
        stages: list(l.stages, 40).map((s) => ({ process: str(s && s.process, 30), sections: nr(s && s.sections), usualWastePct: nr(s && s.usualWastePct),
          usualMaterials: list(s && s.usualMaterials, 6).map((m) => ({ material: str(m && m.material, 40), basis: str(m && m.basis, 10), usualValue: nr(m && m.usualValue), seen: nr(m && m.seen) })) })).filter((s) => s.process),
        boms: list(l.boms, 40).map((b) => ({ construction: str(b && b.construction, 60), boms: nr(b && b.boms),
          routes: list(b && b.routes, 10).map((r) => ({ name: str(r && r.name, 80), n: nr(r && r.n) })).filter((r) => r.name),
          modes: { WHOLE: nr(b && b.modes && b.modes.WHOLE) || 0, SPLIT: nr(b && b.modes && b.modes.SPLIT) || 0 },
          materials: list(b && b.materials, 30).map((m) => ({ code: str(m && m.code, 40), group: str(m && m.group, 30), stages: list(m && m.stages, 6).map((x) => str(x, 40)),
            per1000: nr(m && m.per1000), min: nr(m && m.min), max: nr(m && m.max), inBoms: nr(m && m.inBoms) })).filter((m) => m.code) })).filter((b) => b.construction),
        typical: list(l.typical, 40).map((t) => { const o = {}; const inp = (t && t.inputs && typeof t.inputs === 'object') ? t.inputs : {};
          Object.keys(inp).slice(0, 80).forEach((k) => { const v = inp[k]; if (typeof v === 'number' && isFinite(v)) o[str(k, 30)] = nr(v); else if (typeof v === 'string' && v.length <= 20) o[str(k, 30)] = str(v, 20); });
          const vals = {}; const vin = (t && t.values && typeof t.values === 'object') ? t.values : {};
          Object.keys(vin).slice(0, 80).forEach((k) => { vals[str(k, 30)] = list(vin[k], 8).map((v) => (typeof v === 'number' ? nr(v) : str(v, 20))); });
          const rng = {}; const rin = (t && t.range && typeof t.range === 'object') ? t.range : {};
          Object.keys(rin).slice(0, 80).forEach((k) => { const a = list(rin[k], 2).map(nr); if (a.length === 2) rng[str(k, 30)] = a; });
          const sn = {}; const sin = (t && t.seen && typeof t.seen === 'object') ? t.seen : {};
          Object.keys(sin).slice(0, 80).forEach((k) => { sn[str(k, 30)] = nr(sin[k]); });
          return { construction: str(t && t.construction, 60), from: str(t && t.from, 30), count: nr(t && t.count), inputs: o, values: vals, range: rng, seen: sn }; }).filter((t) => t.construction),
        lessons: list(l.lessons, 20).map((q) => ({ what: ['recipe', 'calculation', 'route'].indexOf(q && q.what) > -1 ? q.what : 'recipe', construction: str(q && q.construction, 60),
          route: str(q && q.route, 80), process: str(q && q.process, 30), field: str(q && q.field, 30), ai: str(q && q.ai, 300), person: str(q && q.person, 300) })),
        workflowRecipes: list(l.workflowRecipes, 5).map((w) => ({ name: str(w && w.name, 80), construction: str(w && w.construction, 60),
          routes: list(w && w.routes, 4).map((r) => ({ name: str(r && r.name, 80), steps: list(r && r.steps, 30).map((c) => str(c, 30)), stages: cleanSecs(r && r.stages) })) })).filter((w) => w.name)
      };
    })(x.learned),
    /* what is on the screen now — technical only; never an item name, a customer or a cost */
    now: {
      calc: {
        structure: fill.current.structure, inputs: fill.current.inputs,
        targetWeight: nr(c.targetWeight), bagQuantity: nr(c.bagQuantity), byWeight: !!c.byWeight,
        netWeight: nr(c.netWeight), saved: !!c.saved, route: str(c.route, 80), madeByAi: !!c.madeByAi,
        figures: list(c.figures, 40).map((f) => ({ key: str(f && f.key, 30).toUpperCase(), label: str(f && f.label, 60), grams: nr(f && f.grams) })).filter((f) => f.key),
        parts: list(c.parts, 16).map((q) => ({ key: str(q && q.key, 30).toUpperCase(), label: str(q && q.label, 40), grams: nr(q && q.grams), consumable: !!(q && q.consumable), within: str(q && q.within, 30) })).filter((q) => q.key)
      },
      bom: n.bom ? clean(n.bom) : null,
      note: str(n.note, 300),
      view: cleanView(n.view)
    }
  };
}

const STEP_LIST = [
  '{"do":"calc","construction":NAME,"inputs":{FIELD KEY: value},"targetWeight":grams or null,"bagQuantity":number or null,"fresh":true|false} — fill the calculation (fresh:true starts a new one; false changes the one on screen).',
  '{"do":"save"} — save the calculation.',
  '{"do":"route","name":ROUTE NAME} — run this bag on a saved route; or {"do":"route","name":new name,"steps":[PROCESS CODE,...]} — a new route from the process master.',
  '{"do":"workflow","name":WORKFLOW NAME} — make this bag follow a saved workflow from LEARNED.workflows (it brings its routes and recipes).',
  '{"do":"parts","mode":"WHOLE"|"SPLIT","tabs":{PART KEY: true|false},"routes":{PART KEY: ROUTE NAME}} — which parts of the bag are made on their own route (a tab, SPLIT) and which are costed inside a stage; PART KEYs from NOW.calc.parts (or, for a new bag, BODY, TOP PATCH, BOTTOM PATCH, VALVE, LINER, BOPP as its construction has them).',
  '{"do":"bom"} — open this bag’s BOM (it is costed there, on the person’s screen).',
  '{"do":"check"} — after the BOM is built, check it all (routes, parts taken in, recipes, waste): "is everything right?".',
  '{"do":"suggest","stage":PROCESS CODE} — fill that stage from the calculation with Nexora\u2019s own Suggest (layer shares on a coating/lamination stage, grams per bag on a finishing, pasting, easy-open or stitching stage) and save it.',
  '{"do":"recipe","add":true|false,"remove":true|false,"part":PART KEY or null,"stage":PROCESS CODE,"lines":[{"material":MATERIAL CODE,"value":number,"basis":"PCT"} or {"part":PART KEY,"value":grams or null} or {"earlier":true,"stage":PROCESS CODE or null,"basis":"PCT"|"PART_G","value":number or null,"figure":FIGURE KEY or null}],"wastePct":number or null} — set the materials of one stage (of the body, or of a part on its own tab); a {"part":KEY} line TAKES IN that part at this stage (e.g. the patches and the valve at the bottom/finishing stage, BOPP at lamination). Earlier-stage rows stay.',
  '{"do":"waste","part":PART KEY or null,"stage":PROCESS CODE,"pct":number} — the waste % of one stage.',
  '{"do":"resources","from":a BOM or calculation NUMBER from BOMS/RECORDS (the reference),"stage":PROCESS CODE or null} — give this bag\u2019s stages the resources the reference BOM uses at the same stages (every matching stage when none is named).',
  '{"do":"resource","action":"add"|"set"|"remove","stage":PROCESS CODE,"name":RESOURCE NAME,"type":one of RESOURCETYPES or null,"basis":"KG"|"BAG"|"PER1000"|"PERN" or null,"rate":number or null,"perBags":number or null,"forAll":true|false,"part":PART KEY or null} — add, change or take out ONE resource on a stage of this bag (forAll:true changes the process itself in the Process master — every route that runs it).',
  '{"do":"stage","action":"remove"|"add","stage":PROCESS CODE,"after":PROCESS CODE or null,"part":PART KEY or null,"shared":true|false} — take a WHOLE stage off this bag\u2019s BOM, its section with it — or put a process on after the stage named (before packing when none is named). For THIS BAG ONLY (Nexora keeps the bag\u2019s own copy of its route); "shared": true changes the route itself — every bag on it and any workflow using it — ONLY when the person says so.',
  '{"do":"recipe","stage":PROCESS CODE,"clear":true,"part":PART KEY or null} — empty that stage\u2019s materials (the stage stays on the route; what it takes from the stage before stays).',
  '{"do":"accept"} — save the stages Nexora suggested on this BOM into its route (they are then the plant\u2019s own).',
  '{"do":"savebom"} — save the BOM as a record (with its version).',
  '{"do":"saveworkflow","name":NAME} — save this bag\u2019s whole set-up (routes, tabs, every recipe) as a workflow, loaded on the next bag of this construction.',
  '{"do":"price","material":MATERIAL CODE,"change":number or null,"pct":number or null,"set":number or null,"from":"YYYY-MM-DD" or null} — a new price version for a material: "+5" is change 5, "3 % up" is pct 3, "210 karo" is set 210.',
  '{"do":"quote","quantity":number,"rate":number or null,"margin":percent or null} — a quotation for the bag on screen (or the one just made): its quantity, and the selling rate the person said, or a margin over the bag\u2019s cost that Nexora works out on the person\u2019s computer. The buyer is typed by the person.',
  '{"do":"cost"} — show the cost per bag (worked out on the person’s screen; you never see it).',
  '{"do":"find","what":"calc"|"bom"|"quote","number":a NUMBER from RECORDS/BOMS/QUOTES or null,"construction":NAME or null,"q":search words or null,"open":true|false} — find saved work; open:true opens the one found (a calculation in the calculation window, a BOM on the BOM window, a quotation to edit), else its records window is shown filtered.',
  '{"do":"compare","a":CALC NUMBER or "current","b":CALC NUMBER} — two calculations side by side (weight, layers, and cost per bag for a person who may see it).',
  '{"do":"targetcost","calc":CALC NUMBER or "current","mode":"PRICE"|"COST","price":selling price per bag or null,"margin":percent or null,"cost":target cost per bag or null} — Target Cost: what to change to bring the bag to that cost; it searches the options on the person\u2019s computer.',
  '{"do":"priceimpact","changes":[{"material":MATERIAL CODE,"change":number or null,"pct":number or null,"set":number or null}]} — Price Impact: what every saved BOM costs at today\u2019s prices ([] ) or at what-if prices (nothing is saved).',
  '{"do":"constant","name":CONSTANT NAME from CONSTANTS,"value":number} — set a constant (in its own unit, as CONSTANTS show it); it goes to the administrator for approval when the person may not change it.',
  '{"do":"material","name":NAME,"group":GROUP from GROUPS,"code":CODE or null,"uom":"KG"|"PCS"|"MTR" or null,"wastePct":number or null} — add a raw material to the RM Master (its code is made from its group when not said; a price is a separate "price" step).',
  '{"do":"note","text":TEXT} — write a note on the person\u2019s own note pad.',
  '{"do":"guide","view":one of ' + ASSIST_VIEWS.join('|') + ',"button":the words on a button, tab or field of that window,"say":one short line} — SHOW the person where to press: open that window and point at it, with the line.',
  '{"do":"open","view":one of ' + ASSIST_VIEWS.join('|') + '} — go to a window.'
];
const ASSIST_SYSTEM = [
  'You are Nexora AI, the assistant inside Nexora — software for PP/PE woven sack plants: bag weight (calculation), bill of materials (BOM) by route and stage, recipes, costing, quotation.',
  'You are an expert in woven sacks: tape extrusion (PP with filler/CaCO3 and masterbatch, usually 2–8 % waste), circular weaving, BOPP printing and slitting, lamination/coating (PP/LD granule), backseam, block bottom, pinch, stitching, liners, valves, finishing and packing.',
  'You see the screen the person is on (NOW), the plant\u2019s constructions (their fields and what they NEED), processes, routes, materials with their current rates, and what the plant has saved. You NEVER see — and must never ask for or guess — an item name, a customer name or the cost of a bag.',
  'THINK FOR YOURSELF, LIKE THE PLANT\u2019S TECHNICAL MANAGER. Do the job the person MEANS, not only the words: a calculation ASKS every open field of its construction (the person may leave blank what the bag does not have — a handle, a liner — and Nexora goes on without it); a route has every process the construction\u2019s layers and parts need (CONSTRUCTIONS[].needs — a coated/laminated (2L) bag has lamination; a BOPP bag BOPP printing and lamination; a backseamed bag backseam; patches or a valve block bottom; a pinch bag pinch bottom); "make a quotation" is a "quote" step, after the bag is saved; "how do I…" is answered in steps the person can follow, with an "open" step to take them there. Facts: the mesh is needed for the denier and the GPM; the coating GSM for any coated or laminated bag. When a thing is truly unclear, ask — but never leave out what the job obviously needs.',
  'STANDING INSTRUCTIONS: when the person says how things should ALWAYS be done ("from next time…", "always…", "hamesha…", "have thi…"), put it in "remember" as one short sentence. RULES are the instructions already given — follow every one of them, every time. When the person asks to drop one ("forget …", "no longer …"), put its exact text from RULES in "forget" (a list).',
  'Talk with the person about anything on this screen or in Nexora (HELP_TOPICS name its windows). When they ask for work to be done, return STEPS. Steps allowed: ' + STEP_LIST.join(' '),
  'Rules for the calculation: UNITS says how THIS plant types sizes (UNITS.length) and counts mesh (UNITS.mesh); FIELDS carry those units and NOW shows the bag in them. Put every size and mesh EXACTLY as the person says it, in those units — "32x32" is M.WARP 32 and M.WEFT 32, "490x550" is width 490 and length 550 — and never convert on your own. Convert only when the person names a different unit (e.g. "19 inch" in a mm plant → 482.6), and say so. "490x550" is width x length. A bag WEIGHT said in grams ("70 gram", "70 g bag", "target 70") is the TARGET WEIGHT — put it in "targetWeight"; Nexora then finds the body fabric GSM itself (weight → GSM), so never ask for the GSM then and never invent one. A number is a GSM only when the person says gsm or g/m². Choose the construction by name and meaning ("1L" = one layer, "stitch", "block bottom", "laminated"). An enum field takes one of its options exactly.',
  'Rules for a recipe: "80+20" for a stage means two materials by percent — choose them from MATERIALS by what this plant usually uses on that stage (LEARNED.stages usualMaterials), else by what is usual in the trade (for tape: the PP granule and the filler), unless the person names them; say which you chose. When a stage’s waste is not said, LEARNED.stages usualWastePct is this plant’s own. Use only codes from MATERIALS and PROCESSES and names from ROUTES.',
  'Choosing or creating a ROUTE — understand the bag first (layers, laminated or BOPP printed, stitched or block bottom or pinch, valve, liner, backseam) and use what Nexora has LEARNED from this plant: (1) a saved workflow in LEARNED.workflows with fits:true and the best score → a "workflow" step (it brings routes and recipes) — say its reasons; (2) a route in ROUTES whose constructions include this construction; (3) the route this plant runs most for similar bags (LEARNED.routeUse: same layers, same laminated/unlaminated, same bottom) → a "route" step with that name, and say "used by N saved bags"; (4) otherwise a NEW route from PROCESSES in the woven-sack order — tape → weaving → (BOPP printing → lamination, when laminated) → (backseam, when backseamed) → cutting/stitching/bottom/finishing → packing — only processes this plant has; give it a clear name. Nexora fills a new route’s sections from what the plant usually does. When the person only asks which route or to suggest one, explain the choice and return the route step (with save first if the bag is not saved).',
  'THE WHOLE JOB FROM ONE SENTENCE: when the person says a bag and its specification and asks for the cost ("mare aa bag che ... cost aapo"), do all of it: calc → save → workflow or route (+ parts, if the bag has patches, a valve, a liner or BOPP) → bom → every stage\u2019s recipe/waste (and where each part is taken in) → check → cost. Ask only for what you truly cannot decide.',
  'LEARNED.lessons are the PERSON\u2019S OWN CORRECTIONS of what you did before (you put "ai", they changed it to "person"). They win over everything else: for the same construction/process/field, do it the person\u2019s way, and say you did.',
  'THE STAGE BEFORE: a stage that takes the fabric or tube from an earlier stage says HOW with an "earlier" line. Where parts or other materials are ADDED at that stage (finishing, stitching, block bottom, pinch, bag making: patches, valve, liner, yarn, zipper) it takes the BODY AS A WHOLE PART by its own weight — {"earlier":true,"basis":"PART_G","figure":"BODY.TOTAL"} — never 100 % of everything before, which would count what is added twice. A stage that only converts what comes in (weaving, slitting, packing) takes {"earlier":true,"basis":"PCT","value":100} or needs no line. Always follow how THIS plant\u2019s saved sections do it (ROUTES[].stages and LEARNED.workflowRecipes lines "EARLIER STAGE …" with their basis and figure). FIGURES lists the part figures (NOW.calc.figures has this bag\u2019s grams).',
  'NO PROCESS THE BAG DOES NOT NEED: never add printing (flexo or BOPP printing), lamination, coating, BOPP, backseam, liner or valve steps unless the person said so, the construction has it (e.g. BOPP / laminated in its name or fields), or this plant\u2019s own route for the construction has it. When unsure, leave it out and ask in "answer".',
  'ADD OR REPLACE: "add weaving in lamination", "LD 5 % umero", "take in the valve" ADD to what the stage already holds — set "add": true (the section keeps its lines; a line of the same stage, material or part is replaced). Without "add" the stage\u2019s materials are replaced by yours. "Weaving in lamination as per calculation weight" = {"do":"recipe","add":true,"stage":"LAMINATION","lines":[{"earlier":true,"stage":"WEAVING","figure":"BODY.FAB"}]} — the woven fabric by the calculation\u2019s own weight (FIGURES: BODY.FAB base fabric, BODY.TOTAL whole body).',
  'THIS BOM ONLY: every change you make to a BOM — stages, recipes, waste, resources — is for THIS bag\u2019s BOM only; Nexora keeps the bag\u2019s own copy of its route, so a saved workflow, the route itself and the Process master stay as they are. Change those ONLY when the person says so in words ("in the route itself", "for every bag", "in Route Master", "in the workflow", "for all routes", "in the process master") — then "shared": true on a stage step, "forAll": true on a resource step — and Nexora asks the person once more before Run. Never change a default (a constant, a price, the RM master, a workflow) that the person did not name.',
  'RESOURCES are a stage\u2019s conversion charges (manpower, electricity, consumables, overhead…), each with a basis: KG (per kg through the stage), BAG, PER1000 or PERN (per N bags). PROCESSES[].resources are each process\u2019s own. "take the resources from BOM-… / like CAL-…" → a "resources" step with that number. "add labour 0.40 per kg on weaving", "remove electricity from tape", "make packing labour 12 per 1000 bags" → a "resource" step; its rate ONLY as the person says it (never a guess; ask). Only when ALLOWED.cost is true.',
  'A WHOLE STAGE: "remove the flexo printing section", "flexo printing kadho", "X stage nathi joitu", "take X off the BOM" → {"do":"stage","action":"remove","stage":X} — never a recipe step for that. "add slitting after weaving", "X stage umero" → {"do":"stage","action":"add","stage":X,"after":Y}. Only "empty / clear the materials of X" is a recipe step with "clear": true.',
  'ADD, CHANGE, REMOVE — ANYTHING: to change a line\u2019s value use "add" with the new value (the same material/stage/part is replaced); to take lines out use "remove": true with those lines; "from the calculation" / "calculation par thi" / "suggest" for a stage = a "suggest" step.',
  'LEARN FROM ALL THE SAVED BOMs: LEARNED.boms gathers EVERY saved BOM of this plant per construction — the routes used and how often, whole bag or by parts, and each material\u2019s kg per 1000 kg of finished bags (average, min–max, in how many BOMs) at the stages it was used. For a similar bag use the route used most and the materials in their usual proportions at the same stages, unless the person says otherwise.',
  'LEARN FROM ALL THE SAVED BAGS: LEARNED.typical gathers EVERY saved bag of this plant per construction — for each field the figure used most (inputs), how often (seen), its range and the other figures used (values) — patch sizes, valve, mesh, coating, BOPP, fold…. For a new bag of that construction take every figure it needs from there unless the person says otherwise, and say "the rest from your saved <construction> bag <from>". Ask only for what belongs to this bag alone: width and length when not said, and the body fabric GSM OR the target weight — ONE of the two, never both (a GSM gives the weight, a weight gives the GSM).',
  'THE WEIGHT ALWAYS WINS: when a bag weight in grams and a GSM are both said (or one is said after the other), the WEIGHT is the target — put "targetWeight" and leave the GSM out; Nexora finds the GSM for that weight.',
  'ASK, NEVER GUESS: put in the calculation ONLY figures the person said (or that are on the screen when changing it). A required field not said is left out and asked in "answer" — never filled with a typical value.',
  'NEVER SAY IT IS DONE. You change nothing yourself: every change is a STEP the person runs with Run. Never write "added", "done", "updated", "saved" or "કર્યું"/"ઉમેર્યું"/"कर दिया" — write what the steps WILL do ("press Run to add …"). If you cannot make a step for what was asked, say so plainly and ask what is missing; never pretend.',
  'YOU DO THE WORK. When you pick or create a route, you also decide EVERY stage\u2019s recipe and waste yourself and return them as "recipe" (with its wastePct) or "waste" steps — do not leave stages for Nexora to fill. Learn what to put from this plant\u2019s own saved data: the route\u2019s own saved sections (ROUTES[].stages), the recipes of its saved workflows (LEARNED.workflowRecipes), and what the learning finds usual per process (LEARNED.stages). Skip a stage only when its saved section already fits and the person did not ask to change it. A stage fed only by the earlier stage (weaving, finishing, packing) needs only its "waste" step. When nothing is learned, use woven-sack practice and say in the answer that those figures are your estimate.',
  'SAVING: the recipe and waste steps already save what they write into the route. When the person asks to save or keep the route or the BOM, add "accept" (keeps any stages Nexora only suggested) and "savebom"; when they ask for a workflow ("save it as a workflow", "next time load it"), add "saveworkflow" with a clear name. Do not save unless asked.',
  'Order steps as the work goes: calc → save → route (only if needed) → bom → recipe/waste → cost. Leave out what NOW shows is already done. When the person corrects something ("no, width 520", "make it 75 gram"), return the WHOLE corrected list of steps again with the change, with "fresh":false on the calc step when NOW.calc.madeByAi is true.',
  'If something needed is missing, still return the steps you can and ask for the rest in "answer". Keep "answer" short and practical: what you understood, what the steps will do, any assumption.',
  'Reply in the SAME language the person used: English → English; Gujarati (in Gujarati script or in English letters) → Gujarati in Gujarati script; Hindi → Hindi in Devanagari. Keep codes, field names, material and process names and Nexora button names in English. Set "lang" to en, gu or hi accordingly.',
  'EVERY WINDOW (4.67.7): NOW.view is what the window on screen shows (its filters, the numbers listed, what is picked). RECORDS are the saved calculations, BOMS the saved BOMs, QUOTES the quotations — by their NUMBERS and technical figures (width, length, GSM, weight, construction, date; never an item name or a customer). Answer questions about them yourself ("how many 2L bags this month", "which bag is heaviest", "which bags have no BOM") and use their numbers in find/compare/targetcost steps. CONSTANTS are the plant\u2019s constants (name, value, unit); WORKFLOWLIST the saved workflows; GROUPS the RM groups.',
  'ALLOWED says what this person may do (cost = may see costs; rm, price, constants, route, quote, compare, targetcost, priceimpact, notes). Never propose a step for what is false; say who can do it (an administrator in Settings \u2192 Users).',
  'BE THE EXPERT, EASY AND EXACT. Write the answer for a busy person who does not know the software: first the result in one line, then the reason. Use short lines; "- " bullets; "1. 2. 3." for steps to follow; **bold** for the key figure; a table ("| a | b |" rows) when comparing. Use ONLY figures from CONTEXT or that you work out from them — show the working in one line (e.g. denier = GSM x DENIER FACTOR / (warp + weft) with the plant\u2019s own constant), and mark any estimate as an estimate. "How do I…" → numbered steps in the person\u2019s words, plus a "guide" step at the first button (and "open" when it is on another window). When the person only asks, answer — no steps.',
  'NEXT: give "next" — up to 3 short follow-ups the person is likely to want now, in THEIR language, each a complete request Nexora AI could do (e.g. "Save it and open the BOM", "Compare it with CAL-2026-000012").',
  'BY VOICE (4.67.8): when VOICE is true the answer is SPOKEN to the person — two or three short spoken sentences, no table, no list, no symbols; the plan still carries every step. When the person asks to go ahead with the plan already shown and adds nothing new ("run", "run karo", "chalavo", "haa, karo", "kari do", "go ahead", "चलाओ", "कर दो"), answer "run": true with no steps. A voice transcript may mishear a number: repeat the figures you understood in the answer.',
  'A RECORDING: put in "transcript" exactly the words you heard, in the script they were spoken. Take a NEW bag only from what this recording (or these typed words) says — never carry a construction, a size or a weight over from earlier in the conversation unless the person points to it ("the same bag", "that one", "it"). When the recording is unclear or seems cut short, say what you heard and ask — no calculation step.',
  'Answer ONLY with JSON: {"transcript": string, "lang": "en"|"gu"|"hi", "answer": string, "steps": [ ... ], "remember": string or null, "forget": [string], "next": [string], "run": true|false}.'
].join('\n');

/** What a construction needs, read from its own fields and its name: the processes its layers and parts call for. */
export function needsOf(con) {
  const f = (con && con.fields) || [], n = String((con && con.name) || '').toUpperCase();
  const has = (re) => f.some((k) => re.test(k));
  const layers = Number((/^(\d)L\b/.exec(n) || [])[1]) || null;
  return {
    layers: layers,
    coating: has(/CT GSM/) || (layers !== null && layers >= 2),
    bopp: has(/BOP MIC|BOPP/) || /BOPP/.test(n),
    metallised: has(/MT MIC/),
    backseam: has(/BACKSEAM|BKSM/) || /BKSM|BACKSEAM/.test(n),
    blockBottom: /BLOCK BOTTOM/.test(n) || has(/^PATCH$|PTC/),
    valve: has(/^VALVE$/),
    pinch: /PINCH/.test(n),
    liner: has(/LNR|LINER/) || /LNR|LINER/.test(n),
    stitch: /STITCH/.test(n)
  };
}
/** The processes a new route must have for a construction's needs; the codes this plant has. */
function routeNeeds(needs, procCodes) {
  const want = [];
  const pick = (codes) => codes.filter((c) => procCodes.indexOf(c) > -1)[0];
  if (needs.bopp) { const bp = pick(['BOPP_PRINTING']); if (bp) want.push({ code: bp, why: 'a BOPP bag is printed on its film', after: 'WEAVING' }); }
  if (needs.coating || needs.bopp) { const l = pick(['LAMINATION', 'COATING']); if (l) want.push({ code: l, why: needs.bopp ? 'the film is laminated to the fabric' : 'this construction has a coating layer', after: 'WEAVING' }); }
  if (needs.backseam) { const b = pick(['BACKSEAM']); if (b) want.push({ code: b, why: 'the construction is backseamed', after: 'LAMINATION' }); }
  if (needs.blockBottom) { const b = pick(['BLOCK_BOTTOM']); if (b) want.push({ code: b, why: 'patches and a valve make a block bottom', after: 'FINISHING' }); }
  if (needs.pinch) { const b = pick(['PINCH_BOTTOM']); if (b) want.push({ code: b, why: 'a pinch bottom bag', after: 'FINISHING' }); }
  return want;
}
/** Every number the person said — in this request, earlier in the conversation, in a recording\u2019s transcript. */
function saidNumbers(p) {
  const txt = [p.text, p.transcript || ''].concat(p.history.filter((h) => h.role === 'user').map((h) => h.text)).join(' ');
  return (txt.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => isFinite(n));
}
/* 4.67.12 — what the person's own words say about the bag: its layers, and its kind of bottom.
   A new calculation that contradicts them ("4L block bottom" said, "1L STITCH BAG" planned) is not
   run — it is asked. Words in English, Gujarati or Hindi, spoken or typed. */
export function saidBag(t) {
  const x = String(t || '').toLowerCase();
  const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, ek: 1, be: 2, tran: 3, char: 4, 'એક': 1, 'બે': 2, 'ત્રણ': 3, 'ચાર': 4, 'दो': 2, 'तीन': 3, 'चार': 4 };
  let layers = null;
  const m = /(\d|one|two|three|four|five|ek|be|tran|char|એક|બે|ત્રણ|ચાર|दो|तीन|चार)\s*-?\s*(?:l\b|layer|layers|લેયર|એલ|લ\b|लेयर|एल|परत)/i.exec(x);
  if (m) layers = /\d/.test(m[1]) ? Number(m[1]) : (NUM[m[1]] || null);
  const block = /block\s*-?\s*bottom|blockbottom|બ્લોક|ब्लॉक/.test(x);
  const pinch = /pinch|પિંચ|पिंच/.test(x);
  const stitch = /stitch|સ્ટીચ|સિલાઈ|स्टिच|सिलाई/.test(x);
  return { layers: layers, bottom: block ? 'BLOCK' : pinch ? 'PINCH' : stitch ? 'STITCH' : null };
}
function bagMismatch(said, conName) {
  const n = String(conName || '').toUpperCase();
  const lay = Number((/^(\d)L\b/.exec(n) || [])[1]) || null;
  const bottom = /BLOCK BOTTOM/.test(n) ? 'BLOCK' : /PINCH/.test(n) ? 'PINCH' : /STITCH/.test(n) ? 'STITCH' : null;
  const why = [];
  if (said.layers && lay && said.layers !== lay) why.push(said.layers + 'L');
  if (said.bottom && bottom && said.bottom !== bottom) why.push(said.bottom === 'BLOCK' ? 'block bottom' : said.bottom === 'PINCH' ? 'pinch bottom' : 'stitched');
  return why;
}
/** The steps Nexora AI proposed, checked against what was sent. */
export function checkSteps(p, raw) {
  const out = [], dropped = [], missing = [], notes = [];
  const conOf = {}; p.constructions.forEach((c) => { conOf[c.name.toUpperCase()] = c; });
  const fieldOf = {}; p.fields.forEach((f) => { fieldOf[f.key] = f; });
  const procOf = {}; p.processes.forEach((q) => { procOf[q.code.toUpperCase()] = q; });
  const routeOf = {}; p.routes.forEach((r) => { routeOf[r.name.toUpperCase()] = r; });
  const matOf = {}; p.materials.forEach((m) => { matOf[m.code.toUpperCase()] = m; });
  const matFind = (v) => { const k = String(v || '').trim().toUpperCase(); if (matOf[k]) return matOf[k];
    return p.materials.filter((m) => m.name.toUpperCase() === k)[0] || null; };
  const procFind = (v) => { const k = String(v || '').trim().toUpperCase(); if (procOf[k]) return procOf[k];
    return p.processes.filter((q) => q.name.toUpperCase() === k)[0] || null; };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const x = Number(String(v).replace(/,/g, '')); return isFinite(x) ? Math.round(x * 1000) / 1000 : null; };
  const BASES = { PCT: 1, PERBAG_G: 1, PER1000: 1, ABS: 1 };
  list(raw, 24).forEach((s) => {
    const d = s && String(s.do || '').toLowerCase();
    if (d === 'calc') {
      const named = s.construction ? conOf[String(s.construction).trim().toUpperCase()] : null;
      const fresh = s.fresh !== false || !p.now.calc.madeByAi;
      /* the words of THIS request (typed, or heard) against the bag planned */
      if (fresh && named) {
        const why = bagMismatch(saidBag(p.text + ' ' + (p.transcript || '')), named.name);
        if (why.length) {
          dropped.push('construction ' + named.name + ' (you said ' + why.join(', ') + ')');
          missing.push({ key: '__construction', label: 'Construction \u2014 you said ' + why.join(', '), type: 'enum', required: true,
            options: p.constructions.map((c) => c.name).filter((c) => !bagMismatch(saidBag(p.text + ' ' + (p.transcript || '')), c).length).concat(p.constructions.map((c) => c.name)).filter((c, i, a) => a.indexOf(c) === i) });
          return;
        }
      }
      const con = named || (!s.construction ? conOf[String(p.now.calc.structure || '').toUpperCase()] : null) || null;
      if (s.construction && !named) dropped.push('construction ' + str(s.construction, 40));
      const inputs = {};
      Object.keys((s.inputs && typeof s.inputs === 'object') ? s.inputs : {}).forEach((k) => {
        const f = fieldOf[k];
        if (!f || (con && con.fields.indexOf(k) < 0)) { dropped.push(str(k, 30)); return; }
        const v = s.inputs[k];
        if (f.type === 'enum') { const hit = f.options.filter((o) => o.toUpperCase() === String(v).trim().toUpperCase())[0]; if (hit) inputs[k] = hit; else dropped.push(k); return; }
        const x = num(v); if (x !== null && x >= 0) inputs[k] = x; else dropped.push(k);
      });
      const tw = num(s.targetWeight);
      const target = tw !== null && tw > 0 && tw < 100000 ? tw : null;
      /* "70 gram" is the bag: the GSM is Nexora's to find, never a guess */
      if (target && inputs['BD FAB GSM'] !== undefined) delete inputs['BD FAB GSM'];
      const q = num(s.bagQuantity);
      /* 4.67.4 — "koi filed jarur hoy to pusatu nthi direct fill kri de che": a figure the
         person never said (in this request or earlier in the conversation), and that is not
         already on the bag being changed, is taken out and asked — Nexora AI's guess shown */
      const guessed = {};
      const said = saidNumbers(p);
      const saidWords = (p.text + ' ' + p.history.filter((h) => h.role === 'user').map((h) => h.text).join(' ') + ' ' + (p.transcript || '')).toLowerCase();
      const onBag = fresh ? {} : (p.now.calc.inputs || {});
      /* what the plant's own saved bags of this construction say (patch, valve, mesh, coating…) */
      const typ = con ? (p.learned.typical || []).filter((t) => t.construction.toUpperCase() === con.name.toUpperCase())[0] : null;
      const fromSaved = [];
      Object.keys(inputs).forEach((k) => {
        const v = inputs[k], f = fieldOf[k];
        if (onBag[k] !== undefined && String(onBag[k]) === String(v)) return;
        if (typ && ((typ.inputs[k] !== undefined && String(typ.inputs[k]) === String(v)) || (typ.values[k] || []).some((x) => String(x) === String(v)))) { fromSaved.push(k); return; }
        if (f && f.type === 'enum') { if (saidWords.indexOf(String(v).toLowerCase()) < 0) { guessed[k] = v; delete inputs[k]; } return; }
        /* a size may have been said in another unit (19 inch in a mm plant); any other figure must be the very number said */
        const lu = String(p.units.length || 'mm').toLowerCase();
        const isLen = f && String(f.unit || '').toLowerCase() === lu && /^(mm|cm|in)$/.test(lu);
        /* mesh said per 10 cm, per cm or per inch, in a plant that counts it another way (40 x 40 per 10 cm = 10.2 per inch) */
        const isMeshF = k === 'M.WARP' || k === 'M.WEFT';
        const conv = isMeshF ? [1, 0.254, 2.54, 1 / 2.54, 10 / 2.54, 10, 0.1] : !isLen ? [1] : lu === 'mm' ? [1, 10, 25.4] : lu === 'cm' ? [1, 0.1, 2.54] : [1, 1 / 25.4, 1 / 2.54];
        if (!said.some((n) => conv.some((c) => Math.abs(n * c - v) < Math.max(0.051, Math.abs(v) * 0.002)))) { guessed[k] = v; delete inputs[k]; }
      });
      /* a figure this construction needs that Nexora AI left out, the saved bags give it (a new bag only) */
      if (typ && fresh) Object.keys(typ.inputs).forEach((k) => {
        if (inputs[k] !== undefined || guessed[k] !== undefined || !fieldOf[k] || (con && con.fields.indexOf(k) < 0)) return;
        inputs[k] = typ.inputs[k]; fromSaved.push(k);
      });
      out.push(Object.assign({ do: 'calc', construction: con ? con.name : null, inputs: inputs, targetWeight: target, bagQuantity: q && q > 0 ? Math.round(q) : null, fresh: !!fresh },
        fromSaved.length ? { fromSaved: fromSaved, savedFrom: typ.from } : {}));
      Object.keys(guessed).forEach((k) => { const f = fieldOf[k] || {};
        if (k === 'BD FAB GSM' && !target) { missing.push({ key: '__gsm_or_weight', label: 'Body fabric GSM or target weight', required: true, guess: guessed[k] }); return; }
        missing.push({ key: k, label: f.label || k, unit: f.unit, type: f.type, options: f.options, required: !!f.required, guess: guessed[k] }); });
      const have = Object.assign({}, fresh ? {} : p.now.calc.inputs, inputs);
      if (!con) missing.push({ key: '__construction', label: 'Construction', type: 'enum', options: p.constructions.map((x) => x.name) });
      else con.fields.forEach((k) => {
        const f = fieldOf[k];
        if (!f || !f.required || have[k] !== undefined || guessed[k] !== undefined) return;
        if (k === 'BD FAB GSM' && (target || (!fresh && p.now.calc.targetWeight))) return;
        /* "either weight or gsm anyone is required": ONE question, not two */
        if (k === 'BD FAB GSM') { missing.push({ key: '__gsm_or_weight', label: 'Body fabric GSM or target weight', required: true }); return; }
        if (typ && typ.inputs[k] !== undefined) return;
        missing.push({ key: k, label: f.label, unit: f.unit, type: f.type, options: f.options, required: true });
      });
      /* "not asking perameter which are marked in structured": every OTHER open field of this
         construction is asked too, unless it was said, is on the bag, or the saved bags give it */
      if (con) con.fields.forEach((k) => {
        const f = fieldOf[k];
        if (!f || f.required || f.optional || k === 'BD FAB GSM' || have[k] !== undefined || guessed[k] !== undefined) return;
        if (typ && typ.inputs[k] !== undefined) return;
        if (missing.some((m) => m.key === k)) return;
        missing.push({ key: k, label: f.label, unit: f.unit, type: f.type, options: f.options, required: false, ask: true });   /* 4.67.9 — asked; blank = the bag has none, Run goes on */
      });
      return;
    }
    if (d === 'save' || d === 'bom' || d === 'cost') { out.push({ do: d }); return; }
    if (d === 'check' || d === 'accept' || d === 'savebom') { out.push({ do: d }); return; }
    if (d === 'quote') {
      const qn = num(s.quantity), rt = num(s.rate), mg = num(s.margin);
      if (!(qn > 0)) { dropped.push('quote without a quantity'); return; }
      out.push({ do: 'quote', quantity: Math.round(qn), rate: rt !== null && rt > 0 ? rt : null, margin: mg !== null && mg > -100 && mg < 1000 ? mg : null });
      return;
    }
    if (d === 'price') {
      const m = matFind(s.material);
      const ch = num(s.change), pc = num(s.pct), st = num(s.set);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(s.from || '')) ? s.from : null;
      if (!m) { dropped.push('material ' + str(s.material, 30)); return; }
      if (st !== null && st > 0) out.push({ do: 'price', material: m.code, set: st, from: from });
      else if (pc !== null && pc > -100) out.push({ do: 'price', material: m.code, pct: pc, from: from });
      else if (ch !== null && ch !== 0) out.push({ do: 'price', material: m.code, change: ch, from: from });
      else dropped.push('price ' + m.code);
      return;
    }
    if (d === 'suggest') { const sg = procFind(s.stage); if (sg) out.push({ do: 'suggest', stage: sg.code }); else dropped.push('suggest ' + str(s.stage, 30)); return; }
    if (d === 'saveworkflow') { out.push({ do: 'saveworkflow', name: str(s.name, 80) }); return; }
    if (d === 'parts') {
      const KNOWN = ['BODY', 'TOP PATCH', 'BOTTOM PATCH', 'PATCH', 'VALVE', 'LINER', 'BOPP', 'HANDLE', 'ZIPPER'];
      const onBag = p.now.calc.parts.map((q) => q.key);
      const okKey = (k) => onBag.length ? onBag.indexOf(k) > -1 : KNOWN.indexOf(k) > -1;
      const tabs = {}, routes = {};
      Object.keys((s.tabs && typeof s.tabs === 'object') ? s.tabs : {}).forEach((k0) => {
        const k = String(k0).trim().toUpperCase();
        if (!okKey(k)) { dropped.push('part ' + str(k0, 30)); return; }
        tabs[k] = !!s.tabs[k0];
        const rn = s.routes && (s.routes[k0] || s.routes[k]);
        if (rn) { const hit = routeOf[String(rn).trim().toUpperCase()]; if (hit) routes[k] = hit.name; else dropped.push('route ' + str(rn, 40)); }
      });
      out.push({ do: 'parts', mode: s.mode === 'SPLIT' ? 'SPLIT' : 'WHOLE', tabs: tabs, routes: routes });
      return;
    }
    if (d === 'workflow') {
      const w = p.learned.workflows.filter((x) => x.name.toUpperCase() === String(s.name || '').trim().toUpperCase())[0];
      if (w) out.push({ do: 'workflow', name: w.name }); else dropped.push('workflow ' + str(s.name, 40));
      return;
    }
    if (d === 'route') {
      const hit = routeOf[String(s.name || '').trim().toUpperCase()];
      const asked = list(s.steps, 30);
      if (hit && !asked.length) { out.push({ do: 'route', name: hit.name }); return; }
      const steps = asked.map(procFind);
      if (steps.length && steps.every(Boolean)) {
        /* "according to structure ai is not making route": what the construction's layers and parts need is put in */
        const codes = steps.map((q) => q.code);
        const calcStep = out.filter((x) => x.do === 'calc')[0];
        const conName = (calcStep && calcStep.construction) || p.now.calc.structure;
        const con = conOf[String(conName || '').toUpperCase()];
        if (con) routeNeeds(needsOf(con), p.processes.map((q) => q.code)).forEach((w) => {
          if (codes.indexOf(w.code) > -1) return;
          let at = codes.indexOf(w.after);
          if (at < 0) at = codes.indexOf('WEAVING');
          if (at < 0) at = Math.max(0, codes.length - 2);
          const packing = codes.indexOf('PACKING');
          codes.splice(Math.min(at + 1, packing > -1 ? packing : codes.length), 0, w.code);
          notes.push('Added ' + (procOf[w.code] ? procOf[w.code].name : w.code) + ' to the route — ' + w.why + '.');
        });
        out.push({ do: 'route', name: str(s.name, 60) || 'Nexora AI route', steps: codes });
        return;
      }
      if (hit) { out.push({ do: 'route', name: hit.name }); return; }
      dropped.push('route ' + str(s.name, 40)); return;
    }
    if (d === 'recipe' || d === 'waste') {
      const st = procFind(s.stage);
      if (!st) { dropped.push(d + ' ' + str(s.stage, 30)); return; }
      const partOf = (v) => { const k = String(v || '').trim().toUpperCase(); if (!k) return null; const onBag = p.now.calc.parts.map((q) => q.key);
        return (!onBag.length || onBag.indexOf(k) > -1) ? k : null; };
      const part = s.part ? partOf(s.part) : null;
      if (d === 'waste') { const v = num(s.pct != null ? s.pct : s.value); if (v !== null && v >= 0 && v < 100) out.push(Object.assign({ do: 'waste', stage: st.code, pct: v }, part ? { part: part } : {})); else dropped.push('waste'); return; }
      const lines = [];
      list(s.lines, 12).forEach((l) => {
        if (l && l.earlier) {
          const from = l.stage ? procFind(l.stage) : null;
          const fig = l.figure ? p.figures.filter((f) => f.key === String(l.figure).trim().toUpperCase())[0] : null;
          if (l.stage && !from) { dropped.push('stage ' + str(l.stage, 30)); return; }
          if (l.figure && !fig) { dropped.push('figure ' + str(l.figure, 30)); return; }
          const v = num(l.value);
          lines.push({ earlier: true, stage: from ? from.code : null, basis: fig ? 'PART_G' : (l.basis === 'PART_G' ? 'PART_G' : 'PCT'), value: fig ? null : (v !== null && v > 0 ? v : 100), figure: fig ? fig.key : null });
          return;
        }
        if (l && l.part) { const k = partOf(l.part); const v = num(l.value); if (k) lines.push({ part: k, value: v !== null && v > 0 ? v : null }); else dropped.push('part ' + str(l.part, 30)); return; }
        const m = matFind(l && l.material); const v = num(l && l.value);
        if (!m || ((v === null || v < 0) && !s.remove)) { dropped.push('material ' + str(l && l.material, 30)); return; }
        lines.push({ material: m.code, name: m.name, value: v, basis: BASES[l.basis] ? l.basis : 'PCT' });
      });
      const w = num(s.wastePct);
      if (s.clear === true) { out.push(Object.assign({ do: 'recipe', stage: st.code, lines: [], clear: true, wastePct: w !== null && w >= 0 && w < 100 ? w : null }, part ? { part: part } : {})); return; }
      if (lines.length) out.push(Object.assign({ do: 'recipe', stage: st.code, lines: lines, wastePct: w !== null && w >= 0 && w < 100 ? w : null }, part ? { part: part } : {}, s.remove ? { remove: true } : (s.add ? { add: true } : {})));
      return;
    }
    if (d === 'open') { if (ASSIST_VIEWS.indexOf(s.view) > -1) out.push({ do: 'open', view: s.view }); else dropped.push('window ' + str(s.view, 20)); return; }
    /* 4.67.7 — the rest of Nexora */
    const recOf = (v) => { const k = String(v || '').trim().toUpperCase(); return k ? p.records.filter((r) => r.n.toUpperCase() === k)[0] || null : null; };
    const may = (k, what) => { if (p.allowed[k] === false) { dropped.push(what + ' (not in your access)'); return false; } return true; };
    if (d === 'resources') {
      if (!may('cost', 'resources')) return;
      const k = String(s.from || '').trim().toUpperCase();
      const b = p.boms.filter((x) => x.n.toUpperCase() === k || (x.calc && x.calc.toUpperCase() === k))[0];
      const c = !b ? p.records.filter((x) => x.n.toUpperCase() === k)[0] : null;
      if (!b && !c) { dropped.push('reference ' + str(s.from, 30) + ' (not found)'); return; }
      const st = s.stage ? procFind(s.stage) : null;
      if (s.stage && !st) { dropped.push('stage ' + str(s.stage, 30)); return; }
      out.push({ do: 'resources', from: b ? b.n : c.n, calc: b ? (b.calc || null) : c.n, stage: st ? st.code : null });
      return;
    }
    if (d === 'resource') {
      if (!may('cost', 'resource')) return;
      const st = procFind(s.stage);
      if (!st) { dropped.push('resource: stage ' + str(s.stage, 30)); return; }
      const act = ['add', 'set', 'remove'].indexOf(s.action) > -1 ? s.action : 'add';
      const name = str(s.name, 40);
      if (!name) { dropped.push('resource without a name'); return; }
      const BASIS = { KG: 1, BAG: 1, PER1000: 1, PERN: 1 };
      const o = { do: 'resource', action: act, stage: st.code, name: name, forAll: s.forAll === true };
      const onBag = p.now.calc.parts.map((q) => q.key);
      if (s.part && (!onBag.length || onBag.indexOf(String(s.part).toUpperCase()) > -1)) o.part = String(s.part).toUpperCase();
      if (act !== 'remove') {
        const t = String(s.type || '').trim().toUpperCase();
        o.type = p.resourceTypes.indexOf(t) > -1 ? t : (t ? 'OTHER' : null);
        o.basis = BASIS[String(s.basis || '').toUpperCase()] ? String(s.basis).toUpperCase() : null;
        const pb = num(s.perBags); o.perBags = o.basis === 'PERN' && pb > 0 ? pb : null;
        const r = num(s.rate);
        /* a rate is the person's to say */
        o.rate = r !== null && r >= 0 && saidNumbers(p).some((n) => Math.abs(n - r) < 1e-9) ? r : null;
        if (o.rate === null && act === 'add') missing.push({ key: '__rate', label: 'Rate for ' + name + ' on ' + st.name + (o.basis ? ' (' + o.basis + ')' : ''), required: true });
      }
      out.push(o);
      return;
    }
    if (d === 'stage') {
      const st = procFind(s.stage);
      if (!st) { dropped.push('stage ' + str(s.stage, 30)); return; }
      const act = s.action === 'add' ? 'add' : 'remove';
      const after = s.after ? procFind(s.after) : null;
      if (s.after && !after) dropped.push('stage ' + str(s.after, 30) + ' (to put it after)');
      const onBag = p.now.calc.parts.map((q) => q.key);
      const part = s.part && (!onBag.length || onBag.indexOf(String(s.part).toUpperCase()) > -1) ? String(s.part).toUpperCase() : null;
      out.push(Object.assign({ do: 'stage', action: act, stage: st.code }, act === 'add' ? { after: after ? after.code : null } : {}, part ? { part: part } : {}, s.shared === true ? { shared: true } : {}));
      return;
    }
    if (d === 'find') {
      const what = ['calc', 'bom', 'quote'].indexOf(s.what) > -1 ? s.what : 'calc';
      const pool = what === 'bom' ? p.boms : what === 'quote' ? p.quotes : p.records;
      const numb = s.number ? String(s.number).trim().toUpperCase() : '';
      const hit = numb ? pool.filter((r) => r.n.toUpperCase() === numb || (what === 'bom' && r.calc && r.calc.toUpperCase() === numb))[0] : null;
      if (numb && !hit) { dropped.push(what + ' ' + str(s.number, 30) + ' (not found)'); return; }
      const con = s.construction ? conOf[String(s.construction).trim().toUpperCase()] : null;
      if (s.construction && !con) { dropped.push('construction ' + str(s.construction, 40)); return; }
      if (what === 'bom' && !may('bom', 'BOM')) return;
      if (what === 'quote' && !may('quote', 'quotation')) return;
      out.push({ do: 'find', what: what, number: hit ? hit.n : null, construction: con ? con.name : null, q: str(s.q, 60) || null, open: !!(s.open && hit) });
      return;
    }
    if (d === 'compare') {
      if (!may('compare', 'compare')) return;
      const a = String(s.a || '').toLowerCase() === 'current' ? { n: 'current' } : recOf(s.a);
      const b = recOf(s.b);
      if (!a || !b || a.n === b.n) { dropped.push('compare ' + str(s.a, 20) + ' / ' + str(s.b, 20)); return; }
      out.push({ do: 'compare', a: a.n, b: b.n });
      return;
    }
    if (d === 'targetcost') {
      if (!may('targetcost', 'Target Cost') || !may('cost', 'Target Cost')) return;
      const c = String(s.calc || 'current').toLowerCase() === 'current' ? { n: 'current' } : recOf(s.calc);
      if (!c) { dropped.push('calculation ' + str(s.calc, 30)); return; }
      const mode = s.mode === 'COST' ? 'COST' : 'PRICE';
      const pr = num(s.price), mg = num(s.margin), co = num(s.cost);
      out.push({ do: 'targetcost', calc: c.n, mode: mode, price: pr !== null && pr > 0 ? pr : null, margin: mg !== null && mg >= 0 && mg < 100 ? mg : null, cost: co !== null && co > 0 ? co : null });
      return;
    }
    if (d === 'priceimpact') {
      if (!may('priceimpact', 'Price Impact') || !may('cost', 'Price Impact')) return;
      const ch = [];
      list(s.changes, 20).forEach((c) => {
        const m = matFind(c && c.material); if (!m) { dropped.push('material ' + str(c && c.material, 30)); return; }
        const a = num(c.change), pc = num(c.pct), st = num(c.set);
        if (st !== null && st > 0) ch.push({ material: m.code, set: st });
        else if (pc !== null && pc > -100) ch.push({ material: m.code, pct: pc });
        else if (a !== null && a !== 0) ch.push({ material: m.code, change: a });
        else dropped.push('price ' + m.code);
      });
      out.push({ do: 'priceimpact', changes: ch });
      return;
    }
    if (d === 'constant') {
      const c = p.constants.filter((x) => x.name.toUpperCase() === String(s.name || '').trim().toUpperCase())[0];
      const v = num(s.value);
      if (!c) { dropped.push('constant ' + str(s.name, 40)); return; }
      /* ask, never guess: the figure must be one the person said */
      if (v === null || !saidNumbers(p).some((n) => Math.abs(n - v) < 1e-9)) { missing.push({ key: '__constant', label: c.name + (c.unit ? ' (' + c.unit + ')' : ''), required: true }); out.push({ do: 'constant', name: c.name, value: null }); return; }
      out.push({ do: 'constant', name: c.name, value: v });
      return;
    }
    if (d === 'material') {
      if (!may('rm', 'new material')) return;
      const name = str(s.name, 60);
      const g = p.groups.filter((x) => x.toUpperCase() === String(s.group || '').trim().toUpperCase())[0] || null;
      const code = s.code ? str(String(s.code).trim().toUpperCase(), 20) : null;
      if (!name) { dropped.push('material without a name'); return; }
      if (code && matOf[code]) { dropped.push('material ' + code + ' (already in the RM Master)'); return; }
      if (p.materials.some((m) => m.name.toUpperCase() === name.toUpperCase())) { dropped.push('material ' + name + ' (already in the RM Master)'); return; }
      if (!g) { missing.push({ key: '__group', label: 'RM group for ' + name, type: 'enum', options: p.groups, required: true }); }
      const w = num(s.wastePct);
      out.push({ do: 'material', name: name, group: g, code: code, uom: ['KG', 'PCS', 'MTR'].indexOf(String(s.uom || '').toUpperCase()) > -1 ? String(s.uom).toUpperCase() : 'KG', wastePct: w !== null && w >= 0 && w < 100 ? w : null });
      return;
    }
    if (d === 'note') { const t = str(s.text, 1000); if (t && may('notes', 'note')) out.push({ do: 'note', text: t }); else if (!t) dropped.push('empty note'); return; }
    if (d === 'guide') {
      const v = ASSIST_VIEWS.indexOf(s.view) > -1 ? s.view : p.screen;
      const b = str(s.button, 40);
      if (!b) { dropped.push('guide without a button'); return; }
      out.push({ do: 'guide', view: v, button: b, say: str(s.say, 200) });
      return;
    }
    if (d) dropped.push(str(d, 20));
  });
  return { steps: out, dropped: dropped, missing: missing, notes: notes };
}

/** POST /v1/ai/assist */
export async function assist(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanAssist(payload);
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!p.text && !m.parts.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say or type something first.' } };
  /* 4.67.12 — what the question does not need is not sent: a route another bag made its own (named
     "<route> — CAL-…") is that bag's business, and a route no construction runs on goes without its
     sections (its steps still go) */
  const curRoute = String(p.now.calc.route || '');
  const routesSent = p.routes.filter((r) => !/ \u2014 [A-Z]{2,5}-\d{4}-\d+/.test(r.name) || r.name === curRoute)
    .map((r) => (r.constructions.length || r.name === curRoute) ? r : Object.assign({}, r, { stages: [] }));
  const ctx = { SCREEN: p.screen, VOICE: p.voice, UNITS: p.units, RULES: p.rules, ALLOWED: p.allowed, NOW: p.now, CONSTRUCTIONS: p.constructions, FIELDS: p.fields, PROCESSES: p.processes,
    ROUTES: routesSent, MATERIALS: p.materials, GROUPS: p.groups, CONSTANTS: p.constants, FIGURES: p.figures, RECORDS: p.records, BOMS: p.boms, QUOTES: p.quotes,
    WORKFLOWLIST: p.workflowList, LEARNED: p.learned, HELP_TOPICS: p.topics };
  const contents = [{ role: 'user', parts: [{ text: 'CONTEXT:\n' + JSON.stringify(ctx) }] },
    { role: 'model', parts: [{ text: '{"transcript":"","lang":"en","answer":"Ready.","steps":[]}' }] }];
  p.history.forEach((h) => contents.push({ role: h.role, parts: [{ text: h.text }] }));
  /* no language switch: Nexora AI answers in the language the person used,
     unless a language was asked for by name */
  const said = (lang === 'gu' || lang === 'hi') ? langLine(lang, 'the answer') : '';
  contents.push({ role: 'user', parts: m.parts.concat([{ text: said + (m.audio ? 'The person speaks in the attached recording.' + (p.text ? ' Also typed: ' + p.text : '') : p.text) +
    (m.files ? '\nAlso attached: ' + m.files + ' photo(s)/document(s) of the bag — read its sizes and specification from them.' : '') }]) });
  const a = await ask(companyId, ASSIST_SYSTEM, { contents: contents }, fetchImpl, { strong: !p.voice && !m.audio, maxTokens: 8192 });
  if (a.fail) return a.fail;
  const j = a.json || {};
  if (j.transcript) p.transcript = str(j.transcript, 1200);
  const checked = checkSteps(p, j.steps);
  const l = String(j.lang || '').toLowerCase();
  let answer = str(j.answer, 6000);
  if (!checked.steps.length && /\b(added|done|updated|changed|saved|removed|set it|applied)\b|ઉમેર્ય|ઉમેરી દ|કરી દી|કર્યુ|बदल दि|जोड़ दि|कर दिया|सेव कर/i.test(answer)) {
    const lg = l === 'gu' || l === 'hi' ? l : 'en';
    answer += lg === 'gu' ? '\n\n(ધ્યાન: હજુ કશું બદલાયું નથી — આ માટે કોઈ પગલું બન્યું નથી. Stage અને શું ઉમેરવું તે ફરી કહો.)'
      : lg === 'hi' ? '\n\n(ध्यान दें: अभी कुछ नहीं बदला — इसके लिए कोई कदम नहीं बना। Stage और क्या जोड़ना है, फिर से कहें।)'
      : '\n\n(Note: nothing has been changed — no step could be made for this. Say the stage and what to add again.)';
  }
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, transcript: str(j.transcript, 1200),
    lang: l === 'gu' || l === 'hi' ? l : 'en', answer: answer,
    steps: checked.steps, missing: checked.missing, dropped: checked.dropped, notes: checked.notes, remember: j.remember ? str(j.remember, 300) : null,
    forget: list(j.forget, 10).map((x) => str(x, 300)).filter((x) => p.rules.indexOf(x) > -1),
    next: list(j.next, 3).map((x) => str(x, 120)).filter(Boolean),
    run: j.run === true && !checked.steps.length } };
}

/* ==========================================================================
   4.67.8 — "does app support continues conversation via voice in multi
   language?" · "go". The answer read aloud, in English, Gujarati or Hindi,
   by Google's speech model (the application uses the computer's own voice
   first and asks here only when it has none for the language — Gujarati,
   on most Windows computers). Only the answer's words come here, never
   anything else; the voice goes back as audio.
   ========================================================================== */
const speakRecent = [];
const speakPerCompany = new Map();
function takeSpeak(companyId) {
  const now = Date.now();
  while (speakRecent.length && now - speakRecent[0] > 60000) speakRecent.shift();
  if (speakRecent.length >= (Math.max(1, parseInt(process.env.AI_SPEAK_PER_MINUTE, 10) || 12))) return { busy: true };
  const k = String(companyId || 'none'); const c = speakPerCompany.get(k); const d = today();
  const used = c && c.day === d ? c.n : 0;
  if (used >= (Math.max(1, parseInt(process.env.AI_SPEAK_DAILY, 10) || 200))) return { spent: true };
  speakPerCompany.set(k, { day: d, n: used + 1 }); speakRecent.push(now);
  return {};
}
export function _resetSpeak() { speakRecent.length = 0; speakPerCompany.clear(); }
/** The voice model: GEMINI_TTS_MODEL, else the newest Flash-Lite TTS the key lists (it answers soonest), else Flash TTS. */
export function ttsOf(names) {
  const env = String(process.env.GEMINI_TTS_MODEL || '').trim().replace(/^models\//, '');
  if (env) return env;
  const ver = (n) => { const m = /gemini-(\d+)(?:\.(\d+))?/.exec(n); return m ? Number(m[1]) * 1000 + Number(m[2] || 0) : 0; };
  const pick = (re) => names.filter((n) => re.test(n) && !blocked.has(n)).sort((a, b) => ver(b) - ver(a))[0];
  return pick(/flash-lite.*tts|tts.*flash-lite/) || pick(/flash.*tts/) || 'gemini-3.8-flash-lite-tts';
}
/** Words that read well aloud: no marks, no table, not too long. */
export function speakable(t) {
  const lines = String(t || '').split('\n').filter((l) => !/^\s*\|/.test(l)).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
  let x = lines.join(' ').replace(/\*\*|__|`|#{1,4}\s/g, '').replace(/^\s*[-*\u2022]\s+/gm, '').replace(/[\u2726\u2714\u2713\u{1F4CC}\u{1F5D1}]/gu, '')
    .replace(/\s+/g, ' ').trim();
  if (x.length > 700) { const cut = x.slice(0, 700); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\u0964'), cut.lastIndexOf('? ')); x = end > 200 ? cut.slice(0, end + 1) : cut; }
  return x;
}
function audioOf(body) {
  /* the interactions answer: steps[].content[] of type audio */
  const steps = (body && body.steps) || [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const c = (steps[i] && steps[i].content) || [];
    for (let j = c.length - 1; j >= 0; j--) if (c[j] && c[j].type === 'audio' && c[j].data) return { data: c[j].data, mime: c[j].mime_type || c[j].mimeType || 'audio/wav' };
  }
  /* the generateContent answer: candidates[0].content.parts[].inlineData */
  const parts = ((((body && body.candidates) || [])[0] || {}).content || {}).parts || [];
  for (let i = 0; i < parts.length; i++) { const d = parts[i] && (parts[i].inlineData || parts[i].inline_data); if (d && d.data) return { data: d.data, mime: d.mimeType || d.mime_type || 'audio/L16;rate=24000' }; }
  return null;
}
/** POST /v1/ai/speak {text, lang} → {ok, mime, data} */
export async function speak(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const x = payload && typeof payload === 'object' ? payload : {};
  const text = speakable(x.text);
  if (!text) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Nothing to say.' } };
  const t = takeSpeak(companyId);
  if (t.busy) return { httpStatus: 429, body: { error: 'AI_BUSY', message: 'Nexora AI is speaking for others — the answer is on the screen.' } };
  if (t.spent) return { httpStatus: 429, body: { error: 'AI_DAILY', message: 'Today\u2019s spoken answers are used up — the answers stay on the screen.' } };
  await resolveModel(false, fetchImpl);
  const name = ttsOf(allNames.length ? allNames : model.available || []);
  const voice = String(process.env.GEMINI_TTS_VOICE || 'Kore').trim();
  const say = [{ type: 'text', text: text }];
  let r = null;
  try {
    r = await gfetch(API + '/interactions', { method: 'POST', body: JSON.stringify({ model: name, input: [{ type: 'user_input', content: say }],
      response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: voice }] } }) }, fetchImpl, 30000);
  } catch (e) { r = null; }
  let a = r && r.ok ? audioOf(r.body) : null;
  if (!a) {
    /* the older way of asking the same model */
    try {
      r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', { method: 'POST', body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }) }, fetchImpl, 30000);
    } catch (e) { return { httpStatus: 504, body: { error: 'AI_TIMEOUT', message: 'The voice did not come in time — the answer is on the screen.' } }; }
    a = r && r.ok ? audioOf(r.body) : null;
  }
  if (!a) {
    const busy = r && r.status === 429;
    return { httpStatus: busy ? 429 : 502, body: { error: busy ? 'AI_BUSY' : 'AI_VOICE', message: busy ? 'The voice is busy — the answer is on the screen.' :
      'The answer could not be spoken (' + (r ? r.status : 'no answer') + ': ' + scrub(r && r.body && r.body.error && r.body.error.message) + ').' } };
  }
  return { httpStatus: 200, body: { ok: true, model: name, mime: a.mime, data: a.data, lang: ['gu', 'hi'].indexOf(lang) > -1 ? lang : 'en' } };
}

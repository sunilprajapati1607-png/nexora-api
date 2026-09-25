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

/** POST /v1/ai/check-bom */
export async function checkBom(companyId, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = clean(payload);
  if (!p.stages.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'There is no route on this BOM to check yet.' } };
  const t = take(companyId);
  if (t.busy) return { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy — try again in ' + t.busy + ' seconds.' } };
  if (t.spent) return { httpStatus: 429, body: { error: 'AI_DAILY', message: 'This company has used today’s ' + daily() + ' Nexora AI checks. They come back tomorrow.' } };
  const name = await resolveModel(false, fetchImpl);
  if (!name) return { httpStatus: 503, body: { error: 'AI_MODEL', message: 'Nexora AI has no model it can use right now.' } };
  let r;
  try {
    r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', {
      method: 'POST',
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: promptFor(p, lang) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 2048 }
      })
    }, fetchImpl);
  } catch (e) {
    return { httpStatus: 504, body: { error: 'AI_TIMEOUT', message: 'Nexora AI did not answer in time. Try again.' } };
  }
  if (!r.ok) {
    if (r.status === 404) resolveModel(true, fetchImpl).catch(() => {});      // the model went away: look again
    const busy = r.status === 429;
    return { httpStatus: busy ? 429 : 502, body: { error: busy ? 'AI_BUSY' : 'AI_FAILED', retryAfter: busy ? 60 : undefined,
      message: busy ? 'Nexora AI is busy (Google’s limit) — try again in a minute.' : 'Nexora AI could not answer (' + r.status + '): ' + scrub(r.body && r.body.error && r.body.error.message) } };
  }
  const ans = readAnswer(r.body);
  if (!ans) return { httpStatus: 502, body: { error: 'AI_UNREADABLE', message: 'Nexora AI answered in a form Nexora could not read. Try again.' } };
  return { httpStatus: 200, body: Object.assign({ ok: true, model: name, left: t.left }, ans) };
}

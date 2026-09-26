/**
 * Nexora Jobwork — Nexora AI (Google Gemini)
 * ===========================================
 * The weight calculator's Nexora AI (nexora-api/api/src/ai.js, 4.67.3),
 * brought across: one Gemini caller, the newest Flash-Lite picked by
 * itself, a retired model replaced by the one Google names, limits, JSON
 * only, and every request passed through a whitelist before it leaves.
 *
 * THE AGENT. The person asks, in words or by voice, on any window. Nexora AI
 * answers, and when they ask for work it returns STEPS from a fixed list.
 * The application shows the steps; the person presses ONE Run; the
 * application does them with its own screens — and a document is only ever
 * FILLED IN: the person reads it and presses Post, and the validation engine
 * checks it as it checks every posting. The ledger is append-only; nothing
 * a model guessed is written into it without a person.
 *
 * WHAT IS NEVER SENT (owner's rule): a party's name, an item's name, a rate,
 * a price, an amount or a cost. The application sends parties as P1, P2…
 * and items as I1, I2… (with their material group and unit) and puts the
 * names back on its own screen. Here that is enforced once more: a party or
 * item field that is not a token is dropped, and no field for money exists
 * in the whitelist at all. (On Google's free tier what is sent may be used
 * to improve its products.)
 *
 * Limits: the free tier is one key for every plant, so each installation
 * (device id) gets AI_DAILY_PER_DEVICE questions a day (default 60) and the
 * service sends at most AI_PER_MINUTE (default 10) a minute. In memory —
 * a restart resets them.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
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
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 40000;

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
let model = { name: null, at: 0, error: null };
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
      model = { name: pick, at: Date.now(), error: pick ? (pick === wanted ? null : 'asked for ' + wanted + ', using ' + pick) : 'no usable model on this key' };
    } catch (e) {
      model = { name: wanted, at: Date.now() - MODEL_TTL_MS + 5 * 60 * 1000, error: scrub(e && e.message) };
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
const perDevice = new Map();         // device -> { day, n }
let recent = [];
const daily = () => Math.max(1, parseInt(process.env.AI_DAILY_PER_DEVICE, 10) || 60);
const perMinute = () => Math.max(1, parseInt(process.env.AI_PER_MINUTE, 10) || 10);
function today() { return new Date().toISOString().slice(0, 10); }
function take(device) {
  const now = Date.now();
  recent = recent.filter((t) => now - t < 60000);
  if (recent.length >= perMinute()) return { busy: Math.ceil((60000 - (now - recent[0])) / 1000) };
  const k = String(device || 'none');
  const c = perDevice.get(k);
  const d = today();
  const used = c && c.day === d ? c.n : 0;
  if (used >= daily()) return { spent: true, used };
  perDevice.set(k, { day: d, n: used + 1 });
  recent.push(now);
  return { left: daily() - used - 1 };
}
export function _resetLimits() { perDevice.clear(); recent = []; }

/* ---- the answer language ------------------------------------------------ */
export function langLine(lang, what) {
  const w = what || 'your answer';
  if (lang === 'gu') return 'Write ' + w + ' in Gujarati (Gujarati script). Keep document numbers, codes, tokens (P1, I1), field names and Nexora button names in English.\n';
  if (lang === 'hi') return 'Write ' + w + ' in Hindi (Devanagari script). Keep document numbers, codes, tokens (P1, I1), field names and Nexora button names in English.\n';
  return '';
}
export function pickLang(v) { return v === 'gu' || v === 'hi' || v === 'en' ? v : 'auto'; }

/* ---- what a person may attach: their voice, a photo, a PDF --------------- */
const MEDIA_TYPES = {
  'audio/wav': 1, 'audio/x-wav': 1, 'audio/mp3': 1, 'audio/mpeg': 1, 'audio/ogg': 1, 'audio/flac': 1, 'audio/aac': 1, 'audio/webm': 1,
  'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/heic': 1, 'application/pdf': 1
};
const MAX_MEDIA_B64 = 8 * 1024 * 1024;
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

/* ---- what may be sent ---------------------------------------------------- */
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n || 80);
const nr = (v) => { const x = Number(v); return isFinite(x) ? Math.round(x * 1000) / 1000 : null; };
const list = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
/* a party is P<n>, an item I<n> — anything else is dropped, so a real name
   can never ride along in those fields */
const ptok = (v) => (/^P\d{1,5}$/.test(String(v || '')) ? String(v) : null);
const itok = (v) => (/^I\d{1,5}$/.test(String(v || '')) ? String(v) : null);
const docNo = (v) => str(v, 40).replace(/[^\w\/\-. ]/g, '');
const oneOf = (v, a, d) => (a.indexOf(v) > -1 ? v : d);

export const VIEWS = ['dashboard', 'plans', 'plans-in', 'plans-out', 'plan', 'orders-in', 'orders-out', 'porders', 'porder',
  'quick-receipt', 'quick-issue', 'labels', 'stock', 'reconcile', 'trace', 'relation', 'material-ledger', 'pending',
  'challans', 'itc04', 'ageing', 'invoices', 'rates', 'bills', 'exceptions', 'waste', 'profit', 'parties', 'items',
  'item_groups', 'specs', 'uoms', 'processes', 'warehouses', 'routes', 'recipes', 'activity', 'sync', 'settings', 'notes'];
const STAGES = ['PLAN', 'RECEIPT', 'PO', 'ISSUE', 'PRODUCTION', 'QC', 'RELEASE', 'DISPATCH', 'INVOICE', 'CLOSED'];

export function cleanAssist(p) {
  const x = p && typeof p === 'object' ? p : {};
  const n = x.now && typeof x.now === 'object' ? x.now : {};
  return {
    screen: oneOf(x.screen, VIEWS, 'dashboard'),
    today: /^\d{4}-\d{2}-\d{2}$/.test(String(x.today || '')) ? x.today : today(),
    text: str(x.text, 1200),
    history: list(x.history, 20).map((h) => ({ role: h && h.role === 'model' ? 'model' : 'user', text: str(h && h.text, 2500) })).filter((h) => h.text),
    parties: list(x.parties, 400).map((q) => ({ t: ptok(q && q.t), type: str(q && q.type, 20) })).filter((q) => q.t),
    items: list(x.items, 600).map((q) => ({ t: itok(q && q.t), group: str(q && q.group, 40), cls: str(q && q.cls, 6), uom: str(q && q.uom, 10), uom2: str(q && q.uom2, 10) })).filter((q) => q.t),
    groups: list(x.groups, 80).map((g) => str(g, 40)).filter(Boolean),
    warehouses: list(x.warehouses, 60).map((w) => str(w, 30)).filter(Boolean),
    processes: list(x.processes, 80).map((q) => ({ code: str(q && q.code, 20), name: str(q && q.name, 40) })).filter((q) => q.code),
    routes: list(x.routes, 60).map((r) => ({ name: str(r && r.name, 60), steps: list(r && r.steps, 20).map((s) => str(s, 20)) })).filter((r) => r.name),
    plans: list(x.plans, 200).map((q) => ({
      no: docNo(q && q.no), dir: (q && q.dir) === 'OUT' ? 'OUT' : 'IN', party: ptok(q && q.party), status: str(q && q.status, 20),
      stage: oneOf(q && q.stage, STAGES, ''), date: str(q && q.date, 10), due: str(q && q.due, 10),
      inKg: nr(q && q.inKg), outKg: nr(q && q.outKg), wasteKg: nr(q && q.wasteKg), balanceKg: nr(q && q.balanceKg),
      items: list(q && q.items, 12).map(itok).filter(Boolean), process: str(q && q.process, 40)
    })).filter((q) => q.no),
    orders: list(x.orders, 100).map((q) => ({ no: docNo(q && q.no), plan: docNo(q && q.plan), item: itok(q && q.item), status: str(q && q.status, 20),
      plannedKg: nr(q && q.plannedKg), issuedKg: nr(q && q.issuedKg), madeKg: nr(q && q.madeKg) })).filter((q) => q.no),
    stock: list(x.stock, 400).map((s) => ({ item: itok(s && s.item), party: ptok(s && s.party), plan: docNo(s && s.plan), stage: str(s && s.stage, 20),
      wh: str(s && s.wh, 30), kg: nr(s && s.kg), batches: nr(s && s.batches) })).filter((s) => s.item && s.kg),
    pending: (function (q) {
      q = q && typeof q === 'object' ? q : {};
      const o = {};
      ['qcWaiting', 'releaseWaiting', 'toInvoice', 'challansDue', 'challansOverdue', 'exceptions', 'openPlans', 'openOrders'].forEach((k) => { const v = nr(q[k]); if (v !== null) o[k] = v; });
      return o;
    })(x.pending),
    topics: list(x.topics, 120).map((t) => str(t, 80)).filter(Boolean),
    /* what is open on the screen — numbers and tokens only */
    now: { plan: docNo(n.plan), order: docNo(n.order), doc: docNo(n.doc), batch: docNo(n.batch), form: str(n.form, 40), note: str(n.note, 300) }
  };
}

/* ---- the steps ----------------------------------------------------------- */
const STEP_LIST = [
  '{"do":"open","view":VIEW} — go to a window (VIEW one of ' + VIEWS.filter((v) => v !== 'plan' && v !== 'porder').join('|') + ').',
  '{"do":"find","view":VIEW,"text":words} — open a register and put words in its search (a plan number, a batch, P3, I7…).',
  '{"do":"plan","no":PLAN NO} — open one plan (from PLANS).',
  '{"do":"order","no":ORDER NO} — open one production order (from ORDERS).',
  '{"do":"trace","batch":BATCH NO} — trace a batch backwards and forwards.',
  '{"do":"stock","by":"item"|"party"|"group"|"warehouse"|"stage"} — the stock window, grouped.',
  '{"do":"newplan","dir":"IN"|"OUT","party":P TOKEN,"lines":[{"item":I TOKEN,"kg":number}],"process":PROCESS CODE or null} — fill a new jobwork plan (IN: the party’s material processed here; OUT: our material sent to a job worker).',
  '{"do":"receipt","plan":PLAN NO,"lines":[{"item":I TOKEN,"kg":number,"qty2":number or null}],"challan":string or null} — fill a material receipt on a plan.',
  '{"do":"porder","plan":PLAN NO,"item":I TOKEN,"kg":number,"qty2":number or null} — fill a production order on an inward plan.',
  '{"do":"issue","plan":PLAN NO,"order":ORDER NO or null,"item":I TOKEN or null,"kg":number,"pick":"FIFO"|"FEFO"} — fill an issue to production; the batches are picked FIFO (oldest first) or FEFO (first to expire).',
  '{"do":"production","plan":PLAN NO,"order":ORDER NO or null,"item":I TOKEN,"kg":number,"qty2":number or null} — fill a production receipt (what came off the machine).',
  '{"do":"qc","plan":PLAN NO} — open the QC test for a plan.',
  '{"do":"release","plan":PLAN NO} — open Release to FG for a plan (after QC passed).',
  '{"do":"invoice","plan":PLAN NO} — open a job-work invoice for a plan (Nexora puts the rates; you never see them).'
];

const SYSTEM = [
  'You are Nexora AI, the assistant inside Nexora Jobwork — software for job work in plastic packaging plants (PP/PE woven sacks, BOPP, lamination, printing, films, bags).',
  'You know job work well. INWARD job work (direction IN): a customer (the principal) sends its own material; the plant receives it (material receipt, their challan), makes a production order, issues material to production, receives what was made (production receipt, batches), tests it (QC), releases it to finished goods, sends it back to the party with a challan, and raises a job-work invoice for the processing. OUTWARD job work (OUT): the plant sends its own material to a job worker on a delivery challan and gets it back processed; under GST the goods must come back within 1 year (capital goods 3 years) and are reported on ITC-04. The plan pipeline is PLAN → RECEIPT → [PO → ISSUE → PRODUCTION] → QC → RELEASE → DISPATCH → INVOICE → CLOSED. Stock is kept by plan, stage, warehouse and batch; a batch is issued FIFO (oldest first) or FEFO (first to expire); the balance of a plan is what came in minus what went out, used and wasted.',
  'You see the window the person is on (SCREEN, NOW) and a summary of THIS plant: parties as tokens P1, P2… with their type, items as tokens I1, I2… with their material group, class (RM raw material, SFG semi-finished, FG finished) and units, open PLANS, production ORDERS, STOCK in kg, PENDING work, processes, routes and warehouses. Write P and I tokens exactly as given (Nexora shows the real names on the person’s screen). You NEVER see — and must never ask for, guess or invent — a party’s name, an item’s name, a rate, a price, an amount or a cost. If the person asks about money, say those figures are on their screen in Nexora (Invoices, Rates, Bills, Profit) and offer to open that window.',
  'Answer questions from the data you were given: which plans are waiting for QC, how much of I3 is in stock for P2, which challans are overdue, what to do next on a plan. Add up and compare the kg figures carefully; say the plan numbers. If the data you have cannot answer it, say so plainly and open the window that can.',
  'When the person asks for work to be done, return STEPS. Steps allowed: ' + STEP_LIST.join(' '),
  'Steps that make a document (newplan, receipt, porder, issue, production) only FILL the form — the person reads it and presses Post; Nexora checks it then. Use only plan and order numbers from PLANS and ORDERS, and only P and I tokens from PARTIES and ITEMS. Quantities are kg unless the person says the second unit (bags, pieces, rolls → qty2). "1.2 ton" is 1200 kg. Leave out a step the screen shows is already done. When the person corrects you ("no, 900 kg"), return the whole corrected list of steps again.',
  'If something needed is missing (which plan, which item, how much), still return the steps you can and ask for the rest in "answer". Keep "answer" short and practical.',
  'Reply in the SAME language the person used: English → English; Gujarati (in Gujarati script or in English letters) → Gujarati in Gujarati script; Hindi → Hindi in Devanagari. Keep document numbers, tokens, codes and Nexora button names in English. Set "lang" to en, gu or hi accordingly.',
  'Answer ONLY with JSON: {"transcript": string (what the person said, when it came as a recording), "lang": "en"|"gu"|"hi", "answer": string, "steps": [ ... ]}.'
].join('\n');

/** The steps Nexora AI proposed, checked against what was sent. */
export function checkSteps(p, raw) {
  const out = [], dropped = [];
  const planOf = {}; p.plans.forEach((q) => { planOf[q.no.toUpperCase()] = q; });
  const orderOf = {}; p.orders.forEach((q) => { orderOf[q.no.toUpperCase()] = q; });
  const partyOk = {}; p.parties.forEach((q) => { partyOk[q.t] = 1; });
  const itemOk = {}; p.items.forEach((q) => { itemOk[q.t] = 1; });
  const procOf = {}; p.processes.forEach((q) => { procOf[q.code.toUpperCase()] = q; procOf[q.name.toUpperCase()] = q; });
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const x = Number(String(v).replace(/,/g, '')); return isFinite(x) ? Math.round(x * 1000) / 1000 : null; };
  const kgOk = (v) => { const x = num(v); return x !== null && x > 0 && x < 1e7 ? x : null; };
  const plan = (v) => planOf[String(v || '').trim().toUpperCase()] || null;
  const order = (v) => orderOf[String(v || '').trim().toUpperCase()] || null;
  const item = (v) => (itemOk[String(v || '').trim().toUpperCase()] ? String(v).trim().toUpperCase() : null);
  const lines = (a) => list(a, 20).map((l) => {
    const it = item(l && l.item), kg = kgOk(l && l.kg), q2 = num(l && l.qty2);
    if (!it || !kg) { dropped.push('line ' + str(l && l.item, 12)); return null; }
    return { item: it, kg: kg, qty2: q2 !== null && q2 > 0 ? q2 : null };
  }).filter(Boolean);
  list(raw, 12).forEach((s) => {
    const d = s && String(s.do || '').toLowerCase();
    if (d === 'open') { const v = oneOf(s.view, VIEWS, null); if (v && v !== 'plan' && v !== 'porder') out.push({ do: 'open', view: v }); else dropped.push('window ' + str(s.view, 20)); return; }
    if (d === 'find') { const v = oneOf(s.view, VIEWS, null); const t = str(s.text, 60).trim(); if (v && t) out.push({ do: 'find', view: v, text: t }); else dropped.push('find'); return; }
    if (d === 'plan') { const q = plan(s.no); if (q) out.push({ do: 'plan', no: q.no }); else dropped.push('plan ' + str(s.no, 30)); return; }
    if (d === 'order') { const q = order(s.no); if (q) out.push({ do: 'order', no: q.no }); else dropped.push('order ' + str(s.no, 30)); return; }
    if (d === 'trace') { const b = docNo(s.batch).trim(); if (b) out.push({ do: 'trace', batch: b }); else dropped.push('trace'); return; }
    if (d === 'stock') { out.push({ do: 'stock', by: oneOf(s.by, ['item', 'party', 'group', 'warehouse', 'stage'], 'item') }); return; }
    if (d === 'newplan') {
      const party = partyOk[String(s.party || '').trim().toUpperCase()] ? String(s.party).trim().toUpperCase() : null;
      if (s.party && !party) dropped.push('party ' + str(s.party, 12));
      const pr = s.process ? procOf[String(s.process).trim().toUpperCase()] : null;
      out.push({ do: 'newplan', dir: s.dir === 'OUT' ? 'OUT' : 'IN', party: party, lines: lines(s.lines), process: pr ? pr.code : null });
      return;
    }
    if (d === 'receipt') {
      const q = plan(s.plan); if (!q) { dropped.push('receipt ' + str(s.plan, 30)); return; }
      out.push({ do: 'receipt', plan: q.no, lines: lines(s.lines), challan: s.challan ? str(s.challan, 30) : null }); return;
    }
    if (d === 'porder' || d === 'issue' || d === 'production') {
      const q = plan(s.plan); if (!q) { dropped.push(d + ' ' + str(s.plan, 30)); return; }
      const o = s.order ? order(s.order) : null;
      if (s.order && !o) dropped.push('order ' + str(s.order, 30));
      const it = s.item ? item(s.item) : null;
      if (s.item && !it) dropped.push('item ' + str(s.item, 12));
      const kg = kgOk(s.kg), q2 = num(s.qty2);
      const step = { do: d, plan: q.no, item: it, kg: kg, qty2: q2 !== null && q2 > 0 ? q2 : null };
      if (d !== 'porder') step.order = o ? o.no : null;
      if (d === 'issue') step.pick = s.pick === 'FEFO' ? 'FEFO' : 'FIFO';
      out.push(step);
      return;
    }
    if (d === 'qc' || d === 'release' || d === 'invoice') { const q = plan(s.plan); if (q) out.push({ do: d, plan: q.no }); else dropped.push(d + ' ' + str(s.plan, 30)); return; }
    if (d) dropped.push(str(d, 20));
  });
  return { steps: out, dropped: dropped };
}

/* ---- one call to Gemini --------------------------------------------------- */
async function ask(device, system, prompt, fetchImpl) {
  if (!aiConfigured()) return { fail: { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } } };
  const t = take(device);
  if (t.busy) return { fail: { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy — try again in ' + t.busy + ' seconds.' } } };
  if (t.spent) return { fail: { httpStatus: 429, body: { error: 'AI_DAILY', message: 'This computer has used today’s ' + daily() + ' Nexora AI questions. They come back tomorrow.' } } };
  let name = await resolveModel(false, fetchImpl);
  if (!name) return { fail: { httpStatus: 503, body: { error: 'AI_MODEL', message: 'Nexora AI has no model it can use right now.' } } };
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: prompt.contents,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 2048 }
  });
  let r;
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

/** POST /v1/ai/assist */
export async function assist(device, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanAssist(payload);
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!p.text && !m.parts.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say or type something first.' } };
  const ctx = { SCREEN: p.screen, TODAY: p.today, NOW: p.now, PARTIES: p.parties, ITEMS: p.items, GROUPS: p.groups, WAREHOUSES: p.warehouses,
    PROCESSES: p.processes, ROUTES: p.routes, PLANS: p.plans, ORDERS: p.orders, STOCK: p.stock, PENDING: p.pending, HELP_TOPICS: p.topics };
  const contents = [{ role: 'user', parts: [{ text: 'CONTEXT:\n' + JSON.stringify(ctx) }] },
    { role: 'model', parts: [{ text: '{"transcript":"","lang":"en","answer":"Ready.","steps":[]}' }] }];
  p.history.forEach((h) => contents.push({ role: h.role, parts: [{ text: h.text }] }));
  contents.push({ role: 'user', parts: m.parts.concat([{ text: langLine(lang, 'the answer') + (m.audio ? 'The person speaks in the attached recording.' + (p.text ? ' Also typed: ' + p.text : '') : p.text) +
    (m.files ? '\nAlso attached: ' + m.files + ' photo(s)/document(s) — a challan, a slip or a list; read the quantities from them.' : '') }]) });
  const a = await ask(device, SYSTEM, { contents: contents }, fetchImpl);
  if (a.fail) return a.fail;
  const j = a.json || {};
  const checked = checkSteps(p, j.steps);
  const l = String(j.lang || '').toLowerCase();
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, transcript: str(j.transcript, 1200),
    lang: l === 'gu' || l === 'hi' ? l : 'en', answer: str(j.answer, 3000), steps: checked.steps, dropped: checked.dropped } };
}

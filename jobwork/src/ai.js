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
const TIMEOUT_MS = 80000;

/* GEMINI_API_KEY — or the name the dashboard was given (the owner's is
   NEXORA_JOBOWRK): a variable whose name says GEMINI, NEXORA or JOBWORK and
   whose value is shaped like a key (one word, 30+ characters; quotes and
   spaces a paste may bring are taken off). Only the NAME is ever said (on
   /health and in the log), never the value. */
const tidy = (v) => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
const keyShaped = (v) => /^[\w\-.]{30,}$/.test(v);
export function keySource() {
  const env = process.env;
  if (tidy(env.GEMINI_API_KEY)) return 'GEMINI_API_KEY';
  const names = Object.keys(env);
  return names.filter((n) => /GEMINI/i.test(n) && keyShaped(tidy(env[n])))[0]
    || names.filter((n) => /NEXORA|JOB[OW]*[RW]*K/i.test(n) && keyShaped(tidy(env[n])))[0]
    || names.filter((n) => /^AIza[\w\-]{20,}$/.test(tidy(env[n])))[0] || null;
}
/** For the log when nothing was found: each candidate's length only. */
export function keyHint() {
  return Object.keys(process.env).filter((n) => /GEMINI|NEXORA|JOB/i.test(n))
    .map((n) => n + ' (' + tidy(process.env[n]).length + ' characters)').join(', ') || 'none';
}
const key = () => { const n = keySource(); return n ? tidy(process.env[n]) : ''; };
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
  return { configured: aiConfigured(), keyFrom: keySource(), model: model.name, note: model.error || null };
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
  /* no language switch: the language the person used — said with every question, or Gujarati typed in English letters comes back in English */
  return 'Write ' + w + ' in the language the person used — English → English; Gujarati, even typed in English letters ("karo", "che", "mate", "no", "par") → Gujarati in Gujarati script; Hindi → Hindi in Devanagari. Keep document numbers, codes, tokens (P1, I1) and Nexora button names in English.\n';
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
      inKg: nr(q && q.inKg), outKg: nr(q && q.outKg), wasteKg: nr(q && q.wasteKg), balanceKg: nr(q && q.balanceKg), unaccountedKg: nr(q && q.unaccountedKg),
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

/* ---- tables: asked for here, worked out on the person's screen ------------
   "jobwork ma ai mahiti table ne lagti table swarupe aape ane total sathe".
   A figure Nexora AI adds up itself can be wrong; a table the application
   builds from its own book cannot. So for the plant's data Nexora AI asks
   for a TABLE — which data, which filter, grouped by what, which columns —
   and the application computes it, with the names and a total row, on the
   person's screen. Nothing of the result comes back here, so a table may
   even hold money (invoices): Google never sees a rupee of it. */
export const TABLES = {
  stock: { by: ['party', 'item', 'group', 'plan', 'stage', 'warehouse', 'batch', 'class'], show: ['kg', 'qty2', 'batches'] },
  movements: { by: ['date', 'month', 'type', 'dir', 'party', 'item', 'group', 'plan', 'stage', 'warehouse', 'doc', 'batch'], show: ['kgIn', 'kgOut', 'net', 'qty2', 'count'] },
  documents: { by: ['date', 'month', 'type', 'dir', 'doc', 'plan', 'party', 'status'], show: ['count', 'kg', 'lines'] },
  plans: { by: ['plan', 'party', 'dir', 'status', 'stage', 'date', 'month', 'job', 'due'], show: ['count', 'receivedKg', 'addedKg', 'finishedKg', 'inStagesKg', 'unaccountedKg'] },
  orders: { by: ['order', 'plan', 'party', 'item', 'status', 'due', 'stage'], show: ['count', 'plannedKg', 'issuedKg', 'madeKg', 'wasteKg', 'leftKg'] },
  batches: { by: ['batch', 'item', 'group', 'plan', 'party', 'stage', 'warehouse', 'received', 'expiry', 'qc'], show: ['kg', 'count', 'ageDays'] },
  challans: { by: ['challan', 'date', 'month', 'party', 'plan', 'state'], show: ['count', 'sentKg', 'backKg', 'balanceKg', 'daysLeft'] },
  invoices: { by: ['invoice', 'date', 'month', 'party', 'plan', 'status'], show: ['count', 'subtotal', 'tax', 'total'] },
  qc: { by: ['qc', 'date', 'month', 'plan', 'item', 'result', 'batch'], show: ['count', 'kg'] }
};
const WHERE = ['party', 'item', 'group', 'plan', 'order', 'stage', 'warehouse', 'type', 'dir', 'status', 'from', 'to', 'open', 'batch', 'result', 'state', 'class'];
const TABLE_STEP = '{"do":"table","title":short title,"from":' + Object.keys(TABLES).map((k) => '"' + k + '"').join('|') +
  ',"where":{FIELD: value, …},"by":[FIELD, …],"show":[COLUMN, …],"sort":"-COLUMN" or "FIELD","limit":number} — a TABLE worked out by Nexora from its own book, with names and a TOTAL row, shown in the chat. ' +
  'Per "from": ' + Object.keys(TABLES).map((k) => k + ' (by ' + TABLES[k].by.join('/') + '; show ' + TABLES[k].show.join('/') + ')').join('; ') +
  '. "where" may hold ' + WHERE.join(', ') + ' (party a P token, item an I token, plan/order a number, dir IN|OUT, from/to YYYY-MM-DD, open true|false, state overdue|due|ok|closed for challans, result PASS|FAIL|HOLD). ' +
  '"by" empty = one row per record. movements are the ledger rows; their "type" is exactly one of RECEIPT (material received from the party), ISSUE (issued to a stage or sent out), PRODUCTION_RECEIPT (made on the floor), ADD_MATERIAL (our material added), TRANSFER (moved, e.g. released to FG), RETURN (sent back to the party), WASTE, REJECTION — "material receipt" is type RECEIPT, "dispatch" is RETURN; "dir" is the PLAN\u2019s direction (IN inward job work, OUT outward), not in or out of the store — kgIn/kgOut are the quantities in and out. documents are the posted documents (type MATERIAL_RECEIPT, ISSUE, PRODUCTION_RECEIPT, RETURN, TRANSFER…); invoices hold money the person sees and you never do.';

/* ---- the steps ----------------------------------------------------------- */
const STEP_LIST = [
  TABLE_STEP,
  '{"do":"window", …the same fields as a table…} — "window ma aapo", "show it in the window", "open it", "give me that in window": Nexora opens its OWN window for that data (Stock, Jobwork Plans, Production Orders, Challans, Invoices, the customer material ledger…) with the same grouping and filters. Runs by itself. Use it when the person asks for a window; a table in the chat otherwise.',
  '{"do":"open","view":VIEW} — go to a window (VIEW one of ' + VIEWS.filter((v) => v !== 'plan' && v !== 'porder').join('|') + ').',
  '{"do":"find","view":VIEW,"text":words} — open a register and put words in its search (a plan number, a batch, P3, I7…).',
  '{"do":"plan","no":PLAN NO} — open one plan (from PLANS).',
  '{"do":"order","no":ORDER NO} — open one production order (from ORDERS).',
  '{"do":"trace","batch":BATCH NO} — trace a batch backwards and forwards.',
  '{"do":"stock","by":"item"|"party"|"group"|"warehouse"|"stage"} — OPEN the Stock window, grouped: only when the person asks to open or go to that window.',
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
  'You see the window the person is on (SCREEN, NOW) and a summary of THIS plant: parties as tokens P1, P2… with their type, items as tokens I1, I2… with their material group, class (RM raw material, SFG semi-finished, FG finished) and units, open PLANS, production ORDERS, STOCK in kg, PENDING work, processes, routes and warehouses. Write P and I tokens exactly as given (Nexora shows the real names on the person’s screen). You NEVER see — and must never ask for, guess or invent — a party’s name, an item’s name, a rate, a price, an amount or a cost. When the person asks about money (invoice amounts, totals, tax), return an "invoices" table — Nexora works the amounts out on their screen and you never see them; for rates, bills or profit open that window.',
  'BE OPEN. Answer ANYTHING the person asks, as fully as they want it: this plant\u2019s work, job work and GST (job-work challans, ITC-04, section 143, e-way bills), processes and quality (extrusion, weaving, lamination, printing, stitching, yields, waste, QC), planning, how to do something in Nexora, or any general question. The only things you cannot give are a party\u2019s name, an item\u2019s name and money figures — and even those the person gets, because a table is worked out on their screen.',
  'TABLES. Whenever the answer is a list, a comparison or figures from the plant\u2019s data — stock, movements, plans, orders, batches, challans, invoices, QC, "which", "how much", "list", "total", "party wise", "month wise" — return a "table" step (more than one if useful). Nexora works it out EXACTLY from its own book, with the real names and a total row; you do NOT add up or copy figures into "answer" — say in one line what the table shows and what to notice. A table step runs by itself; the person does not press Run. For knowledge that is naturally a table (a comparison, a checklist, a schedule), put it in "tables": [{"title": string, "columns": [string, …], "rows": [[cell, …], …], "total": true|false}] — "total": true only when a column is a quantity to add. NEVER copy the plant\u2019s own figures (stock, kg, plans, orders, invoices) into "tables" — the plant\u2019s data always goes as a table step, and never both.',
  'The summary you are given (PLANS, ORDERS, STOCK, PENDING) is for understanding what the person means; when you are not sure it holds everything, ask for a table.',
  'Never mention tokens to the person: write P3 or I7 where the name goes (Nexora puts the name there), but never words like "token", "P token" or "code P1" — in "answer" and in "tables" alike.',
  'When the person asks for work to be done, return STEPS. Steps allowed: ' + STEP_LIST.join(' '),
  'Steps that make a document (newplan, receipt, porder, issue, production) only FILL the form — the person reads it and presses Post; Nexora checks it then. Use only plan and order numbers from PLANS and ORDERS, and only P and I tokens from PARTIES and ITEMS. Quantities are kg unless the person says the second unit (bags, pieces, rolls → qty2). "1.2 ton" is 1200 kg. Leave out a step the screen shows is already done. When the person corrects you ("no, 900 kg"), return the whole corrected list of steps again.',
  'If something needed is missing (which plan, which item, how much), still return the steps you can and ask for the rest in "answer".',
  'FOLLOW-UPS ON A TABLE stay IN THE CHAT: "group it by material group", "party wise", "only I3", "sort by kg", "add batches", "this month only" about a table already shown means a NEW "table" step (the same "from", with the change) — never an "open" or "stock" step. Open a window only when the person asks to open, go to or show a window — and for data (a table shown, or asked for "in the window") that is a "window" step with the table\u2019s fields, so Nexora opens its own register filtered and grouped the same way.',
  'HOW TO WRITE "answer" (Markdown, it is drawn on the screen): for a figure or a yes/no, one or two lines. For an explanation, a process, a procedure, a rule or a "how do I", write it ELABORATED and STRUCTURED, never one paragraph: "## " headings; numbered steps ("1. ") for anything done in order, each step saying what is done, by whom or at which stage, and where in Nexora (window and button in **bold**); "- " bullets for points; **bold** for key terms and figures; a short "## Checks" or "## Common mistakes" and a "## Tip" where they help. For a plant process (extrusion, weaving, lamination, printing, stitching…) cover: purpose, input and output, the steps, settings/parameters usually watched, typical waste %, quality checks, and how it is recorded in Nexora (which document at which stage). Use a Markdown table (| a | b |) inside "answer" for a small comparison; a big one goes in "tables".',
  'Reply in the SAME language the person used: English → English; Gujarati (in Gujarati script or in English letters) → Gujarati in Gujarati script; Hindi → Hindi in Devanagari. Keep document numbers, tokens, codes and Nexora button names in English; write numbers with the digits 0-9 (1200 kg, never ૧૨૦૦). Set "lang" to en, gu or hi accordingly.',
  'Answer ONLY with JSON: {"transcript": string (what the person said, when it came as a recording), "lang": "en"|"gu"|"hi", "answer": string, "steps": [ ... ], "tables": [ ... ]}.'
].join('\n');

/** A knowledge table in the answer: at most 4, 12 columns, 80 rows; text or numbers only. */
export function cleanTables(a) {
  return list(a, 4).map((t) => {
    const cols = list(t && t.columns, 12).map((c) => str(c, 60));
    if (!cols.length) return null;
    const rows = list(t && t.rows, 80).map((r) => list(r, cols.length).map((c) => (typeof c === 'number' && isFinite(c)) ? c : str(c, 200)));
    return { title: str(t && t.title, 100), columns: cols, rows: rows, total: !!(t && t.total) };
  }).filter(Boolean);
}

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
  list(raw, 14).forEach((s) => {
    const d = s && String(s.do || '').toLowerCase();
    if (d === 'table' || d === 'window') {
      const FROM_ALIAS = { ledger: 'movements', movement: 'movements', receipts: 'movements', issues: 'movements', transactions: 'movements',
        stock_ledger: 'movements', document: 'documents', docs: 'documents', plan: 'plans', order: 'orders', workorders: 'orders', production_orders: 'orders',
        batch: 'batches', challan: 'challans', invoice: 'invoices', bills: 'invoices', qc_tests: 'qc', tests: 'qc', inventory: 'stock', balances: 'stock' };
      const f0 = String(s.from || '').toLowerCase().trim().split(/[^a-z_]/)[0];
      const from = TABLES[f0] ? f0 : (FROM_ALIAS[f0] || null);
      if (!from) { dropped.push('table ' + str(s.from, 20)); return; }
      const T = TABLES[from];
      const where = {};
      const w = s.where && typeof s.where === 'object' ? s.where : {};
      Object.keys(w).forEach((k) => {
        if (WHERE.indexOf(k) < 0) { dropped.push('filter ' + str(k, 20)); return; }
        const v = w[k];
        if (k === 'party') { const t = ptok(String(v || '').toUpperCase()); if (t && partyOk[t]) where.party = t; else dropped.push('party ' + str(v, 12)); return; }
        if (k === 'item') { const t = item(v); if (t) where.item = t; else dropped.push('item ' + str(v, 12)); return; }
        if (k === 'from' || k === 'to') { if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) where[k] = String(v); else dropped.push(k); return; }
        if (k === 'open') { where.open = v === true || v === 'true'; return; }
        if (k === 'dir') { if (v === 'IN' || v === 'OUT') where.dir = v; return; }
        where[k] = str(v, 60).trim();
      });
      const by = list(s.by, 4).filter((f) => T.by.indexOf(f) > -1);
      list(s.by, 4).filter((f) => T.by.indexOf(f) < 0).forEach((f) => dropped.push('group ' + str(f, 20)));
      let show = list(s.show, 8).filter((f) => T.show.indexOf(f) > -1);
      if (!show.length) show = T.show.slice(0, 1);
      const sortKey = String(s.sort || '').replace(/^-/, '');
      const sort = (T.show.indexOf(sortKey) > -1 || T.by.indexOf(sortKey) > -1) ? String(s.sort) : '';
      const lim = Math.round(num(s.limit) || 0);
      out.push({ do: d, title: str(s.title, 80) || from, from: from, where: where, by: by, show: show, sort: sort, limit: lim > 0 && lim <= 500 ? lim : 200 });
      return;
    }
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

/* ---- how long it may think ----------------------------------------------------
   2.0.1 — measured: the same small question took 8 s, then 42 s an hour
   later. The newer Flash-Lite models THINK before they answer, and a longer
   prompt makes them think longer; an assistant on a plant floor wants the
   answer. So the least thinking is asked for (Gemini 3: thinkingLevel low;
   2.5: a budget of 0). A model that does not take the setting says so with
   a 400 and is asked again without it, and remembered. GEMINI_THINKING=off
   leaves the model to itself. */
const noThinking = new Set();
export function thinkingFor(name) {
  if (String(process.env.GEMINI_THINKING || '').toLowerCase() === 'off' || noThinking.has(name)) return null;
  if (/^gemini-[3-9]/.test(name)) return { thinkingLevel: 'low' };
  if (/^gemini-2\.5/.test(name)) return { thinkingBudget: 0 };
  return null;
}
export function _noThinking() { return noThinking; }

/* ---- one call to Gemini --------------------------------------------------- */
async function ask(device, system, prompt, fetchImpl) {
  const t0 = Date.now();
  const done = (out, what) => { console.log('ai ' + what + ' ' + (Date.now() - t0) + ' ms' + (out && out.model ? ' ' + out.model : '')); return out; };
  let r0 = await askOnce(device, system, prompt, fetchImpl);
  /* an answer that could not be read is asked for once more (not counted
     again) — the person should not press Send twice for Google's slip */
  if (r0.fail && r0.fail.body && r0.fail.body.error === 'AI_UNREADABLE') {
    console.log('ai AI_UNREADABLE, asking again');
    r0 = await askOnce(device, system, prompt, fetchImpl, true);
  }
  return done(r0, r0.fail ? (r0.fail.body && r0.fail.body.error) : 'ok');
}

/* 2.0.1 — measured: AI_UNREADABLE in 2 s, twice in ten. A model that
   thinks may send its thought summary as a part of its own ("thought":
   true) beside the answer; joined, they are not JSON. Only the answer's
   parts are read, and if need be only from the first { to the last }. */
export function readJsonAnswer(body) {
  const c = (((body && body.candidates) || [])[0] || {}).content;
  const text = ((c && c.parts) || []).filter((x) => x && !x.thought).map((x) => x.text || '').join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* cut it out below */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
}

async function askOnce(device, system, prompt, fetchImpl, again) {
  if (!aiConfigured()) return { fail: { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } } };
  const t = again ? { left: undefined } : take(device);
  if (t.busy) return { fail: { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy — try again in ' + t.busy + ' seconds.' } } };
  if (t.spent) return { fail: { httpStatus: 429, body: { error: 'AI_DAILY', message: 'This computer has used today’s ' + daily() + ' Nexora AI questions. They come back tomorrow.' } } };
  let name = await resolveModel(false, fetchImpl);
  if (!name) return { fail: { httpStatus: 503, body: { error: 'AI_MODEL', message: 'Nexora AI has no model it can use right now.' } } };
  const payloadFor = (n) => {
    const gc = { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 6144 };
    const th = thinkingFor(n);
    if (th) gc.thinkingConfig = th;
    return JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: prompt.contents, generationConfig: gc });
  };
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', { method: 'POST', body: payloadFor(name) }, fetchImpl);
    } catch (e) {
      return { fail: { httpStatus: 504, body: { error: 'AI_TIMEOUT', message: 'Nexora AI did not answer in time. Try again.' } } };
    }
    const msg = String((r.body && r.body.error && r.body.error.message) || '');
    /* a model that does not take the thinking setting: ask again without it */
    if (r.status === 400 && /think/i.test(msg) && thinkingFor(name) && attempt < 3) { noThinking.add(name); continue; }
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
  const json = readJsonAnswer(r.body);
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
  const tables = cleanTables(j.tables);
  const l = String(j.lang || '').toLowerCase();
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, transcript: str(j.transcript, 1200),
    lang: l === 'gu' || l === 'hi' ? l : 'en', answer: str(j.answer, 9000), steps: checked.steps, dropped: checked.dropped, tables: tables } };
}

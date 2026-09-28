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
/* 2.1.2 — a model Google refused is set aside for an HOUR, not until the next restart */
const BLOCK_MS = 60 * 60 * 1000;
const blockedAt = new Map();                     // model -> when Google refused it
const blocked = {
  has: (n) => { const t = blockedAt.get(n); if (t === undefined) return false; if (Date.now() - t > BLOCK_MS) { blockedAt.delete(n); return false; } return true; },
  add: (n) => { blockedAt.set(n, Date.now()); return blocked; },
  clear: () => blockedAt.clear(),
  get size() { return blockedAt.size; }
};
export function _blocked() { return blocked; }
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

async function gfetch(url, opts, fetchImpl, ms, cancel) {
  const f = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms || TIMEOUT_MS);
  /* 2.1.2 — a question answered by another model stops this one */
  const stop = () => ctrl.abort();
  if (cancel) { if (cancel.aborted) ctrl.abort(); else cancel.addEventListener('abort', stop, { once: true }); }
  try {
    const r = await f(url, Object.assign({}, opts, { signal: ctrl.signal,
      headers: Object.assign({ 'content-type': 'application/json', 'x-goog-api-key': key() }, (opts && opts.headers) || {}) }));
    const text = await r.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text.slice(0, 200) }; }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    /* what kind of failure: our clock ran out, another model answered first, or Google could not be reached */
    const err = (e && typeof e === 'object') ? e : new Error(String(e));
    try { err.nxKind = timedOut ? 'timeout' : (cancel && cancel.aborted) ? 'cancelled' : 'network'; } catch (x) { /* frozen */ }
    throw err;
  } finally { clearTimeout(timer); if (cancel) cancel.removeEventListener('abort', stop); }
}

export async function resolveModel(force, fetchImpl) {
  if (!aiConfigured()) return null;
  if (!force && model.name && Date.now() - model.at < MODEL_TTL_MS) return model.name;
  if (resolving) return resolving;
  resolving = (async () => {
    const wanted = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim().replace(/^models\//, '');
    try {
      const r = await gfetch(API + '/models?pageSize=200', { method: 'GET' }, fetchImpl, 8000);   /* 2.1.2 — a question never waits long on the list */
      if (!r.ok) throw new Error('models list ' + r.status + ': ' + scrub(r.body && r.body.error && r.body.error.message));
      const names = ((r.body && r.body.models) || [])
        .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') > -1)
        .map((m) => String(m.name || '').replace(/^models\//, ''));
      const pick = (names.indexOf(wanted) > -1 && !blocked.has(wanted)) ? wanted : bestOf(names);
      model = { name: pick, at: Date.now(), error: pick ? (pick === wanted ? null : 'asked for ' + wanted + ', using ' + pick) : 'no usable model on this key', available: names };
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
  return { configured: aiConfigured(), keyFrom: keySource(), model: model.name, strong: strongModel(), ear: earModel(), voice: voiceModel(), note: model.error || null, lastAudio: lastAudio, recent: recentCalls.slice(-12) };
}

/* ---- the ear and the voice (2.0.3) ------------------------------------------
   "voice input is not working perfectly, it's not following local language
   properly." Listening was Flash-Lite hearing and answering in one breath.
   Now listening is a call of its own, to the better Flash (not Lite) the key
   has, told the language and asked for nothing but a faithful transcript.
   The voice — the answer read aloud in a conversation — is Gemini's speech
   model when the key has one. GEMINI_AUDIO_MODEL / GEMINI_TTS_MODEL name
   others. */
function flashRank(n) {
  const m = /^gemini-(\d+)(?:\.(\d+))?-flash(?:-(\d{3}))?$/.exec(n);
  return m ? Number(m[1]) * 1000 + Number(m[2] || 0) * 10 + (m[3] ? 0 : 1) : null;
}
/* 2.0.4 — from the weight calculator 4.67.7 ("haju strong generative ai jevu banavo"): the newest
   plain Flash (it reasons before it answers) is asked first, within STRONG_MS; when it is busy,
   slow or refuses, Flash-Lite answers the same question. Not for a voice turn — a person waiting on
   a spoken answer wants it now. GEMINI_MODEL_STRONG names another; "off" keeps Lite for all. */
const STRONG_MS = Math.max(5000, parseInt(process.env.AI_STRONG_MS, 10) || 12000);
/* measured 2026-09-27: the newest Flash answered 429 at once — this key has little free allowance
   for it. A model that says 429 rests fifteen minutes and the next Flash is asked instead. */
const resting = new Map();          // model -> until (ms)
export function _resting() { return resting; }
export function strongModel() {
  const env = String(process.env.GEMINI_MODEL_STRONG || '').trim().replace(/^models\//, '');
  if (env.toLowerCase() === 'off') return null;
  const names = model.available || [];
  const awake = (n) => !(resting.get(n) > Date.now());
  if (env) return names.indexOf(env) > -1 && !blocked.has(env) && awake(env) ? env : null;
  const f = names.filter((n) => !blocked.has(n) && flashRank(n) !== null && awake(n));
  f.sort((a, b) => flashRank(b) - flashRank(a));
  return f[0] || null;
}
export function earModel() {
  const env = String(process.env.GEMINI_AUDIO_MODEL || '').trim();
  if (env) return env;
  const names = (model.available || []).filter((n) => !blocked.has(n) && flashRank(n) !== null);
  names.sort((a, b) => flashRank(b) - flashRank(a));
  return names[0] || model.name;
}
export function voiceModel() {
  const env = String(process.env.GEMINI_TTS_MODEL || '').trim();
  if (env) return env;
  const names = (model.available || []).filter((n) => /tts/i.test(n) && !blocked.has(n));
  names.sort((a, b) => (/flash/.test(b) ? 1 : 0) - (/flash/.test(a) ? 1 : 0) || (b > a ? 1 : -1));
  return names[0] || null;
}
/* listening and speaking count against the minute, not against the day's questions */
function takeMinute() {
  const now = Date.now();
  recent = recent.filter((t) => now - t < 60000);
  if (recent.length >= perMinute() * 2) return { busy: Math.ceil((60000 - (now - recent[0])) / 1000) };
  recent.push(now);
  return {};
}

/* ---- limits ------------------------------------------------------------- */
const perDevice = new Map();         // device -> { day, n }
let recent = [];
const daily = () => Math.max(1, parseInt(process.env.AI_DAILY_PER_DEVICE, 10) || 150);
const perMinute = () => Math.max(1, parseInt(process.env.AI_PER_MINUTE, 10) || 10);
/* 2.1.2 — the day is India's (the plants' own midnight, not 05:30 in the morning) */
function today() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
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
  return 'Write ' + w + ' in the language the person used — English → English; Gujarati, even typed in English letters ("mane", "aapo", "karo", "che", "chhe", "mate", "no", "ni", "par", "batavo", "samjavo", "ketlo", "kya", "shu", "ma", "thi" — these are GUJARATI, not Hindi) → Gujarati in Gujarati script; Hindi → Hindi in Devanagari. Keep document numbers, codes, tokens (P1, I1) and Nexora button names in English.\n';
}
export function pickLang(v) { return v === 'gu' || v === 'hi' || v === 'en' ? v : 'auto'; }

/* ---- what a person may attach: their voice, a photo, a PDF --------------- */
const MEDIA_TYPES = {
  'audio/wav': 1, 'audio/x-wav': 1, 'audio/mp3': 1, 'audio/mpeg': 1, 'audio/ogg': 1, 'audio/flac': 1, 'audio/aac': 1, 'audio/webm': 1,
  'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/heic': 1, 'application/pdf': 1
};
const MAX_MEDIA_B64 = 8 * 1024 * 1024;
/* 2.1.1 — as the weight calculator's service (4.67.13): what a 16-bit WAV holds is measured — its
   seconds and how loud it is. A recording that is all but silent is the microphone's doing, not
   Google's; it is said so, and nothing is planned. Never the sound, never the words, are kept. */
export function wavLevel(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    const rate = buf.readUInt32LE(24), bits = buf.readUInt16LE(34);
    let off = 12, dataAt = -1, dataLen = 0;
    while (off + 8 <= buf.length) { const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4); if (id === 'data') { dataAt = off + 8; dataLen = Math.min(len, buf.length - off - 8); break; } off += 8 + len; }
    if (dataAt < 0 || bits !== 16 || !rate) return null;
    const n = Math.floor(dataLen / 2);
    let sum = 0, peak = 0;
    for (let i = 0; i < n; i++) { const v = buf.readInt16LE(dataAt + i * 2) / 32768; sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    return { seconds: Math.round(n / rate * 10) / 10, rms: n ? Math.round(Math.sqrt(sum / n) * 10000) / 10000 : 0, peak: Math.round(peak * 1000) / 1000 };
  } catch (e) { return null; }
}
let lastAudio = null;
export function audioStatus() { return lastAudio; }
function noteAudio(m, where) {
  lastAudio = { at: new Date().toISOString(), where: where, bytes: m.audioBytes, seconds: m.level ? m.level.seconds : null,
    rms: m.level ? m.level.rms : null, peak: m.level ? m.level.peak : null, transcriptChars: null, verdict: null };
  if (m.level && m.level.peak < 0.01) { lastAudio.verdict = 'silent'; return true; }
  return false;
}
const NOTHING_SAID = {
  silent: { en: 'The recording came through silent — check the microphone (Windows → Settings → Privacy → Microphone), then say it again or type it. Nothing was done.',
    gu: 'રેકોર્ડિંગમાં અવાજ જ નથી આવ્યો — microphone તપાસો (Windows → Settings → Privacy → Microphone), પછી ફરી બોલો કે લખો. કશું કર્યું નથી.',
    hi: 'रिकॉर्डिंग में आवाज़ ही नहीं आई — microphone जाँचें, फिर से बोलें या लिखें। कुछ नहीं किया।' },
  unheard: { en: 'I could not hear that — please say it again, or type it. Nothing was done.',
    gu: 'હું સાંભળી ન શક્યો — ફરી બોલો કે લખો. કશું કર્યું નથી.',
    hi: 'मैं सुन नहीं पाया — फिर से बोलें या लिखें। कुछ नहीं किया।' }
};
function nothingHeard(why, lang) {
  const lg = lang === 'gu' || lang === 'hi' ? lang : 'en';
  return { httpStatus: 200, body: { ok: true, model: null, transcript: '', lang: lg, heard: false, silent: why === 'silent',
    answer: NOTHING_SAID[why][lg], speech: '', speechEn: NOTHING_SAID[why].en, remember: null, forget: [], next: [], run: false, steps: [], dropped: [], tables: [] } };
}
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
  const au = all.filter((m) => /^audio\//.test(String(m && m.mime)))[0];
  return { parts: parts, audio: !!au, files: all.filter((m) => !/^audio\//.test(String(m && m.mime))).length,
    level: au ? wavLevel(au.data) : null, audioBytes: au ? Math.round(String(au.data || '').length * 3 / 4) : 0 };
}

/* ---- what may be sent ---------------------------------------------------- */
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n || 80);
/* 2.0.2 — an answer keeps its lines: the headings, steps and bullets Nexora AI
   writes are lines, and str() above made one paragraph of them all */
const text = (v, n) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, n || 80);
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
const STAGES = ['PLAN', 'RECEIPT', 'PO', 'FLOOR', 'ISSUE', 'PRODUCTION', 'QC', 'RELEASE', 'DISPATCH', 'INVOICE', 'CLOSED'];

export function cleanAssist(p) {
  const x = p && typeof p === 'object' ? p : {};
  const n = x.now && typeof x.now === 'object' ? x.now : {};
  return {
    screen: oneOf(x.screen, VIEWS, 'dashboard'),
    today: /^\d{4}-\d{2}-\d{2}$/.test(String(x.today || '')) ? x.today : today(),
    text: str(x.text, 1200),
    history: list(x.history, 20).map((h) => ({ role: h && h.role === 'model' ? 'model' : 'user', text: text(h && h.text, 2500) })).filter((h) => h.text),
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
    /* 2.0.3 — "what needs somebody" on the dashboard: what the application itself knows is waiting */
    attention: list(x.attention, 80).map((a) => ({ level: oneOf(a && a.level, ['problem', 'warning', 'todo'], 'todo'), what: str(a && a.what, 50),
      plan: docNo(a && a.plan), order: docNo(a && a.order), party: ptok(a && a.party), item: itok(a && a.item), detail: str(a && a.detail, 220),
      kg: nr(a && a.kg), days: nr(a && a.days), who: str(a && a.who, 30) })).filter((a) => a.what),
    /* what the window shows — names as tokens, money taken out, by the application */
    screenText: text(x.screenText, 3500),
    /* 2.0.4 — the person's role and what it may post; the instructions they asked to be kept */
    role: str(x.role, 20), allowed: list(x.allowed, 12).map((a) => str(a, 30)).filter(Boolean),
    rules: list(x.rules, 20).map((r) => str(r, 300)).filter(Boolean),
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
  '{"do":"floor","plan":PLAN NO,"order":ORDER NO or null,"item":I TOKEN or null,"kg":number,"pick":"FIFO"|"FEFO"} — fill a STORE ISSUE TO THE PRODUCTION FLOOR (step 1 of the two-step issue: an internal transfer from the store into the production floor store, nothing consumed).',
  '{"do":"issue","plan":PLAN NO,"order":ORDER NO or null,"item":I TOKEN or null,"kg":number,"pick":"FIFO"|"FEFO"} — fill an ISSUE FOR PRODUCTION (step 2: from the production floor store to the machine — the consumption); the batches are picked FIFO (oldest first) or FEFO (first to expire).',
  '{"do":"return","plan":PLAN NO,"item":I TOKEN or null,"kg":number or null,"pick":"FIFO"|"FEFO"} — fill a RETURN TO THE CUSTOMER on an inward plan (the return challan); with no item and kg it offers all the finished goods. After it posts, Nexora offers to print the challan; every return challan is in Jobwork Challans → Return challans.',
  '{"do":"production","plan":PLAN NO,"order":ORDER NO or null,"item":I TOKEN,"kg":number,"qty2":number or null} — fill a production receipt (what came off the machine).',
  '{"do":"qc","plan":PLAN NO} — open the QC test for a plan.',
  '{"do":"release","plan":PLAN NO} — open Release to FG for a plan (after QC passed).',
  '{"do":"invoice","plan":PLAN NO} — open a job-work invoice for a plan (Nexora puts the rates; you never see them).',
  '{"do":"guide","view":VIEW,"button":the words on a button, tab, field or menu item of that window,"say":one short line} — SHOW the person where to press: Nexora opens that window and points at it, with the line. It runs by itself. EVERY answer to "how do I…", "how to…", "where is…", "show me where", "kevi rite", "kya dabavu", "kaha hai" MUST carry one guide step: the window and the words on the FIRST button to press (e.g. view "porders", button "New").',
  '{"do":"note","text":words} — put a note on the person\u2019s own notes pad (names as P/I tokens; Nexora writes the names).'
];

const SYSTEM = [
  'You are Nexora AI, the assistant inside Nexora Jobwork — software for job work in plastic packaging plants (PP/PE woven sacks, BOPP, lamination, printing, films, bags).',
  'You know job work well. INWARD job work (direction IN): a customer (the principal) sends its own material; the plant receives it (material receipt, their challan), makes a production order, issues material to production, receives what was made (production receipt, batches), tests it (QC), releases it to finished goods, sends it back to the party with a challan, and raises a job-work invoice for the processing. OUTWARD job work (OUT): the plant sends its own material to a job worker on a delivery challan and gets it back processed; under GST the goods must come back within 1 year (capital goods 3 years) and are reported on ITC-04. The plan pipeline is PLAN → RECEIPT → [PO → FLOOR → ISSUE → PRODUCTION] → QC → RELEASE → DISPATCH → INVOICE → CLOSED. THE TWO-STEP ISSUE (on unless the plant turned it off in Settings → Documents): the STORE first issues material to the PRODUCTION FLOOR STORE ("Store issue to floor", an internal transfer — still raw material on the plan, nothing consumed); then "Issue for production" takes it from the floor store to the machine — that is the consumption; the production receipt converts it into output, waste and loss. DISPATCH is the return to the customer on a return challan (Rule 55); every document prints from its row, challans in three copies, and Jobwork Challans has two tabs — Delivery challans (to job workers) and Return challans (to principals). Stock is kept by plan, stage, warehouse and batch; a batch is issued FIFO (oldest first) or FEFO (first to expire); the balance of a plan is what came in minus what went out, used and wasted.',
  'You see the window the person is on (SCREEN, NOW) and a summary of THIS plant: parties as tokens P1, P2… with their type, items as tokens I1, I2… with their material group, class (RM raw material, SFG semi-finished, FG finished) and units, open PLANS, production ORDERS, STOCK in kg, PENDING work, processes, routes and warehouses. Write P and I tokens exactly as given (Nexora shows the real names on the person’s screen). You NEVER see — and must never ask for, guess or invent — a party’s name, an item’s name, a rate, a price, an amount or a cost. When the person asks about money (invoice amounts, totals, tax), return an "invoices" table — Nexora works the amounts out on their screen and you never see them; for rates, bills or profit open that window.',
  'BE OPEN. Answer ANYTHING the person asks, as fully as they want it: this plant\u2019s work, job work and GST (job-work challans, ITC-04, section 143, e-way bills), processes and quality (extrusion, weaving, lamination, printing, stitching, yields, waste, QC), planning, how to do something in Nexora, or any general question. The only things you cannot give are a party\u2019s name, an item\u2019s name and money figures — and even those the person gets, because a table is worked out on their screen.',
  'TABLES. Whenever the answer is a list, a comparison or figures from the plant\u2019s data — stock, movements, plans, orders, batches, challans, invoices, QC, "which", "how much", "list", "total", "party wise", "month wise" — return a "table" step (more than one if useful). Nexora works it out EXACTLY from its own book, with the real names and a total row; you do NOT add up or copy figures into "answer" — say in one line what the table shows and what to notice. A table step runs by itself; the person does not press Run. For knowledge that is naturally a table (a comparison, a checklist, a schedule), put it in "tables": [{"title": string, "columns": [string, …], "rows": [[cell, …], …], "total": true|false}] — "total": true only when a column is a quantity to add. NEVER copy the plant\u2019s own figures (stock, kg, plans, orders, invoices) into "tables" — the plant\u2019s data always goes as a table step, and never both.',
  'The summary you are given (PLANS, ORDERS, STOCK, PENDING) is for understanding what the person means; when you are not sure it holds everything, ask for a table.',
  'ATTENTION is what needs somebody NOW, worked out by Nexora from the book: each open plan\u2019s next step, problems and exceptions, challans near or past the GST limit, QC waiting, batches near expiry, material still to issue on open orders — with level (problem, warning, todo) and who usually does it (stores, production, QC, office). For "what needs attention", "what is pending", "what should I do today", "kone shu karvanu che", "shu baki che", "kya pending hai" answer FROM ATTENTION: problems first, then warnings, then the to-dos, grouped by who does them, each with the plan or order number, what to do and where in Nexora (window and button in bold); offer to fill the first one. If ATTENTION is empty, say nothing is waiting. SCREEN_TEXT is what the person\u2019s window shows (names as tokens, money taken out): use it for questions about "this", "here", "this screen" or "the dashboard".',
  'BE THE EXPERT, EASY AND EXACT: first the result in one line, then the reason; short lines, bullets, numbered steps for anything done in order, **bold** for the key figure; figures only from CONTEXT or a table step, with the working in one line when you work one out.',
  'ROLE and ALLOWED say what this person may post (MANAGER and ADMIN: everything). Never propose a document step for a kind they may not post; say who can (a Supervisor or Manager, or Settings \u2192 Who is posting).',
  'STANDING INSTRUCTIONS: when the person says how things should ALWAYS be done ("from next time\u2026", "always\u2026", "hamesha\u2026", "have thi\u2026", "\u0939\u092e\u0947\u0936\u093e\u2026"), put it in "remember" as one short sentence. RULES are the instructions already given \u2014 follow every one of them, every time. When asked to drop one ("forget \u2026", "no longer \u2026"), put its exact text from RULES in "forget".',
  'NEXT: give "next" \u2014 up to 3 short follow-ups the person is likely to want now, in THEIR language, each a complete request you could do (e.g. "Issue 500 kg FIFO on JW-2026-A-000002", "Group it by month").',
  'RUN BY VOICE: when the person asks to go ahead with the plan already shown and adds nothing new ("run", "run karo", "chalavo", "haa, karo", "kari do", "go ahead", "\u091a\u0932\u093e\u0913", "\u0915\u0930 \u0926\u094b"), answer "run": true with no steps. A spoken question may mishear a number: repeat the figures you understood.',
  'Write every P and I token EXACTLY as given, in Latin letters and digits (P3, I1) — never translated or transliterated (not \u0a86\u0a87 \u0ae7, not \u0906\u0908 1), in "answer", "tables", "speech" and "next" alike.',
  'Never mention tokens to the person: write P3 or I7 where the name goes (Nexora puts the name there), but never words like "token", "P token" or "code P1" — in "answer" and in "tables" alike.',
  'When the person asks for work to be done, return STEPS. Steps allowed: ' + STEP_LIST.join(' '),
  'Steps that make a document (newplan, receipt, porder, issue, production) only FILL the form — the person reads it and presses Post; Nexora checks it then. Use only plan and order numbers from PLANS and ORDERS, and only P and I tokens from PARTIES and ITEMS. Quantities are kg unless the person says the second unit (bags, pieces, rolls → qty2). "1.2 ton" is 1200 kg. Leave out a step the screen shows is already done. When the person corrects you ("no, 900 kg"), return the whole corrected list of steps again.',
  'If something needed is missing (which plan, which item, how much), still return the steps you can and ask for the rest in "answer".',
  'FOLLOW-UPS ON A TABLE stay IN THE CHAT: "group it by material group", "party wise", "only I3", "sort by kg", "add batches", "this month only" about a table already shown means a NEW "table" step (the same "from", with the change) — never an "open" or "stock" step. Open a window only when the person asks to open, go to or show a window — and for data (a table shown, or asked for "in the window") that is a "window" step with the table\u2019s fields, so Nexora opens its own register filtered and grouped the same way.',
  'HOW TO WRITE "answer" (Markdown, it is drawn on the screen): for a figure or a yes/no, one or two lines. For an explanation, a process, a procedure, a rule or a "how do I", write it ELABORATED and STRUCTURED, never one paragraph: "## " headings; numbered steps ("1. ", with the digits 0-9 — never ૧ ૨ ૩ or १ २ ३, in headings too) for anything done in order, each step saying what is done, by whom or at which stage, and where in Nexora (window and button in **bold**); "- " bullets for points; **bold** for key terms and figures; a short "## Checks" or "## Common mistakes" and a "## Tip" where they help. For a plant process (extrusion, weaving, lamination, printing, stitching…) cover: purpose, input and output, the steps, settings/parameters usually watched, typical waste %, quality checks, and how it is recorded in Nexora (which document at which stage). Use a Markdown table (| a | b |) inside "answer" for a small comparison; a big one goes in "tables".',
  'Reply in the SAME language the person used: English → English; Gujarati (in Gujarati script or in English letters) → Gujarati in Gujarati script; Hindi → Hindi in Devanagari. Keep document numbers, tokens, codes and Nexora button names in English; write numbers with the digits 0-9 (1200 kg, never ૧૨૦૦). Set "lang" to en, gu or hi accordingly.',
  'When VOICE is true the person is TALKING with you and will HEAR "speech": put in "speech" what to say aloud — two to four short spoken sentences in the person\u2019s language, no Markdown, no symbols, numbers said plainly, a table only summed up ("the table is on your screen"); and, when that language is not English, the same in simple English in "speechEn". "answer" still carries the full written answer. End "speech" with a short follow-up question only when one is natural.',
  'Answer ONLY with JSON: {"transcript": string (what the person said, when it came as a recording), "lang": "en"|"gu"|"hi", "answer": string, "speech": string (only when VOICE), "speechEn": string (only when VOICE and not English), "steps": [ ... ], "tables": [ ... ], "remember": string or null, "forget": [string], "next": [string], "run": true|false}.'
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
    if (d === 'porder' || d === 'issue' || d === 'production' || d === 'floor' || d === 'return') {
      const q = plan(s.plan); if (!q) { dropped.push(d + ' ' + str(s.plan, 30)); return; }
      const o = s.order ? order(s.order) : null;
      if (s.order && !o) dropped.push('order ' + str(s.order, 30));
      const it = s.item ? item(s.item) : null;
      if (s.item && !it) dropped.push('item ' + str(s.item, 12));
      const kg = kgOk(s.kg), q2 = num(s.qty2);
      const step = { do: d, plan: q.no, item: it, kg: kg, qty2: q2 !== null && q2 > 0 ? q2 : null };
      if (d !== 'porder' && d !== 'return') step.order = o ? o.no : null;
      if (d === 'issue' || d === 'floor' || d === 'return') step.pick = s.pick === 'FEFO' ? 'FEFO' : 'FIFO';
      out.push(step);
      return;
    }
    if (d === 'guide') {
      const v = oneOf(s.view, VIEWS, null);
      const b = str(s.button, 60).trim();
      if (v && v !== 'plan' && v !== 'porder') out.push({ do: 'guide', view: v, button: b, say: str(s.say, 200) });
      else dropped.push('guide ' + str(s.view, 20));
      return;
    }
    if (d === 'note') { const tx = str(s.text, 500).trim(); if (tx) out.push({ do: 'note', text: tx }); else dropped.push('note'); return; }
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
/* 2.1.2 — as the weight calculator's service 4.67.17 ("didnt got answered" there: Google's free
   Flash-Lite answered one question in 20 s and not the next in 60 s). Now:
   - a question has DEADLINE in all (the application waits 120 s), whatever is tried inside it;
   - a question the usual model has not answered in HEDGE is ALSO asked of a second model the key lists
     (another Flash-Lite, else a Flash that is not resting); the first answer wins and the other is
     stopped. A busy (429), overloaded (5xx), unreachable, retired or unreadable model hands over at once;
   - "did not answer in time" means Google was slow; "could not reach Google" is its own message;
   - a question Google did not answer is not counted against the device's day;
   - every call is noted (when, which question, which model, how long, how it ended, tokens — never what
     was asked or answered) for /health, and on Render in the log. */
let deadlineMs = 100000;
export function _setDeadline(ms) { deadlineMs = ms; }
let hedgeMs = 15000;
export function _setHedge(ms) { hedgeMs = ms; }
const recentCalls = [];
export function aiRecent() { return recentCalls.slice(); }
function noteCall(rec) {
  recentCalls.push(rec);
  while (recentCalls.length > 25) recentCalls.shift();
  if (process.env.RENDER) {
    try { console.log('ai ' + rec.kind + ' ' + rec.model + ' ' + rec.outcome + (rec.status ? ' ' + rec.status : '') + ' ' + rec.ms + ' ms' +
      (rec.inTok ? ' in=' + rec.inTok : '') + (rec.outTok ? ' out=' + rec.outTok : '') + (rec.thinkTok ? ' think=' + rec.thinkTok : '') + (rec.code ? ' ' + rec.code : '')); } catch (e) { /* no log */ }
  }
}
function errCode(e) {
  const c = e && e.cause;
  return String((c && (c.code || c.name)) || (e && (e.code || e.name)) || 'error');
}
/** The request for one model: Gemini 3 keeps its own temperature (Google: below 1.0 it may loop), the
    older ones 0.2; the least thinking (thinkingFor); room for 8192 tokens (Gujarati and Hindi need many). */
export function payloadFor(base, name) {
  const g = Object.assign({}, base.generationConfig);
  const v = /^gemini-(\d+)/.exec(String(name || ''));
  if (!v || Number(v[1]) < 3) g.temperature = 0.2;
  const th = thinkingFor(name);
  if (th) g.thinkingConfig = th;
  return JSON.stringify(Object.assign({}, base, { generationConfig: g }));
}
/** One model, asked once (twice when it refuses the thinking setting). → {ok:true, json, name} or {ok:false, why, status, r, name, named} */
async function tryModel(name, base, fetchImpl, ms, kind, cancel) {
  const t0 = Date.now();
  let r = null;
  for (let pass = 0; pass < 2; pass++) {
    const rec = { at: new Date().toISOString(), kind: kind, model: name };
    const ts = Date.now();
    try {
      r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', { method: 'POST', body: payloadFor(base, name) }, fetchImpl, Math.max(1000, ms - (Date.now() - t0)), cancel);
    } catch (e) {
      rec.ms = Date.now() - ts; rec.outcome = (e && e.nxKind) || 'network'; rec.code = scrub(errCode(e)).slice(0, 60);
      noteCall(rec);
      return { ok: false, why: rec.outcome, name: name };
    }
    rec.ms = Date.now() - ts; rec.status = r.status;
    const cand = ((r.body && r.body.candidates) || [])[0] || {};
    const use = (r.body && r.body.usageMetadata) || {};
    if (cand.finishReason) rec.finish = String(cand.finishReason).slice(0, 30);
    if (use.promptTokenCount) rec.inTok = use.promptTokenCount;
    if (use.candidatesTokenCount) rec.outTok = use.candidatesTokenCount;
    if (use.thoughtsTokenCount) rec.thinkTok = use.thoughtsTokenCount;
    const msg = String((r.body && r.body.error && r.body.error.message) || '');
    /* a model that does not take the thinking setting: asked again without it, and remembered */
    if (r.status === 400 && /think/i.test(msg) && thinkingFor(name) && pass === 0) { rec.outcome = 'no-thinking'; noteCall(rec); noThinking.add(name); continue; }
    if (!r.ok) {
      /* only a 404 or "no longer available" retires a model — a 400 about a file type is not its fault */
      const gone = r.status === 404 || /no longer available|deprecated/i.test(msg);
      rec.outcome = gone ? 'retired' : r.status === 429 ? 'busy' : 'http';
      rec.code = scrub(msg).slice(0, 80);
      noteCall(rec);
      if (gone) blocked.add(name);
      const named = gone ? ((msg.match(/models\/(gemini-[\w.\-]+)/g) || []).map((x) => x.replace(/^models\//, '')).filter((n) => n !== name && !blocked.has(n))[0] || null) : null;
      return { ok: false, why: rec.outcome, status: r.status, r: r, name: name, named: named };
    }
    const json = readJsonAnswer(r.body);
    const refused = (r.body && r.body.promptFeedback && r.body.promptFeedback.blockReason) ||
      (/^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION)$/.test(rec.finish || '') ? rec.finish : null);
    rec.outcome = json ? 'ok' : refused ? 'refused' : 'unreadable';
    if (refused && !json) rec.code = String(refused).slice(0, 30);
    noteCall(rec);
    if (!json && refused) return { ok: false, why: 'refused', status: r.status, r: r, name: name };
    if (!json) return { ok: false, why: 'unreadable', status: r.status, r: r, name: name, finish: rec.finish };
    return { ok: true, json: json, name: name };
  }
  return { ok: false, why: 'http', status: r ? r.status : 0, r: r, name: name };
}
/** Every model a question may go to, in order: the usual one, the other Flash-Lites (newest first), then the
    Flashes (newest first). 4.67.17 — measured live 22:05: every model said 503 "high demand" except
    gemini-3.6-flash, which the retry never reached (it went round two models only). Now it goes down the list. */
export function candidatesOf(first, names, skip) {
  const not = [first].concat(skip || []);
  const pool = (names || []).filter((n) => not.indexOf(n) < 0 && !blocked.has(n) && rankOf(n) !== null);
  const lites = pool.filter((n) => /flash-lite(?:-\d{3})?$/.test(n)).sort((a, b) => rankOf(b) - rankOf(a));
  const flashes = pool.filter((n) => /-flash(?:-\d{3})?$/.test(n) && !(resting.get(n) > Date.now())).sort((a, b) => flashRank(b) - flashRank(a));
  return [first].concat(lites, flashes);
}
/** The second model for a slow or failing question. */
export function backupOf(name, names, skip) { return candidatesOf(name, names, skip)[1] || null; }
/* 4.67.17 / 2.1.2 — measured live 2026-09-28 21:14: Google answered 503 "This model is currently experiencing
   high demand" for 3.8-flash, 3.5-flash-lite AND 3.1-flash-lite within seconds of each other; a question a
   minute later went through. So a question goes down the list of models; when all have said busy or
   overloaded and time is left, it waits a moment (1.5 s, 3 s, 4.5 s …) and goes round them again, at most
   MAX_TRIES asks in all. */
const MAX_TRIES = 10;
let retryPause = 1500;
export function _setRetryPause(ms) { retryPause = ms; }
const retryable = (res) => res && (res.why === 'busy' || res.why === 'network' || res.why === 'unreadable' || res.why === 'retired' || (res.why === 'http' && res.status >= 500));
const handsOver = (res) => res.why === 'timeout' || res.why === 'network' || res.why === 'busy' || res.why === 'retired' || res.why === 'unreadable' ||
  (res.why === 'http' && res.status >= 500);
/** The usual model, and — when it is slow or fails — the next one down the list; the first answer wins. */
function race(first, payload, fetchImpl, kind, deadline, skip) {
  return new Promise((resolve) => {
    let done = false, running = 0, last = null, tries = 0, round = 0, timer = null;
    const order = candidatesOf(first, model.available || [], skip);
    let nextAt = 1;                              /* the next model down the list this round */
    const ctrls = [];
    const left = () => deadline - Date.now();
    const finish = (res) => {
      if (done) return;
      done = true; clearTimeout(timer);
      ctrls.forEach((c) => { try { c.abort(); } catch (e) { /* gone */ } });
      resolve(res);
    };
    /* the next model to ask — one Google named (a retired model's successor) goes first */
    const pickNext = (prefer) => {
      if (prefer && !blocked.has(prefer)) {
        const at = order.indexOf(prefer);
        if (at < 0) order.splice(nextAt, 0, prefer);
        else if (at > nextAt) { order.splice(at, 1); order.splice(nextAt, 0, prefer); }
      }
      while (nextAt < order.length && blocked.has(order[nextAt])) nextAt++;
      return nextAt < order.length ? order[nextAt++] : null;
    };
    const askNext = (prefer) => {
      if (done || tries >= MAX_TRIES || left() < 8000) return false;
      const next = pickNext(prefer);
      if (!next) return false;
      run(next);
      return true;
    };
    /* nothing is running and nothing has answered: the next model at once; all asked — a pause, and round again */
    const again = (prefer) => {
      if (done) return;
      if (tries >= MAX_TRIES || left() < 10000 || !retryable(last)) { finish(last); return; }
      if (askNext(prefer)) return;
      round++;
      nextAt = 0;
      setTimeout(() => { if (!done && !askNext(null)) finish(last); }, Math.min(retryPause * round, 6000));
    };
    const run = (name) => {
      running++; tries++;
      const c = new AbortController(); ctrls.push(c);
      tryModel(name, payload, fetchImpl, Math.max(1000, left()), kind + (name === first ? '' : '/backup'), c.signal).then((res) => {
        running--;
        if (done) return;
        if (res.ok) { finish(res); return; }
        /* what is said when nothing answers: the usual model's failure, unless it was only retired */
        if (!last || (name === first && res.why !== 'retired') || last.why === 'retired') last = res;
        if (!running) { if (handsOver(res)) again(res.named); else finish(last); }
      });
    };
    /* slow, not failed: the next model is asked beside it */
    timer = setTimeout(() => { if (!done && running && tries === 1) askNext(null); }, hedgeMs);
    run(first);
  });
}
/* a question Google did not answer is given back to the device's day */
function giveBack(device) {
  const c = perDevice.get(String(device || 'none'));
  if (c && c.day === today() && c.n > 0) c.n--;
}
async function ask(device, system, prompt, fetchImpl, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const done = (out, what) => { console.log('ai ' + what + ' ' + (Date.now() - t0) + ' ms' + (out && out.model ? ' ' + out.model : '')); return out; };
  if (!aiConfigured()) return { fail: { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } } };
  const t = take(device);
  if (t.busy) return { fail: { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy — try again in ' + t.busy + ' seconds.' } } };
  if (t.spent) return { fail: { httpStatus: 429, body: { error: 'AI_DAILY', message: 'This computer has used today’s ' + daily() + ' Nexora AI questions. They come back tomorrow.' } } };
  const deadline = Date.now() + deadlineMs;
  const name = await resolveModel(false, fetchImpl);
  if (!name) { giveBack(device); return { fail: { httpStatus: 503, body: { error: 'AI_MODEL', message: 'Nexora AI has no model it can use right now.' } } }; }
  const kind = opts.kind || 'assist';
  const base = { systemInstruction: { parts: [{ text: system }] }, contents: prompt.contents, generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 } };
  /* the stronger model first, within its budget; the usual one answers when it cannot */
  const strong = opts.strong ? strongModel() : null;
  if (strong && strong !== name) {
    const rs = await tryModel(strong, base, fetchImpl, Math.min(STRONG_MS, deadline - Date.now() - 20000), kind + '/strong');
    if (rs.ok) return done({ json: rs.json, model: strong, left: t.left }, 'ok');
    /* busy, out of allowance or out of time: it rests, so the next question does not wait on it again */
    if (rs.why !== 'http' || rs.status >= 500) resting.set(strong, Date.now() + 15 * 60 * 1000);
  }
  const res = await race(name, base, fetchImpl, kind, deadline, strong ? [strong] : []);
  if (res.ok) {
    if (blocked.has(name) && res.name !== name) model = Object.assign({}, model, { name: res.name, at: Date.now(), error: 'switched to ' + res.name + ' (Google retired the one before)' });
    return done({ json: res.json, model: res.name, left: t.left }, 'ok');
  }
  if (res.why !== 'refused' && !(res.why === 'http' && res.status < 500)) giveBack(device);
  const fail = (httpStatus, error, message, extra) => done({ fail: { httpStatus: httpStatus, body: Object.assign({ error: error, message: message }, extra || {}) } }, error);
  if (res.why === 'refused') return fail(422, 'AI_REFUSED', 'Google declined to answer that question — put it another way.');
  if (res.why === 'timeout' || res.why === 'cancelled') return fail(504, 'AI_TIMEOUT', 'Nexora AI did not answer in time — Google was slow just now. Try again.');
  if (res.why === 'network') return fail(502, 'AI_UNREACHABLE', 'Nexora AI could not reach Google just now. Try again in a moment.');
  if (res.why === 'http' && res.status >= 500) return fail(503, 'AI_OVERLOADED', 'Google’s AI is overloaded just now (it says “high demand”) — Nexora AI asked it several times. Try again in a minute.', { retryAfter: 60 });
  if (res.why === 'unreadable') return fail(502, 'AI_UNREADABLE', res.finish === 'MAX_TOKENS' ? 'Nexora AI’s answer ran too long and was cut off. Ask a narrower question.' : 'Nexora AI answered in a form Nexora could not read. Try again.');
  if (res.why === 'busy') return fail(429, 'AI_BUSY', 'Nexora AI is busy (Google’s limit) — try again in a minute.', { retryAfter: 60 });
  return fail(502, 'AI_FAILED', 'Nexora AI could not answer (' + res.status + '): ' + scrub(res.r && res.r.body && res.r.body.error && res.r.body.error.message));
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

/* ---- POST /v1/ai/transcribe — what the person said, faithfully ---------------- */
const EAR_SYSTEM = 'You are the ear of Nexora Jobwork, software for job work in plastic packaging plants (woven sacks, BOPP, lamination, printing, stitching). ' +
  'Write down EXACTLY what the person says in the recording — do not answer it, do not shorten it, do not translate it. ' +
  'Gujarati speech in Gujarati script, Hindi in Devanagari, English in English. People here mix English trade words into Gujarati and Hindi: keep those in English letters as they are spoken — stock, plan, receipt, issue, production order, batch, challan, invoice, QC, release, kg, ton, FIFO, FEFO, lamination, extrusion, weaving, printing, stitching, BOPP, GSM, and plan or order numbers (JW-2026-A-000002). ' +
  'Numbers with the digits 0-9 ("બારસો" → 1200). Names of companies and materials as heard. If nothing is said, text is "". ' +
  'Answer ONLY with JSON: {"text": string, "lang": "gu"|"hi"|"en"}.';
export async function transcribe(device, payload, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!m.audio) return { httpStatus: 400, body: { error: 'NOTHING', message: 'No recording came.' } };
  if (noteAudio(m, 'ear')) return { httpStatus: 200, body: { ok: true, model: null, text: '', lang: 'en', silent: true } };
  const t = takeMinute();
  if (t.busy) return { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy \u2014 try again in ' + t.busy + ' seconds.' } };
  await resolveModel(false, fetchImpl);
  const lang = payload && ['gu', 'hi', 'en'].indexOf(payload.lang) > -1 ? payload.lang : 'auto';
  const said = { gu: 'The person speaks GUJARATI (with English trade words).', hi: 'The person speaks HINDI (with English trade words).', en: 'The person speaks ENGLISH (Indian accent).', auto: 'The person may speak Gujarati, Hindi or English, often mixed.' }[lang];
  const hints = list(payload && payload.hints, 60).map((h) => str(h, 40)).filter(Boolean);
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: EAR_SYSTEM }] },
    contents: [{ role: 'user', parts: m.parts.concat([{ text: said + (hints.length ? ' Words used in this plant: ' + hints.join(', ') + '.' : '') }]) }],
    generationConfig: Object.assign({ temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1024 }, thinkingFor(earModel()) ? { thinkingConfig: thinkingFor(earModel()) } : {}) });
  const t0 = Date.now();
  /* 2.0.3 — measured on the same sentence: Flash-Lite heard it exactly in 2.5-3 s, Flash in 20 s.
     The dedicated prompt is what hears better; Lite is the ear, Flash the careful ear when asked for. */
  let name = (payload && payload.model && (model.available || []).indexOf(String(payload.model)) > -1) ? String(payload.model)
    : (payload && payload.careful ? earModel() : (model.name || earModel()));
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', { method: 'POST', body: attempt && !thinkingFor(name) ? body.replace(/,"thinkingConfig":\{[^}]*\}/, '') : body }, fetchImpl); }
    catch (e) { return e && e.nxKind === 'network' ? { httpStatus: 502, body: { error: 'AI_UNREACHABLE', message: 'Nexora AI could not reach Google just now. Try again in a moment.' } }
      : { httpStatus: 504, body: { error: 'AI_TIMEOUT', message: 'Nexora AI did not hear it in time. Try again.' } }; }
    const msg = String((r.body && r.body.error && r.body.error.message) || '');
    if (r.status === 400 && /think/i.test(msg)) { noThinking.add(name); continue; }
    if (!r.ok && (r.status === 404 || /no longer available|not found|not supported/i.test(msg)) && name !== model.name) { name = model.name; continue; }
    /* 2.0.3 — measured: the Flash models answered 503 (Google overloaded) for minutes at a time; Lite still hears */
    if (!r.ok && (r.status === 503 || r.status === 500 || r.status === 429) && name !== model.name) { name = model.name; continue; }
    if (!r.ok && (r.status === 503 || r.status === 500) && name === model.name && earModel() !== name && attempt === 0) { name = earModel(); continue; }
    break;
  }
  console.log('ai ear ' + (r && r.ok ? 'ok' : r && r.status) + ' ' + (Date.now() - t0) + ' ms ' + name);
  if (!r.ok) return { httpStatus: r.status === 429 ? 429 : 502, body: { error: r.status === 429 ? 'AI_BUSY' : 'AI_FAILED', message: r.status === 429 ? 'Nexora AI is busy (Google\u2019s limit) \u2014 try again in a minute.' : 'Nexora AI could not hear it (' + r.status + ').' } };
  const j = readJsonAnswer(r.body) || {};
  const l = String(j.lang || '').toLowerCase();
  const heardText = text(j.text, 1500).trim();
  if (lastAudio) { lastAudio.transcriptChars = heardText.length; lastAudio.verdict = heardText.length < 2 ? 'no-words' : 'heard'; }
  return { httpStatus: 200, body: { ok: true, model: name, text: heardText, lang: l === 'gu' || l === 'hi' ? l : 'en' } };
}

/* ---- POST /v1/ai/speak — the answer read aloud (a WAV) -------------------------- */
function wavOf(pcmB64, rate) {
  const pcm = Buffer.from(pcmB64, 'base64');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString('base64');
}
export async function speak(device, payload, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const words = str(payload && payload.text, 900).trim();
  if (!words) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Nothing to say.' } };
  await resolveModel(false, fetchImpl);
  const name = voiceModel();
  if (!name) return { httpStatus: 501, body: { error: 'NO_VOICE', message: 'This Gemini key has no speech model.' } };
  const t = takeMinute();
  if (t.busy) return { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: t.busy, message: 'Nexora AI is busy.' } };
  const lang = payload && ['gu', 'hi', 'en'].indexOf(payload.lang) > -1 ? payload.lang : 'en';
  const how = { gu: 'Say this in Gujarati, warmly and clearly, at an easy pace: ', hi: 'Say this in Hindi, warmly and clearly, at an easy pace: ', en: 'Say this in Indian English, warmly and clearly: ' }[lang];
  const t0 = Date.now();
  let r;
  try {
    r = await gfetch(API + '/models/' + encodeURIComponent(name) + ':generateContent', { method: 'POST', body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: (payload && payload.plain) || process.env.GEMINI_VOICE_PLAIN || lang !== 'en' ? words : how + words }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: Object.assign({ voiceConfig: { prebuiltVoiceConfig: { voiceName: String(process.env.GEMINI_VOICE || 'Kore') } } }, payload && /^[a-z]{2}-[A-Z]{2}$/.test(String(payload.languageCode || '')) ? { languageCode: payload.languageCode } : {}) } }) }, fetchImpl);
  } catch (e) { return { httpStatus: 504, body: { error: 'AI_TIMEOUT', message: 'The voice did not come in time.' } }; }
  console.log('ai voice ' + (r.ok ? 'ok' : r.status) + ' ' + (Date.now() - t0) + ' ms ' + name);
  if (r.status === 429) return { httpStatus: 429, body: { error: 'AI_BUSY', retryAfter: 600, message: 'The voice has used Google’s allowance for now.' } };
  if (!r.ok) return { httpStatus: 502, body: { error: 'AI_FAILED', message: 'The voice could not be made (' + r.status + '): ' + scrub(r.body && r.body.error && r.body.error.message) } };
  const part = ((((r.body && r.body.candidates) || [])[0] || {}).content || {}).parts;
  const data = ((part || []).filter((p) => p && p.inlineData)[0] || {}).inlineData;
  if (!data || !data.data) return { httpStatus: 502, body: { error: 'AI_FAILED', message: 'The voice came back empty.' } };
  const rate = Number((/rate=(\d+)/.exec(String(data.mimeType || '')) || [])[1]) || 24000;
  const wav = /wav/i.test(String(data.mimeType)) ? data.data : wavOf(data.data, rate);
  return { httpStatus: 200, body: { ok: true, mime: 'audio/wav', data: wav } };
}

/** POST /v1/ai/assist */
export async function assist(device, payload, lang, fetchImpl) {
  if (!aiConfigured()) return { httpStatus: 503, body: { error: 'AI_OFF', message: 'Nexora AI is not switched on at the service yet.' } };
  const p = cleanAssist(payload);
  const m = mediaParts(payload);
  if (m.error) return m.error;
  if (!p.text && !m.parts.length) return { httpStatus: 400, body: { error: 'NOTHING', message: 'Say or type something first.' } };
  if (m.audio && noteAudio(m, 'assist') && !p.text) return nothingHeard('silent', lang);
  const ctx = { SCREEN: p.screen, ROLE: p.role, ALLOWED: p.allowed, RULES: p.rules, SCREEN_TEXT: p.screenText, ATTENTION: p.attention, TODAY: p.today, VOICE: !!(payload && payload.voice), NOW: p.now, PARTIES: p.parties, ITEMS: p.items, GROUPS: p.groups, WAREHOUSES: p.warehouses,
    PROCESSES: p.processes, ROUTES: p.routes, PLANS: p.plans, ORDERS: p.orders, STOCK: p.stock, PENDING: p.pending, HELP_TOPICS: p.topics };
  const contents = [{ role: 'user', parts: [{ text: 'CONTEXT:\n' + JSON.stringify(ctx) }] },
    { role: 'model', parts: [{ text: '{"transcript":"","lang":"en","answer":"Ready.","steps":[]}' }] }];
  p.history.forEach((h) => contents.push({ role: h.role, parts: [{ text: h.text }] }));
  contents.push({ role: 'user', parts: m.parts.concat([{ text: langLine(lang, 'the answer') + (m.audio ? 'The person speaks in the attached recording.' + (p.text ? ' Also typed: ' + p.text : '') : p.text) +
    (m.files ? '\nAlso attached: ' + m.files + ' photo(s)/document(s) — a challan, a slip or a list; read the quantities from them.' : '') }]) });
  const a = await ask(device, SYSTEM, { contents: contents }, fetchImpl, { strong: !(payload && payload.voice), kind: m.audio ? 'assist/voice' : 'assist' });
  if (a.fail) return a.fail;
  const j = a.json || {};
  if (m.audio && lastAudio) lastAudio.transcriptChars = String(j.transcript || '').trim().length;
  /* spoken, and no words came back: nothing is planned on a guess from the conversation before */
  if (m.audio && !p.text && String(j.transcript || '').trim().length < 2) { if (lastAudio) lastAudio.verdict = 'no-words'; return nothingHeard('unheard', lang); }
  if (m.audio && lastAudio) lastAudio.verdict = 'heard';
  const checked = checkSteps(p, j.steps);
  /* 2.0.4 — seen live: asked for stock by material group, the model sent the worked-out table AND one of its
     own, typed from the summary, with a different total (3,456.75 against the book's 3,904.75). Where the book
     answers, only the book answers: a typed table goes only with an answer that has no table from the book. */
  const fromBook = checked.steps.some((x) => x.do === 'table' || x.do === 'window');
  const tables = fromBook ? [] : cleanTables(j.tables);
  const l = String(j.lang || '').toLowerCase();
  return { httpStatus: 200, body: { ok: true, model: a.model, left: a.left, transcript: str(j.transcript, 1200),
    lang: l === 'gu' || l === 'hi' ? l : 'en', answer: text(j.answer, 9000), speech: str(j.speech, 1200), speechEn: str(j.speechEn, 1200), remember: j.remember ? str(j.remember, 300) : null,
    forget: list(j.forget, 5).map((f) => str(f, 300)).filter(Boolean), next: list(j.next, 3).map((q) => str(q, 120)).filter(Boolean),
    run: j.run === true && !checked.steps.filter((x) => x.do !== 'table' && x.do !== 'window' && x.do !== 'guide').length, steps: checked.steps, dropped: checked.dropped, tables: tables } };
}

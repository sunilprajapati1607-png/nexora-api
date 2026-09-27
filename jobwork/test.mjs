/* Nexora Jobwork AI service — tests with a fake Google.
   The fake records every request body, so the test can prove that a
   party's name, an item's name and money never leave this service. */
import assert from 'node:assert/strict';
import { handle } from './server.js';
import { _resting, strongModel, _blocked as _blockedSet, cleanAssist, checkSteps, cleanTables, _resetLimits, resolveModel, thinkingFor, _noThinking, readJsonAnswer, earModel, voiceModel } from './src/ai.js';

let pass = 0;
process.env.GEMINI_MODEL_STRONG = 'off';
const _blockedReset = () => { try { _blockedSet().clear(); } catch (e) {} };
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n', e); process.exitCode = 1; } };

const sent = [];
function fakeGoogle(answer, opts) {
  opts = opts || {};
  return async (url, init) => {
    sent.push({ url: String(url), body: init && init.body ? String(init.body) : '', headers: init && init.headers });
    if (/\/models\?/.test(url)) return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
    if (opts.retire && /gemini-3\.5-flash-lite:/.test(url)) return new Response(JSON.stringify({ error: { message: 'models/gemini-3.5-flash-lite is no longer available, use models/gemini-3.5-flash' } }), { status: 404 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }), { status: 200 });
  };
}

/* a tiny req/res pair for handle() */
function call(method, url, body, fetchImpl) {
  return new Promise((resolve) => {
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const listeners = {};
    const req = { method, url, headers: {}, on: (ev, fn) => { listeners[ev] = fn; } };
    const res = { status: 0, headers: {}, writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { resolve({ status: this.status, headers: this.headers, json: b ? JSON.parse(b) : null }); } };
    handle(req, res, fetchImpl);
    setImmediate(() => { if (listeners.data && data) listeners.data(Buffer.from(data)); if (listeners.end) listeners.end(); });
  });
}

const PAYLOAD = {
  screen: 'plans', today: '2026-09-26', text: 'Receive 1200 kg of I2 on JW-IN/0007 for P1',
  parties: [{ t: 'P1', type: 'CUSTOMER', name: 'Shakti Polymers' }, { t: 'Shakti Polymers', type: 'CUSTOMER' }],
  items: [{ t: 'I2', group: 'PP granule', cls: 'RM', uom: 'KG', name: 'Reliance H030SG raffia' }, { t: 'Reliance', group: 'x' }],
  plans: [{ no: 'JW-IN/0007', dir: 'IN', party: 'P1', partyName: 'Shakti Polymers', status: 'OPEN', stage: 'RECEIPT', inKg: 0, rate: 12.5, amount: 15000, items: ['I2', 'Reliance H030SG'] }],
  orders: [{ no: 'PO-0003', plan: 'JW-IN/0007', item: 'I2', plannedKg: 900, cost: 4000 }],
  stock: [{ item: 'I2', party: 'P1', kg: 300, value: 36000, rate: 120 }],
  pending: { qcWaiting: 2, invoiceValue: 99999 },
  now: { plan: 'JW-IN/0007', customer: 'Shakti Polymers' },
  invoices: [{ amount: 55555 }]
};

await t('health says AI off without a key', async () => {
  delete process.env.GEMINI_API_KEY;
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.service, 'nexora-jobwork-api');
  assert.equal(r.json.ai.configured, false);
  assert.equal(r.headers['access-control-allow-origin'], '*');
});

await t('assist without a key: AI_OFF, and Google is never called', async () => {
  sent.length = 0;
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-12345678', assist: PAYLOAD }, fakeGoogle({}));
  assert.equal(r.status, 503); assert.equal(r.json.error, 'AI_OFF'); assert.equal(sent.length, 0);
});

process.env.GEMINI_API_KEY = 'test-key-not-real-0123456789';

await t('OPTIONS answers CORS', async () => {
  const r = await call('OPTIONS', '/v1/ai/assist');
  assert.equal(r.status, 204);
});

await t('a request with no device id is refused', async () => {
  const r = await call('POST', '/v1/ai/assist', { assist: PAYLOAD }, fakeGoogle({}));
  assert.equal(r.status, 400); assert.equal(r.json.error, 'DEVICE');
});

await t('NO NAMES, NO MONEY: what reaches Google', async () => {
  sent.length = 0; _resetLimits();
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-12345678', assist: PAYLOAD },
    fakeGoogle({ lang: 'en', answer: 'Filled the receipt.', steps: [{ do: 'receipt', plan: 'JW-IN/0007', lines: [{ item: 'I2', kg: 1200 }] }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = sent.filter((s) => /generateContent/.test(s.url));
  assert.equal(g.length, 1);
  /* what Gemini reads: every text part, unescaped */
  const req = JSON.parse(g[0].body);
  const body = req.contents.map((c) => c.parts.map((x) => x.text || '').join('\n')).join('\n');
  assert.ok(body.indexOf('CONTEXT:') > -1);
  ['Shakti', 'Reliance', 'H030SG', '12.5', '15000', '36000', '4000', '99999', '55555', '"amount":', '"rate":', '"value":', '"cost":', '"partyName":', '"customer":', '"invoices"', '"invoiceValue"', '"name":', 'test-key-not-real'].forEach((w) => {
    assert.ok(body.indexOf(w) < 0, 'sent to Google: ' + w);
  });
  assert.ok(body.indexOf('JW-IN/0007') > -1 && body.indexOf('"P1"') > -1 && body.indexOf('"I2"') > -1 && body.indexOf('PP granule') > -1);
  /* the key goes in the header only */
  assert.equal(g[0].headers['x-goog-api-key'], 'test-key-not-real-0123456789');
  assert.ok(g[0].url.indexOf('test-key') < 0);
  assert.deepEqual(r.json.steps, [{ do: 'receipt', plan: 'JW-IN/0007', lines: [{ item: 'I2', kg: 1200, qty2: null }], challan: null }]);
});

await t('the newest Flash-Lite is chosen', async () => {
  const name = await resolveModel(true, fakeGoogle({}));
  assert.equal(name, 'gemini-3.5-flash-lite');
});

await t('a retired model is replaced by the one Google names, in the same request', async () => {
  _resetLimits();
  await resolveModel(true, fakeGoogle({}));
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-12345678', assist: { text: 'hello' } }, fakeGoogle({ lang: 'en', answer: 'Hi', steps: [] }, { retire: true }));
  assert.equal(r.status, 200); assert.equal(r.json.model, 'gemini-3.5-flash');
});

await t('steps are checked: unknown plans, tokens and windows are dropped', async () => {
  const p = cleanAssist(PAYLOAD);
  const c = checkSteps(p, [
    { do: 'open', view: 'stock' }, { do: 'open', view: 'hack' },
    { do: 'plan', no: 'JW-IN/9999' }, { do: 'plan', no: 'jw-in/0007' },
    { do: 'issue', plan: 'JW-IN/0007', order: 'PO-0003', item: 'I2', kg: '900', pick: 'FEFO' },
    { do: 'newplan', dir: 'OUT', party: 'Shakti Polymers', lines: [{ item: 'I2', kg: 50 }, { item: 'I99', kg: 5 }] },
    { do: 'delete', what: 'everything' }
  ]);
  assert.deepEqual(c.steps.map((s) => s.do), ['open', 'plan', 'issue', 'newplan']);
  assert.equal(c.steps[1].no, 'JW-IN/0007');
  assert.deepEqual(c.steps[2], { do: 'issue', plan: 'JW-IN/0007', item: 'I2', kg: 900, qty2: null, order: 'PO-0003', pick: 'FEFO' });
  assert.equal(c.steps[3].party, null);
  assert.equal(c.steps[3].lines.length, 1);
  assert.ok(c.dropped.indexOf('delete') > -1 && c.dropped.some((d) => /plan JW-IN\/9999/.test(d)));
});

await t('limits: per device a day, then tomorrow', async () => {
  _resetLimits();
  process.env.AI_DAILY_PER_DEVICE = '2'; process.env.AI_PER_MINUTE = '50';
  const f = fakeGoogle({ lang: 'en', answer: 'ok', steps: [] });
  const a = await call('POST', '/v1/ai/assist', { device: 'dev-aaaaaaaa', assist: { text: 'x' } }, f);
  const b = await call('POST', '/v1/ai/assist', { device: 'dev-aaaaaaaa', assist: { text: 'x' } }, f);
  const c = await call('POST', '/v1/ai/assist', { device: 'dev-aaaaaaaa', assist: { text: 'x' } }, f);
  const d = await call('POST', '/v1/ai/assist', { device: 'dev-bbbbbbbb', assist: { text: 'x' } }, f);
  assert.deepEqual([a.status, b.status, c.status, d.status], [200, 200, 429, 200]);
  assert.equal(c.json.error, 'AI_DAILY');
  delete process.env.AI_DAILY_PER_DEVICE; delete process.env.AI_PER_MINUTE;
});

await t('a recording goes as audio; a wrong file type is refused', async () => {
  _resetLimits(); sent.length = 0;
  const ok = await call('POST', '/v1/ai/assist', { device: 'dev-12345678', assist: { audio: { mime: 'audio/webm;codecs=opus', data: 'AAAA' } } }, fakeGoogle({ lang: 'gu', transcript: 'x', answer: 'y', steps: [] }));
  assert.equal(ok.status, 200); assert.equal(ok.json.lang, 'gu');
  assert.ok(sent.some((s) => /inlineData/.test(s.body) && /audio\/webm/.test(s.body)));
  const bad = await call('POST', '/v1/ai/assist', { device: 'dev-12345678', assist: { attachments: [{ mime: 'application/x-msdownload', data: 'AAAA' }] } }, fakeGoogle({}));
  assert.equal(bad.status, 400);
});

await t('Gujarati asked for by name is said to Gemini', async () => {
  _resetLimits(); sent.length = 0;
  await call('POST', '/v1/ai/assist', { device: 'dev-12345678', lang: 'gu', assist: { text: 'stock ketlo che' } }, fakeGoogle({ lang: 'gu', answer: 'a', steps: [] }));
  assert.ok(sent.some((s) => /in Gujarati \(Gujarati script\)/.test(s.body)));
});

await t('a table step: known data, known fields, tokens only', async () => {
  const p = cleanAssist(PAYLOAD);
  const c = checkSteps(p, [
    { do: 'table', title: 'Stock party wise', from: 'stock', where: { party: 'P1', item: 'Reliance', from: '2026-09-01', rate: 5 }, by: ['party', 'item', 'price'], show: ['kg', 'amount'], sort: '-kg', limit: 9999 },
    { do: 'table', from: 'salaries' },
    { do: 'table', from: 'invoices', by: ['month'], show: ['total'] }
  ]);
  assert.equal(c.steps.length, 2);
  assert.deepEqual(c.steps[0], { do: 'table', title: 'Stock party wise', from: 'stock', where: { party: 'P1', from: '2026-09-01' }, by: ['party', 'item'], show: ['kg'], sort: '-kg', limit: 200 });
  assert.deepEqual(c.steps[1].show, ['total']);
  ['item Reliance', 'filter rate', 'group price', 'table salaries'].forEach((d) => assert.ok(c.dropped.indexOf(d) > -1, d));
});

await t('knowledge tables are cut to size and hold only text and numbers', async () => {
  const t2 = cleanTables([{ title: 'ITC-04', columns: ['What', 'When'], rows: [['Goods sent', 'Quarterly'], [{ x: 1 }, 5, 'extra']], total: false }, { columns: [] }]);
  assert.equal(t2.length, 1);
  assert.deepEqual(t2[0].rows[1], ['[object Object]', 5]);
});

await t('least thinking is asked for; a model that refuses it is asked again without', async () => {
  assert.deepEqual(thinkingFor('gemini-3.5-flash-lite'), { thinkingLevel: 'low' });
  assert.deepEqual(thinkingFor('gemini-2.5-flash-lite'), { thinkingBudget: 0 });
  _resetLimits(); _noThinking().clear(); sent.length = 0;
  await resolveModel(true, fakeGoogle({}));
  let n = 0;
  const refuse = async (url, init) => {
    sent.push({ url: String(url), body: String((init && init.body) || '') });
    if (/generateContent/.test(url) && /thinkingConfig/.test(String(init.body)) && ++n) return new Response(JSON.stringify({ error: { message: 'Unknown name thinkingLevel: Cannot find field.' } }), { status: 400 });
    return fakeGoogle({ lang: 'en', answer: 'ok', steps: [] })(url, init);
  };
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-12345678', assist: { text: 'hi' } }, refuse);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = sent.filter((s) => /generateContent/.test(s.url));
  assert.equal(n, 1); assert.ok(/thinkingConfig/.test(g[0].body) && !/thinkingConfig/.test(g[g.length - 1].body));
  assert.equal(thinkingFor(r.json.model), null);
  _noThinking().clear();
});

await t('the answer is read without the thought parts, and cut from { to }', async () => {
  const j = readJsonAnswer({ candidates: [{ content: { parts: [{ thought: true, text: 'Thinking about stock...' }, { text: '{\"answer\":\"ok\",\"steps\":[]}' }] } }] });
  assert.deepEqual(j, { answer: 'ok', steps: [] });
  assert.deepEqual(readJsonAnswer({ candidates: [{ content: { parts: [{ text: 'Here: {\"a\":1} done' }] } }] }), { a: 1 });
  assert.equal(readJsonAnswer({ candidates: [{ content: { parts: [{ text: 'no json' }] } }] }), null);
});

await t('an unreadable answer is asked for once more, counted once', async () => {
  _resetLimits(); sent.length = 0;
  await resolveModel(true, fakeGoogle({}));
  let calls = 0;
  const flaky = async (url, init) => {
    if (/generateContent/.test(url) && ++calls === 1) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] }), { status: 200 });
    return fakeGoogle({ lang: 'en', answer: 'second time', steps: [] })(url, init);
  };
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-flaky001', assist: { text: 'hi' } }, flaky);
  assert.equal(r.status, 200); assert.equal(r.json.answer, 'second time'); assert.equal(calls, 2);
});

await t('a window step is checked like a table and keeps its kind', async () => {
  const p = cleanAssist(PAYLOAD);
  const c = checkSteps(p, [{ do: 'window', title: 'Stock by group', from: 'stock', where: { party: 'P1', cost: 5 }, by: ['group'], show: ['kg'] }]);
  assert.deepEqual(c.steps, [{ do: 'window', title: 'Stock by group', from: 'stock', where: { party: 'P1' }, by: ['group'], show: ['kg'], sort: '', limit: 200 }]);
  assert.ok(c.dropped.indexOf('filter cost') > -1);
});

await t('an answer keeps its lines (headings, steps, bullets)', async () => {
  _resetLimits();
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-lines0001', assist: { text: 'explain' } },
    fakeGoogle({ lang: 'en', answer: '## Lamination\n\n1. Unwind\n2. Coat\n\n- **GSM** checked\u0007', steps: [] }));
  assert.equal(r.json.answer, '## Lamination\n\n1. Unwind\n2. Coat\n\n- **GSM** checked ');
});

await t('the ear is the better Flash, the voice the speech model the key has', async () => {
  _blockedReset();
  await resolveModel(true, fakeGoogle({}));
  assert.equal(earModel(), 'gemini-3.5-flash');
  assert.equal(voiceModel(), 'gemini-2.5-flash-preview-tts');
});

await t('transcribe: the recording goes to the ear, with the language said; the day is not counted', async () => {
  _resetLimits(); sent.length = 0;
  process.env.AI_DAILY_PER_DEVICE = '1';
  const f = fakeGoogle({ text: 'JW-2026-A-000002 પર 1200 kg receipt કરો', lang: 'gu' });
  const r = await call('POST', '/v1/ai/transcribe', { device: 'dev-ear00001', lang: 'gu', hints: ['LAMINATION'], audio: { mime: 'audio/wav', data: 'AAAA' } }, f);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.text, 'JW-2026-A-000002 પર 1200 kg receipt કરો'); assert.equal(r.json.lang, 'gu');
  const g = sent.filter((x) => /generateContent/.test(x.url)).pop();
  assert.ok(/gemini-3\.5-flash-lite:generateContent/.test(g.url));
  assert.ok(/speaks GUJARATI/.test(g.body) && /LAMINATION/.test(g.body) && /audio\/wav/.test(g.body));
  /* the question after it is still allowed: listening did not use the day's one */
  const a = await call('POST', '/v1/ai/assist', { device: 'dev-ear00001', assist: { text: 'hi' } }, fakeGoogle({ lang: 'en', answer: 'ok', steps: [] }));
  assert.equal(a.status, 200);
  delete process.env.AI_DAILY_PER_DEVICE;
});

await t('speak: a WAV from the speech model', async () => {
  _resetLimits();
  const tts = async (url, init) => {
    if (/tts:generateContent/.test(url)) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.from([0, 0, 1, 0]).toString('base64') } }] } }] }), { status: 200 });
    return fakeGoogle({})(url, init);
  };
  const r = await call('POST', '/v1/ai/speak', { device: 'dev-voice001', text: 'Stock is 3904 kg.', lang: 'en' }, tts);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const wav = Buffer.from(r.json.data, 'base64');
  assert.equal(wav.slice(0, 4).toString(), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.length, 48);
});

await t('a spoken answer comes when the person talks', async () => {
  _resetLimits(); sent.length = 0;
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-voice002', assist: { text: 'stock ketlo che', voice: true } },
    fakeGoogle({ lang: 'gu', answer: '## Stock\n- 3904 kg', speech: 'કુલ સ્ટોક 3904 kg છે.', steps: [] }));
  assert.equal(r.json.speech, 'કુલ સ્ટોક 3904 kg છે.');
  assert.ok(sent.some((x) => { try { return JSON.parse(x.body).contents[0].parts[0].text.indexOf('"VOICE":true') > -1; } catch (e) { return false; } }));
});

await t('what needs somebody: the attention list and the screen go, cleaned', async () => {
  const p = cleanAssist({ attention: [{ level: 'problem', what: 'Challan past the limit', plan: 'JW-1', party: 'P1', detail: 'sent 400 kg, 12 days over', kg: 400, days: -12, who: 'office', amount: 9999 },
    { level: 'odd', what: 'QC waiting', party: 'Shakti Polymers' }], screenText: 'Open plans 5\nWaiting for QC 2' });
  assert.deepEqual(p.attention[0], { level: 'problem', what: 'Challan past the limit', plan: 'JW-1', order: '', party: 'P1', item: null, detail: 'sent 400 kg, 12 days over', kg: 400, days: -12, who: 'office' });
  assert.equal(p.attention[1].level, 'todo'); assert.equal(p.attention[1].party, null);
  assert.equal(p.screenText, 'Open plans 5\nWaiting for QC 2');
});

await t('the ear: a busy Flash (503) hands the recording to Lite', async () => {
  _resetLimits(); _blockedReset(); sent.length = 0;
  await resolveModel(true, fakeGoogle({}));
  const busy = async (url, init) => {
    if (/gemini-3\.5-flash:generateContent/.test(url)) { sent.push({ url: String(url), body: '' }); return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 }); }
    return fakeGoogle({ text: 'stock ketlo che', lang: 'gu' })(url, init);
  };
  const r = await call('POST', '/v1/ai/transcribe', { device: 'dev-ear00002', lang: 'gu', careful: true, audio: { mime: 'audio/wav', data: 'AAAA' } }, busy);
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.model, 'gemini-3.5-flash-lite'); assert.equal(r.json.text, 'stock ketlo che');
});

await t('the stronger model answers first; when it is busy, Lite answers the same question; a voice turn goes to Lite', async () => {
  delete process.env.GEMINI_MODEL_STRONG;
  _resetLimits(); _blockedReset(); sent.length = 0;
  await resolveModel(true, fakeGoogle({}));
  assert.equal(strongModel(), 'gemini-3.5-flash');
  const ok = await call('POST', '/v1/ai/assist', { device: 'dev-strong01', assist: { text: 'why is my yield low' } }, fakeGoogle({ lang: 'en', answer: 'strong', steps: [] }));
  assert.equal(ok.json.model, 'gemini-3.5-flash');
  const busy = async (url, init) => /gemini-3\.5-flash:generateContent/.test(url) ? new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 }) : fakeGoogle({ lang: 'en', answer: 'lite', steps: [] })(url, init);
  const fb = await call('POST', '/v1/ai/assist', { device: 'dev-strong02', assist: { text: 'why' } }, busy);
  assert.equal(fb.json.model, 'gemini-3.5-flash-lite'); assert.equal(fb.json.answer, 'lite');
  sent.length = 0;
  const v = await call('POST', '/v1/ai/assist', { device: 'dev-strong03', assist: { text: 'stock', voice: true } }, fakeGoogle({ lang: 'en', answer: 'x', speech: 'x', steps: [] }));
  assert.equal(v.json.model, 'gemini-3.5-flash-lite');
  assert.ok(!sent.some((x) => /gemini-3\.5-flash:generateContent/.test(x.url)));
  process.env.GEMINI_MODEL_STRONG = 'off';
});

await t('remember, forget, next and run come back; guide and note are checked', async () => {
  _resetLimits();
  const r = await call('POST', '/v1/ai/assist', { device: 'dev-rules001', assist: { text: 'hamesha FEFO', rules: ['Always FIFO'], role: 'OPERATOR', allowed: ['ISSUE'] } },
    fakeGoogle({ lang: 'gu', answer: 'ok', remember: 'Always issue FEFO.', forget: ['Always FIFO'], next: ['a', 'b', 'c', 'd'], run: false,
      steps: [{ do: 'guide', view: 'plans', button: 'New', say: 'Press New' }, { do: 'guide', view: 'nowhere' }, { do: 'note', text: 'call P1' }] }));
  assert.equal(r.json.remember, 'Always issue FEFO.'); assert.deepEqual(r.json.forget, ['Always FIFO']); assert.equal(r.json.next.length, 3);
  assert.deepEqual(r.json.steps, [{ do: 'guide', view: 'plans', button: 'New', say: 'Press New' }, { do: 'note', text: 'call P1' }]);
  const run = await call('POST', '/v1/ai/assist', { device: 'dev-rules002', assist: { text: 'run karo' } }, fakeGoogle({ lang: 'gu', answer: 'ok', run: true, steps: [] }));
  assert.equal(run.json.run, true);
});

await t('a strong model that says 429 rests, and the next Flash is asked', async () => {
  delete process.env.GEMINI_MODEL_STRONG;
  _resetLimits(); _blockedReset(); _resting().clear();
  const list = async (url, init) => {
    if (/\/models\?/.test(url)) return new Response(JSON.stringify({ models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }), { status: 200 });
    if (/gemini-3\.8-flash:generateContent/.test(url)) return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
    return fakeGoogle({ lang: 'en', answer: 'from ' + url.replace(/.*models\/|:generateContent/g, ''), steps: [] })(url, init);
  };
  await resolveModel(true, list);
  assert.equal(strongModel(), 'gemini-3.8-flash');
  const a = await call('POST', '/v1/ai/assist', { device: 'dev-rest0001', assist: { text: 'why' } }, list);
  assert.equal(a.json.model, 'gemini-3.5-flash-lite');
  assert.equal(strongModel(), 'gemini-3.5-flash');
  const b = await call('POST', '/v1/ai/assist', { device: 'dev-rest0002', assist: { text: 'why' } }, list);
  assert.equal(b.json.model, 'gemini-3.5-flash');
  _resting().clear(); process.env.GEMINI_MODEL_STRONG = 'off';
  await resolveModel(true, fakeGoogle({}));
});

console.log(pass + ' passed');

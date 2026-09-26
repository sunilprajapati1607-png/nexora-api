/* Nexora Jobwork AI service — tests with a fake Google.
   The fake records every request body, so the test can prove that a
   party's name, an item's name and money never leave this service. */
import assert from 'node:assert/strict';
import { handle } from './server.js';
import { cleanAssist, checkSteps, cleanTables, _resetLimits, resolveModel, thinkingFor, _noThinking, readJsonAnswer } from './src/ai.js';

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n', e); process.exitCode = 1; } };

const sent = [];
function fakeGoogle(answer, opts) {
  opts = opts || {};
  return async (url, init) => {
    sent.push({ url: String(url), body: init && init.body ? String(init.body) : '', headers: init && init.headers });
    if (/\/models\?/.test(url)) return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
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

console.log(pass + ' passed');

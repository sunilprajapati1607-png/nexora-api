/**
 * Nexora Jobwork — Nexora AI service (Render web service "nexora-jobwork-api")
 * ============================================================================
 *   "software ne render server per navo project banavi ne connect kro, aema
 *    gemini ai inbuilt thase, same as bag weight calculation."
 *
 * A service of its own, beside the weight calculator's nexora-api, so the
 * two products never share a limit, a deploy or a failure. No database, no
 * dependencies: it only carries a question from Nexora Jobwork to Google
 * Gemini and a checked answer back.
 *
 *   GET  /health          — alive, and whether Nexora AI is switched on
 *   POST /v1/ai/assist    — { assist, lang, device } → answer + steps to Run
 *
 * The Gemini key is GEMINI_API_KEY in this service's Render environment and
 * nowhere else. Jobwork has no licence and no sign-in, so the limits are
 * per installation (the random device id the application keeps), see ai.js.
 */
import { createServer } from 'node:http';
import { assist, aiStatus, pickLang, keySource } from './src/ai.js';

const PORT = process.env.PORT || 3000;
const MAX_BODY = 12 * 1024 * 1024;           /* a minute of speech or a few photos, as base64 */
const VERSION = '1.0.0';

const CORS = {
  /* the application runs from file:// (desktop) or its own origin (PWA):
     nothing here is behind a cookie, so any origin may ask */
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-nexora-device',
  'access-control-max-age': '86400'
};

function send(res, status, body) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS));
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { over = true; return; } chunks.push(c); });
    req.on('end', () => {
      if (over) return resolve({ __big: true });
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({ __bad: true }); }
    });
    req.on('error', () => resolve({ __bad: true }));
  });
}

export async function handle(req, res, fetchImpl) {
  const path = String(req.url || '/').split('?')[0];
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if ((path === '/' || path === '/health') && (method === 'GET' || method === 'HEAD')) {
    return send(res, 200, { ok: true, service: 'nexora-jobwork-api', version: VERSION, ai: aiStatus() });
  }
  if (path === '/v1/ai/assist' && method === 'POST') {
    const body = await readJson(req);
    if (body.__big) return send(res, 413, { error: 'MEDIA_BIG', message: 'That is too much to send at once — a minute of speech, or a few photos.' });
    if (body.__bad) return send(res, 400, { error: 'BAD_JSON', message: 'Nexora AI could not read that request.' });
    const device = String(body.device || req.headers['x-nexora-device'] || '').replace(/[^\w\-]/g, '').slice(0, 64);
    if (device.length < 8) return send(res, 400, { error: 'DEVICE', message: 'This installation has no id yet. Restart Nexora Jobwork and try again.' });
    const out = await assist(device, body.assist, pickLang(body.lang), fetchImpl);
    return send(res, out.httpStatus, out.body);
  }
  return send(res, 404, { error: 'NOT_FOUND', message: 'Nothing here.' });
}

/* started directly (not imported by the test) */
if (process.argv[1] && /server\.js$/.test(process.argv[1])) {
  createServer((req, res) => {
    handle(req, res).catch(() => {
      try { send(res, 500, { error: 'SERVER_ERROR', message: 'Nexora AI could not complete that request. Your work is safe on this computer; try again shortly.' }); } catch (e) { /* gone */ }
    });
  }).listen(PORT, () => { if (!keySource()) console.log('Environment names that might hold the key: ' + (Object.keys(process.env).filter((n) => /GEMINI|KEY|JOBWORK|NEXORA|API/i.test(n)).join(', ') || 'none')); console.log('Nexora Jobwork AI listening on ' + PORT + ' — AI ' + (keySource() ? 'on (key from ' + keySource() + ')' : 'OFF (no GEMINI_API_KEY)')); });
}

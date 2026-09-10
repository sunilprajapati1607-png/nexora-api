/**
 * Nexora API — full harness, run against a real Postgres.
 *
 * Every assertion here is a claim the product makes to a paying customer,
 * so each one is checked against the actual service, not a mock:
 *   the clock cannot be reset by reinstalling
 *   a token cannot be edited to grant itself a licence
 *   an expired trial cannot calculate, and says so readably
 *   the owner can extend, licence and revoke, and it takes effect at once
 */
process.env.DATABASE_URL = 'postgresql://nexora_app:test@127.0.0.1:5432/nexora?sslmode=disable';
process.env.NEXORA_TOKEN_SECRET = 'test-secret-abc';
process.env.NEXORA_ADMIN_KEY = 'test-admin-key';
const app = (await import('./src/index.js')).default;

let pass = 0, fail = 0;
const ok = (l, c, got) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (c ? '' : '   got: ' + JSON.stringify(got))); c ? pass++ : fail++; };
const call = async (path, opts = {}) => {
  const r = await app.fetch(new Request('https://x' + path, {
    method: opts.method || 'GET', headers: opts.headers || {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }));
  let b; try { b = await r.json(); } catch (e) { b = 'HTML/text'; }
  return { status: r.status, body: b };
};
const J = { 'content-type': 'application/json' };
const AK = { 'x-admin-key': 'test-admin-key', 'content-type': 'application/json' };
const DEV = 'a1b2c3d4e5f60718';

console.log('HEALTH / schema bootstrap');
let r = await call('/health');
ok('health ok, schema created on demand', r.status === 200 && r.body.ok, r.body);

console.log('\nACTIVATION');
r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: DEV, deviceName: 'SUNIL-SAP', company: 'Nexora Demo Plant', email: 'a@b.com', appVersion: '1.4.0' } });
ok('activates', r.status === 200 && !!r.body.token, r.body);
ok('starts on TRIAL', r.body.licence.state === 'TRIAL', r.body.licence);
ok('7 days left', r.body.licence.daysLeft === 7, r.body.licence.daysLeft);
ok('can calculate', r.body.licence.canCalculate === true, r.body.licence);
ok('not a returning device', r.body.returning === false, r.body.returning);
const TOKEN = r.body.token;
const firstExpiry = r.body.licence.expiresAt;

console.log('\nTHE REINSTALL RULE');
await new Promise((s) => setTimeout(s, 1100));
r = await call('/v1/activate', { method: 'POST', headers: J, body: { deviceId: DEV, company: 'Nexora Demo Plant', appVersion: '1.4.0' } });
ok('re-activating is recognised as returning', r.body.returning === true, r.body.returning);
ok('*** the clock is NOT reset ***', r.body.licence.expiresAt === firstExpiry, { was: firstExpiry, now: r.body.licence.expiresAt });

console.log('\nBAD INPUT');
r = await call('/v1/activate', { method: 'POST', headers: J, body: { deviceId: 'nope' } });
ok('a junk device id is refused', r.status === 400 && r.body.error === 'BAD_DEVICE_ID', r.body);

console.log('\nAUTH');
r = await call('/v1/bom', { method: 'POST', headers: J, body: {} });
ok('no token -> 401', r.status === 401, r.status);
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer tampered.sig' }, body: {} });
ok('forged token -> 401', r.status === 401, r.status);
const evil = Buffer.from(JSON.stringify({ d: DEV, s: 'LICENSED', x: 9e9, e: 9e9 })).toString('base64url');
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + evil + '.' + TOKEN.split('.')[1] }, body: {} });
ok('*** an edited payload with the old signature -> 401 ***', r.status === 401, r.status);

console.log('\nTHE ENGINE, THROUGH THE GATE');
const payload = {
  bags: 10000, bagWeightG: 100, basis: 'KG',
  steps: [{ p: 'TAPE' }, { p: 'WEAV' }, { p: 'LAM' }],
  sections: {
    '0|TAPE': { wastePct: 1, lines: [{ rm: 'PP', basis: 'PCT', value: 100 }] },
    '1|WEAV': { wastePct: 1, lines: [{ src: 'SFG', sfgStep: 0, basis: 'PCT', value: 100 }] },
    '2|LAM': { wastePct: 1, lines: [{ src: 'SFG', sfgStep: 1, basis: 'PCT', value: 80 }, { rm: 'LD', basis: 'PCT', value: 20 }] }
  },
  masters: { rates: { PP: 134, LD: 64.37 }, names: { PP: 'PP', LD: 'LD' }, procRates: { TAPE: 9, WEAV: 6, LAM: 5 },
    procNames: { TAPE: 'Tape', WEAV: 'Weaving', LAM: 'Lamination' }, groups: { PP: 'GRANULE', LD: 'GRANULE' } },
  view: { mode: 'EACH', value: 1000 }, components: []
};
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOKEN }, body: payload });
ok('costs the route', r.status === 200 && r.body.result && r.body.result.ok, r.body.error || r.body);
ok('returns a total', r.body.result.totals.totalCost > 0, r.body.result && r.body.result.totals);
ok('returns the reconciliation, matching', !!r.body.reconcile && r.body.reconcile.check.matches === true, r.body.reconcile && r.body.reconcile.check);
ok('returns the per-stage view', !!r.body.view && r.body.view.mode === 'EACH', r.body.view && r.body.view.mode);
ok('per-kg cost invariant held', r.body.view.invariant.costPerKgUnchanged === true, r.body.view && r.body.view.invariant);
ok('licence rides along with the answer', r.body.licence.state === 'TRIAL', r.body.licence);
const TOTAL = r.body.result.totals.totalCost;

console.log('\nADMIN');
r = await call('/admin');
ok('console page serves', r.status === 200, r.status);
r = await call('/admin/api/licences');
ok('admin api needs the key', r.status === 401, r.status);
r = await call('/admin/api/licences', { headers: AK });
ok('lists the installation', r.status === 200 && r.body.licences.length === 1, r.body);
ok('shows days left', r.body.licences[0].days_left === 7, r.body.licences[0] && r.body.licences[0].days_left);
ok('carries settings', r.body.settings.trialDays === 7 && r.body.settings.expiredMode === 'READONLY', r.body.settings);

console.log('\nEXPIRY — the whole point');
const { q } = await import('./src/db.js');
await q(`UPDATE licences SET expires_at = now() - interval '1 hour' WHERE device_id=$1`, [DEV]);
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOKEN }, body: payload });
ok('*** an expired trial cannot calculate -> 402 ***', r.status === 402, r.status);
ok('and says why, readably', /trial has ended/i.test(r.body.message || ''), r.body.message);
ok('and reports READONLY mode', r.body.licence.mode === 'READONLY', r.body.licence);

console.log('\nTHE OWNER CAN FIX IT');
r = await call('/admin/api/licence', { method: 'POST', headers: AK, body: { deviceId: DEV, action: 'extend', days: 7 } });
ok('extend accepted', r.body.ok === true, r.body);
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOKEN }, body: payload });
ok('*** calculating works again, same second ***', r.status === 200, r.status);
ok('and the numbers are unchanged', r.body.result.totals.totalCost === TOTAL, r.body.result && r.body.result.totals.totalCost);

r = await call('/admin/api/licence', { method: 'POST', headers: AK, body: { deviceId: DEV, action: 'licence', days: 365 } });
r = await call('/v1/heartbeat', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOKEN }, body: { appVersion: '1.4.0' } });
ok('converts to LICENSED', r.body.licence.state === 'LICENSED', r.body.licence);
ok('with a year on it', r.body.licence.daysLeft > 360, r.body.licence.daysLeft);

r = await call('/admin/api/licence', { method: 'POST', headers: AK, body: { deviceId: DEV, action: 'revoke' } });
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOKEN }, body: payload });
ok('*** revoke stops it at the next call ***', r.status === 402 && r.body.licence.state === 'REVOKED', r.body.licence);

console.log('\nSETTINGS ARE LIVE — no new build needed');
r = await call('/admin/api/settings', { method: 'POST', headers: AK, body: { trialDays: 14, expiredMode: 'HARDSTOP', signupsOpen: false } });
ok('settings save', r.body.settings.trialDays === 14 && r.body.settings.expiredMode === 'HARDSTOP', r.body.settings);
r = await call('/v1/activate', { method: 'POST', headers: J, body: { deviceId: 'ffffeeee11112222' } });
ok('*** signups can be closed ***', r.status === 403 && r.body.error === 'SIGNUPS_CLOSED', r.body);
await call('/admin/api/settings', { method: 'POST', headers: AK, body: { signupsOpen: true } });
r = await call('/v1/activate', { method: 'POST', headers: J, body: { deviceId: 'ffffeeee11112222', company: 'Second Plant' } });
ok('and reopened', r.status === 200, r.status);
ok('a new trial uses the NEW length (14 days)', r.body.licence.daysLeft === 14, r.body.licence.daysLeft);
const TOKEN2 = r.body.token;

console.log('\nERRORS ARE READABLE');
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOKEN2 }, body: { nonsense: true } });
ok('a broken payload does not 500', r.status !== 500, { status: r.status, body: r.body });
r = await call('/nope');
ok('unknown path -> 404 json', r.status === 404 && r.body.error === 'NOT_FOUND', r.body);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

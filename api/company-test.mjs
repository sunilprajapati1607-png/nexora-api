/**
 * Nexora API 4.0.0 — companies, seats, keys and isolation
 * ======================================================================
 * Every assertion here is a promise made to a paying customer:
 *
 *   "a company can buy more than one licence"          seats
 *   "those will be connected to each other"            one clock, one
 *                                                      suspend, one extend
 *   "they cannot see other company data"               scoping comes from
 *                                                      the database row,
 *                                                      never the token
 *
 * WHY THE ISOLATION TEST FORGES A *VALID* TOKEN
 * The obvious test — send a garbage token, expect 401 — passes whether or
 * not scoping is done properly, because the signature check catches it
 * long before any scoping code runs. So the token here is signed with the
 * real secret and is completely valid; only its company claim is a lie.
 * That is the one shape that tells the two implementations apart:
 * trusting the token passes it, reading the row fails it.
 *
 * Run:  node company-test.mjs      (needs the local Postgres)
 */
process.env.DATABASE_URL = 'postgresql://nexora_app:test@127.0.0.1:5432/nexora?sslmode=disable';
process.env.NEXORA_TOKEN_SECRET = 'test-secret-abc';
process.env.NEXORA_ADMIN_KEY = 'test-admin-key';

const app = (await import('./src/index.js')).default;
const { q } = await import('./src/db.js');
const { normaliseKey, newLicenceKey } = await import('./src/licence.js');

let pass = 0, fail = 0;
const ok = (l, c, got) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + l + (c ? '' : '   got: ' + JSON.stringify(got)));
  c ? pass++ : fail++;
};
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
const bearer = (t) => ({ ...J, authorization: 'Bearer ' + t });

/* A distinct 16-hex device id per machine in the story. */
const dev = (n) => 'c0ffee00000000' + String(n).padStart(2, '0');

/* Start from nothing so seat counts are exact, and pin the settings this
   suite reasons about — local-test.mjs deliberately leaves trial_days at
   14 to prove settings are live, and an inherited 14 would make the demo
   assertions below quietly wrong rather than fail honestly. */
await call('/health');
await q(`TRUNCATE licences, companies, activation_log RESTART IDENTITY CASCADE`);
await call('/admin/api/settings', { method: 'POST', headers: AK,
  body: { trialDays: 7, demoGraceDays: 0, sessionMinutes: 30, expiredMode: 'READONLY', signupsOpen: true } });

/* ================================================================== */
console.log('LICENCE KEYS');

const k = newLicenceKey();
ok('has the shape a person can read over the phone', /^NEX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(k), k);
ok('uses no character that gets misheard or misread',
   !/[01OILS58BUV]/.test(k.slice(4)), k);
ok('typed in lower case with no hyphens, it still resolves',
   normaliseKey(k.replace(/-/g, '').toLowerCase()) === k, normaliseKey(k.replace(/-/g, '').toLowerCase()));
ok('pasted with spaces and a stray newline, it still resolves',
   normaliseKey(' ' + k.replace(/-/g, ' ') + '\n') === k, normaliseKey(' ' + k.replace(/-/g, ' ') + '\n'));
ok('something that is not a key is rejected, not guessed at',
   normaliseKey('hello') === '' && normaliseKey('') === '', normaliseKey('hello'));

/* ================================================================== */
console.log('\nA COMPANY BUYS THREE LICENCES');

let r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'create', name: 'Satyendra Packaging', seats: 3, days: 365, graceDays: 14,
          email: 'qc@spl.example', gstin: '24AAACS1429B1ZQ' } });
ok('the company is created', r.body.ok === true, r.body);
const CO = r.body.company;
ok('it is LICENSED, not a demo', CO.state === 'LICENSED' && CO.is_demo === false, CO);
ok('it carries a key to give the customer', /^NEX-/.test(CO.licence_key), CO.licence_key);
ok('and the customer\'s GST number is stored against it (4.2.0)',
   CO.gstin === '24AAACS1429B1ZQ', CO.gstin);

/* Two companies may share one GSTIN — a group with two plants on one
   registration is ordinary, and a UNIQUE constraint would refuse the
   second at midnight with an unreadable database error. */
const sameGst = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'create', name: 'Satyendra Packaging \u2014 Unit 2', seats: 1, days: 365,
          gstin: '24AAACS1429B1ZQ' } });
ok('*** a second plant on the SAME GSTIN is allowed ***',
   sameGst.body.ok === true && sameGst.body.company.gstin === '24AAACS1429B1ZQ',
   JSON.stringify(sameGst.body.error || sameGst.body.company.gstin));

const tokens = [];
for (let i = 1; i <= 3; i++) {
  r = await call('/v1/activate', { method: 'POST', headers: J,
    body: { deviceId: dev(i), deviceName: 'SPL-PC-' + i, licenceKey: CO.licence_key, appVersion: '4.0.0' } });
  tokens.push(r.body.token);
  ok('machine ' + i + ' activates on the key', r.status === 200 && !!r.body.token, r.body);
  ok('  and lands on seat ' + i, r.body.licence.company && r.body.licence.company.seatNo === i,
     r.body.licence.company);
  ok('  and reports the company by name', r.body.licence.company.name === 'Satyendra Packaging',
     r.body.licence.company);
  ok('  and carries the GST number down to the app', r.body.licence.company.gstin === '24AAACS1429B1ZQ',
     r.body.licence.company.gstin);
}

ok('all three are LICENSED, not on a demo clock',
   (await Promise.all(tokens.map(async (t) =>
     (await call('/v1/heartbeat', { method: 'POST', headers: bearer(t), body: {} })).body.licence.state)))
     .every((s) => s === 'LICENSED'), 'states differ');

ok('the key is never echoed back in full — a seat could be stolen with it',
   !/[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(
     (await call('/v1/heartbeat', { method: 'POST', headers: bearer(tokens[0]), body: {} }))
       .body.licence.company.key.replace('****-****', '')),
   'key was echoed');

/* ---- the seat limit ---------------------------------------------- */
r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: dev(4), deviceName: 'SPL-PC-4', licenceKey: CO.licence_key, appVersion: '4.0.0' } });
ok('*** THE FOURTH MACHINE IS REFUSED ***', r.status === 409, r.status);
ok('and is told how many seats there are, and what to do',
   /All 3 licences/.test(r.body.message || '') && /free one|Free one/i.test(r.body.message || ''),
   r.body.message);
ok('and no row was created for it',
   (await q(`SELECT 1 FROM licences WHERE device_id=$1`, [dev(4)])).length === 0);

/* ================================================================== */
console.log('\nTHE THREE ARE CONNECTED TO EACH OTHER');

r = await call('/admin/api/company', { method: 'POST', headers: AK, body: { id: CO.id, action: 'suspend' } });
ok('the company can be suspended', r.body.ok === true, r.body);

const suspended = await Promise.all(tokens.map(async (t) =>
  (await call('/v1/heartbeat', { method: 'POST', headers: bearer(t), body: {} })).body.licence));
ok('*** ALL THREE MACHINES STOP, not just one ***',
   suspended.every((l) => l.canCalculate === false && l.state === 'SUSPENDED'),
   suspended.map((l) => l.state));
ok('and each says which company, so the operator knows who to ring',
   suspended.every((l) => /Satyendra Packaging/.test(l.message || '')), suspended[0].message);

r = await call('/admin/api/company', { method: 'POST', headers: AK, body: { id: CO.id, action: 'restore' } });
const restored = await Promise.all(tokens.map(async (t) =>
  (await call('/v1/heartbeat', { method: 'POST', headers: bearer(t), body: {} })).body.licence));
ok('*** ALL THREE COME BACK TOGETHER ***',
   restored.every((l) => l.canCalculate === true && l.state === 'LICENSED'), restored.map((l) => l.state));

/* One extend, three machines. */
const before = restored[0].daysLeft;
await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { id: CO.id, action: 'extend', days: 30 } });
const after = await Promise.all(tokens.map(async (t) =>
  (await call('/v1/heartbeat', { method: 'POST', headers: bearer(t), body: {} })).body.licence.daysLeft));
ok('*** ONE EXTENSION MOVES ALL THREE CLOCKS ***',
   after.every((d) => d >= before + 29), before + ' -> ' + after.join(','));

/* Their offline allowance is the company's, not a client setting. */
ok('the offline allowance comes from the company (14 days)',
   restored.every((l) => l.offlineMinutes === 14 * 1440), restored[0].offlineMinutes);

/* ================================================================== */
console.log('\nA SEAT CAN BE FREED AND REUSED');

r = await call('/admin/api/licence', { method: 'POST', headers: AK,
  body: { deviceId: dev(2), action: 'revoke' } });
ok('one machine is revoked', r.body.ok === true, r.body);
r = await call('/v1/heartbeat', { method: 'POST', headers: bearer(tokens[1]), body: {} });
ok('  it stops', r.body.licence.canCalculate === false, r.body.licence);
r = await call('/v1/heartbeat', { method: 'POST', headers: bearer(tokens[0]), body: {} });
ok('  the other two are untouched', r.body.licence.canCalculate === true, r.body.licence);

r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: dev(5), deviceName: 'SPL-PC-5-replacement', licenceKey: CO.licence_key } });
ok('*** the freed seat lets a replacement machine in ***', r.status === 200, r.body);

/* And revoke-then-restore must not be a way past the limit. */
r = await call('/admin/api/licence', { method: 'POST', headers: AK,
  body: { deviceId: dev(2), action: 'restore' } });
ok('*** restoring the revoked one is refused — it would make four ***',
   !!r.body.error && /seats/i.test(r.body.error), r.body);

/* ================================================================== */
console.log('\nA WEBSITE DEMO');

r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: dev(9), deviceName: 'Visitor-PC', company: 'Some Visitor', appVersion: '4.0.0' } });
const DEMO_TOKEN = r.body.token;
ok('a visitor with no key still gets in', r.status === 200 && !!r.body.token, r.body);
ok('  on a demo of its own', r.body.licence.company.isDemo === true, r.body.licence.company);
ok('  with exactly one seat', r.body.licence.company.seats === 1, r.body.licence.company);
ok('  for 7 days', r.body.licence.daysLeft === 7, r.body.licence.daysLeft);
ok('*** AND NO OFFLINE ALLOWANCE AT ALL ***',
   r.body.licence.company.graceDays === 0, r.body.licence.company);
ok('  so the answer is only good for one working window, not a day',
   r.body.licence.offlineMinutes === 30, r.body.licence.offlineMinutes);
ok('  and it is not in anyone else\'s company',
   r.body.licence.company.name !== 'Satyendra Packaging', r.body.licence.company.name);

/* The demo user buys. Same installation, types the key. */
r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { id: CO.id, action: 'seats', seats: 6 } });
r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: dev(9), licenceKey: CO.licence_key } });
ok('*** a demo that buys moves onto the real licence in place ***',
   r.status === 200 && r.body.licence.company.name === 'Satyendra Packaging', r.body.licence);
ok('  and picks up the customer\'s offline allowance',
   r.body.licence.offlineMinutes === 14 * 1440, r.body.licence.offlineMinutes);
ok('  and its clock is now the company\'s, not the leftover demo one',
   r.body.licence.daysLeft > 300, r.body.licence.daysLeft);

/* ================================================================== */
console.log('\nONE COMPANY CANNOT REACH ANOTHER');

/* A completely valid, correctly signed token — whose company claim is a
   lie. This is the shape that separates "read the row" from "trust the
   token"; a garbage token would be caught by the signature and prove
   nothing about scoping. */
const { createHmac } = await import('node:crypto');
const b64u = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const other = (await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'create', name: 'A Rival Plant', seats: 1, days: 365 } })).body.company;

const lie = { d: dev(9), s: 'LICENSED', c: other.id,
              x: Math.floor(Date.now() / 1000) + 9e6, e: Math.floor(Date.now() / 1000) + 3600 };
const p = b64u(JSON.stringify(lie));
const forged = p + '.' + b64u(createHmac('sha256', 'test-secret-abc').update(p).digest());

r = await call('/v1/heartbeat', { method: 'POST', headers: bearer(forged), body: {} });
ok('the forged token is accepted as a signature — it is genuinely valid', r.status === 200, r.status);
ok('*** BUT THE COMPANY IT CLAIMS IS IGNORED ***',
   r.body.licence.company.name === 'Satyendra Packaging', r.body.licence.company);
ok('*** it did NOT become the rival plant ***',
   r.body.licence.company.name !== 'A Rival Plant', r.body.licence.company);

const { authorise } = await import('./src/licence.js');
const a = await authorise(new Request('https://x/v1/bom', { headers: { authorization: 'Bearer ' + forged } }));
const trueCo = (await q(`SELECT company_id FROM licences WHERE device_id=$1`, [dev(9)]))[0].company_id;
ok('*** and the id every data route will filter on is the row\'s, not the token\'s ***',
   Number(a.companyId) === Number(trueCo) && Number(a.companyId) !== Number(other.id),
   { scoped: a.companyId, claimed: other.id, actual: trueCo });

/* ================================================================== */
console.log('\nA BAD KEY IS A CLEAR REFUSAL, NOT A SILENT DEMO');

r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: dev(20), licenceKey: 'NEX-AAAA-AAAA-AAAA' } });
ok('an unknown key is refused', r.status === 404, r.status);
ok('  and does not quietly hand out a demo instead',
   (await q(`SELECT 1 FROM licences WHERE device_id=$1`, [dev(20)])).length === 0);
ok('  and says what to do', /not recognised/i.test(r.body.message || ''), r.body.message);

r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: dev(21), licenceKey: 'banana' } });
ok('a key that is not even the right shape is refused', r.status === 400, r.status);
ok('  and shows the shape it wants', /NEX-XXXX/.test(r.body.message || ''), r.body.message);

/* Suspended company: a NEW machine cannot join it either. */
await call('/admin/api/company', { method: 'POST', headers: AK, body: { id: CO.id, action: 'suspend' } });
r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: dev(22), licenceKey: CO.licence_key } });
ok('a suspended company cannot take on new machines', r.status === 403, r.status);
await call('/admin/api/company', { method: 'POST', headers: AK, body: { id: CO.id, action: 'restore' } });

/* ================================================================== */
console.log('\nAN INSTALLATION FROM BEFORE 4.0.0');

/* Exactly what an older row looks like: no company, its own clock. Rule
   #28 — bringing it forward must not move that clock by one day. */
await q(`INSERT INTO licences (device_id, device_name, company, email, state,
                               trial_started_at, expires_at, app_version, seen_count)
         VALUES ($1,'OLD-PC','Legacy Plant','old@x.com','TRIAL',
                 now() - interval '2 days', now() + interval '5 days', '3.0.0', 4)`, [dev(30)]);
const oldExpiry = (await q(`SELECT expires_at FROM licences WHERE device_id=$1`, [dev(30)]))[0].expires_at;

r = await call('/v1/activate', { method: 'POST', headers: J, body: { deviceId: dev(30), appVersion: '4.0.0' } });
ok('it activates without a key and is recognised as returning',
   r.status === 200 && r.body.returning === true, r.body);
ok('it is given a company of its own', !!r.body.licence.company, r.body.licence);
const adopted = (await q(
  `SELECT c.expires_at FROM companies c JOIN licences l ON l.company_id=c.id WHERE l.device_id=$1`,
  [dev(30)]))[0];
ok('*** ITS CLOCK CROSSED OVER UNTOUCHED — not restarted, not shortened ***',
   new Date(adopted.expires_at).getTime() === new Date(oldExpiry).getTime(),
   { was: oldExpiry, now: adopted.expires_at });
ok('  and it still has its 5 days', r.body.licence.daysLeft === 5, r.body.licence.daysLeft);

/* A pre-4.0.0 LICENSED row must not be demoted to a demo. */
await q(`INSERT INTO licences (device_id, state, expires_at)
         VALUES ($1,'LICENSED', now() + interval '200 days')`, [dev(31)]);
r = await call('/v1/activate', { method: 'POST', headers: J, body: { deviceId: dev(31) } });
ok('*** a paying customer from 3.0.0 stays licensed ***',
   r.body.licence.state === 'LICENSED' && r.body.licence.company.isDemo === false, r.body.licence);

/* ================================================================== */
console.log('\nSEATS CAN BE REDUCED WITHOUT STOPPING ANYONE');

r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { id: CO.id, action: 'seats', seats: 1 } });
ok('reducing the seat count is allowed', r.body.ok === true, r.body);
ok('  and warns that more machines are still running', /still active/i.test(r.body.warning || ''), r.body.warning);
r = await call('/v1/heartbeat', { method: 'POST', headers: bearer(tokens[0]), body: {} });
ok('*** NOBODY WAS SILENTLY CUT OFF ***', r.body.licence.canCalculate === true, r.body.licence);

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

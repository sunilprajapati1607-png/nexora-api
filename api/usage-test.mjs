/**
 * Nexora API 4.3.0 — transaction count, transaction limit, hours of usage
 * ======================================================================
 * "4-Transaction limit and transaction count as well as hours of usage
 *  count on dashboard"
 *
 * A limit is only a limit if it cannot be got around, so every assertion
 * here is aimed at a way round it rather than at the happy path:
 *
 *   reinstall and report zero        the count must NOT go down
 *   spread the work over two seats   the licence's total is the SUM
 *   edit the number the app sends    the server counts, not the client
 *   no limit sold                    nothing changes, ever
 *
 * And two that protect the CUSTOMER rather than the licence:
 *
 *   reaching the limit is READ-ONLY, not a shutdown — saved work still opens
 *   raising the limit works on the very next call, with no new build
 *
 * Run against a real Postgres, like the other two suites.
 */
process.env.DATABASE_URL = 'postgresql://nexora_app:test@127.0.0.1:5432/nexora?sslmode=disable';
process.env.NEXORA_TOKEN_SECRET = 'test-secret-abc';
process.env.NEXORA_ADMIN_KEY = 'test-admin-key';
const app = (await import('./src/index.js')).default;
const { q } = await import('./src/db.js');

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

const PAYLOAD = {
  bags: 1000, bagWeightG: 100, basis: 'KG',
  steps: [{ p: 'TAPE' }],
  sections: { '0|TAPE': { wastePct: 1, lines: [{ rm: 'PP', basis: 'PCT', value: 100 }] } },
  masters: { rates: { PP: 134 }, names: { PP: 'PP' }, procRates: { TAPE: 9 },
    procNames: { TAPE: 'Tape' }, groups: { PP: 'GRANULE' } },
  view: { mode: 'EACH', value: 1000 }, components: []
};

/* Start clean, and pin the settings, so the order the suites run in never
   changes the answer — the same rule the other two suites follow. */
await call('/health');
await q(`TRUNCATE licences, companies, activation_log RESTART IDENTITY CASCADE`);
await call('/admin/api/settings', { method: 'POST', headers: AK,
  body: { trialDays: 30, demoGraceDays: 0, sessionMinutes: 60, expiredMode: 'READONLY', signupsOpen: true } });

/* A real customer with two seats. */
let r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'create', name: 'Metering Works', seats: 2, days: 365, graceDays: 7 } });
const KEY = r.body.company.licence_key;
const COID = r.body.company.id;
ok('a two-seat customer exists', !!KEY && !!COID, r.body);

const DEV_A = 'aaaa1111bbbb2222';
const DEV_B = 'cccc3333dddd4444';

r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: DEV_A, deviceName: 'PLANT-PC-1', licenceKey: KEY, appVersion: '4.3.0' } });
const TOK_A = r.body.token;
ok('seat 1 activates', r.status === 200 && !!TOK_A, r.body);
ok('and starts with NO limit — nothing was sold one', r.body.licence.txnLimit === 0, r.body.licence.txnLimit);
ok('and no transactions used', r.body.licence.txnUsed === 0, r.body.licence.txnUsed);
ok('so remaining is "no limit", not a number', r.body.licence.txnRemaining === null, r.body.licence.txnRemaining);

r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: DEV_B, deviceName: 'PLANT-PC-2', licenceKey: KEY, appVersion: '4.3.0' } });
const TOK_B = r.body.token;
ok('seat 2 activates on the same key', r.status === 200 && !!TOK_B, r.body);

const beat = (tok, usage) => call('/v1/heartbeat', { method: 'POST',
  headers: { ...J, authorization: 'Bearer ' + tok }, body: { appVersion: '4.3.0', usage } });

console.log('\nCOUNTING');
r = await beat(TOK_A, { txnCount: 12, usageMinutes: 95 });
ok('a machine reports what it committed', r.status === 200, r.status);
ok('and the licence says 12 used', r.body.licence.txnUsed === 12, r.body.licence.txnUsed);
ok('with the hours it was used', r.body.licence.usageMinutes === 95, r.body.licence.usageMinutes);

r = await beat(TOK_B, { txnCount: 8, usageMinutes: 40 });
ok('*** THE LICENCE TOTAL IS THE SUM ACROSS ITS SEATS — 12 + 8 ***',
  r.body.licence.txnUsed === 20, r.body.licence.txnUsed);
ok('and so are the minutes — 95 + 40', r.body.licence.usageMinutes === 135, r.body.licence.usageMinutes);

/* The first machine asks again without reporting anything. It must see
   the WHOLE licence's figure, not just its own 12 — that is the point of
   metering the licence rather than the machine. */
r = await beat(TOK_A, null);
ok('a seat sees the whole licence, not just itself', r.body.licence.txnUsed === 20, r.body.licence.txnUsed);

console.log('\nTHE COUNT CANNOT GO BACKWARDS');
/* Reinstalling clears the local count. If the server took that number the
   limit would be worth nothing: uninstall, reinstall, start again. */
r = await beat(TOK_A, { txnCount: 0, usageMinutes: 0 });
ok('*** A REINSTALLED MACHINE REPORTING 0 DOES NOT RESET THE COUNT ***',
  r.body.licence.txnUsed === 20, r.body.licence.txnUsed);
r = await beat(TOK_A, { txnCount: 3, usageMinutes: 5 });
ok('nor does a lower figure than the server already holds',
  r.body.licence.txnUsed === 20, r.body.licence.txnUsed);
r = await beat(TOK_A, { txnCount: 15, usageMinutes: 100 });
ok('but a higher one counts — 15 + 8', r.body.licence.txnUsed === 23, r.body.licence.txnUsed);

console.log('\nNO LIMIT MEANS NO LIMIT');
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOK_A }, body: PAYLOAD });
ok('23 transactions and still calculating — nothing was sold a cap', r.status === 200, r.status);

console.log('\nTHE LIMIT');
r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'txnlimit', id: COID, txnLimit: 25 } });
ok('the owner can set a limit', r.body.ok === true, r.body);

r = await beat(TOK_A, null);
ok('the licence reports it', r.body.licence.txnLimit === 25, r.body.licence.txnLimit);
ok('with what is left — 25 - 23', r.body.licence.txnRemaining === 2, r.body.licence.txnRemaining);
ok('and still calculates, because it is inside the limit', r.body.licence.canCalculate === true, r.body.licence);

r = await beat(TOK_B, { txnCount: 10, usageMinutes: 60 });   // 15 + 10 = 25
ok('reaching the limit is reported on the SAME call that reaches it',
  r.body.licence.txnUsed === 25 && r.body.licence.canCalculate === false, r.body.licence);
ok('*** and it is READ-ONLY, not a shutdown ***', r.body.licence.mode === 'READONLY', r.body.licence.mode);
ok('the state is still LICENSED — the customer has not lost their licence',
  r.body.licence.state === 'LICENSED', r.body.licence.state);
ok('it is flagged as a limit, not an expiry', r.body.licence.limitReached === true, r.body.licence);
ok('and says so in words a plant can act on',
  /used all 25 of its transactions/i.test(r.body.licence.message || '') &&
  /still be opened and printed/i.test(r.body.licence.message || ''), r.body.licence.message);

r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOK_A }, body: PAYLOAD });
ok('*** AND THE OTHER SEAT IS STOPPED TOO — one licence, one allowance ***',
  r.status === 402, r.status);
ok('with the same readable reason', /transactions/i.test(r.body.message || ''), r.body.message);

console.log('\nTHE CLIENT CANNOT TALK ITS WAY PAST IT');
/* The app sends counts. If the server believed a LOW count from the app,
   the limit would be one edited JSON field away from meaningless. */
r = await beat(TOK_A, { txnCount: 1, usageMinutes: 1 });
ok('*** REPORTING A SMALL NUMBER DOES NOT BUY MORE TRANSACTIONS ***',
  r.body.licence.txnUsed === 25 && r.body.licence.canCalculate === false, r.body.licence);

console.log('\nTHE OWNER CAN RAISE IT, AND IT TAKES EFFECT AT ONCE');
r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'txnlimit', id: COID, txnLimit: 100 } });
ok('raising the limit is accepted', r.body.ok === true, r.body);
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOK_A }, body: PAYLOAD });
ok('*** calculating works again on the very next call ***', r.status === 200, r.status);
ok('and the numbers are unchanged', r.body.result.totals.totalCost > 0, r.body.result && r.body.result.totals);

console.log('\nLOWERING IT BELOW WHAT IS USED WARNS, AND DESTROYS NOTHING');
r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'txnlimit', id: COID, txnLimit: 5 } });
ok('it is allowed', r.body.ok === true, r.body);
ok('and warns that the licence is already over it', /already committed 25/.test(r.body.warning || ''), r.body.warning);
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOK_A }, body: PAYLOAD });
ok('new work stops', r.status === 402, r.status);
r = await call('/admin/api/licences', { headers: AK });
const stillThere = r.body.licences.filter((l) => l.device_id === DEV_A || l.device_id === DEV_B);
ok('*** but NO installation was removed or revoked ***',
  stillThere.length === 2 && stillThere.every((l) => l.state !== 'REVOKED'),
  stillThere.map((l) => l.state));

console.log('\nZERO PUTS IT BACK TO NO LIMIT');
r = await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'txnlimit', id: COID, txnLimit: 0 } });
r = await call('/v1/bom', { method: 'POST', headers: { ...J, authorization: 'Bearer ' + TOK_A }, body: PAYLOAD });
ok('0 means no limit, not a limit of zero', r.status === 200, r.status);

console.log('\nA WORSE PROBLEM IS STILL REPORTED FIRST');
/* Being out of transactions matters less than being suspended, and the
   customer needs to hear the one they can do something about. */
await call('/admin/api/company', { method: 'POST', headers: AK,
  body: { action: 'txnlimit', id: COID, txnLimit: 1 } });
await call('/admin/api/company', { method: 'POST', headers: AK, body: { action: 'suspend', id: COID } });
r = await beat(TOK_A, null);
ok('*** a SUSPENDED licence says suspended, not "out of transactions" ***',
  r.body.licence.state === 'SUSPENDED' && !r.body.licence.limitReached, r.body.licence);
ok('and still reports the figures for the dashboard',
  r.body.licence.txnLimit === 1 && r.body.licence.txnUsed === 25, r.body.licence);
await call('/admin/api/company', { method: 'POST', headers: AK, body: { action: 'restore', id: COID } });

console.log('\nTHE OWNER CAN SEE ALL OF IT');
r = await call('/admin/api/licences', { headers: AK });
const co = r.body.companies.find((c) => Number(c.id) === Number(COID));
ok('the console lists the limit', Number(co.txn_limit) === 1, co && co.txn_limit);
ok('what has been used', Number(co.txn_used) === 25, co && co.txn_used);
ok('and the hours', Number(co.usage_minutes) === 160, co && co.usage_minutes);
const devA = r.body.licences.find((l) => l.device_id === DEV_A);
ok('and per machine, so a heavy seat can be found', Number(devA.txn_count) === 15, devA && devA.txn_count);

console.log('\nA COMPANY THAT NEVER TOUCHES THIS IS UNAFFECTED');
/* The whole feature must be invisible to every existing customer. */
r = await call('/v1/activate', { method: 'POST', headers: J,
  body: { deviceId: 'eeee5555ffff6666', deviceName: 'OTHER', company: 'Untouched Plant', appVersion: '4.3.0' } });
ok('a fresh demo activates as before', r.status === 200 && r.body.licence.canCalculate === true, r.body.licence);
ok('with no limit', r.body.licence.txnLimit === 0, r.body.licence.txnLimit);
r = await call('/v1/bom', { method: 'POST',
  headers: { ...J, authorization: 'Bearer ' + r.body.token }, body: PAYLOAD });
ok('and calculates', r.status === 200, r.status);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

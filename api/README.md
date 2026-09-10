# Nexora API — licence, trial clock and costing engine

The server side of Nexora. It does three jobs:

| | |
|---|---|
| **Licence & trial** | Issues a 7-day trial per computer, keeps the clock, and answers whether an installation may calculate |
| **Costing engine** | Runs the BOM quantity/cost roll-up, the reconciliation and the per-stage view — the part of Nexora worth protecting |
| **Admin console** | One page at `/admin` where you extend, licence, revoke and set the trial length |

---

## 1. The rule this service exists to enforce

**The clock is the server's clock.** Nothing the client says about time is
believed, and no licence decision is ever computed from a date sent in.

That is what makes the three usual attacks pointless:

| Attack | Why it fails |
|---|---|
| Set the PC's date back | The PC's date is never read |
| Delete AppData and reinstall | The device is already in the table, so it gets its **original** expiry back — not a new trial |
| Run it on a fresh VM | That is a new signup: rate-limited, visible in the console, and closable with **Accept new trials → off** |

## 2. Endpoints

```
GET  /health                    is the service up
POST /v1/activate               {deviceId, deviceName, company, email, appVersion}
                                → {token, licence, returning}
POST /v1/heartbeat              Bearer token → refreshed {token, licence}
POST /v1/bom                    Bearer token + route payload → {result, view, reconcile, licence}
                                → 402 with a readable message when the licence does not allow it

GET  /admin                     the console (asks for the admin key)
GET  /admin/api/licences        x-admin-key
POST /admin/api/licence         {deviceId, action: extend|licence|revoke|restore|note, days}
POST /admin/api/settings        {trialDays, expiredMode: READONLY|HARDSTOP, signupsOpen}
GET  /admin/api/events          recent activation log
```

### What crosses the wire on `/v1/bom`

The engine needs functions (`rateOf`, `procName`…) and functions cannot
travel as JSON, so the client sends its **master data as lookup tables**
and the server rebuilds the closures:

```
client  →  { rates:{}, names:{}, uoms:{}, procRates:{}, procNames:{},
             procResources:{}, groups:{} }        the plant's own data
server  →  the formulas                           which it does not have
```

Prices, materials and routes stay on the customer's machine. The
arithmetic that turns them into a cost per bag never leaves this process.

## 3. Environment variables

```
DATABASE_URL           postgres connection string (Neon)
NEXORA_TOKEN_SECRET    HMAC key for licence tokens — 32 random bytes, hex
NEXORA_ADMIN_KEY       the password for /admin
```

Rotating `NEXORA_TOKEN_SECRET` invalidates every issued token; clients
simply re-activate, so it is safe but noisy. Rotating `NEXORA_ADMIN_KEY`
affects nothing but the console.

## 4. Running it

### Locally

```bash
npm install          # only esbuild, and only for the Neon Functions build
npm start            # listens on PORT (default 3000)
npm test             # 38 assertions against a real Postgres
```

`npm test` needs a local database:

```bash
createdb nexora
psql -c "CREATE ROLE nexora_app LOGIN PASSWORD 'test'"
```

### On Render

Runtime **Node**, build `npm install`, start `npm start`. Set the three
environment variables above. `server.js` is the only file that exists for
Render — it adapts the service's `fetch(Request) → Response` handler to a
long-lived Node process.

### On Neon Functions

```bash
npm run build:function
cd build && zip -r ../function.zip index.js package.json
```

The archive must be self-contained: **Neon Functions do not install
dependencies**, which is why this service has none at runtime.

## 5. Why there is a hand-written Postgres client

`src/pgmini.js` speaks the Postgres wire protocol directly — TLS with SNI,
SCRAM-SHA-256, extended query with real parameters. It exists because the
`pg` driver bundles to ~60 KB and Neon Functions ship every byte they use,
which made the driver most of the deployment payload for a service that
runs a handful of parameterised statements.

It is deliberately not a general driver: no COPY, no cursors, no
listen/notify, no binary format. If this service ever needs those, take
the dependency instead of growing that file.

Every query goes through `query(text, params)` and every value travels as
a parameter, so SQL injection is structurally impossible here.

## 6. Project layout

```
server.js            Render entry point (node:http → fetch adapter)
src/index.js         the router — the only file that knows about paths
src/licence.js       the trial clock and the token. The heart of it.
src/engine.js        rebuilds the engine's closures from JSON masters
src/admin.js         admin API + the console page
src/db.js            schema (creates itself) and settings
src/pgmini.js        the Postgres client
vendor/              bomEngine, bomReconcile, stageBasis — byte-identical
                     copies of the desktop app's modules. Do not edit here;
                     copy them across so both sides stay the same engine.
local-test.mjs       the harness
```

## 7. Keeping the engine in step

`vendor/` holds copies of three modules from the desktop app:

```
app/src/calculation/bomEngine.js
app/src/calculation/bomReconcile.js
app/src/calculation/stageBasis.js
```

They are copied, not forked. When the desktop app's engine changes, copy
the files across and re-run both test suites — the desktop app's `npm test`
and this one. A route costed here and a route costed in the old local
build must produce identical figures; that equivalence has been checked to
six decimal places across a six-stage route and should be re-checked after
any engine change.

`vendor/package.json` marks that folder as CommonJS so the bundler reads
those UMD files correctly. Without it, esbuild treats them as ESM and the
`module.exports` branch silently becomes a global.

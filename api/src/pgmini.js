/**
 * Nexora API — a small Postgres client
 * ======================================================================
 * WHY THIS EXISTS, rather than `pg`
 *
 * Neon Functions do NOT install dependencies: whatever the function needs
 * has to be inside the uploaded archive. The `pg` driver bundles to about
 * 60 KB, which is most of the payload and most of the cost of every
 * deployment — for a service whose entire database work is a handful of
 * parameterised SELECTs, INSERTs and UPDATEs.
 *
 * So this speaks the Postgres wire protocol directly, over the platform's
 * own `node:tls`, and nothing else. It implements exactly what this
 * service uses and refuses to pretend otherwise:
 *
 *   TLS with SNI               Neon routes by server name
 *   SCRAM-SHA-256              the only auth Neon offers
 *   extended query ($1, $2…)   so nothing is ever built by concatenation
 *   text results, typed back   ints, floats, bools and JSON come back as
 *                              values rather than strings
 *
 * It is NOT a general driver: no COPY, no cursors, no listen/notify, no
 * binary format, no prepared-statement cache. If this service ever needs
 * those, it should take the dependency rather than grow this file.
 *
 * Every query goes through `query(text, params)` and every value travels
 * as a parameter, so SQL injection is structurally impossible here.
 */
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/* ---- wire helpers ---------------------------------------------------- */
class Writer {
  constructor() { this.chunks = []; }
  str(s) { this.chunks.push(Buffer.from(s, 'utf8'), Buffer.from([0])); return this; }
  raw(b) { this.chunks.push(b); return this; }
  int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.chunks.push(b); return this; }
  int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.chunks.push(b); return this; }
  body() { return Buffer.concat(this.chunks); }
  /** A tagged message: 1-byte type, 4-byte length (inclusive), body. */
  msg(type) {
    const body = this.body();
    const head = Buffer.alloc(5);
    head.write(type, 0, 'ascii');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  }
}

function cstr(buf, off) {
  const end = buf.indexOf(0, off);
  return [buf.toString('utf8', off, end), end + 1];
}

/* ---- type decoding ---------------------------------------------------
   Postgres sends text; these are the OIDs this service actually meets. */
const INT_OIDS = new Set([20, 21, 23, 26]);          // int8 int2 int4 oid
const FLOAT_OIDS = new Set([700, 701, 1700]);        // float4 float8 numeric
const BOOL_OID = 16;
const JSON_OIDS = new Set([114, 3802]);              // json jsonb

function decode(value, oid) {
  if (value === null) return null;
  if (oid === BOOL_OID) return value === 't';
  if (INT_OIDS.has(oid)) { const n = Number(value); return Number.isSafeInteger(n) ? n : value; }
  if (FLOAT_OIDS.has(oid)) { const n = Number(value); return isFinite(n) ? n : value; }
  if (JSON_OIDS.has(oid)) { try { return JSON.parse(value); } catch (e) { return value; } }
  return value;                                       // text, timestamptz, …
}

/* ---- SCRAM-SHA-256 --------------------------------------------------- */
function scramClientFirst(nonce) { return 'n,,n=*,r=' + nonce; }

function scramFinal(password, nonce, serverFirst) {
  const parts = {};
  serverFirst.split(',').forEach((kv) => { const i = kv.indexOf('='); parts[kv.slice(0, i)] = kv.slice(i + 1); });
  const serverNonce = parts.r, salt = Buffer.from(parts.s, 'base64'), iterations = parseInt(parts.i, 10);
  if (!serverNonce.startsWith(nonce)) throw new Error('SCRAM: the server nonce does not extend ours');

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();

  const clientFinalNoProof = 'c=biws,r=' + serverNonce;
  const authMessage = 'n=*,r=' + nonce + ',' + serverFirst + ',' + clientFinalNoProof;

  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ clientSignature[i];

  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest().toString('base64');

  return { clientFinal: clientFinalNoProof + ',p=' + proof.toString('base64'), serverSignature };
}

/* ---- connection ------------------------------------------------------ */
class Conn {
  constructor(cfg) {
    this.cfg = cfg; this.socket = null; this.buf = Buffer.alloc(0);
    this.queue = []; this.inbox = []; this.dead = null; this.strayHandler = null;
  }

  /** Resolve when a message of one of `types` arrives; reject on
   *  ErrorResponse.
   *
   *  Messages that arrive before anyone is waiting are KEPT. Postgres
   *  packs AuthenticationOk, every ParameterStatus, BackendKeyData and
   *  ReadyForQuery into one TCP segment, and `feed()` dispatches the lot
   *  synchronously — long before the next `await expect(...)` has had a
   *  chance to register. Dropping them there cost an afternoon: the login
   *  succeeded and then the client waited forever for a ReadyForQuery it
   *  had already been sent. */
  expect(types) {
    const hit = this.inbox.shift();
    if (hit) {
      if (hit.type === 'E') return Promise.reject(hit.error);
      if (types.indexOf(hit.type) >= 0) return Promise.resolve(hit);
      return Promise.reject(new Error('Unexpected message ' + hit.type + ' from the database.'));
    }
    return new Promise((resolve, reject) => { this.queue.push({ types, resolve, reject }); });
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 5) return;
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      this.dispatch(type, body);
    }
  }

  dispatch(type, body) {
    if (type === 'N' || type === 'S' || type === 'K' || type === 'A') return;   // notice / param / cancel key
    if (this.strayHandler) { this.strayHandler(type, body); return; }
    if (type === 'E') {
      const err = parseError(body);
      const w = this.queue.shift();
      if (w) w.reject(err); else this.inbox.push({ type: 'E', error: err });
      return;
    }
    const w = this.queue[0];
    if (w && w.types.indexOf(type) >= 0) { this.queue.shift(); w.resolve({ type, body }); return; }
    this.inbox.push({ type, body });
  }

  send(buf) { this.socket.write(buf); }
}

function parseError(body) {
  const f = {};
  let off = 0;
  while (off < body.length && body[off] !== 0) {
    const code = String.fromCharCode(body[off]);
    const [val, next] = cstr(body, off + 1);
    f[code] = val; off = next;
  }
  const e = new Error(f.M || 'Postgres error');
  e.code = f.C; e.detail = f.D; e.severity = f.S;
  return e;
}

function parseUrl(url) {
  /* A missing DATABASE_URL used to surface to the user as the bare
     message "Invalid URL" from the URL constructor, which says nothing
     about what is actually wrong. Name the real problem instead. */
  if (typeof url !== 'string' || url.trim() === '') {
    const e = new Error('The database connection string is not configured on this server (DATABASE_URL is empty).');
    e.code = 'DATABASE_URL_MISSING';
    throw e;
  }
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    const e = new Error('The database connection string is not a valid postgres:// URL.');
    e.code = 'DATABASE_URL_INVALID';
    throw e;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    const e = new Error('The database connection string must begin with postgres:// or postgresql:// (found "' + u.protocol + '//").');
    e.code = 'DATABASE_URL_INVALID';
    throw e;
  }
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    ssl: !/sslmode=disable/.test(u.search)
  };
}

async function openConnection(url) {
  const cfg = parseUrl(url);
  const conn = new Conn(cfg);

  await new Promise((resolve, reject) => {
    if (!cfg.ssl) {
      const s = netConnect({ host: cfg.host, port: cfg.port }, () => resolve());
      conn.socket = s;
      /* Attached NOW, not after the await: the server's first
         authentication message can arrive before this promise settles. */
      s.on('data', (c) => conn.feed(c));
      s.on('error', reject);
      return;
    }
    /* SSLRequest first: 8 bytes, then the server answers with a single
       byte before any TLS handshake begins. */
    const plain = netConnect({ host: cfg.host, port: cfg.port }, () => {
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4);
      plain.write(req);
    });
    plain.once('error', reject);
    plain.once('data', (d) => {
      if (d[0] !== 0x53) return reject(new Error('The database refused a TLS connection.'));
      const secure = tlsConnect({ socket: plain, servername: cfg.host }, () => resolve());
      conn.socket = secure;
      secure.on('error', (e) => { conn.dead = e; });
      secure.on('data', (c) => conn.feed(c));
    });
  });

  if (!cfg.ssl) conn.socket.on('error', (e) => { conn.dead = e; });

  /* StartupMessage */
  const w = new Writer();
  w.int32(196608).str('user').str(cfg.user).str('database').str(cfg.database)
   .str('client_encoding').str('UTF8').str('application_name').str('nexora-api').raw(Buffer.from([0]));
  const body = w.body();
  const head = Buffer.alloc(4); head.writeInt32BE(body.length + 4);
  conn.send(Buffer.concat([head, body]));

  /* Authentication */
  for (;;) {
    const { body: b } = await conn.expect(['R']);
    const kind = b.readInt32BE(0);
    if (kind === 0) break;                                  // AuthenticationOk
    if (kind === 10) {                                      // SASL
      const mechanisms = [];
      let off = 4;
      while (off < b.length && b[off] !== 0) { const [m, n] = cstr(b, off); mechanisms.push(m); off = n; }
      if (mechanisms.indexOf('SCRAM-SHA-256') < 0) throw new Error('The database asked for an unsupported login method.');
      const nonce = randomBytes(18).toString('base64');
      const first = scramClientFirst(nonce);
      conn.send(new Writer().str('SCRAM-SHA-256').int32(Buffer.byteLength(first)).raw(Buffer.from(first)).msg('p'));

      const cont = await conn.expect(['R']);
      if (cont.body.readInt32BE(0) !== 11) throw new Error('SCRAM: unexpected server reply');
      const serverFirst = cont.body.toString('utf8', 4);
      const { clientFinal, serverSignature } = scramFinal(cfg.password, nonce, serverFirst);
      conn.send(new Writer().raw(Buffer.from(clientFinal)).msg('p'));

      const fin = await conn.expect(['R']);
      if (fin.body.readInt32BE(0) !== 12) throw new Error('SCRAM: unexpected final reply');
      const got = fin.body.toString('utf8', 4);
      if (got.indexOf(serverSignature) < 0) throw new Error('SCRAM: the server could not prove it knows the password.');
      continue;
    }
    throw new Error('The database asked for a login method this client does not support (' + kind + ').');
  }

  /* Wait for ReadyForQuery */
  await conn.expect(['Z']);
  return conn;
}

/* ---- one query ------------------------------------------------------- */
async function runQuery(conn, text, params) {
  const p = params || [];
  const parse = new Writer().str('').str(text).int16(0).msg('P');
  const bindW = new Writer().str('').str('').int16(0).int16(p.length);
  p.forEach((v) => {
    if (v === null || v === undefined) { bindW.int32(-1); return; }
    const s = Buffer.from(typeof v === 'object' ? JSON.stringify(v) : String(v), 'utf8');
    bindW.int32(s.length).raw(s);
  });
  bindW.int16(0);
  const bind = bindW.msg('B');
  const describe = new Writer().raw(Buffer.from('P')).str('').msg('D');
  const execute = new Writer().str('').int32(0).msg('E');
  const sync = new Writer().msg('S');

  const fields = [];
  const rows = [];
  let error = null;

  const done = new Promise((resolve, reject) => {
    conn.strayHandler = (type, body) => {
      if (type === 'T') {                                   // RowDescription
        const n = body.readInt16BE(0);
        let off = 2;
        for (let i = 0; i < n; i++) {
          const [name, next] = cstr(body, off);
          const oid = body.readInt32BE(next + 6);
          fields.push({ name, oid });
          off = next + 18;
        }
      } else if (type === 'D') {                            // DataRow
        const n = body.readInt16BE(0);
        let off = 2;
        const row = {};
        for (let i = 0; i < n; i++) {
          const len = body.readInt32BE(off); off += 4;
          let v = null;
          if (len >= 0) { v = body.toString('utf8', off, off + len); off += len; }
          const f = fields[i] || { name: 'col' + i, oid: 25 };
          row[f.name] = decode(v, f.oid);
        }
        rows.push(row);
      } else if (type === 'E') {
        error = parseError(body);
      } else if (type === 'Z') {                            // ReadyForQuery
        conn.strayHandler = null;
        error ? reject(error) : resolve();
      }
    };
  });

  /* For the life of this query every message belongs to it, error
     responses included — so the handler is installed before a single byte
     goes out, and anything still sitting in the inbox is drained through
     it first. */
  conn.queue.length = 0;
  const pending = conn.inbox.splice(0, conn.inbox.length);
  pending.forEach((m) => { if (m.type === 'E') error = m.error; });
  conn.send(Buffer.concat([parse, bind, describe, execute, sync]));
  await done;
  return rows;
}

/* ---- the pool -------------------------------------------------------- */
/**
 * One connection, reused, reopened if it dies. A Neon Function handles
 * one request at a time per instance, so a single serialised connection
 * is the honest shape — and queries are queued rather than raced.
 */
export function createClient(url) {
  let conn = null;
  let chain = Promise.resolve();

  async function ensure() {
    if (conn && !conn.dead && conn.socket && !conn.socket.destroyed) return conn;
    conn = await openConnection(url);
    return conn;
  }

  function query(text, params) {
    const run = async () => {
      try {
        const c = await ensure();
        return await runQuery(c, text, params);
      } catch (e) {
        /* A dropped connection is worth exactly one retry: Neon suspends
           idle computes, so the first query after a quiet spell often
           lands on a socket the server has already closed. */
        if (isConnectionFault(e)) {
          if (conn && conn.socket) { try { conn.socket.destroy(); } catch (x) {} }
          conn = null;
          const c = await ensure();
          return await runQuery(c, text, params);
        }
        throw e;
      }
    };
    chain = chain.then(run, run);
    return chain;
  }

  return { query };
}

function isConnectionFault(e) {
  const m = String((e && e.message) || '');
  return /socket|closed|ECONNRESET|EPIPE|ETIMEDOUT|terminat|not connected|destroyed/i.test(m) && !e.code;
}

/**
 * Nexora — the Postgres client for the Deno build
 * ----------------------------------------------------------------------
 * `pgmini.js` speaks the wire protocol itself over node:net and node:tls.
 * Neither module works in Supabase's Edge runtime — a function that so
 * much as imports them boots and then dies silently — so the Deno build
 * uses postgres.js instead. Node keeps pgmini; nothing about the running
 * service changes.
 *
 * This file exists to be INDISTINGUISHABLE from pgmini to everything
 * above it. `db.js` asks for `createClient(url)` and calls `.query(text,
 * params)`, expecting an array of plain row objects — so that is exactly
 * what this returns.
 *
 * The decoding is the part that matters, and it is not the default.
 * pgmini hands back:
 *
 *     bool                    true / false
 *     int2 int4 int8 oid      a Number, when it fits safely
 *     float4 float8           a Number
 *     json jsonb              a parsed object
 *     EVERYTHING ELSE         the raw string — INCLUDING TIMESTAMPS
 *
 * postgres.js would turn timestamps into Date objects and int8 into
 * strings. Both would be silent, plausible, and wrong: the console prints
 * `String(expires_at).slice(0, 10)` to show a date, and a Date there
 * reads "Thu Sep 17 2026" instead of "2026-09-23". So the types below are
 * pinned to pgmini's behaviour rather than left to the library.
 */
import postgres from 'postgres';

/* A type that is simply not converted: the string the server sent — and, on
   the way out, the string this file already produced. See `query` below for
   why no serializer here may alter its argument. */
const asText = (oids) => ({ to: oids[0], from: oids, serialize: (v) => v, parse: (v) => v });

/* int8 the way pgmini does it: a Number while that is lossless, the raw
   string beyond 2^53 rather than a quietly wrong number. */
const asSafeInt = (oids) => ({
  to: oids[0], from: oids,
  serialize: (v) => String(v),
  parse: (v) => { const n = Number(v); return Number.isSafeInteger(n) ? n : v; }
});

/* numeric, which postgres.js hands back as a string and pgmini as a
   number. It is not hypothetical: round() appears in admin.js and ink.js
   and round() on a numeric RETURNS numeric, so a console figure would
   have arrived as "203.498" instead of 203.498. */
const asFloat = (oids) => ({
  to: oids[0], from: oids,
  serialize: (v) => String(v),
  parse: (v) => { const n = Number(v); return isFinite(n) ? n : v; }
});

export function createClient(url) {
  /* Nothing here connects, validates, or even looks at `url` until the
     first query — because pgmini does not either, and `db.js` calls
     createClient at MODULE SCOPE. Throw here and the module fails to
     load, which takes down every route in the service, /health included,
     over a database that no one had asked for yet. console-test imports
     admin.js purely to read its HTML and needs no database at all. */
  let sql = null;

  const connect = () => {
    if (sql) return sql;
    if (typeof url !== 'string' || url.trim() === '') {
      const e = new Error('The database connection string is not configured on this server (DATABASE_URL is empty).');
      e.code = 'DATABASE_URL_MISSING';
      throw e;
    }
    sql = build(url);
    return sql;
  };

  return {
    /**
     * @param {string} text   SQL, with $1 $2 placeholders
     * @param {Array} params
     * @returns {Promise<Array<object>>} plain rows, like pgmini's
     */
    async query(text, params) {
      /* Every parameter goes out as TEXT, exactly as pgmini sends it, and
         the server decides what it means from where it is used.
         This is not tidiness. `logEvent` writes its audit detail as
         JSON.stringify(...) into a jsonb column; postgres.js, left alone,
         asks the server what $2 is, hears "jsonb", and runs its json
         serializer over text that is ALREADY json — storing a JSON string
         where there should be an object. jsonb_typeof then says "string"
         and detail->>'why' comes back null. The audit trail keeps its
         shape and loses its meaning, without an error anywhere.
         So: stringify here, the way pgmini does, and every serializer
         below hands the result through unchanged. */
      const p = (params || []).map((v) => {
        if (v === null || v === undefined) return null;
        if (v instanceof Date) return v.toISOString();
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      });
      const rows = await connect().unsafe(text, p);
      /* postgres.js returns its own array subclass carrying `count`,
         `command` and so on. Callers only ever treat this as an array,
         and a plain one cannot surprise them. */
      return Array.from(rows);
    },
    async end() {
      if (!sql) return;
      try { await sql.end({ timeout: 5 }); } catch (e) { /* closing is best effort */ }
    }
  };
}

function build(url) {
  return postgres(url, {
    /* Supavisor in transaction mode refuses named prepared statements, and
       there is nothing here that needs them. */
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    /* Supabase's pooler presents its own certificate authority, which no
       bundle knows — the same reason pgmini learned about sslmode. This
       encrypts without verifying, exactly as sslmode=require does. */
    ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
    onnotice: () => {},
    types: {
      /* dates and times stay as the server wrote them */
      nexora_timestamp: asText([1114, 1184]),
      nexora_date: asText([1082]),
      nexora_time: asText([1083, 1266]),
      nexora_interval: asText([1186]),
      /* big integers become numbers, as they do today */
      nexora_int8: asSafeInt([20]),
      /* float4, float8 and numeric all arrive as numbers */
      nexora_float: asFloat([700, 701, 1700]),
      /* json and jsonb: parsed on the way in, UNTOUCHED on the way out.
         The default here is JSON.stringify, and the text this file sends is
         already JSON — stringifying it again turns an object into a quoted
         string. See `query`. */
      nexora_json: { to: 3802, from: [114, 3802], serialize: (v) => v, parse: (v) => JSON.parse(v) },
      /* bool: 't'/'f' from the server, and 'true'/'false' out, which is
         what pgmini sends and what Postgres reads either way */
      nexora_bool: { to: 16, from: [16], serialize: (v) => v, parse: (v) => v === 't' },
      /* bytea: pgmini hands back the raw '\\x…' string; the default here
         would hand back a Buffer */
      nexora_bytea: { to: 17, from: [17], serialize: (v) => v, parse: (v) => v }
    }
  });
}

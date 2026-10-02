/**
 * Nexora API — company registration  (4.23.0)
 * ======================================================================
 * "on first time user will register company create his id and passcode,
 *  software will track ip address of pc, email id and gst no and mobile
 *  number for prevent dummy, gst will be checked via online also."
 *
 * Until now a company came into being one of two ways: the owner created
 * it in the console and handed over a licence key, or a download started
 * a nameless demo. This is the third and, from here on, the ordinary one:
 * the plant registers itself.
 *
 * WHAT IS RECORDED, AND WHY EACH THING
 *   company name, GSTIN, email, mobile   who they are — and the three
 *                                        things a dummy registration
 *                                        cannot easily invent twice
 *   company login id + passcode          how their OTHER machines join:
 *                                        instead of a licence key, the
 *                                        second computer activates with
 *                                        the id and passcode (activate())
 *   the device id                        this computer, as every
 *                                        activation records it
 *   the IP the request came from         read from the connection on the
 *                                        server, never from the body —
 *                                        a client cannot lie about it
 *   the first administrator (name+PIN)   the per-person sign-in the
 *                                        company already has (4.8.0) is
 *                                        kept as its own layer: the
 *                                        passcode opens the company, the
 *                                        PIN identifies the person
 *
 * DUMMY PREVENTION — the owner's rule (2026-09-15): refuse outright if
 * the GSTIN, the device or the email is already registered, and say
 * plainly to contact support. That rule applies to SELF-registration.
 * The console keeps its freedom to put two plants of one group on one
 * GSTIN, as company-test.mjs has always insisted.
 *
 * GST is checked for shape here, always, and for truth through the hook
 * in gst.js — which answers UNVERIFIED until a verification service is
 * configured, and never blocks a registration by being unreachable.
 */
import { q, getSettings, logEvent } from './db.js';
import { newLicenceKey, issueToken, describe, companyUsage, deviceKeyHash, settleDeviceKey, deviceKeyRefused } from './licence.js';
import { ensureAdmin } from './sync.js';
import { hashPasscode, validPasscode, PASSCODE_MIN } from './passcode.js';
import { validGstinShape, verifyGstin } from './gst.js';

const DEVICE_RE = /^[a-f0-9]{16,64}$/i;
const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const SUPPORT_LINE = 'Contact Nexora support and quote the details you entered — they will sort it out.';

/* 4.72.0 (audit 41) — A PLAIN E-MAIL ADDRESS, AND NOTHING THAT CAN RIDE ON ONE.
   An address typed into a public form ends up in a mailto: link in both
   consoles. "a@b.com?bcc=x%40y.com&body=…" passed the old check (one @, a
   dot after it, no spaces), and the reply the owner then wrote went to a
   hidden third address. An address is now letters, digits and . _ + ' -
   before the @, and a domain of letters, digits and hyphens after it: no
   ? & = % , ; < > quotes, slashes, colons or spaces, so a mailto: built
   from it can only ever address that one mailbox. (enquiries, problem
   reports and registration read it through here.) */
const PLAIN_EMAIL_RE = /^[A-Za-z0-9._+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
export function plainEmail(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 160) return null;
  return PLAIN_EMAIL_RE.test(s) ? s : null;
}

/* 4.72.0 (audit 8) — REGISTERING, FROM ONE ADDRESS, A FEW TIMES AN HOUR.
   Registering is open to anyone (it is how a company comes to exist), and
   every call that gets past the form's own checks costs a look at the
   companies and, when it succeeds, a company, a licence row, an
   administrator and two scrypt hashes. Five such calls an hour from one
   address is more than any plant registering itself needs, mistakes
   included; the sixth is answered 429 TOO_MANY. Kept in memory and keyed on
   remoteIp() — on Render the address Cloudflare saw, which the caller
   cannot write. A request with no address at all (the suites, a local run)
   is not counted. */
const REG_SEEN = new Map();
const REG_WINDOW_MS = 60 * 60 * 1000;
export const REG_PER_WINDOW = 5;
function registerThrottled(ip) {
  if (!ip) return { over: false };
  const now = Date.now();
  const hits = (REG_SEEN.get(ip) || []).filter((t) => now - t < REG_WINDOW_MS);
  hits.push(now);
  REG_SEEN.set(ip, hits);
  if (REG_SEEN.size > 5000) {
    for (const [k, v] of REG_SEEN) if (!v.some((t) => now - t < REG_WINDOW_MS)) REG_SEEN.delete(k);
  }
  return { over: hits.length > REG_PER_WINDOW, first: hits.length === REG_PER_WINDOW + 1,
    retryAfter: Math.max(1, Math.ceil((hits[0] + REG_WINDOW_MS - now) / 1000)) };
}

/** "+91 98250 00000" → "919825000000"; a number needs 10 to 15 digits. */
export function normaliseMobile(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

/** The client's address, from the connection and nothing else. */
export function remoteIp(request) {
  const h = request && request.headers;
  if (!h || typeof h.get !== 'function') return null;
  const clip = (v) => { const s = String(v || '').trim(); return s ? s.slice(0, 64) : null; };
  /* 4.71.0 (audit) — WHICH ADDRESS CAN BE BELIEVED.
     On Render the service sits behind Cloudflare (every answer carries
     "server: cloudflare" and a CF-RAY). Cloudflare APPENDS the address that
     connected to it to whatever x-forwarded-for the client already sent, so
     the FIRST address there — what this read until now — is whatever the
     client chose to write: a robot could pass every throttle (enquiries,
     reports, the console key) simply by writing a new one each time.
     cf-connecting-ip is written by Cloudflare itself for every request and
     replaces any the client sent, so on Render that is the address. If it
     is ever missing, the LAST x-forwarded-for address — the one added by the
     proxy nearest the client — and then the socket.
     Anywhere else (this machine, the test suites) there is no Cloudflare in
     front, a cf-connecting-ip would be the client's own writing, and the
     old reading stands: the first x-forwarded-for address, then the socket
     address server.js puts in x-nexora-remote (which a client cannot set). */
  if (process.env.RENDER) {
    const cf = clip(h.get('cf-connecting-ip'));
    if (cf) return cf;
    const chain = String(h.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) return clip(chain[chain.length - 1]);
    return clip(h.get('x-nexora-remote'));
  }
  const fwd = String(h.get('x-forwarded-for') || '').split(',')[0].trim();
  if (fwd) return fwd.slice(0, 64);
  return clip(h.get('x-nexora-remote'));
}

function refuse(httpStatus, error, message, extra) {
  return { httpStatus, body: Object.assign({ error, message }, extra || {}) };
}

/**
 * Register a company on this device. Resolves { httpStatus, body } like
 * activate(); on success the body carries a token already signed in as
 * the first administrator, the licence, the user and the company.
 */
export async function register(body, request) {
  const b = body || {};
  const deviceId = String(b.deviceId || '');
  if (!DEVICE_RE.test(deviceId)) {
    return refuse(400, 'BAD_DEVICE_ID', 'This installation could not identify the computer it is running on.');
  }
  const company = String(b.company || '').trim();
  const gstin = String(b.gstin || '').trim().toUpperCase();
  const email = String(b.email || '').trim().toLowerCase();
  const mobile = normaliseMobile(b.mobile);
  const loginId = String(b.loginId || '').trim().toLowerCase();
  const passcode = b.passcode == null ? '' : String(b.passcode);
  const adminName = String(b.adminName || '').trim();
  const adminPin = b.adminPin == null ? '' : String(b.adminPin);

  if (!company) return refuse(400, 'BAD_COMPANY', 'Enter the company name.');
  if (!validGstinShape(gstin)) return refuse(400, 'BAD_GSTIN', 'That is not the shape of a GSTIN — fifteen characters, like 24AAACS1429B1ZQ.');
  if (!plainEmail(email)) return refuse(400, 'BAD_EMAIL', 'Enter a working email address.');
  if (!mobile) return refuse(400, 'BAD_MOBILE', 'Enter a mobile number with its country code — ten to fifteen digits.');
  if (!LOGIN_RE.test(loginId)) return refuse(400, 'BAD_LOGIN_ID', 'A company login id is 3 to 32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.');
  if (!validPasscode(passcode)) return refuse(400, 'BAD_PASSCODE', 'The company passcode needs at least ' + PASSCODE_MIN + ' characters.');
  if (!adminName) return refuse(400, 'BAD_ADMIN', 'Enter the name of the first administrator — that is you.');
  if (String(adminPin).length < 4) return refuse(400, 'BAD_PIN', 'A PIN of at least 4 characters is required.');

  /* 4.72.0 (audit 8) — a few registrations an hour from one address (see registerThrottled). Counted only once the
     form is complete: somebody correcting a typing mistake is not held back by it. */
  const turn = registerThrottled(remoteIp(request));
  if (turn.over) {
    if (turn.first) await logEvent(deviceId, 'REGISTER_REFUSED', { reason: 'TOO_MANY', ip: remoteIp(request) });
    return refuse(429, 'TOO_MANY', 'Too many registrations from this connection in the last hour. Try again later, or contact Nexora.', { retryAfter: turn.retryAfter });
  }

  const settings = await getSettings();
  if (!settings.signupsOpen) {
    return refuse(403, 'SIGNUPS_CLOSED', 'New registrations are not being taken at the moment. Please contact Nexora.');
  }

  /* ---- dummy prevention: refuse, and say so ---------------------- */
  const dupGst = await q(`SELECT id, name FROM companies WHERE gstin = $1 LIMIT 1`, [gstin]);
  if (dupGst.length) {
    await logEvent(deviceId, 'REGISTER_REFUSED', { reason: 'GSTIN', gstin, ip: remoteIp(request) });
    return refuse(409, 'ALREADY_REGISTERED', 'This GSTIN is already registered with Nexora. ' + SUPPORT_LINE, { field: 'gstin' });
  }
  const dupEmail = await q(`SELECT id FROM companies WHERE lower(email) = $1 LIMIT 1`, [email]);
  if (dupEmail.length) {
    await logEvent(deviceId, 'REGISTER_REFUSED', { reason: 'EMAIL', email, ip: remoteIp(request) });
    return refuse(409, 'ALREADY_REGISTERED', 'This email address is already registered with Nexora. ' + SUPPORT_LINE, { field: 'email' });
  }
  /* 4.66.3 — "ek j gst number, ek j pc par, ek j number thi be var demo na lai sake": the
     mobile number too. Compared on its last ten digits, so +91 and 0-prefixed
     spellings of one number are the same number. */
  const dupMobile = await q(`SELECT id FROM companies WHERE length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) >= 10
       AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = right($1, 10) LIMIT 1`, [mobile]);
  if (dupMobile.length) {
    await logEvent(deviceId, 'REGISTER_REFUSED', { reason: 'MOBILE', mobile, ip: remoteIp(request) });
    return refuse(409, 'ALREADY_REGISTERED', 'This mobile number is already registered with Nexora. ' + SUPPORT_LINE, { field: 'mobile' });
  }
  const dupSeat = await q(`SELECT id FROM companies WHERE registered_device = $1 LIMIT 1`, [deviceId]);
  if (dupSeat.length) {
    await logEvent(deviceId, 'REGISTER_REFUSED', { reason: 'DEVICE', ip: remoteIp(request) });
    return refuse(409, 'ALREADY_REGISTERED', 'This computer has already taken a demo with Nexora. Activate it with your company id and passcode, or with your licence key. ' + SUPPORT_LINE, { field: 'device' });
  }
  const dupDevice = await q(`SELECT device_id FROM licences WHERE device_id = $1 LIMIT 1`, [deviceId]);
  if (dupDevice.length) {
    await logEvent(deviceId, 'REGISTER_REFUSED', { reason: 'DEVICE', ip: remoteIp(request) });
    return refuse(409, 'ALREADY_REGISTERED', 'This computer is already registered with Nexora. Activate it with your company id and passcode, or with your licence key. ' + SUPPORT_LINE, { field: 'device' });
  }
  const dupLogin = await q(`SELECT id FROM companies WHERE login_id = $1 LIMIT 1`, [loginId]);
  if (dupLogin.length) {
    return refuse(409, 'LOGIN_ID_TAKEN', 'That company login id is taken. Choose another.', { field: 'loginId' });
  }

  /* ---- GST: shape passed; ask the service if there is one ---------- */
  const gst = await verifyGstin(gstin);
  if (gst.status === 'FAILED') {
    await logEvent(deviceId, 'REGISTER_REFUSED', { reason: 'GST_FAILED', gstin, detail: gst.reason, ip: remoteIp(request) });
    return refuse(422, 'GSTIN_REJECTED', 'The GST verification service does not recognise this GSTIN: ' + gst.reason + ' ' + SUPPORT_LINE, { field: 'gstin' });
  }

  /* ---- the company ------------------------------------------------- */
  const ip = remoteIp(request);
  let co = null;
  for (let attempt = 0; attempt < 5 && !co; attempt++) {
    const key = newLicenceKey();
    try {
      const rows = await q(
        `INSERT INTO companies (name, licence_key, email, phone, gstin, state, seats, grace_days, is_demo, expires_at,
                                login_id, passcode_hash, self_registered, registered_ip, registered_device, registered_at,
                                gst_status, gst_checked_at, gst_note)
         VALUES ($1, $2, $3, $4, $5, 'DEMO', 1, $6, true, nexora_eod(now() + make_interval(days => $7::int)),
                 $8, $9, true, $10, $11, now(), $12, $13::timestamptz, $14)
         RETURNING *`,
        [company, key, email, mobile, gstin, settings.demoGraceDays, settings.trialDays,
         loginId, hashPasscode(passcode), ip, deviceId,
         gst.status, gst.checkedAt, gst.status === 'VERIFIED' ? (gst.legalName || null) : (gst.reason || null)]);
      if (rows.length) co = rows[0];
    } catch (e) {
      /* A key collision retries; a login id or GSTIN race is a refusal. */
      const msg = String(e && e.message || '');
      if (/login/i.test(msg)) return refuse(409, 'LOGIN_ID_TAKEN', 'That company login id is taken. Choose another.', { field: 'loginId' });
      if (!/unique|duplicate/i.test(msg)) throw e;
    }
  }
  if (!co) throw new Error('Could not allocate a licence key.');

  /* ---- this computer takes seat 1 ---------------------------------- */
  /* C7 — holding this installation's device key (its sha256 only; licence.js), so that knowing this
     computer's id is never enough to activate another machine as it */
  const keyHash = deviceKeyHash(b.deviceKey);
  const lic = await q(
    /* 4.71.0 — the company's first computer: approved as it registers (nobody else could approve it) */
    `INSERT INTO licences (device_id, device_name, company, email, state,
                           trial_started_at, expires_at, app_version, last_seen_at, seen_count, company_id, seat_no,
                           approved_at, approved_by, device_key_hash)
     VALUES ($1, $2, $3, $4, 'TRIAL', now(), $5::timestamptz, $6, now(), 1, $7, 1, now(), 'registered the company', $8)
     ON CONFLICT (device_id) DO NOTHING
     RETURNING *`,
    [deviceId, b.deviceName || null, company, email, co.expires_at, b.appVersion || null, co.id, keyHash]);
  const row = lic.length ? lic[0] : (await q(`SELECT * FROM licences WHERE device_id = $1`, [deviceId]))[0];
  /* C7 — a row that appeared between the check above and this insert is somebody else's unless it holds this key */
  if (!lic.length && !(await settleDeviceKey(row, keyHash))) return deviceKeyRefused(deviceId, 'register', keyHash, row && row.company_id);

  /* ---- the first administrator, signed in ----------------------------- */
  const admin = await ensureAdmin(co.id, { name: adminName, pin: adminPin });
  if (!admin.ok) return refuse(400, 'BAD_ADMIN', admin.error || 'The administrator could not be created.');
  /* 4.72.0 — AND SIGNED IN HERE. The token below names the administrator, but since 2026-09-28 a person is
     signed in on a machine only when their binding says so (licence.js authorise: an empty binding is "signed
     out"), and nothing set it — so this computer was told at its first call that the administrator had been
     signed out (the desktop hid it by signing in again a moment later). The binding is now this computer's,
     exactly as /v1/login would leave it. */
  await q(`UPDATE company_users SET session_device = $2, session_at = now() WHERE id = $1 AND company_id = $3`,
    [admin.user.id, deviceId, co.id]);

  await logEvent(deviceId, 'REGISTER', { companyId: co.id, gstin, email, mobile, loginId, ip, gst: gst.status, appVersion: b.appVersion || null });
  const usage = await companyUsage(co.id);
  return { httpStatus: 200, body: {
    token: issueToken(row, admin.user.id),
    licence: describe(row, co, settings, usage),
    user: admin.user,
    company: { id: co.id, name: co.name, loginId, gstin, gstStatus: gst.status, gstNote: gst.status === 'VERIFIED' ? (gst.legalName || null) : gst.reason },
    registered: true
  } };
}

/** The owner re-runs the check from the console, or records a manual
 *  verdict when the number was checked by hand. */
export async function gstAction(body) {
  const id = parseInt(body && body.id, 10);
  if (!id) return { httpStatus: 400, body: { error: 'BAD_ID', message: 'Which company?' } };
  const rows = await q(`SELECT id, gstin FROM companies WHERE id = $1`, [id]);
  if (!rows.length) return { httpStatus: 404, body: { error: 'NO_COMPANY', message: 'No such company.' } };
  const action = String(body.action || '');
  if (action === 'gstverify') {
    if (!rows[0].gstin) return { httpStatus: 400, body: { error: 'NO_GSTIN', message: 'This company has no GSTIN to verify.' } };
    const gst = await verifyGstin(rows[0].gstin);
    await q(`UPDATE companies SET gst_status = $2, gst_checked_at = $3::timestamptz, gst_note = $4 WHERE id = $1`,
      [id, gst.status, gst.checkedAt, gst.status === 'VERIFIED' ? (gst.legalName || null) : (gst.reason || null)]);
    await logEvent(null, 'ADMIN_GST_VERIFY', { id, status: gst.status });
    return { httpStatus: 200, body: { ok: true, gst } };
  }
  if (action === 'gstmark') {
    const status = body.status === 'VERIFIED' ? 'VERIFIED' : body.status === 'FAILED' ? 'FAILED' : 'UNVERIFIED';
    await q(`UPDATE companies SET gst_status = $2, gst_checked_at = now(), gst_note = $3 WHERE id = $1`,
      [id, status, String(body.note || '').trim() || (status === 'VERIFIED' ? 'Checked by hand' : null)]);
    await logEvent(null, 'ADMIN_GST_MARK', { id, status });
    return { httpStatus: 200, body: { ok: true, status } };
  }
  return { httpStatus: 400, body: { error: 'BAD_ACTION', message: 'Unknown action.' } };
}

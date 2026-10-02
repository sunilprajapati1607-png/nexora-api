/**
 * Nexora API — feedback and problem reports (4.45.0)
 * ----------------------------------------------------------------------
 * What a plant tells the owner from inside the application:
 *
 *   Help → Nexora Contact → Send feedback / Report a problem
 *
 * One table, two kinds. A BUG usually carries a picture of the screen
 * (a JPEG data URL taken by the desktop application before its dialog
 * went up); FEEDBACK is words. Both land here, and the licence console
 * and the phone console list them from the same rows.
 *
 * THE WAY IN IS PUBLIC, LIKE AN ENQUIRY — and deliberately as small: a
 * fixed set of fields, every one cut to a sane length, the picture
 * capped, a per-address throttle, and no way to read anything back. When
 * the application sends its licence token as well, the row is put
 * against the company the token belongs to, so the console shows WHICH
 * plant said it; without a token it is still kept, with whatever the
 * application typed in.
 */
import { q, logEvent } from './db.js';
import { plainEmail } from './register.js';

export const KINDS = ['FEEDBACK', 'BUG'];
export const STATES = ['NEW', 'SEEN', 'FIXED', 'CLOSED'];

/* A 1400px-wide JPEG of a busy screen is 150–350 KB as base64; this is
   room for a large one and a wall against a 30 MB bitmap.
   4.72.0 (audit 37) — 1 MB, down from 2.5 MB: the desktop never sends a
   picture wider than 1400px at JPEG quality 72 (main.js captureScreen). */
export const MAX_SHOT = 1000000;

/* 4.72.0 (audit 8, 37) — WHAT ONE DAY MAY ADD TO THE TABLE, whoever sends it.
   The per-address throttle below stops one sender; these stop many. A
   report from a machine with no good token (nothing says whose it is) is
   kept up to DAY_UNSIGNED a day; past that it is answered 503 BUSY, which
   the desktop reads as "keep it and send it later" (its outbox), so a real
   report is delayed, never lost. Pictures come only with a good token, and
   at most DAY_SHOT_BYTES of them a day: past that the report is still kept,
   without its picture. */
export const DAY_UNSIGNED = 300;
export const DAY_SHOT_BYTES = 50 * 1024 * 1024;

/* Every control character (a line break included) is a space: a name, an
   address or a subject is one line wherever it is shown. */
const CONTROL = /[\u0000-\u001f\u007f]+/g;
function clean(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(CONTROL, ' ').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
function cleanText(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
const SHOT_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function cleanShot(v) {
  if (typeof v !== 'string') return null;
  if (v.length > MAX_SHOT) return null;
  if (!SHOT_RE.test(v)) return null;
  return v;
}

/* 4.72.0 (audit 37) — PICTURES ARE NOT KEPT FOR EVER. A report's picture is
   cleared FEEDBACK_SHOT_DAYS days after it came in (90 unless set on Render;
   0 keeps them for ever); the report itself, its words and its state stay.
   Done at most twice a day, when a report arrives. */
const SWEEP_EVERY_MS = 12 * 60 * 60 * 1000;
let lastSweep = 0;
export function shotDays() {
  const raw = process.env.FEEDBACK_SHOT_DAYS;
  if (raw === undefined || String(raw).trim() === '') return 90;
  const n = parseInt(raw, 10);
  return n > 0 ? n : 0;
}
export async function sweepOldShots(force) {
  const days = shotDays();
  if (!days) return 0;
  if (!force && Date.now() - lastSweep < SWEEP_EVERY_MS) return 0;
  lastSweep = Date.now();
  try {
    const rows = await q(`UPDATE feedback SET shot = NULL
                           WHERE shot IS NOT NULL AND created_at < now() - make_interval(days => $1::int)
                       RETURNING id`, [days]);
    if (rows.length) await logEvent(null, 'FEEDBACK_SHOTS_CLEARED', { count: rows.length, olderThanDays: days });
    return rows.length;
  } catch (e) { return 0; }
}

function describe(r, withShot) {
  const out = {
    id: Number(r.id),
    kind: r.kind,
    subject: r.subject,
    message: r.message,
    name: r.name,
    phone: r.phone,
    email: r.email,
    company: r.company,
    companyId: r.company_id ? Number(r.company_id) : null,
    coName: r.co_name || null,
    licenceKey: r.licence_key,
    userName: r.user_name,
    deviceId: r.device_id,
    deviceName: r.device_name,
    appVersion: r.app_version,
    edition: r.edition,
    view: r.view,
    hasShot: !!(r.has_shot === true || r.has_shot === 't' || (r.shot && String(r.shot).length > 30)),
    state: r.state,
    reply: r.reply,
    remoteIp: r.remote_ip || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
  if (withShot) out.shot = r.shot || null;
  return out;
}

/* ---- the owner's side -------------------------------------------------- */

export async function listFeedback() {
  /* The picture is not in the list: three hundred reports with a picture
     each would be a hundred megabytes for a table. It is fetched one at
     a time, when one is opened. */
  const rows = await q(`
    SELECT f.id, f.kind, f.subject, f.message, f.name, f.phone, f.email, f.company, f.company_id,
           f.licence_key, f.user_name, f.device_id, f.device_name, f.app_version, f.edition, f.view,
           (f.shot IS NOT NULL AND length(f.shot) > 30) AS has_shot,
           f.state, f.reply, f.created_at, f.updated_at,
           c.name AS co_name
      FROM feedback f
      LEFT JOIN companies c ON c.id = f.company_id
     ORDER BY f.created_at DESC
     LIMIT 500`);
  return { feedback: rows.map((r) => describe(r, false)), kinds: KINDS, states: STATES };
}

export async function feedbackShot(id) {
  const n = parseInt(id, 10);
  if (!(n > 0)) return { error: 'Which report?' };
  const rows = await q(`SELECT id, shot FROM feedback WHERE id = $1`, [n]);
  if (!rows.length) return { error: 'That report is no longer here.' };
  /* 4.72.0 (audit 42) — the console puts this straight into an <img src="…">, so it goes out only if it is
     still exactly what cleanShot() lets in: a data: picture in base64 and nothing else. A row changed some
     other way (by hand in the database, say) is never handed to the page. */
  const shot = rows[0].shot || null;
  if (shot && !SHOT_RE.test(shot)) return { id: n, shot: null, error: 'That picture could not be shown safely.' };
  return { id: n, shot };
}

export async function feedbackAction(body) {
  const action = String(body.action || '');
  const id = parseInt(body.id, 10);
  if (!(id > 0)) return { error: 'Which report?' };
  const existing = await q(`SELECT * FROM feedback WHERE id = $1`, [id]);
  if (!existing.length) return { error: 'That report is no longer here.' };

  if (action === 'state') {
    if (!STATES.includes(body.state)) return { error: 'That is not a state a report can be in.' };
    const rows = await q(`UPDATE feedback SET state = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, body.state]);
    await logEvent(null, 'ADMIN_FEEDBACK_STATE', { id, state: body.state });
    return { ok: true, feedback: describe(rows[0], false), warning: `Marked ${body.state.toLowerCase()}.` };
  }
  if (action === 'reply') {
    const rows = await q(`UPDATE feedback SET reply = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, cleanText(body.reply, 4000)]);
    await logEvent(null, 'ADMIN_FEEDBACK_REPLY', { id });
    return { ok: true, feedback: describe(rows[0], false), warning: 'Note saved.' };
  }
  if (action === 'delete') {
    await q(`DELETE FROM feedback WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_FEEDBACK_DELETE', { id, subject: existing[0].subject });
    return { ok: true, removed: existing[0].subject || ('#' + id) };
  }
  return { error: 'That is not something that can be done to a report.' };
}

/* ---- the application's side ------------------------------------------- */

/* Ten reports an hour from one address: a plant with three machines on
   one connection can each report twice and still have room; nobody
   filling the table with rubbish gets far. */
const SEEN = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const PER_WINDOW = 10;
let capLogged = '';   /* the day the day-cap was last logged: once a day, not once per refusal */

function throttled(ip) {
  if (!ip) return false;
  const now = Date.now();
  const hits = (SEEN.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  SEEN.set(ip, hits);
  if (SEEN.size > 5000) {
    for (const [k, v] of SEEN) if (!v.some((t) => now - t < WINDOW_MS)) SEEN.delete(k);
  }
  return hits.length > PER_WINDOW;
}

/**
 * @param body   what the application sent
 * @param ip     the caller's address, for the throttle
 * @param auth   the result of authorise(), when the application sent its
 *               token and the token was good; null otherwise
 */
export async function publicFeedback(body, ip, auth) {
  let message = cleanText(body.message, 6000);
  if (!message) return { error: 'EMPTY', message: 'Write a line about it first.' };
  if (throttled(ip)) return { error: 'TOO_MANY', message: 'That is enough reports from here for an hour — thank you, we have them.' };

  /* 4.72.0 (audit 8, 37) — a picture only from a machine with a good token; the day's totals (one statement:
     reports with no good token, and the pictures' bytes) only when one of the two caps can apply */
  const signed = !!(auth && auth.company && auth.company.id);
  const shotOffered = typeof body.shot === 'string' && body.shot.length > 0;
  let shot = signed && shotOffered ? cleanShot(body.shot) : null;
  if (!signed || shot) {
    const day = (await q(`SELECT COUNT(*) FILTER (WHERE company_id IS NULL)::int AS unsigned,
                                 COALESCE(SUM(octet_length(shot)), 0)::bigint AS shot_bytes
                            FROM feedback WHERE created_at > now() - interval '1 day'`))[0] || {};
    if (!signed && Number(day.unsigned) >= DAY_UNSIGNED) {
      const today = new Date().toISOString().slice(0, 10);
      if (capLogged !== today) { capLogged = today; await logEvent(null, 'FEEDBACK_DAY_CAP', { unsigned: Number(day.unsigned) }); }
      return { error: 'BUSY', busy: true, message: 'Nexora has had a great many reports today. This one is kept on this computer and sent again later.' };
    }
    if (shot && Number(day.shot_bytes) + shot.length > DAY_SHOT_BYTES) shot = null;
  }

  /* 4.72.0 (audit 41) — an address that is not a plain one is not kept as an address (the consoles make a mailto:
     link of it); what was typed stays readable at the end of the message */
  const typedEmail = clean(body.email, 160);
  const email = plainEmail(typedEmail);
  if (typedEmail && !email) message = message + '\n\nE-mail as typed: ' + typedEmail;

  const kind = KINDS.includes(body.kind) ? body.kind : 'FEEDBACK';
  const company = (auth && auth.company && auth.company.name) || clean(body.company, 160);
  const companyId = (auth && auth.company && auth.company.id) ? Number(auth.company.id) : null;
  const licenceKey = (auth && auth.company && auth.company.licence_key) || clean(body.licenceKey, 60);
  const deviceId = (auth && auth.row && auth.row.device_id) || clean(body.deviceId, 80);
  const deviceName = (auth && auth.row && auth.row.device_name) || clean(body.deviceName, 120);
  const userName = (auth && auth.user && auth.user.name) || clean(body.user, 120);

  const rows = await q(
    `INSERT INTO feedback (kind, subject, message, name, phone, email, company, company_id, licence_key,
                           user_name, device_id, device_name, app_version, edition, view, shot, remote_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [
      kind,
      clean(body.subject, 160),
      message,
      clean(body.name, 120),
      clean(body.phone, 40),
      email,
      company,
      companyId,
      licenceKey,
      userName,
      deviceId,
      deviceName,
      clean(body.appVersion, 40),
      clean(body.edition, 20),
      clean(body.view, 80),
      shot,
      ip || null
    ]
  );
  const id = Number(rows[0].id);
  await logEvent(deviceId || null, kind === 'BUG' ? 'FEEDBACK_BUG' : 'FEEDBACK', { id, company, subject: clean(body.subject, 160) });
  await sweepOldShots(false);
  /* shotKept: whether the picture sent was kept (false: none came with a good token, or the day's are used up) */
  return shotOffered ? { ok: true, id, shotKept: !!shot } : { ok: true, id };
}

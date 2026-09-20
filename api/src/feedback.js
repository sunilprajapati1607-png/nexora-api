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

export const KINDS = ['FEEDBACK', 'BUG'];
export const STATES = ['NEW', 'SEEN', 'FIXED', 'CLOSED'];

/* A 1400px-wide JPEG of a busy screen is 150–350 KB as base64; this is
   room for a large one and a wall against a 30 MB bitmap. */
const MAX_SHOT = 2500000;

function clean(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
function cleanText(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
function cleanShot(v) {
  if (typeof v !== 'string') return null;
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return null;
  if (v.length > MAX_SHOT) return null;
  return v;
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
  return { id: n, shot: rows[0].shot || null };
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
  const message = cleanText(body.message, 6000);
  if (!message) return { error: 'EMPTY', message: 'Write a line about it first.' };
  if (throttled(ip)) return { error: 'TOO_MANY', message: 'That is enough reports from here for an hour — thank you, we have them.' };

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
      clean(body.email, 160),
      company,
      companyId,
      licenceKey,
      userName,
      deviceId,
      deviceName,
      clean(body.appVersion, 40),
      clean(body.edition, 20),
      clean(body.view, 80),
      cleanShot(body.shot),
      ip || null
    ]
  );
  const id = Number(rows[0].id);
  await logEvent(deviceId || null, kind === 'BUG' ? 'FEEDBACK_BUG' : 'FEEDBACK', { id, company, subject: clean(body.subject, 160) });
  return { ok: true, id };
}

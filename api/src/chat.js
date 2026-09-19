/**
 * Nexora API — the company's own conversation
 * ----------------------------------------------------------------------
 *   "add best ui base company internal chat window with tagging of
 *    documents and item code, only for inter company ... in this
 *    conversation username are included like sunil: hey how are u"
 *
 * A costing desk, a planner and a works manager talk about the same bag
 * all day, and until now they did it on WhatsApp — which means the
 * plant's costing conversation lives on three private phones, leaves with
 * whoever resigns, and cannot be searched by anybody who joins.
 *
 * So: one room per company, inside the software the work is already in.
 *
 * WHAT IT IS, AND WHAT IT DELIBERATELY IS NOT
 *
 *   · ONE ROOM. Not channels, not direct messages. A plant of five people
 *     does not need a directory of rooms to lose things in, and every
 *     channel added is a place a message can be missed.
 *   · COMPANY ONLY. company_id comes from the device row, exactly as
 *     every other scoped read does, so there is no request a client can
 *     make that reads another company's messages.
 *   · TAGS ARE REFERENCES, NOT ATTACHMENTS. A message can name a
 *     calculation, a BOM, a quotation or an item code; what travels is
 *     the NUMBER, and the reader's own installation opens its own copy.
 *     No costing, no price and no bag ever leaves the plant.
 *   · NOT EDITABLE. A message can be deleted by the person who wrote it
 *     or by an administrator, and that is all. A conversation that can be
 *     silently rewritten is worth nothing as a record of what was agreed.
 *
 * It is polled on the heartbeat the licence already runs, so a plant with
 * five machines makes no more calls than it did before.
 */
import { q, logEvent } from './db.js';

const MAX_BODY = 2000;
const MAX_TAGS = 12;

/* A tag is a pointer to something in the plant's own data. `kind` says
   which window opens it; `ref` is the number or code as the reader would
   type it. Nothing else is stored, because nothing else is needed and
   anything else would be the plant's data leaving the plant. */
const TAG_KINDS = { CALC: 1, BOM: 1, QUOTE: 1, ITEM: 1 };

function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    if (!t || typeof t !== 'object') continue;
    const kind = String(t.kind || '').toUpperCase();
    const ref = String(t.ref == null ? '' : t.ref).trim().slice(0, 60);
    if (!TAG_KINDS[kind] || !ref) continue;
    if (out.some((x) => x.kind === kind && x.ref === ref)) continue;
    out.push({ kind, ref });
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function describe(row) {
  return {
    id: Number(row.id),
    userId: row.user_id == null ? null : Number(row.user_id),
    name: row.name || 'somebody',
    body: row.body || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    at: row.at,
    deleted: row.deleted === true
  };
}

/** Say something. The NAME is written into the row as well as the id:
 *  a message should still read correctly when the person who wrote it has
 *  left and their row has gone. */
export async function send(companyId, actor, body) {
  if (!companyId) {
    return { httpStatus: 403, body: { error: 'NO_COMPANY', message: 'This installation is not on a company licence.' } };
  }
  if (!actor) {
    return { httpStatus: 401, body: { error: 'SIGN_IN', message: 'Sign in to say something.' } };
  }
  const text = String((body && body.body) || '').trim();
  if (!text) {
    return { httpStatus: 400, body: { error: 'EMPTY', message: 'There is nothing to send.' } };
  }
  const tags = cleanTags(body && body.tags);
  const rows = await q(
    `INSERT INTO chat_messages (company_id, user_id, name, body, tags)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [companyId, actor.id, actor.name || 'somebody', text.slice(0, MAX_BODY), JSON.stringify(tags)]);
  return { httpStatus: 200, body: { message: describe(rows[0]) } };
}

/** Everything said since the id the client already holds. Ascending, so a
 *  client appends rather than sorting, and capped so a machine that has
 *  been off for a month does not ask for a year in one call. */
export async function since(companyId, sinceId, limit) {
  if (!companyId) return { httpStatus: 200, body: { messages: [], next: 0 } };
  const from = Math.max(0, Math.floor(Number(sinceId) || 0));
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  /* The FIRST read of a machine that holds nothing asks for the last n
     rather than the first n: opening the window on a new installation
     should show the recent conversation, not the day the plant started. */
  const rows = from > 0
    ? await q(`SELECT * FROM chat_messages WHERE company_id = $1 AND id > $2
                ORDER BY id ASC LIMIT $3`, [companyId, from, n])
    : (await q(`SELECT * FROM chat_messages WHERE company_id = $1
                 ORDER BY id DESC LIMIT $2`, [companyId, n])).reverse();
  const list = rows.map(describe);
  return { httpStatus: 200, body: { messages: list, next: list.length ? list[list.length - 1].id : from } };
}

/** Remove one. The writer, or an administrator. The row stays with its
 *  body emptied rather than disappearing, so the conversation does not
 *  silently close up around a gap and leave the next reader wondering
 *  what the reply was to. */
export async function remove(companyId, actor, id) {
  if (!actor) return { httpStatus: 401, body: { error: 'SIGN_IN', message: 'Sign in first.' } };
  const rows = await q(`SELECT * FROM chat_messages WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!rows.length) return { httpStatus: 404, body: { error: 'NO_MESSAGE', message: 'That message is not here.' } };
  const row = rows[0];
  const mine = Number(row.user_id) === Number(actor.id);
  if (!mine && actor.role !== 'ADMIN') {
    return { httpStatus: 403, body: { error: 'NOT_YOURS', message: 'Only the person who wrote it, or an administrator, can remove a message.' } };
  }
  await q(`UPDATE chat_messages SET body = '', tags = '[]'::jsonb, deleted = true WHERE id = $1`, [id]);
  await logEvent(null, 'CHAT_DELETE', { companyId, id: Number(id), by: actor.id });
  const after = (await q(`SELECT * FROM chat_messages WHERE id = $1`, [id]))[0];
  return { httpStatus: 200, body: { message: describe(after) } };
}

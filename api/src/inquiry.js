/**
 * Nexora API — enquiries
 * ----------------------------------------------------------------------
 * A lead, from the first time anybody hears of them to the day they become
 * a company. Two ways in and they meet in the same table:
 *
 *   the website   POST /enquiry        (public, no key, honeypot, throttled)
 *   the owner     POST /admin/api/inquiry  action=create
 *
 * The public route is the only unauthenticated write in the whole service,
 * so it is deliberately small: a fixed set of fields, every one trimmed and
 * cut to a sane length, a honeypot, and a per-address throttle. It can
 * create a row and nothing else — it cannot read, change or delete one.
 */
import { q, logEvent } from './db.js';

/* The list the website's "I am interested in" select offers, plus the two
   the application itself sells. Anything else is kept verbatim but marked
   OTHER, so a new product on the site does not need a service release. */
export const PRODUCTS = [
  'Bag Weight & Cost Forecasting',
  'Nexora ERP',
  'Inventory & Roll Traceability',
  'HR & Payroll',
  'Maintenance',
  'Staff Tracking',
  'ERP Implementation',
  'Website Development',
  'Custom Software',
  'AMC & Support',
  'Jobwork Module',
  'Other'
];

export const STATES = ['NEW', 'CONTACTED', 'DEMO', 'QUOTED', 'WON', 'LOST'];

const SOURCES = ['WEBSITE', 'MANUAL', 'PHONE', 'WHATSAPP', 'REFERRAL', 'VISIT', 'EXHIBITION'];

function clean(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/* A message keeps its line breaks — it is the one field somebody actually
   wrote in paragraphs, and flattening it would lose what they meant. */
function cleanText(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function describe(r) {
  return {
    id: Number(r.id),
    name: r.name,
    company: r.company,
    phone: r.phone,
    email: r.email,
    product: r.product,
    message: r.message,
    state: r.state,
    source: r.source,
    sourcePage: r.source_page,
    channel: r.channel,
    notes: r.notes,
    followUp: r.follow_up,
    companyId: r.company_id ? Number(r.company_id) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/* ---- the owner's side -------------------------------------------------- */

export async function listInquiries() {
  const rows = await q(`
    SELECT i.*, c.name AS co_name
      FROM inquiries i
      LEFT JOIN companies c ON c.id = i.company_id
     ORDER BY i.created_at DESC
     LIMIT 1000`);
  return {
    inquiries: rows.map((r) => Object.assign(describe(r), { coName: r.co_name || null })),
    products: PRODUCTS,
    states: STATES,
    sources: SOURCES
  };
}

export async function inquiryAction(body) {
  const action = String(body.action || '');

  if (action === 'create') {
    const name = clean(body.name, 120);
    if (!name) return { error: 'A name is required.' };
    const rows = await q(
      `INSERT INTO inquiries (name, company, phone, email, product, message, state, source, channel, notes, follow_up)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        name,
        clean(body.company, 160),
        clean(body.phone, 40),
        clean(body.email, 160),
        clean(body.product, 80) || 'Other',
        cleanText(body.message, 4000),
        STATES.includes(body.state) ? body.state : 'NEW',
        SOURCES.includes(body.source) ? body.source : 'MANUAL',
        clean(body.channel, 40),
        cleanText(body.notes, 4000),
        body.followUp ? String(body.followUp).slice(0, 10) : null
      ]
    );
    await logEvent(null, 'ADMIN_INQUIRY_CREATE', { id: Number(rows[0].id), name });
    return { ok: true, inquiry: describe(rows[0]) };
  }

  const id = parseInt(body.id, 10);
  if (!(id > 0)) return { error: 'Which enquiry?' };
  const existing = await q(`SELECT * FROM inquiries WHERE id = $1`, [id]);
  if (!existing.length) return { error: 'That enquiry is no longer here.' };

  if (action === 'state') {
    if (!STATES.includes(body.state)) return { error: 'That is not a state an enquiry can be in.' };
    const rows = await q(
      `UPDATE inquiries SET state = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, body.state]
    );
    await logEvent(null, 'ADMIN_INQUIRY_STATE', { id, state: body.state });
    return { ok: true, inquiry: describe(rows[0]), warning: `Marked ${body.state.toLowerCase()}.` };
  }

  if (action === 'update') {
    /* Only the fields that were actually sent are touched, so the phone can
       send one changed field without having to echo the whole row back. */
    const patch = [];
    const vals = [id];
    const set = (col, v) => { vals.push(v); patch.push(`${col} = $${vals.length}`); };

    if ('name' in body) { const n = clean(body.name, 120); if (!n) return { error: 'A name is required.' }; set('name', n); }
    if ('company' in body) set('company', clean(body.company, 160));
    if ('phone' in body) set('phone', clean(body.phone, 40));
    if ('email' in body) set('email', clean(body.email, 160));
    if ('product' in body) set('product', clean(body.product, 80) || 'Other');
    if ('message' in body) set('message', cleanText(body.message, 4000));
    if ('notes' in body) set('notes', cleanText(body.notes, 4000));
    if ('source' in body) set('source', SOURCES.includes(body.source) ? body.source : 'MANUAL');
    if ('channel' in body) set('channel', clean(body.channel, 40));
    if ('state' in body && STATES.includes(body.state)) set('state', body.state);
    if ('followUp' in body) set('follow_up', body.followUp ? String(body.followUp).slice(0, 10) : null);
    if ('companyId' in body) {
      const cid = parseInt(body.companyId, 10);
      set('company_id', cid > 0 ? cid : null);
    }
    if (!patch.length) return { error: 'Nothing to change.' };

    const rows = await q(
      `UPDATE inquiries SET ${patch.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      vals
    );
    await logEvent(null, 'ADMIN_INQUIRY_UPDATE', { id, fields: patch.length });
    return { ok: true, inquiry: describe(rows[0]), warning: 'Saved.' };
  }

  if (action === 'delete') {
    await q(`DELETE FROM inquiries WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_INQUIRY_DELETE', { id, name: existing[0].name });
    return { ok: true, removed: existing[0].name };
  }

  return { error: 'That is not something that can be done to an enquiry.' };
}

/* ---- the website's side ------------------------------------------------ */

/* One address may leave six enquiries an hour. Enough for somebody who
   fills the form twice because they mistyped their number; not enough to
   be worth anybody's while as a way of filling the table with rubbish. */
const SEEN = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const PER_WINDOW = 6;

function throttled(ip) {
  if (!ip) return false;
  const now = Date.now();
  const hits = (SEEN.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  SEEN.set(ip, hits);
  /* The map is swept whenever it gets large, so a long-running process
     cannot grow one entry per address for ever. */
  if (SEEN.size > 5000) {
    for (const [k, v] of SEEN) if (!v.some((t) => now - t < WINDOW_MS)) SEEN.delete(k);
  }
  return hits.length > PER_WINDOW;
}

/**
 * The website's forms. Answers 200 to anything that is not obviously abuse,
 * including a throttled or empty post — a visitor must never be told which
 * of their attempts the service decided to keep.
 */
export async function publicInquiry(body, ip) {
  /* The honeypot the site already carries. A real visitor never sees the
     field, so anything in it is a robot and the row is simply not written. */
  if (clean(body._gotcha, 40)) return { ok: true };

  const name = clean(body.name, 120);
  const phone = clean(body.phone, 40);
  const email = clean(body.email, 160);
  if (!name) return { ok: true };
  if (!phone && !email) return { ok: true };
  if (throttled(ip)) return { ok: true };

  const rows = await q(
    `INSERT INTO inquiries (name, company, phone, email, product, message, source, source_page, channel, remote_ip)
     VALUES ($1,$2,$3,$4,$5,$6,'WEBSITE',$7,$8,$9) RETURNING id`,
    [
      name,
      clean(body.company, 160),
      phone,
      email,
      clean(body.interest || body.product, 80) || 'Other',
      cleanText(body.message, 4000),
      clean(body.source_page || body.sourcePage, 300),
      clean(body.channel_chosen || body.channel, 40),
      ip || null
    ]
  );
  await logEvent(null, 'INQUIRY_WEBSITE', { id: Number(rows[0].id), name });
  return { ok: true };
}

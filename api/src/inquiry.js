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
import { plainEmail } from './register.js';

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

/* 4.72.0 (audit 41) — every control character (a line break included) is a space: a name, a phone or an
   address is one line wherever it is shown, and never carries a second one */
const CONTROL = /[\u0000-\u001f\u007f]+/g;
function clean(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(CONTROL, ' ').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/* 4.72.0 (audit 41) — what the console may store as an e-mail address: blank, or a plain address (register.js
   plainEmail — nothing a mailto: link could carry a hidden copy or a ready-made text on). The owner typing one
   that is not is told so, rather than having it changed. */
const BAD_EMAIL = 'That e-mail address does not look right: letters, digits and . _ + \' - before the @, a domain after it, no spaces.';
function consoleEmail(v) {
  const typed = clean(v, 160);
  if (!typed) return { ok: true, value: null };
  const e = plainEmail(typed);
  return e ? { ok: true, value: e } : { ok: false };
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
    /* 4.73.0 — C17: the website's form 2 (null on every enquiry from before it, and on one typed in by hand) */
    location: r.location || null,
    website: r.website || null,
    products: Array.isArray(r.products) ? r.products : null,
    productOther: r.product_other || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/* ---- 4.73.0 — C17: THE WEBSITE'S ENQUIRY FORM 2 ----------------------------------
   Owner 2026-10-02: "location of manufacturing, website, product range … all information mandatory", and
   (the same day) "E-mail રાખો, પણ ફરજિયાત નહીં" — keep the e-mail, not required. The form adds three things
   and posts { …as before…, form: 2, location, website, products: [ticks], productOther }. With form 2 the
   service requires what the page requires — the fields it always required (name, company, phone, interest,
   message) and the three new ones (location, website, at least one product tick; the words beside "Other"
   when Other is ticked) — answering 400 { error: 'MISSING', field, message } for the first one missing, in the
   page's own order (fields: every one). The e-mail may be left empty; one that is given must be a plain
   address (register.js plainEmail, as the page checks it too) or it is 400 { error: 'BAD_EMAIL', field:
   'email', message }. A post without `form` is a page cached from before (or another form) and is taken
   exactly as before. Plain text only: control characters become spaces, each field is cut to its length (the
   page's own maxlength or more); a tick is kept only if it is one of the form's own (FORM_PRODUCTS, matched
   whatever its case or spacing), each once, in the form's order. */
export const FORM_PRODUCTS = ['BOPP bags', 'Tape', 'Fabric', 'BOPP printing', 'Block bottom bags', 'Pinch bottom bags', 'Other'];
const productKey = (v) => String(v == null ? '' : v).replace(CONTROL, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
export function formProducts(v) {
  const sent = (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])).slice(0, 40).map(productKey);
  return FORM_PRODUCTS.filter((p) => sent.indexOf(p.toLowerCase()) > -1);
}
/* the page's order and its words (D:\nexora-website assets/js/site.js NEED) */
const FORM2_WORDS = {
  name: 'Please enter your name.',
  company: 'Please enter your company or plant name.',
  phone: 'Please enter your WhatsApp / mobile number.',
  email: 'Please enter a valid email address, like name@company.com — or leave it empty.',
  location: 'Please enter your manufacturing location — city and state.',
  website: 'Please enter your company website.',
  products: 'Please tick at least one product in your range.',
  productOther: 'Please write your other products.',
  interest: 'Please choose what you are interested in.',
  message: 'Please write a short message.'
};
/** form 2, read and checked → { ok: true, location, website, products, productOther } or
 *  { ok: false, error: 'MISSING' | 'BAD_EMAIL', field, fields } (the first, and every missing one) */
export function readForm2(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { location: clean(b.location, 160), website: clean(b.website, 300), products: formProducts(b.products),
    productOther: clean(b.productOther, 160) };
  const missing = [];
  if (!clean(b.name, 120)) missing.push('name');
  if (!clean(b.company, 160)) missing.push('company');
  if (!clean(b.phone, 40)) missing.push('phone');
  if (!out.location) missing.push('location');
  if (!out.website) missing.push('website');
  if (!out.products.length) missing.push('products');
  else if (out.products.indexOf('Other') > -1 && !out.productOther) missing.push('productOther');
  if (!clean(b.interest || b.product, 80)) missing.push('interest');
  if (!cleanText(b.message, 4000)) missing.push('message');
  if (missing.length) return { ok: false, error: 'MISSING', field: missing[0], fields: missing };
  /* optional — but one that is typed must be an address that can be written to */
  const typed = clean(b.email, 160);
  if (typed && !plainEmail(typed)) return { ok: false, error: 'BAD_EMAIL', field: 'email', fields: ['email'] };
  return Object.assign({ ok: true }, out);
}
const isForm2 = (v) => v === 2 || v === '2';

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
    const em = consoleEmail(body.email);
    if (!em.ok) return { error: BAD_EMAIL };
    const rows = await q(
      `INSERT INTO inquiries (name, company, phone, email, product, message, state, source, channel, notes, follow_up)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        name,
        clean(body.company, 160),
        clean(body.phone, 40),
        em.value,
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
    if ('email' in body) { const em = consoleEmail(body.email); if (!em.ok) return { error: BAD_EMAIL }; set('email', em.value); }
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

/* 4.72.0 (audit 37) — AND THE WEBSITE AS A WHOLE, DAY_WEBSITE A DAY. The
   per-address throttle stops one sender; many addresses at once used to be
   able to write without end, pushing real leads out of the console's list
   (which shows the newest thousand). Past this many website enquiries in a
   day the form still answers { ok: true } — a robot learns nothing — but
   nothing more is written, and the event log says so once that day. */
export const DAY_WEBSITE = 200;
let capLogged = '';

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

  /* 4.73.0 — C17: form 2's fields are required here as on the page (readForm2). Said before anything is
     counted against the address, so a visitor who left one out and sends again is not throttled for it.
     → { httpStatus: 400, body } (index.js answers it as it is); every other answer is the 200 { ok: true }. */
  let form2 = null;
  if (isForm2(body.form)) {
    form2 = readForm2(body);
    if (!form2.ok) {
      return { httpStatus: 400, body: { error: form2.error, field: form2.field, fields: form2.fields, message: FORM2_WORDS[form2.field] } };
    }
  }

  const name = clean(body.name, 120);
  const phone = clean(body.phone, 40);
  const typedEmail = clean(body.email, 160);
  if (!name) return { ok: true };
  if (!phone && !typedEmail) return { ok: true };
  if (throttled(ip)) return { ok: true };

  /* 4.72.0 (audit 37) — the website's day (DAY_WEBSITE) */
  const day = (await q(`SELECT COUNT(*)::int AS n FROM inquiries WHERE source = 'WEBSITE' AND created_at > now() - interval '1 day'`))[0];
  if (day && Number(day.n) >= DAY_WEBSITE) {
    const today = new Date().toISOString().slice(0, 10);
    if (capLogged !== today) { capLogged = today; await logEvent(null, 'INQUIRY_DAY_CAP', { website: Number(day.n) }); }
    return { ok: true };
  }

  /* 4.72.0 (audit 41) — an address that is not a plain one is not kept as an address (the consoles make a
     mailto: link of it); what was typed is kept, readable, at the end of the message, so the lead is not lost */
  const email = plainEmail(typedEmail);
  let message = cleanText(body.message, 4000);
  if (typedEmail && !email) message = (message ? message + '\n\n' : '') + 'E-mail as typed: ' + typedEmail;

  const rows = await q(
    `INSERT INTO inquiries (name, company, phone, email, product, message, source, source_page, channel, remote_ip,
                            location, website, products, product_other)
     VALUES ($1,$2,$3,$4,$5,$6,'WEBSITE',$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING id`,
    [
      name,
      clean(body.company, 160),
      phone,
      email,
      clean(body.interest || body.product, 80) || 'Other',
      message,
      clean(body.source_page || body.sourcePage, 300),
      clean(body.channel_chosen || body.channel, 40),
      ip || null,
      /* 4.73.0 — C17: form 2's fields (NULL from an older page) */
      form2 ? form2.location : null,
      form2 ? form2.website : null,
      form2 ? JSON.stringify(form2.products) : null,
      form2 ? form2.productOther : null
    ]
  );
  await logEvent(null, 'INQUIRY_WEBSITE', { id: Number(rows[0].id), name, form: form2 ? 2 : 1 });
  return { ok: true };
}

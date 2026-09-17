/**
 * Nexora API — the admin console
 * ----------------------------------------------------------------------
 * "which can be handled by me". This is that: one page, served by the
 * same function, listing every installation with its state and clock, and
 * the four things an owner actually needs to do — extend a trial, turn a
 * trial into a licence, revoke one, and stop issuing new trials.
 *
 * Guarded by a single admin key sent as a header. That is deliberately
 * modest security for a deliberately modest tool: it exposes no customer
 * data beyond what the owner already has, and it can be replaced with
 * real accounts the day there is more than one operator.
 */
import { q, getSettings, logEvent } from './db.js';
import { newLicenceKey } from './licence.js';
import { ensureAdmin, usersSummary, userCap } from './sync.js';

const ADMIN_KEY = process.env.NEXORA_ADMIN_KEY || '';

export function adminAuthorised(request) {
  const k = request.headers.get('x-admin-key') || '';
  return !!ADMIN_KEY && k === ADMIN_KEY;
}

export async function listLicences() {
  /* Joined to companies so one screen answers the question that matters:
     which customer is this machine, and how many of their seats are gone.
     LEFT JOIN, and COALESCE on the expiry, so a pre-4.0.0 row that has not
     been adopted yet still lists correctly instead of vanishing. */
  const rows = await q(`
    SELECT l.device_id, l.device_name, l.company, l.email, l.state, l.trial_started_at,
           l.created_at, l.last_seen_at, l.seen_count, l.app_version, l.notes,
           l.company_id, l.seat_no,
           /* 4.6.0 — net of any owner reset, the same figure the licence
              is judged on. The raw report stays in the row. */
           GREATEST(0, l.txn_count - l.txn_base)::int         AS txn_count,
           GREATEST(0, l.usage_minutes - l.usage_base)::int  AS usage_minutes,
           l.usage_reset_at,
           c.name AS co_name, c.licence_key AS co_key, c.state AS co_state,
           c.seats AS co_seats, c.is_demo AS co_is_demo,
           COALESCE(c.expires_at, l.expires_at) AS expires_at,
           GREATEST(0, ((COALESCE(c.expires_at, l.expires_at) AT TIME ZONE INTERVAL '+05:30')::date
                        - (now() AT TIME ZONE INTERVAL '+05:30')::date))::int AS days_left,
           (COALESCE(c.expires_at, l.expires_at) < now()) AS expired
      FROM licences l
      LEFT JOIN companies c ON c.id = l.company_id
     ORDER BY l.created_at DESC
     LIMIT 500`);
  const settings = await getSettings();
  return { licences: rows, companies: await listCompanies(), settings };
}

/* ---- companies (4.0.0) -----------------------------------------------
   The company IS the licence: one key, N seats, one clock, one state.
   Everything here acts on the company, so a customer's five machines are
   extended, suspended and restored together and can never drift apart. */

export async function listCompanies() {
  const rows = await q(`
    SELECT c.id, c.name, c.licence_key, c.email, c.phone, c.state, c.seats, c.gstin,
           c.grace_days, c.is_demo, c.expires_at, c.created_at, c.notes, c.txn_limit,
           /* 4.23.0 — self-registration: who registered, from where, and
              what the GST check said. The passcode hash is never listed. */
           c.login_id, c.self_registered, c.registered_ip, c.registered_device, c.registered_at,
           c.gst_status, c.gst_checked_at, c.gst_note,
           /* 4.31.0 — calendar days in IST; expired is the instant, not the count */
           GREATEST(0, ((c.expires_at AT TIME ZONE INTERVAL '+05:30')::date
                        - (now() AT TIME ZONE INTERVAL '+05:30')::date))::int AS days_left,
           (c.expires_at < now()) AS expired,
           (SELECT COUNT(*)::int FROM licences l
             WHERE l.company_id = c.id AND l.state <> 'REVOKED') AS seats_used,
           /* 4.3.0 — what this licence has used, summed across its seats.
              Computed here rather than stored, so it cannot disagree with
              the device rows it is made of. */
           (SELECT COALESCE(SUM(GREATEST(0, l.txn_count - l.txn_base)), 0)::int FROM licences l
             WHERE l.company_id = c.id) AS txn_used,
           (SELECT COALESCE(SUM(GREATEST(0, l.usage_minutes - l.usage_base)), 0)::int FROM licences l
             WHERE l.company_id = c.id) AS usage_minutes
      FROM companies c
     ORDER BY c.is_demo ASC, c.created_at DESC
     LIMIT 500`);
  /* 4.8.0 — who can sign in on this company's seats. */
  for (const c of rows) {
    const u = await usersSummary(c.id);
    c.users_count = u.count;
    c.admin_names = u.admins;
    /* One seat = one person. Every name counts, switched off or not;
       users_count stays the ACTIVE number the page always showed. */
    c.users_total = (await userCap(c.id)).count;
  }
  return rows;
}

export async function companyAction(body) {
  const action = String(body.action || '');
  const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 365));

  /* CREATE is the only action without an id. Everything else names one. */
  if (action === 'create') {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'A company name is required.' };
    const seats = Math.max(1, Math.min(500, parseInt(body.seats, 10) || 1));
    const grace = Math.max(0, Math.min(365, parseInt(body.graceDays, 10) || 0));
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = newLicenceKey();
      try {
        const rows = await q(
          `INSERT INTO companies (name, licence_key, email, phone, state, seats, grace_days,
                                  is_demo, expires_at, notes, gstin)
           VALUES ($1,$2,$3,$4,'LICENSED',$5,$6,false, nexora_eod(now() + make_interval(days => $7::int)), $8, $9)
           RETURNING *`,
          [name, key, body.email || null, body.phone || null, seats, grace, days, body.notes || null,
           (String(body.gstin || '').trim().toUpperCase() || null)]);
        if (rows.length) {
          await logEvent(null, 'ADMIN_COMPANY_CREATE', { id: rows[0].id, name, seats, days, grace });
          return { ok: true, company: rows[0] };
        }
      } catch (e) {
        if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
      }
    }
    return { error: 'Could not allocate a licence key. Try again.' };
  }

  const id = parseInt(body.id, 10);
  if (!id) return { error: 'A company is required.' };

  if (action === 'extend') {
    /* From whichever is later, so extending a live licence adds time
       rather than shortening it. */
    await q(`UPDATE companies
                SET expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int))
              WHERE id = $1`, [id, days]);
    await logEvent(null, 'ADMIN_COMPANY_EXTEND', { id, days });

  } else if (action === 'licence') {
    await q(`UPDATE companies
                SET state = 'LICENSED', is_demo = false,
                    expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int))
              WHERE id = $1`, [id, days]);
    await logEvent(null, 'ADMIN_COMPANY_LICENCE', { id, days });

  } else if (action === 'seats') {
    const seats = Math.max(1, Math.min(500, parseInt(body.seats, 10) || 1));
    /* Reducing below what is in use is ALLOWED and stops nothing. Silently
       revoking somebody's PC to satisfy a number is exactly the kind of
       data loss rule #29 forbids — so it warns and leaves them running. */
    const used = (await q(
      `SELECT COUNT(*)::int AS n FROM licences WHERE company_id = $1 AND state <> 'REVOKED'`, [id]))[0];
    await q(`UPDATE companies SET seats = $2 WHERE id = $1`, [id, seats]);
    const people = (await q(`SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1`, [id]))[0];
    await logEvent(null, 'ADMIN_COMPANY_SEATS', { id, seats, inUse: Number(used.n), people: Number(people.n) });
    /* One seat = one person as well as one machine. Going below either
       stops nobody; the application refuses the NEXT person. */
    const warn = [];
    if (Number(used.n) > seats) warn.push(used.n + ' machines are still active, which is more than the ' + seats +
      ' seats now allowed. None were stopped — revoke the ones you do not want in the Installations list.');
    if (Number(people.n) > seats) warn.push(people.n + ' people are on this company, which is more than the ' + seats +
      ' seats now allowed. Nobody was removed — the application refuses the next person until seats are raised.');
    if (warn.length) return { ok: true, warning: 'Saved. ' + warn.join(' ') };

  } else if (action === 'grace') {
    const grace = Math.max(0, Math.min(365, parseInt(body.graceDays, 10) || 0));
    await q(`UPDATE companies SET grace_days = $2 WHERE id = $1`, [id, grace]);
    await logEvent(null, 'ADMIN_COMPANY_GRACE', { id, grace });

  } else if (action === 'suspend') {
    await q(`UPDATE companies SET state = 'SUSPENDED' WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_COMPANY_SUSPEND', { id });

  } else if (action === 'restore') {
    await q(`UPDATE companies SET state = CASE WHEN is_demo THEN 'DEMO' ELSE 'LICENSED' END WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_COMPANY_RESTORE', { id });

  } else if (action === 'rename') {
    await q(`UPDATE companies SET name = $2 WHERE id = $1`, [id, String(body.name || '').trim() || 'Unnamed']);

  } else if (action === 'gstin') {
    /* Stored exactly as given, upper-cased only. The shape is checked in
       the app; the server does not second-guess a legal identifier. */
    await q(`UPDATE companies SET gstin = $2 WHERE id = $1`,
      [id, String(body.gstin || '').trim().toUpperCase() || null]);
    await logEvent(null, 'ADMIN_COMPANY_GSTIN', { id });

  } else if (action === 'txnlimit') {
    /* 4.3.0 — how many transactions this licence may commit.
       0 means NO LIMIT and is the default, so a company nobody sets this
       on behaves exactly as it did before the column existed.

       Lowering it below what is already used is ALLOWED and destroys
       nothing — the same principle as reducing seats. It stops NEW
       transactions; every saved calculation still opens, reads and
       prints. The warning says so, because an owner who lowers a limit by
       accident should learn it here rather than from the customer. */
    const lim = Math.max(0, Math.min(10000000, parseInt(body.txnLimit, 10) || 0));
    await q(`UPDATE companies SET txn_limit = $2 WHERE id = $1`, [id, lim]);
    const u = (await q(
      `SELECT COALESCE(SUM(GREATEST(0, txn_count - txn_base)), 0)::int AS n FROM licences WHERE company_id = $1`, [id]))[0];
    const used = Number(u && u.n) || 0;
    await logEvent(null, 'ADMIN_COMPANY_TXNLIMIT', { id, txnLimit: lim, used });
    if (lim > 0 && used >= lim) {
      return { ok: true, warning: 'Saved. This licence has already committed ' + used +
        ' transactions, which is at or over the new limit of ' + lim +
        '. Nothing saved was touched, but its machines cannot commit anything new until the limit is raised.' };
    }

  } else if (action === 'resetusage') {
    /* 4.6.0 — start this licence's count and hours again from zero, on
       every seat. The machines' own reports are not altered (they are
       monotonic by design); the point they stood at is recorded and
       everything is read as count − base from here on. A limit that was
       reached is therefore no longer reached, on the very next heartbeat. */
    await q(`UPDATE licences
                SET txn_base = txn_count, usage_base = usage_minutes, usage_reset_at = now()
              WHERE company_id = $1`, [id]);
    await logEvent(null, 'ADMIN_COMPANY_RESETUSAGE', { id });

  } else if (action === 'adminuser') {
    /* 4.8.0 — the owner creates (or resets the PIN of) the company's
       administrator. Everything else about users happens inside the
       application, by that administrator. */
    const out = await ensureAdmin(id, { name: body.name, pin: body.pin });
    if (out.error) return { error: out.error };
    return { ok: true, user: out.user, warning: out.reset
      ? 'The PIN for ' + out.user.name + ' was reset and they are the administrator.'
      : out.user.name + ' can now sign in as the administrator on any of this company\'s seats.' };

  } else if (action === 'delete') {
    /* The one action that cannot be undone from here. It takes the
       company and everything that hangs off it — its machines, its
       people, the records its seats synced, its ink models — so nothing
       is left pointing at a company that no longer exists. The owner
       types the company's name to confirm; an id in a button is not a
       decision, a name typed out is. */
    const co = (await q(`SELECT id, name FROM companies WHERE id = $1`, [id]))[0];
    if (!co) return { error: 'No such company.' };
    if (String(body.confirmName || '').trim() !== String(co.name).trim()) {
      return { error: 'Type the company name exactly — ' + co.name + ' — to delete it.' };
    }
    const count = async (sql) => Number((await q(sql, [id]))[0].n);
    const removed = {
      installations: await count(`SELECT COUNT(*)::int AS n FROM licences WHERE company_id = $1`),
      users: await count(`SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1`),
      records: await count(`SELECT COUNT(*)::int AS n FROM sync_records WHERE company_id = $1`),
      inkModels: await count(`SELECT COUNT(*)::int AS n FROM ink_models WHERE company_id = $1`)
    };
    await q(`DELETE FROM licences WHERE company_id = $1`, [id]);
    await q(`DELETE FROM company_users WHERE company_id = $1`, [id]);
    await q(`DELETE FROM sync_records WHERE company_id = $1`, [id]);
    await q(`DELETE FROM ink_models WHERE company_id = $1`, [id]);
    await q(`DELETE FROM companies WHERE id = $1`, [id]);
    await logEvent(null, 'ADMIN_COMPANY_DELETE', { id, name: co.name, removed });
    return { ok: true, removed, name: co.name };

  } else if (action === 'note') {
    await q(`UPDATE companies SET notes = $2 WHERE id = $1`, [id, String(body.notes || '')]);

  } else {
    return { error: 'Unknown action: ' + action };
  }
  return { ok: true };
}

export async function licenceAction(body) {
  const deviceId = String(body.deviceId || '');
  const action = String(body.action || '');
  const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 7));
  if (!deviceId) return { error: 'deviceId is required' };

  /* 4.0.0 — THE CLOCK MOVED TO THE COMPANY. These two actions used to
     write the device's own expires_at, which describe() no longer reads
     once a device has a company. Left as they were they would appear to
     work and change nothing, which is worse than an error. So they now
     act on the company the device belongs to, and say so. */
  if (action === 'extend' || action === 'licence') {
    const rows = await q(`SELECT company_id FROM licences WHERE device_id = $1`, [deviceId]);
    const companyId = rows.length ? rows[0].company_id : null;
    if (!companyId) {
      /* Not adopted yet — write the device row, exactly as before. */
      await q(`UPDATE licences
                  SET expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int)),
                      state = CASE WHEN $3::bool THEN 'LICENSED'
                                   WHEN state = 'EXPIRED' THEN 'TRIAL' ELSE state END
                WHERE device_id = $1`, [deviceId, days, action === 'licence']);
      await logEvent(deviceId, action === 'licence' ? 'ADMIN_LICENCE' : 'ADMIN_EXTEND', { days, scope: 'device' });
      return { ok: true, scope: 'device' };
    }
    await q(`UPDATE companies
                SET expires_at = nexora_eod(GREATEST(now(), expires_at) + make_interval(days => $2::int))
                  ${action === 'licence' ? ", state = 'LICENSED', is_demo = false" : ''}
              WHERE id = $1`, [companyId, days]);
    await logEvent(deviceId, action === 'licence' ? 'ADMIN_LICENCE' : 'ADMIN_EXTEND',
      { days, scope: 'company', companyId });
    return { ok: true, scope: 'company', companyId,
      warning: 'This applied to the whole company — every machine on that licence.' };

  } else if (action === 'resetusage') {
    /* 4.6.0 — one machine's count and hours, from zero. Same base
       mechanism as the company-wide reset; the report itself is untouched. */
    await q(`UPDATE licences SET txn_base = txn_count, usage_base = usage_minutes, usage_reset_at = now()
              WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_RESETUSAGE', {});

  } else if (action === 'revoke') {
    await q(`UPDATE licences SET state = 'REVOKED' WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_REVOKE', {});
  } else if (action === 'restore') {
    /* Restoring puts a machine back on a seat, so the seat count has to be
       checked here too — otherwise revoke-then-restore is a way past it. */
    const rows = await q(`SELECT company_id FROM licences WHERE device_id = $1`, [deviceId]);
    const companyId = rows.length ? rows[0].company_id : null;
    if (companyId) {
      const co = (await q(`SELECT name, seats FROM companies WHERE id = $1`, [companyId]))[0];
      const used = (await q(
        `SELECT COUNT(*)::int AS n FROM licences WHERE company_id = $1 AND state <> 'REVOKED'`,
        [companyId]))[0];
      if (co && Number(used.n) >= Number(co.seats)) {
        return { error: 'All ' + co.seats + ' seats for ' + co.name +
          ' are in use. Revoke another machine first, or give the company more seats.' };
      }
    }
    await q(`UPDATE licences SET state = 'TRIAL' WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_RESTORE', { companyId });
  } else if (action === 'delete') {
    /* 4.23.1 — one installation, removed outright. The company-level
       delete cannot reach a device row with no company: the three test
       machines from before 4.0.0 are exactly that, and Revoke only marks
       them. This is the only way to be rid of such a row.
       It does NOT touch the company: a live machine deleted here frees
       its seat and can activate again, which is the difference between
       this and revoking. */
    const row = (await q(`SELECT device_id, device_name, company, company_id FROM licences WHERE device_id = $1`, [deviceId]))[0];
    if (!row) return { error: 'No such installation.' };
    await q(`DELETE FROM licences WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_INSTALL_DELETE', { company: row.company, companyId: row.company_id, deviceName: row.device_name });
    return { ok: true, deleted: deviceId, orphan: !row.company_id };

  } else if (action === 'note') {
    await q(`UPDATE licences SET notes = $2 WHERE device_id = $1`, [deviceId, String(body.notes || '')]);
  } else {
    return { error: 'Unknown action: ' + action };
  }
  return { ok: true };
}

export async function saveSettings(body) {
  const pairs = [];
  if (body.trialDays !== undefined) pairs.push(['trial_days', String(Math.max(1, parseInt(body.trialDays, 10) || 7))]);
  if (body.expiredMode !== undefined) pairs.push(['expired_mode', body.expiredMode === 'HARDSTOP' ? 'HARDSTOP' : 'READONLY']);
  if (body.signupsOpen !== undefined) pairs.push(['signups_open', body.signupsOpen ? 'yes' : 'no']);
  if (body.demoSignup !== undefined) pairs.push(['demo_signup', body.demoSignup ? 'yes' : 'no']);
  if (body.demoGraceDays !== undefined) pairs.push(['demo_grace_days', String(Math.max(0, Math.min(365, parseInt(body.demoGraceDays, 10) || 0)))]);
  if (body.sessionMinutes !== undefined) pairs.push(['session_minutes', String(Math.min(720, Math.max(5, parseInt(body.sessionMinutes, 10) || 30)))]);
  for (const [k, v] of pairs) {
    await q(`INSERT INTO settings (key, value) VALUES ($1,$2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
  }
  return { ok: true, settings: await getSettings() };
}

export async function recentEvents(deviceId) {
  return q(`SELECT at, event, detail FROM activation_log
             WHERE ($1::text IS NULL OR device_id = $1)
             ORDER BY at DESC LIMIT 100`, [deviceId || null]);
}

/* ------------------------------------------------------------------ */
export const ADMIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexora — Licence console</title>
<style>
:root{--bg:#f4f6fb;--surface:#fff;--border:#e1e5ee;--text:#1a2233;--muted:#667085;--accent:#4f7cff;--accentbg:#eaf1fe;
      --ok:#16a34a;--warn:#d97706;--bad:#dc2626;--okbg:#e8f7ee;--warnbg:#fef3e2;--badbg:#fdeaea;}
@media(prefers-color-scheme:dark){:root{--bg:#12141c;--surface:#1b1e29;--border:#2a2e3e;--text:#e8ebf2;--muted:#98a2b3;
      --accentbg:#1c2740;--okbg:#123222;--warnbg:#3a2a10;--badbg:#3a1717;}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0}
.sub{color:var(--muted);margin:0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.top .grow{flex:1}
.kpis{display:flex;gap:8px;flex-wrap:wrap}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 14px;min-width:96px}
.kpi b{display:block;font-size:20px;line-height:1.1}.kpi span{color:var(--muted);font-size:12px}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.s-TRIAL,.s-DEMO{background:var(--okbg);color:var(--ok)}.s-LICENSED{background:var(--accentbg);color:var(--accent)}
.s-EXPIRED{background:var(--warnbg);color:var(--warn)}.s-REVOKED,.s-SUSPENDED,.s-FAILED{background:var(--badbg);color:var(--bad)}
.s-SELF{background:var(--accentbg);color:var(--accent)}.s-UNVERIFIED{background:var(--warnbg);color:var(--warn)}
.key{font:13px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.03em}
code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
button{font:inherit;padding:6px 11px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover{color:#fff;opacity:.92}
button.danger{border-color:var(--bad);color:var(--bad)}button.danger:hover{background:var(--badbg)}
button.small{padding:3px 8px;font-size:12px}
input,select{font:inherit;padding:7px 9px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text)}
label{display:inline-flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
label input,label select{font-size:14px;color:var(--text)}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.msg{padding:10px 12px;border-radius:8px;margin:8px 0}
.msg.err{background:var(--badbg);color:var(--bad)}.msg.warn{background:var(--warnbg);color:var(--warn)}.msg.ok{background:var(--okbg);color:var(--ok)}
.help{color:var(--muted);font-size:12.5px;margin:6px 0 0}
#gate{max-width:400px;margin:12vh auto}
/* companies */
.co{border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:10px;background:var(--surface)}
.co.suspended{border-color:var(--bad)}
.co-head{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
.co-name{font-size:16px;font-weight:700;margin-right:4px}
.co-meta{color:var(--muted);font-size:12.5px;display:flex;gap:14px;flex-wrap:wrap;margin-top:6px}
.co-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
.fact{border:1px solid var(--border);border-radius:9px;padding:8px 10px}
.fact span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.fact b{font-size:15px}
.fact small{color:var(--muted)}
.bar{display:block;height:5px;border-radius:3px;background:var(--border);margin-top:5px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}.bar.full i{background:var(--bad)}
.manage{margin-top:12px;border-top:1px dashed var(--border);padding-top:12px;display:none}
.manage.open{display:block}
.group{margin-bottom:10px}
.group h4{margin:0 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.acts .why{color:var(--muted);font-size:12px;margin-left:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:10px}
.legend div{background:var(--bg);border-radius:9px;padding:9px 11px;font-size:12.5px}
.legend b{display:block}
</style></head><body>
<div class="wrap">
  <div id="gate" class="card">
    <h1>Nexora — Licence console</h1>
    <p class="sub" style="margin:4px 0 12px">Enter the admin key (NEXORA_ADMIN_KEY on the service).</p>
    <div id="gateErr"></div>
    <div class="row"><input id="key" type="password" placeholder="Admin key" style="flex:1" onkeydown="if(event.key==='Enter')load()"><button class="primary" onclick="load()">Open</button></div>
  </div>

  <div id="app" style="display:none">
    <div class="top">
      <div class="grow"><h1>Nexora — Licence console</h1><p class="sub" id="sub"></p></div>
      <div class="kpis" id="kpi"></div>
      <button onclick="load()">Refresh</button>
      <button data-target="settings" onclick="toggle(this)">Service settings</button>
      <button onclick="signOut()" title="Forget the key in this browser tab">Sign out</button>
    </div>

    <div class="card" id="settings" style="display:none">
      <h2>Service settings <span class="sub" style="font-weight:400">— apply to every installation from its next check</span></h2>
      <div class="row" style="margin-top:10px">
        <label>Demo length, days<input id="sTrial" type="number" min="1" max="365" style="width:90px"></label>
        <label>Demo may work offline, days<input id="sGrace" type="number" min="0" max="365" style="width:90px"></label>
        <label>Working window, minutes<input id="sSession" type="number" min="5" max="720" style="width:90px"></label>
        <label>When a licence ends<select id="sMode"><option value="READONLY">Read-only — saved work still opens and prints</option><option value="HARDSTOP">Hard stop</option></select></label>
        <label style="flex-direction:row;align-items:center;gap:8px;color:var(--text)"><input id="sOpen" type="checkbox">Accept new registrations</label>
        <label style="flex-direction:row;align-items:center;gap:8px;color:var(--text)" title="A demo with no GSTIN, email or mobile — anyone who types a name gets one. Off unless you are handing a machine to a prospect yourself."><input id="sDemo" type="checkbox">Also allow anonymous demos</label>
        <button class="primary" onclick="saveSettings()">Save settings</button>
      </div>
      <p class="help"><b>Accept new registrations</b> is how a plant that downloads Nexora starts: company, GSTIN, email, mobile, a company id and passcode. <b>Anonymous demos</b> is the old way &mdash; a licence key left blank creates a company from whatever name is typed, with nothing to tell a real plant from a made-up one; leave it off unless you are demonstrating on a prospect&rsquo;s machine yourself. A demo with 0 offline days stops the moment it cannot reach this service. The working window is only how long a good answer is reused before the application asks again. Offline days for a paying customer are set on the company.</p>
    </div>

    <div class="card">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Companies</h2>
        <input id="cq" placeholder="Find a company, key, email, GSTIN…" oninput="renderCompanies()" style="min-width:240px">
        <button class="primary" data-target="newco" onclick="toggle(this)">New company</button>
      </div>
      <div id="newco" style="display:none;border:1px solid var(--border);border-radius:10px;padding:12px;margin:8px 0 12px">
        <div class="row">
          <label>Company name<input id="nName" placeholder="Company name" style="min-width:220px"></label>
          <label>Seats<input id="nSeats" type="number" min="1" max="500" value="1" style="width:80px"></label>
          <label>Licence days<input id="nDays" type="number" min="1" max="3650" value="365" style="width:90px"></label>
          <label>Offline days<input id="nGrace" type="number" min="0" max="365" value="0" style="width:90px"></label>
          <label>GSTIN<input id="nGst" placeholder="15 characters" maxlength="15" style="min-width:170px;text-transform:uppercase"></label>
          <label>Email<input id="nEmail" placeholder="address" style="min-width:170px"></label>
          <button class="primary" onclick="createCo()">Create licensed company</button>
          <button data-target="newco" onclick="toggle(this)">Cancel</button>
        </div>
        <p class="help">For a customer you set up yourself. A licence key is generated; every machine they install types the same key and takes one seat. A plant that registers itself from the application appears here on its own, as a demo.</p>
      </div>
      <div id="coMsg"></div>
      <div id="colist"></div>
      <div class="legend">
        <div><b>Suspend</b>stops every machine of the company at its next check. Nothing is deleted; Restore puts it all back. Use it when a customer has not paid.</div>
        <div><b>Revoke</b>(on one installation) stops that one machine and frees its seat for another. The company keeps running.</div>
        <div><b>Delete</b>removes the company, its machines, its people and everything its seats synced. It cannot be undone from here — the name must be typed to confirm.</div>
        <div><b>Transactions and hours</b>are what the company has used — saved records, and time in the application — summed over its machines. A limit of 0 means none.</div>
      </div>
    </div>

    <div class="card">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Installations <span class="sub" style="font-weight:400" id="instsub"></span></h2>
        <input id="q" placeholder="Search company, key, email, device…" oninput="render()" style="min-width:240px">
        <button class="small" id="clearFilter" style="display:none" onclick="clearCompanyFilter()">Show all companies</button>
      </div>
      <div style="overflow-x:auto"><table id="tbl">
        <thead><tr><th>Company · machine</th><th>State</th><th>Email</th><th>Days left</th><th>Started</th><th>Last seen</th><th>Version</th><th>Transactions</th><th>Hours</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">The clock belongs to the company, not the machine. Revoke one machine to free its seat; suspend the company to stop all of them.</p>
    </div>
  </div>
</div>
<script>
let KEY='', DATA={licences:[],companies:[],settings:{}}, OPEN=null, COFILTER=null;
/* Where /admin/api/* lives. Empty when this page is served BY the service,
   which is how Render serves it — relative paths, same origin, no CORS.
   Set to the service's address when the page is hosted somewhere else,
   because a Supabase Edge Function cannot serve it: the platform rewrites
   text/html to text/plain, so the console would arrive as source. The page
   holds no secret either way; the admin key is typed in and kept only in
   this browser tab. */
let API_BASE=window.NEXORA_API_BASE||'';
if(API_BASE.charAt(API_BASE.length-1)==='/')API_BASE=API_BASE.slice(0,-1);
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmt(d){return d?new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'2-digit'}):'—'}
function toggle(btn){const id=typeof btn==='string'?btn:btn.dataset.target;const n=document.getElementById(id);n.style.display=n.style.display==='none'?'':'none';}
function say(html){document.getElementById('coMsg').innerHTML=html;if(html)setTimeout(()=>{if(document.getElementById('coMsg').innerHTML===html)say('')},6000);}
function signOut(){try{sessionStorage.removeItem('nexora_admin_key')}catch(e){}location.reload();}
async function api(path,opts){
  const r=await fetch(API_BASE+path,Object.assign({headers:{'x-admin-key':KEY,'content-type':'application/json'}},opts||{}));
  if(r.status===401)throw new Error('That admin key was not accepted.');
  let b={};try{b=await r.json()}catch(e){}
  if(!r.ok&&!b.error)throw new Error('Request failed ('+r.status+')');
  return b;
}
async function load(){
  KEY=KEY||document.getElementById('key').value.trim();
  try{
    DATA=await api('/admin/api/licences');
    try{sessionStorage.setItem('nexora_admin_key',KEY)}catch(e){}
    document.getElementById('gate').style.display='none';
    document.getElementById('app').style.display='';
    const s=DATA.settings;
    document.getElementById('sTrial').value=s.trialDays;
    document.getElementById('sGrace').value=s.demoGraceDays;
    document.getElementById('sSession').value=s.sessionMinutes;
    document.getElementById('sMode').value=s.expiredMode;
    document.getElementById('sOpen').checked=!!s.signupsOpen;
    document.getElementById('sDemo').checked=!!s.demoSignup;
    renderCompanies();
    render();
  }catch(e){
    KEY='';
    document.getElementById('gateErr').innerHTML='<div class="msg err">'+esc(e.message)+'</div>';
  }
}
/* ---------- companies ---------- */
function gstPill(c){
  const s=c.gst_status||'UNVERIFIED';
  const title=(c.gst_note?esc(c.gst_note)+' · ':'')+(c.gst_checked_at?'checked '+new Date(c.gst_checked_at).toLocaleString():'never checked');
  return '<span class="pill s-'+(s==='VERIFIED'?'LICENSED':s)+'" title="'+title+'">'+
    (s==='VERIFIED'?'GST verified':s==='FAILED'?'GST failed':'GST not yet verified')+'</span>';
}
function usersCell(c){
  const n=+c.users_count||0;
  const max=+c.seats||1;   /* one seat = one person */
  const total=+c.users_total||n;
  if(!n&&!total)return '<b style="color:var(--warn)">none yet</b><small> — set an administrator under People · one per seat</small>';
  return '<b>'+total+' of '+max+'</b>'+(total>n?'<small> ('+n+' active)</small>':'')+(total>=max?'<small style="color:var(--warn)"> · full</small>':'')+(c.admin_names?'<small> · admin '+esc(c.admin_names)+'</small>':'<small style="color:var(--bad)"> · no administrator</small>');
}
function txnCell(used,limit){
  used=+used||0;limit=+limit||0;
  if(!limit)return '<b>'+used+'</b><small> · no limit</small>';
  const pct=Math.min(100,Math.round(used/limit*100));
  const col=used>=limit?'var(--bad)':(used>=limit*0.9?'var(--warn)':'var(--accent)');
  return '<b>'+used+'</b><small> of '+limit+'</small><span class="bar'+(used>=limit?' full':'')+'"><i style="width:'+pct+'%;background:'+col+'"></i></span>'+
    (used>=limit?'<small style="color:var(--bad)">limit reached — read-only</small>':'');
}
function hoursText(mins){mins=+mins||0;const h=Math.floor(mins/60),m=mins%60;return h?h+' h '+m+' m':m+' m';}
function renderCompanies(){
  const term=(document.getElementById('cq').value||'').toLowerCase();
  const cos=(DATA.companies||[]).filter(c=>!term||[c.name,c.licence_key,c.email,c.gstin,c.login_id,c.phone].some(v=>String(v||'').toLowerCase().includes(term)));
  document.getElementById('colist').innerHTML=cos.map(c=>{
    const state=(c.expired&&c.state!=='SUSPENDED')?'EXPIRED':c.state;
    const used=c.seats_used, seats=c.seats, pct=Math.min(100,Math.round(used/Math.max(1,seats)*100));
    const open=OPEN===c.id;
    return '<div class="co'+(c.state==='SUSPENDED'?' suspended':'')+'" id="co-'+c.id+'">'+
      '<div class="co-head">'+
        '<div class="grow" style="flex:1">'+
          '<span class="co-name">'+esc(c.name)+'</span> '+
          '<span class="pill s-'+state+'">'+(state==='DEMO'?'demo':state.toLowerCase())+'</span> '+
          (c.self_registered?'<span class="pill s-SELF" title="Registered by the plant itself on '+esc(fmt(c.registered_at))+(c.registered_ip?' from '+esc(c.registered_ip):'')+'">self-registered</span> ':'')+
          (c.gstin?gstPill(c):'')+
          '<div class="co-meta">'+
            '<span>Key <span class="key">'+esc(c.licence_key)+'</span> <button class="small" data-key="'+esc(c.licence_key)+'" onclick="copyKey(this)">Copy</button></span>'+
            (c.gstin?'<span>GSTIN <code>'+esc(c.gstin)+'</code></span>':'')+
            (c.email?'<span><code>'+esc(c.email)+'</code></span>':'')+
            (c.phone?'<span><code>'+esc(c.phone)+'</code></span>':'')+
            (c.login_id?'<span>Login id <code>'+esc(c.login_id)+'</code></span>':'')+
            (c.registered_ip?'<span title="The address this company registered from">IP <code>'+esc(c.registered_ip)+'</code></span>':'')+
          '</div>'+
        '</div>'+
        '<div><button'+(open?' class="primary"':'')+' data-id="'+c.id+'" onclick="manage(this)">'+(open?'Close':'Manage')+'</button></div>'+
      '</div>'+
      '<div class="co-facts">'+
        '<div class="fact"><span>Seats</span><b>'+used+' of '+seats+'</b><span class="bar'+(used>=seats?' full':'')+'"><i style="width:'+pct+'%"></i></span></div>'+
        '<div class="fact"><span>'+(state==='EXPIRED'?'Ended':state==='SUSPENDED'?'Suspended · ends':'Days left')+'</span><b>'+(state==='EXPIRED'||state==='SUSPENDED'?fmt(c.expires_at):(c.days_left===0?'today':c.days_left))+'</b>'+(state==='EXPIRED'||state==='SUSPENDED'?'':'<small>'+fmt(c.expires_at)+'</small>')+'</div>'+
        '<div class="fact"><span>Offline allowed</span><b>'+(c.grace_days>0?c.grace_days+' days':'none')+'</b>'+(c.grace_days>0?'':'<small>stops when it cannot reach the service</small>')+'</div>'+
        '<div class="fact"><span>Transactions</span>'+txnCell(c.txn_used,c.txn_limit)+'</div>'+
        '<div class="fact"><span>Hours in use</span><b>'+hoursText(c.usage_minutes)+'</b></div>'+
        '<div class="fact"><span>People</span>'+usersCell(c)+'</div>'+
      '</div>'+
      '<div class="manage'+(open?' open':'')+'" id="mg-'+c.id+'">'+
        '<div class="group"><h4>Licence</h4><div class="acts">'+
          (c.is_demo?'<button class="primary" data-id="'+c.id+'" data-action="licence" data-days="365" onclick="coAct(this)">Make licensed for 1 year</button><span class="why">turns this demo into a paying customer</span>':'')+
          '<button data-id="'+c.id+'" onclick="coDays(this)">Add days…</button>'+
          '<button data-id="'+c.id+'" data-action="extend" data-days="365" onclick="coAct(this)">+1 year</button>'+
        '</div></div>'+
        '<div class="group"><h4>Machines</h4><div class="acts">'+
          '<button data-id="'+c.id+'" data-now="'+seats+'" onclick="coSeats(this)">Seats…</button><span class="why">how many computers may run on this licence &mdash; and how many people may sign in, one per seat</span>'+
          '<button data-id="'+c.id+'" data-now="'+c.grace_days+'" onclick="coGrace(this)">Offline days…</button>'+
          '<button data-id="'+c.id+'" onclick="showInstallations(this)">Show its installations</button>'+
        '</div></div>'+
        '<div class="group"><h4>People</h4><div class="acts">'+
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coAdmin(this)">Set administrator…</button><span class="why">the person who adds everyone else from inside the application</span>'+
        '</div></div>'+
        (c.gstin?'<div class="group"><h4>GST</h4><div class="acts">'+
          '<button data-id="'+c.id+'" onclick="gstVerify(this)">Verify online</button><span class="why">asks the verification service, if one is configured</span>'+
          (c.gst_status!=='VERIFIED'?'<button data-id="'+c.id+'" data-status="VERIFIED" onclick="gstMark(this)">Mark checked by hand</button>':'<button data-id="'+c.id+'" data-status="UNVERIFIED" onclick="gstMark(this)">Take the verified mark off</button>')+
        '</div></div>':'')+
        '<div class="group"><h4>Usage</h4><div class="acts">'+
          '<button data-id="'+c.id+'" data-now="'+(c.txn_limit||0)+'" onclick="coLimit(this)">Transaction limit…</button>'+
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coReset(this)">Reset usage</button><span class="why">count and hours from zero; nothing saved is touched</span>'+
        '</div></div>'+
        '<div class="group"><h4>Stop</h4><div class="acts">'+
          (c.state==='SUSPENDED'
            ?'<button data-id="'+c.id+'" data-action="restore" data-days="0" onclick="coAct(this)">Restore</button><span class="why">every machine runs again</span>'
            :'<button class="danger" data-id="'+c.id+'" data-action="suspend" data-days="0" onclick="coAct(this)">Suspend</button><span class="why">every machine stops at its next check; nothing is deleted</span>')+
          '<button class="danger" data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coDelete(this)">Delete…</button><span class="why">removes the company and everything that belongs to it</span>'+
        '</div></div>'+
      '</div>'+
    '</div>';
  }).join('')||'<p class="help">No companies yet. A plant that registers itself from the application appears here as a demo; a customer you set up yourself is created with New company.</p>';
}
function manage(btn){const id=+btn.dataset.id;OPEN=OPEN===id?null:id;renderCompanies();if(OPEN)document.getElementById('co-'+OPEN).scrollIntoView({block:'nearest'});}
function copyKey(btn){const k=btn.dataset.key;try{navigator.clipboard.writeText(k);say('<div class="msg ok">Copied '+esc(k)+'</div>');}catch(e){prompt('Licence key',k);}}
async function coAct(btn){
  const id=+btn.dataset.id,action=btn.dataset.action,days=+btn.dataset.days||0;
  if(action==='suspend'&&!confirm('Suspend this company?\\n\\nEVERY machine on this licence stops calculating at its next check. Nothing is deleted; Restore puts it back.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id,action,days})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function coDays(btn){
  const v=prompt('Add how many days to this licence?\\n\\nThe company\\'s clock moves; every seat follows.','30');
  if(v===null)return;
  const days=parseInt(v,10);
  if(!(days>0)){say('<div class="msg err">Enter a number of days.</div>');return;}
  btn.dataset.action='extend';btn.dataset.days=String(days);await coAct(btn);
}
async function coSeats(btn){
  const v=prompt('How many machines may run on this licence?',btn.dataset.now);
  if(v===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'seats',seats:+v})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function coGrace(btn){
  const v=prompt('How many days may this customer work with no contact with the service?\\n\\n0 = none: it stops as soon as it cannot reach us.',btn.dataset.now);
  if(v===null)return;
  await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'grace',graceDays:+v})});
  await load();
}
async function coLimit(btn){
  const v=prompt('How many transactions may this licence commit?\\n\\n0 = no limit. Reaching the limit makes the machines READ-ONLY: everything saved still opens and prints.',btn.dataset.now);
  if(v===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'txnlimit',txnLimit:+v})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function coReset(btn){
  if(!confirm('Start '+btn.dataset.name+'\\'s transaction count and hours again from zero, on every machine?\\n\\nNothing saved is touched. A limit that was reached is no longer reached.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'resetusage'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">Usage reset for <b>'+esc(btn.dataset.name)+'</b>.</div>');
  await load();
}
async function coAdmin(btn){
  const name=btn.dataset.name;
  const who=prompt('Administrator for '+name+'\\n\\nName the person who will manage users and see every calculation. If a user of that name exists, they become the administrator and get the new PIN.','Administrator');
  if(who===null||!who.trim())return;
  const pin=prompt('PIN for '+who.trim()+' (at least 4 characters). Tell it to them directly; it is not shown again.');
  if(pin===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'adminuser',name:who.trim(),pin})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  await load();
}
async function coDelete(btn){
  const name=btn.dataset.name;
  const typed=prompt('Delete '+name+'?\\n\\nThis removes the company, its machines, its people and everything its seats synced. It cannot be undone from here.\\n\\nType the company name exactly to confirm:');
  if(typed===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'delete',confirmName:typed})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  const x=r.removed||{};
  say('<div class="msg ok">Deleted <b>'+esc(r.name)+'</b> — '+(x.installations||0)+' installation(s), '+(x.users||0)+' user(s), '+(x.records||0)+' synced record(s), '+(x.inkModels||0)+' ink model(s).</div>');
  OPEN=null;await load();
}
async function gstVerify(btn){
  const r=await api('/admin/api/gst',{method:'POST',body:JSON.stringify({action:'gstverify',id:+btn.dataset.id})});
  if(r.error){say('<div class="msg err">'+esc(r.message||r.error)+'</div>');return;}
  say('<div class="msg '+(r.gst.status==='VERIFIED'?'ok':r.gst.status==='FAILED'?'err':'warn')+'">GST '+esc(r.gst.status.toLowerCase())+(r.gst.reason?' — '+esc(r.gst.reason):r.gst.legalName?' — '+esc(r.gst.legalName):'')+'</div>');
  await load();
}
async function gstMark(btn){
  const status=btn.dataset.status;
  const note=status==='VERIFIED'?(prompt('How was it checked? (a note for the record)','Checked on the GST portal by hand')||''):'';
  const r=await api('/admin/api/gst',{method:'POST',body:JSON.stringify({action:'gstmark',id:+btn.dataset.id,status,note})});
  if(r.error){say('<div class="msg err">'+esc(r.message||r.error)+'</div>');return;}
  await load();
}
async function createCo(){
  const name=document.getElementById('nName').value.trim();
  if(!name){say('<div class="msg err">A company name is required.</div>');return;}
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({
    action:'create',name,
    seats:+document.getElementById('nSeats').value,
    days:+document.getElementById('nDays').value,
    graceDays:+document.getElementById('nGrace').value,
    gstin:document.getElementById('nGst').value.trim(),
    email:document.getElementById('nEmail').value.trim()})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  document.getElementById('newco').style.display='none';
  document.getElementById('nName').value='';document.getElementById('nEmail').value='';document.getElementById('nGst').value='';
  await load();
  say('<div class="msg ok"><b>'+esc(r.company.name)+'</b> created. Licence key <span class="key">'+esc(r.company.licence_key)+'</span> — give this to the customer; every machine types it at activation.</div>');
}
/* ---------- installations ---------- */
function showInstallations(btn){COFILTER=+btn.dataset.id;render();document.getElementById('tbl').scrollIntoView({behavior:'smooth',block:'start'});}
function clearCompanyFilter(){COFILTER=null;render();}
function render(){
  const term=(document.getElementById('q').value||'').toLowerCase();
  const all=DATA.licences, cos=DATA.companies||[];
  const rows=all.filter(l=>(!COFILTER||l.company_id===COFILTER)&&(!term||[l.company,l.co_name,l.co_key,l.email,l.device_id,l.device_name].some(v=>String(v||'').toLowerCase().includes(term))));
  const live=all.filter(l=>!l.expired&&l.state!=='REVOKED').length;
  document.getElementById('kpi').innerHTML=
    '<div class="kpi"><b>'+cos.filter(c=>!c.is_demo).length+'</b><span>Customers</span></div>'+
    '<div class="kpi"><b>'+cos.filter(c=>c.is_demo).length+'</b><span>Demos</span></div>'+
    '<div class="kpi"><b>'+all.length+'</b><span>Installations</span></div>'+
    '<div class="kpi"><b>'+live+'</b><span>Running</span></div>';
  document.getElementById('sub').textContent=cos.length+' compan'+(cos.length===1?'y':'ies')+' · '+all.length+' installation'+(all.length===1?'':'s');
  const fc=COFILTER?cos.find(c=>c.id===COFILTER):null;
  document.getElementById('instsub').textContent=fc?'— '+fc.name+' only':'— '+rows.length+' of '+all.length;
  document.getElementById('clearFilter').style.display=COFILTER?'':'none';
  document.querySelector('#tbl tbody').innerHTML=rows.map(l=>{
    let state=(l.state==='TRIAL'&&l.expired)?'EXPIRED':l.state;
    if(l.co_state==='SUSPENDED'&&state!=='REVOKED')state='SUSPENDED';
    return '<tr>'+
      '<td><b>'+esc(l.co_name||l.company||'—')+'</b>'+(l.seat_no?' <code>seat '+l.seat_no+' of '+(l.co_seats||1)+'</code>':'')+
        '<br><code>'+esc(String(l.device_id).slice(0,12))+'…</code>'+(l.device_name?' <code>'+esc(l.device_name)+'</code>':'')+'</td>'+
      '<td><span class="pill s-'+state+'">'+state.toLowerCase()+'</span></td>'+
      '<td>'+esc(l.email||'—')+'</td>'+
      '<td>'+(state==='EXPIRED'||state==='REVOKED'?'—':(l.days_left===0?'today':l.days_left))+'</td>'+
      '<td>'+fmt(l.trial_started_at)+'</td>'+
      '<td>'+fmt(l.last_seen_at)+'</td>'+
      '<td>'+esc(l.app_version||'—')+'</td>'+
      '<td><b>'+(+l.txn_count||0)+'</b>'+(l.usage_reset_at?'<br><code>reset '+fmt(l.usage_reset_at)+'</code>':'')+'</td>'+
      '<td>'+hoursText(l.usage_minutes)+'</td>'+
      '<td><div class="acts">'+
        '<button class="small" data-device="'+esc(l.device_id)+'" data-action="resetusage" onclick="act(this)">Reset usage</button>'+
        (l.state==='REVOKED'
          ?'<button class="small" data-device="'+esc(l.device_id)+'" data-action="restore" onclick="act(this)">Restore</button>'
          :'<button class="small danger" data-device="'+esc(l.device_id)+'" data-action="revoke" onclick="act(this)" title="Stops this machine and frees its seat">Revoke</button>')+
        '<button class="small danger" data-device="'+esc(l.device_id)+'" data-name="'+esc(l.co_name||l.company||l.device_name||l.device_id)+'" onclick="delInstall(this)" title="Remove this installation row altogether">Delete</button>'+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="10" class="help">Nothing here yet.</td></tr>';
}
async function delInstall(btn){
  if(!confirm('Delete the installation "'+btn.dataset.name+'"?\\n\\nThe row is removed altogether. If the machine is still in use it frees its seat and can activate again — use Revoke to stop a machine, and this to tidy away one that is finished with.'))return;
  const r=await api('/admin/api/licence',{method:'POST',body:JSON.stringify({deviceId:btn.dataset.device,action:'delete'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">Installation deleted'+(r.orphan?' — it belonged to no company.':'.')+'</div>');
  await load();
}
async function act(btn){
  const deviceId=btn.dataset.device,action=btn.dataset.action;
  if(action==='revoke'&&!confirm('Revoke this installation?\\n\\nIt stops calculating at its next check, and its seat is freed for another machine. The company keeps running.'))return;
  if(action==='resetusage'&&!confirm('Start this machine\\'s transaction count and hours again from zero? Nothing saved is touched.'))return;
  const r=await api('/admin/api/licence',{method:'POST',body:JSON.stringify({deviceId,action,days:0})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');
  await load();
}
async function saveSettings(){
  await api('/admin/api/settings',{method:'POST',body:JSON.stringify({
    trialDays:+document.getElementById('sTrial').value,
    demoGraceDays:+document.getElementById('sGrace').value,
    sessionMinutes:+document.getElementById('sSession').value,
    expiredMode:document.getElementById('sMode').value,
    signupsOpen:document.getElementById('sOpen').checked,
    demoSignup:document.getElementById('sDemo').checked})});
  say('<div class="msg ok">Settings saved.</div>');
  await load();
}
try{const k=sessionStorage.getItem('nexora_admin_key');if(k){KEY=k;load();}}catch(e){}
</script></body></html>`;

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
           l.txn_count, l.usage_minutes,
           c.name AS co_name, c.licence_key AS co_key, c.state AS co_state,
           c.seats AS co_seats, c.is_demo AS co_is_demo,
           COALESCE(c.expires_at, l.expires_at) AS expires_at,
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (COALESCE(c.expires_at, l.expires_at) - now())) / 86400.0))::int AS days_left
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
  return q(`
    SELECT c.id, c.name, c.licence_key, c.email, c.phone, c.state, c.seats, c.gstin,
           c.grace_days, c.is_demo, c.expires_at, c.created_at, c.notes, c.txn_limit,
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (c.expires_at - now())) / 86400.0))::int AS days_left,
           (SELECT COUNT(*)::int FROM licences l
             WHERE l.company_id = c.id AND l.state <> 'REVOKED') AS seats_used,
           /* 4.3.0 — what this licence has used, summed across its seats.
              Computed here rather than stored, so it cannot disagree with
              the device rows it is made of. */
           (SELECT COALESCE(SUM(l.txn_count), 0)::int FROM licences l
             WHERE l.company_id = c.id) AS txn_used,
           (SELECT COALESCE(SUM(l.usage_minutes), 0)::int FROM licences l
             WHERE l.company_id = c.id) AS usage_minutes
      FROM companies c
     ORDER BY c.is_demo ASC, c.created_at DESC
     LIMIT 500`);
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
           VALUES ($1,$2,$3,$4,'LICENSED',$5,$6,false, now() + make_interval(days => $7::int), $8, $9)
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
                SET expires_at = GREATEST(now(), expires_at) + make_interval(days => $2::int)
              WHERE id = $1`, [id, days]);
    await logEvent(null, 'ADMIN_COMPANY_EXTEND', { id, days });

  } else if (action === 'licence') {
    await q(`UPDATE companies
                SET state = 'LICENSED', is_demo = false,
                    expires_at = GREATEST(now(), expires_at) + make_interval(days => $2::int)
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
    await logEvent(null, 'ADMIN_COMPANY_SEATS', { id, seats, inUse: Number(used.n) });
    if (Number(used.n) > seats) {
      return { ok: true, warning: 'Saved. ' + used.n + ' machines are still active, which is more than the ' +
        seats + ' seats now allowed. None were stopped — revoke the ones you do not want in the Installations list.' };
    }

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
      `SELECT COALESCE(SUM(txn_count), 0)::int AS n FROM licences WHERE company_id = $1`, [id]))[0];
    const used = Number(u && u.n) || 0;
    await logEvent(null, 'ADMIN_COMPANY_TXNLIMIT', { id, txnLimit: lim, used });
    if (lim > 0 && used >= lim) {
      return { ok: true, warning: 'Saved. This licence has already committed ' + used +
        ' transactions, which is at or over the new limit of ' + lim +
        '. Nothing saved was touched, but its machines cannot commit anything new until the limit is raised.' };
    }

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
                  SET expires_at = GREATEST(now(), expires_at) + make_interval(days => $2::int),
                      state = CASE WHEN $3::bool THEN 'LICENSED'
                                   WHEN state = 'EXPIRED' THEN 'TRIAL' ELSE state END
                WHERE device_id = $1`, [deviceId, days, action === 'licence']);
      await logEvent(deviceId, action === 'licence' ? 'ADMIN_LICENCE' : 'ADMIN_EXTEND', { days, scope: 'device' });
      return { ok: true, scope: 'device' };
    }
    await q(`UPDATE companies
                SET expires_at = GREATEST(now(), expires_at) + make_interval(days => $2::int)
                  ${action === 'licence' ? ", state = 'LICENSED', is_demo = false" : ''}
              WHERE id = $1`, [companyId, days]);
    await logEvent(deviceId, action === 'licence' ? 'ADMIN_LICENCE' : 'ADMIN_EXTEND',
      { days, scope: 'company', companyId });
    return { ok: true, scope: 'company', companyId,
      warning: 'This applied to the whole company — every machine on that licence.' };

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
<title>Nexora — Licences</title>
<style>
:root{--bg:#f4f6fb;--surface:#fff;--border:#e1e5ee;--text:#1a2233;--muted:#667085;--accent:#4f7cff;
      --ok:#16a34a;--warn:#d97706;--bad:#dc2626;--okbg:#e8f7ee;--warnbg:#fef3e2;--badbg:#fdeaea;}
@media(prefers-color-scheme:dark){:root{--bg:#12141c;--surface:#1b1e29;--border:#2a2e3e;--text:#e8ebf2;--muted:#98a2b3;
      --okbg:#123222;--warnbg:#3a2a10;--badbg:#3a1717;}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600}
.s-TRIAL{background:var(--okbg);color:var(--ok)}.s-LICENSED{background:#eaf1fe;color:var(--accent)}
.s-DEMO{background:var(--okbg);color:var(--ok)}
.s-EXPIRED{background:var(--warnbg);color:var(--warn)}.s-REVOKED{background:var(--badbg);color:var(--bad)}
.s-SUSPENDED{background:var(--badbg);color:var(--bad)}
.keycell{font:13px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.03em;color:var(--text)}
.seatbar{display:inline-block;min-width:78px}
.seatbar i{display:block;height:5px;border-radius:3px;background:var(--border);margin-top:3px;overflow:hidden}
.seatbar i b{display:block;height:100%;background:var(--accent)}
.seatbar.full i b{background:var(--bad)}
.msg.warn{background:var(--warnbg);color:var(--warn)}
.msg.ok{background:var(--okbg);color:var(--ok)}
button{font:inherit;padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);
       color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
input,select{font:inherit;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)}
code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tools{display:flex;gap:6px;flex-wrap:wrap}
#gate{max-width:380px;margin:12vh auto}
.msg{padding:10px 12px;border-radius:8px;margin-bottom:12px}
.msg.err{background:var(--badbg);color:var(--bad)}
.kpi{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:4px}
.kpi div b{display:block;font-size:22px}
.kpi div span{color:var(--muted);font-size:12px}
@media(max-width:640px){th:nth-child(3),td:nth-child(3),th:nth-child(7),td:nth-child(7){display:none}}
</style></head><body>
<div class="wrap">
  <div id="gate" class="card">
    <h1>Nexora — Licences</h1>
    <p class="sub">Enter your admin key.</p>
    <div id="gateErr"></div>
    <div class="row"><input id="key" type="password" placeholder="Admin key" style="flex:1"
      onkeydown="if(event.key==='Enter')load()"><button class="primary" onclick="load()">Open</button></div>
  </div>
  <div id="app" style="display:none">
    <h1>Nexora — Licences</h1>
    <p class="sub" id="sub"></p>
    <div class="card">
      <div class="kpi" id="kpi"></div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <b style="flex:1">Settings</b>
        <label>Demo days <input id="sTrial" type="number" min="1" max="365" style="width:70px"></label>
        <label>Demo offline days <input id="sGrace" type="number" min="0" max="365" style="width:70px"></label>
        <label>Working window (min) <input id="sSession" type="number" min="5" max="720" style="width:70px"></label>
        <label>On expiry
          <select id="sMode"><option value="READONLY">Read-only</option><option value="HARDSTOP">Hard stop</option></select>
        </label>
        <label><input id="sOpen" type="checkbox"> Accept new demos</label>
        <button class="primary" onclick="saveSettings()">Save</button>
      </div>
      <div class="sub" style="margin:0;font-size:12px">
        Applies to every installation from its next check — no new build needed.
        <b>Demo offline days 0</b> means a demo stops the moment it cannot reach this service;
        the working window is only how long a good answer is reused before asking again, so the
        app is not calling on every keystroke. Per-customer offline days are set on the company.
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <b style="flex:1">Companies</b>
        <button class="primary" onclick="showNew()">New company</button>
        <button onclick="load()">Refresh</button>
      </div>
      <div id="newco" style="display:none;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
        <div class="row">
          <label>Name <input id="nName" placeholder="Satyendra Packaging" style="min-width:200px"></label>
          <label>Seats <input id="nSeats" type="number" min="1" max="500" value="1" style="width:70px"></label>
          <label>Days <input id="nDays" type="number" min="1" max="3650" value="365" style="width:80px"></label>
          <label>Offline days <input id="nGrace" type="number" min="0" max="365" value="0" style="width:70px"></label>
          <label>GSTIN <input id="nGst" placeholder="optional" maxlength="15" style="min-width:170px;text-transform:uppercase"></label>
          <label>Email <input id="nEmail" placeholder="optional" style="min-width:160px"></label>
          <button class="primary" onclick="createCo()">Create</button>
          <button onclick="document.getElementById('newco').style.display='none'">Cancel</button>
        </div>
        <div class="sub" style="margin:8px 0 0;font-size:12px">
          A key is generated. Give it to the customer — every machine they install types the same key
          and takes one seat.
        </div>
      </div>
      <div id="coMsg"></div>
      <div style="overflow-x:auto"><table id="cotbl">
        <thead><tr><th>Company</th><th>Licence key</th><th>State</th><th>Seats</th><th>Days left</th>
        <th>Offline</th><th>Actions</th></tr></thead><tbody></tbody></table></div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <b style="flex:1">Installations</b>
        <input id="q" placeholder="Search company, key, email, device" oninput="render()" style="min-width:200px">
        <button onclick="load()">Refresh</button>
      </div>
      <div style="overflow-x:auto"><table id="tbl">
        <thead><tr><th>Company</th><th>State</th><th>Email</th><th>Days left</th><th>Started</th>
        <th>Last seen</th><th>Version</th><th>Actions</th></tr></thead><tbody></tbody></table></div>
      <div class="sub" style="margin:10px 0 0;font-size:12px">
        The clock belongs to the <b>company</b>, not the machine — extend or suspend it above and every
        seat follows. Revoking one machine only frees its seat so another can take it.
      </div>
    </div>
  </div>
</div>
<script>
let KEY='', DATA={licences:[],companies:[],settings:{}};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function api(path,opts){
  const r=await fetch(path,Object.assign({headers:{'x-admin-key':KEY,'content-type':'application/json'}},opts||{}));
  if(r.status===401)throw new Error('That admin key was not accepted.');
  if(!r.ok)throw new Error('Request failed ('+r.status+')');
  return r.json();
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
    renderCompanies();
    render();
  }catch(e){
    KEY='';
    document.getElementById('gateErr').innerHTML='<div class="msg err">'+esc(e.message)+'</div>';
  }
}
function showNew(){const n=document.getElementById('newco');n.style.display=n.style.display==='none'?'':'none';}
function say(html){document.getElementById('coMsg').innerHTML=html;}

function renderCompanies(){
  const cos=DATA.companies||[];
  const fmt=d=>d?new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'2-digit'}):'—';
  document.querySelector('#cotbl tbody').innerHTML=cos.map(c=>{
    const state=(c.days_left<=0&&c.state!=='SUSPENDED')?'EXPIRED':c.state;
    const used=c.seats_used, seats=c.seats;
    const pct=Math.min(100,Math.round(used/Math.max(1,seats)*100));
    return '<tr>'+
      '<td><b>'+esc(c.name)+'</b>'+(c.is_demo?' <span class="pill s-DEMO">demo</span>':'')+
        (c.gstin?'<br><code>GSTIN '+esc(c.gstin)+'</code>':'')+
        (c.email?'<br><code>'+esc(c.email)+'</code>':'')+'</td>'+
      '<td><span class="keycell">'+esc(c.licence_key)+'</span> '+
        '<button title="Copy" onclick="copyKey(\\''+c.licence_key+'\\')">Copy</button></td>'+
      '<td><span class="pill s-'+state+'">'+state+'</span></td>'+
      '<td><span class="seatbar'+(used>=seats?' full':'')+'">'+used+' of '+seats+
        '<i><b style="width:'+pct+'%"></b></i></span></td>'+
      '<td>'+(state==='EXPIRED'||state==='SUSPENDED'?fmt(c.expires_at):c.days_left+'<br><code>'+fmt(c.expires_at)+'</code>')+'</td>'+
      '<td>'+(c.grace_days>0?c.grace_days+' d':'<span title="Stops as soon as it cannot reach the service">none</span>')+'</td>'+
      '<td><div class="tools">'+
        '<button onclick="coAct('+c.id+',\\'extend\\',365)">+1 yr</button>'+
        (c.is_demo?'<button class="primary" onclick="coAct('+c.id+',\\'licence\\',365)">Make licensed</button>':'')+
        '<button onclick="coSeats('+c.id+','+seats+')">Seats</button>'+
        '<button onclick="coGrace('+c.id+','+c.grace_days+')">Offline</button>'+
        (c.state==='SUSPENDED'
          ?'<button onclick="coAct('+c.id+',\\'restore\\',0)">Restore</button>'
          :'<button onclick="coAct('+c.id+',\\'suspend\\',0)">Suspend</button>')+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="7" style="color:var(--muted)">No companies yet. Every demo creates one automatically.</td></tr>';
}
function copyKey(k){
  try{navigator.clipboard.writeText(k);say('<div class="msg ok">Copied '+esc(k)+'</div>');
      setTimeout(()=>say(''),2500);}catch(e){prompt('Licence key',k);}
}
async function coAct(id,action,days){
  if(action==='suspend'&&!confirm('Suspend this company? EVERY machine on this licence stops calculating at its next check.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id,action,days})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');else say('');
  await load();
}
async function coSeats(id,now){
  const v=prompt('How many machines may run on this licence?',now);
  if(v===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id,action:'seats',seats:+v})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');else say('');
  await load();
}
async function coGrace(id,now){
  const v=prompt('How many days may this customer work with no contact with the service?\\n\\n0 = none: it stops as soon as it cannot reach us.',now);
  if(v===null)return;
  await api('/admin/api/company',{method:'POST',body:JSON.stringify({id,action:'grace',graceDays:+v})});
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
  document.getElementById('nName').value='';document.getElementById('nEmail').value='';
  await load();
  say('<div class="msg ok"><b>'+esc(r.company.name)+'</b> created. Licence key <span class="keycell">'+
      esc(r.company.licence_key)+'</span> — give this to the customer; every machine types it at activation.</div>');
}

function render(){
  const term=(document.getElementById('q').value||'').toLowerCase();
  const rows=DATA.licences.filter(l=>!term||
    [l.company,l.co_name,l.co_key,l.email,l.device_id,l.device_name].some(v=>String(v||'').toLowerCase().includes(term)));
  const all=DATA.licences;
  const cos=DATA.companies||[];
  const n=st=>all.filter(l=>l.state===st).length;
  const live=all.filter(l=>l.days_left>0&&l.state!=='REVOKED').length;
  document.getElementById('kpi').innerHTML=
    '<div><b>'+cos.filter(c=>!c.is_demo).length+'</b><span>Customers</span></div>'+
    '<div><b>'+cos.filter(c=>c.is_demo).length+'</b><span>Demos</span></div>'+
    '<div><b>'+all.length+'</b><span>Installations</span></div>'+
    '<div><b>'+live+'</b><span>Running</span></div>'+
    '<div><b>'+n('REVOKED')+'</b><span>Revoked</span></div>';
  document.getElementById('sub').textContent=rows.length+' of '+all.length+' shown';
  const fmt=d=>d?new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'2-digit'}):'—';
  document.querySelector('#tbl tbody').innerHTML=rows.map(l=>{
    let state=(l.state==='TRIAL'&&l.days_left<=0)?'EXPIRED':l.state;
    if(l.co_state==='SUSPENDED'&&state!=='REVOKED')state='SUSPENDED';
    return '<tr>'+
      '<td><b>'+esc(l.co_name||l.company||'—')+'</b>'+
        (l.seat_no?' <code>seat '+l.seat_no+' of '+(l.co_seats||1)+'</code>':'')+
        (l.co_key?'<br><span class="keycell">'+esc(l.co_key)+'</span>':'')+
        '<br><code>'+esc(String(l.device_id).slice(0,12))+'…</code>'+
        (l.device_name?' <code>'+esc(l.device_name)+'</code>':'')+'</td>'+
      '<td><span class="pill s-'+state+'">'+state+'</span></td>'+
      '<td>'+esc(l.email||'—')+'</td>'+
      '<td>'+(state==='EXPIRED'||state==='REVOKED'?'—':l.days_left)+'</td>'+
      '<td>'+fmt(l.trial_started_at)+'</td>'+
      '<td>'+fmt(l.last_seen_at)+'</td>'+
      '<td>'+esc(l.app_version||'—')+'</td>'+
      '<td><div class="tools">'+
        (l.state==='REVOKED'
          ?'<button onclick="act(\\''+l.device_id+'\\',\\'restore\\',0)">Restore</button>'
          :'<button onclick="act(\\''+l.device_id+'\\',\\'revoke\\',0)">Revoke — frees the seat</button>')+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="8" style="color:var(--muted)">Nothing yet — no one has installed it.</td></tr>';
}
async function act(deviceId,action,days){
  if(action==='revoke'&&!confirm('Revoke this installation? It stops calculating at its next check, and its seat is freed for another machine.'))return;
  const r=await api('/admin/api/licence',{method:'POST',body:JSON.stringify({deviceId,action,days})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  if(r.warning)say('<div class="msg warn">'+esc(r.warning)+'</div>');else say('');
  await load();
}
async function saveSettings(){
  await api('/admin/api/settings',{method:'POST',body:JSON.stringify({
    trialDays:+document.getElementById('sTrial').value,
    demoGraceDays:+document.getElementById('sGrace').value,
    sessionMinutes:+document.getElementById('sSession').value,
    expiredMode:document.getElementById('sMode').value,
    signupsOpen:document.getElementById('sOpen').checked})});
  await load();
}
try{const k=sessionStorage.getItem('nexora_admin_key');if(k){KEY=k;load();}}catch(e){}
</script></body></html>`;

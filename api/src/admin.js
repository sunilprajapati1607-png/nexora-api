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

const ADMIN_KEY = process.env.NEXORA_ADMIN_KEY || '';

export function adminAuthorised(request) {
  const k = request.headers.get('x-admin-key') || '';
  return !!ADMIN_KEY && k === ADMIN_KEY;
}

export async function listLicences() {
  const rows = await q(`
    SELECT device_id, device_name, company, email, state, trial_started_at,
           expires_at, created_at, last_seen_at, seen_count, app_version, notes,
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - now())) / 86400.0))::int AS days_left
      FROM licences
     ORDER BY created_at DESC
     LIMIT 500`);
  const settings = await getSettings();
  return { licences: rows, settings };
}

export async function licenceAction(body) {
  const deviceId = String(body.deviceId || '');
  const action = String(body.action || '');
  const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 7));
  if (!deviceId) return { error: 'deviceId is required' };

  if (action === 'extend') {
    /* Extend from whichever is later — now, or the current expiry — so
       extending a live trial adds time rather than shortening it. */
    await q(`UPDATE licences
                SET expires_at = GREATEST(now(), expires_at) + make_interval(days => $2::int),
                    state = CASE WHEN state = 'EXPIRED' THEN 'TRIAL' ELSE state END
              WHERE device_id = $1`, [deviceId, days]);
    await logEvent(deviceId, 'ADMIN_EXTEND', { days });
  } else if (action === 'licence') {
    await q(`UPDATE licences
                SET state = 'LICENSED',
                    expires_at = GREATEST(now(), expires_at) + make_interval(days => $2::int)
              WHERE device_id = $1`, [deviceId, days]);
    await logEvent(deviceId, 'ADMIN_LICENCE', { days });
  } else if (action === 'revoke') {
    await q(`UPDATE licences SET state = 'REVOKED' WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_REVOKE', {});
  } else if (action === 'restore') {
    await q(`UPDATE licences SET state = CASE WHEN expires_at > now() THEN 'TRIAL' ELSE 'EXPIRED' END
              WHERE device_id = $1`, [deviceId]);
    await logEvent(deviceId, 'ADMIN_RESTORE', {});
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
.s-EXPIRED{background:var(--warnbg);color:var(--warn)}.s-REVOKED{background:var(--badbg);color:var(--bad)}
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
        <label>Trial days <input id="sTrial" type="number" min="1" max="365" style="width:80px"></label>
        <label>On expiry
          <select id="sMode"><option value="READONLY">Read-only</option><option value="HARDSTOP">Hard stop</option></select>
        </label>
        <label><input id="sOpen" type="checkbox"> Accept new trials</label>
        <button class="primary" onclick="saveSettings()">Save</button>
      </div>
      <div class="sub" style="margin:0;font-size:12px">Applies to every installation from its next check — no new build needed.</div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <b style="flex:1">Installations</b>
        <input id="q" placeholder="Search company, email, device" oninput="render()" style="min-width:200px">
        <button onclick="load()">Refresh</button>
      </div>
      <div style="overflow-x:auto"><table id="tbl">
        <thead><tr><th>Company</th><th>State</th><th>Email</th><th>Days left</th><th>Started</th>
        <th>Last seen</th><th>Version</th><th>Actions</th></tr></thead><tbody></tbody></table></div>
    </div>
  </div>
</div>
<script>
let KEY='', DATA={licences:[],settings:{}};
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
    document.getElementById('sMode').value=s.expiredMode;
    document.getElementById('sOpen').checked=!!s.signupsOpen;
    render();
  }catch(e){
    KEY='';
    document.getElementById('gateErr').innerHTML='<div class="msg err">'+esc(e.message)+'</div>';
  }
}
function render(){
  const term=(document.getElementById('q').value||'').toLowerCase();
  const rows=DATA.licences.filter(l=>!term||
    [l.company,l.email,l.device_id,l.device_name].some(v=>String(v||'').toLowerCase().includes(term)));
  const all=DATA.licences;
  const n=st=>all.filter(l=>l.state===st).length;
  const live=all.filter(l=>l.state==='TRIAL'&&l.days_left>0).length;
  document.getElementById('kpi').innerHTML=
    '<div><b>'+all.length+'</b><span>Installations</span></div>'+
    '<div><b>'+live+'</b><span>Trials running</span></div>'+
    '<div><b>'+n('LICENSED')+'</b><span>Licensed</span></div>'+
    '<div><b>'+n('EXPIRED')+'</b><span>Expired</span></div>'+
    '<div><b>'+n('REVOKED')+'</b><span>Revoked</span></div>';
  document.getElementById('sub').textContent=rows.length+' of '+all.length+' shown';
  const fmt=d=>d?new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'2-digit'}):'—';
  document.querySelector('#tbl tbody').innerHTML=rows.map(l=>{
    const state=(l.state==='TRIAL'&&l.days_left<=0)?'EXPIRED':l.state;
    return '<tr>'+
      '<td><b>'+esc(l.company||'—')+'</b><br><code>'+esc(String(l.device_id).slice(0,12))+'…</code>'+
        (l.device_name?'<br><code>'+esc(l.device_name)+'</code>':'')+'</td>'+
      '<td><span class="pill s-'+state+'">'+state+'</span></td>'+
      '<td>'+esc(l.email||'—')+'</td>'+
      '<td>'+(state==='EXPIRED'||state==='REVOKED'?'—':l.days_left)+'</td>'+
      '<td>'+fmt(l.trial_started_at)+'</td>'+
      '<td>'+fmt(l.last_seen_at)+'</td>'+
      '<td>'+esc(l.app_version||'—')+'</td>'+
      '<td><div class="tools">'+
        '<button onclick="act(\\''+l.device_id+'\\',\\'extend\\',7)">+7 days</button>'+
        '<button onclick="act(\\''+l.device_id+'\\',\\'licence\\',365)">Licence 1 yr</button>'+
        (l.state==='REVOKED'
          ?'<button onclick="act(\\''+l.device_id+'\\',\\'restore\\',0)">Restore</button>'
          :'<button onclick="act(\\''+l.device_id+'\\',\\'revoke\\',0)">Revoke</button>')+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="8" style="color:var(--muted)">Nothing yet — no one has installed it.</td></tr>';
}
async function act(deviceId,action,days){
  if(action==='revoke'&&!confirm('Revoke this installation? It stops calculating at its next check.'))return;
  await api('/admin/api/licence',{method:'POST',body:JSON.stringify({deviceId,action,days})});
  await load();
}
async function saveSettings(){
  await api('/admin/api/settings',{method:'POST',body:JSON.stringify({
    trialDays:+document.getElementById('sTrial').value,
    expiredMode:document.getElementById('sMode').value,
    signupsOpen:document.getElementById('sOpen').checked})});
  await load();
}
try{const k=sessionStorage.getItem('nexora_admin_key');if(k){KEY=k;load();}}catch(e){}
</script></body></html>`;

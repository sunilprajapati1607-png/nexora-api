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
import { hashPasscode, validPasscode, PASSCODE_MIN } from './passcode.js';
import { newLicenceKey } from './licence.js';
import { ensureAdmin, usersSummary, userCap, listUsers, hashPin, validPin, nameKey, cleanEmail } from './sync.js';

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
           (COALESCE(c.expires_at, l.expires_at) < now()) AS expired,
           /* 4.43.0 — who is signed in ON THIS MACHINE, now. One person is
              signed in at one place at a time, so there is at most one, and
              a machine with nobody on it can do nothing but show its
              sign-in screen — which is worth seeing from here when a plant
              rings to say "it is not working". */
           u.name AS on_user, u.session_at AS on_since
      FROM licences l
      LEFT JOIN companies c ON c.id = l.company_id
      LEFT JOIN company_users u ON u.session_device = l.device_id
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
           /* 4.42.0 — a seat is a PERSON, so this is the people count.
              The machines are counted beside it under its own name, because
              the owner still wants to know how many are out there — they
              simply are not what the company is paying for. */
           (SELECT COUNT(*)::int FROM company_users u
             WHERE u.company_id = c.id) AS seats_used,
           (SELECT COUNT(*)::int FROM licences l
             WHERE l.company_id = c.id AND l.state <> 'REVOKED') AS machines_used,
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
    /* 4.42.0 — whom a circular would actually reach at this company. */
    c.user_emails = u.emails;
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
    /* 4.42.0 — a seat is a person and nothing else. Machines are not
       rationed any more, so their number is no longer a warning: a plant
       may put Nexora on every terminal it owns and still pay for the
       three people who actually use it. Going below the people already
       created stops nobody; the application refuses the NEXT person. */
    const warn = [];
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

  } else if (action === 'users') {
    /* 4.39.0 — THE PEOPLE ON A COMPANY, FROM THE OWNER'S SIDE.

         "company console ma thi user delete ane create kri sakay ane
          tamam user ane passcode joi sakay"

       A company runs its own people from inside the application, and
       that stays true. But when a plant telephones — the administrator
       has left, nobody can sign in, a leaver is still holding the only
       seat — the owner had no way to see who is on a company, let alone
       do anything about it. This is that way.

       WHAT IS NOT HERE, AND WILL NOT BE: the PINs. They are scrypt
       hashes, exactly like the company passcode, so there is nothing to
       show — not to the plant, not to the owner, not to anyone who ever
       gets hold of the database. That is the whole point of storing them
       that way, and it is worth far more than the convenience of reading
       one back. When somebody has forgotten theirs, SET a new one and
       tell them: 'userpin' below, and 'passcode' for the company's own.
       Every bank in the world answers a forgotten password the same
       way, for the same reason. */
    const list = await listUsers(id);
    const cap = await userCap(id);
    /* 4.43.0 — a device id is sixteen characters of hex and means
       nothing to the person reading it. Name the machine. */
    const machines = await q(`SELECT device_id, device_name FROM licences WHERE company_id = $1`, [id]);
    const nameOf = {};
    machines.forEach((m) => { nameOf[m.device_id] = m.device_name || null; });
    list.forEach((u) => { u.sessionDeviceName = u.sessionDevice ? (nameOf[u.sessionDevice] || null) : null; });
    return { ok: true, users: list, cap: cap };

  } else if (action === 'usersignout') {
    /* 4.43.0 — SIGN SOMEBODY OUT FROM HERE.

       One person is signed in at one place at a time, and a session ends
       when the application closes. That leaves one case the plant cannot
       fix for itself: the machine is gone — stolen, wiped, or sitting
       switched off in a shed — and it will never close tidily. The name
       stays bound to it, and the person cannot get on anywhere because
       they would displace a machine that is not there to be displaced.

       This releases the binding. It does not change the PIN and it does
       not remove anybody: the very next sign-in, anywhere, simply works. */
    const u = (await q(`SELECT id, name, session_device FROM company_users WHERE id = $1 AND company_id = $2`,
      [body.userId, id]))[0];
    if (!u) return { error: 'No such person on this company.' };
    if (!u.session_device) return { ok: true, warning: u.name + ' is not signed in anywhere.' };
    await q(`UPDATE company_users SET session_device = NULL, session_at = NULL WHERE id = $1`, [u.id]);
    await logEvent(null, 'ADMIN_USER_SIGNOUT', { companyId: id, userId: u.id, was: u.session_device });
    return { ok: true, warning: u.name + ' has been signed out. The machine they were on finds out at its next ' +
      'check and shows the sign-in screen; they can sign in anywhere now.' };

  } else if (action === 'useradd') {
    const name = String(body.name || '').trim();
    if (!name) return { error: 'A name is required.' };
    if (!validPin(body.pin)) return { error: 'A PIN of at least 4 characters is required.' };
    const key = nameKey(name);
    const dup = await q(`SELECT id FROM company_users WHERE company_id = $1 AND name_key = $2`, [id, key]);
    if (dup.length) return { error: 'There is already a user called ' + name + ' on this company.' };
    /* The seat limit is the licence, and the owner is not exempt from it:
       a seat given here is a seat the company is not paying for. Raise
       the seats first if that is what is meant. */
    const cap = await userCap(id);
    if (cap.count >= cap.max) {
      return { error: 'This company has ' + cap.max + ' seat(s) and ' + cap.count +
        ' person(s) on them. Give it more seats first, or remove someone who has left.' };
    }
    const rows = await q(
      `INSERT INTO company_users (company_id, name, name_key, pin_hash, role, scope, active, email)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING *`,
      [id, name, key, hashPin(body.pin), body.role === 'ADMIN' ? 'ADMIN' : 'USER',
       body.scope === 'ALL' ? 'ALL' : 'OWN', cleanEmail(body.email)]);
    await logEvent(null, 'ADMIN_USER_CREATE', { companyId: id, userId: rows[0].id, name });
    return { ok: true, warning: name + ' can now sign in. Tell them the PIN directly \u2014 it is not shown again.' };

  } else if (action === 'useremail') {
    /* 4.42.0 \u2014 a person's own address, set or cleared. Blank clears it,
       which is the only way to take somebody off the distribution list who
       still runs the software. */
    const u = (await q(`SELECT id, name FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    const raw = String(body.email == null ? '' : body.email).trim();
    const mail = cleanEmail(raw);
    if (raw && !mail) return { error: 'That does not look like an email address.' };
    await q(`UPDATE company_users SET email = $3 WHERE company_id = $1 AND id = $2`, [id, u.id, mail]);
    await logEvent(null, 'ADMIN_USER_EMAIL', { companyId: id, userId: u.id, name: u.name, set: !!mail });
    return { ok: true, warning: mail
      ? u.name + ' will be written to at ' + mail + '.'
      : 'The address for ' + u.name + ' has been taken off.' };

  } else if (action === 'userrole') {
    /* 4.39.0 — what a person IS on their company. An administrator adds
       and removes people and sees everyone's work; an ordinary user does
       neither. The plant changes this itself from inside the
       application; this is for the call where the only administrator has
       left and nobody inside can promote anyone. */
    const want = body.role === 'ADMIN' ? 'ADMIN' : 'USER';
    const u = (await q(`SELECT id, name, role FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    if (u.role === want) return { ok: true, warning: u.name + ' is already ' + (want === 'ADMIN' ? 'an administrator' : 'an ordinary user') + '.' };
    if (u.role === 'ADMIN' && want === 'USER') {
      const admins = await q(
        `SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1 AND role = 'ADMIN' AND active = true`, [id]);
      if ((Number(admins[0].n) || 0) <= 1) {
        return { error: u.name + ' is the only administrator. Make somebody else one first \u2014 a company with none cannot add anybody.' };
      }
    }
    /* An administrator sees the company's work, which is what the role is
       for; stepping down puts that back to their own unless somebody has
       deliberately widened it. */
    await q(`UPDATE company_users SET role = $3, scope = CASE WHEN $3 = 'ADMIN' THEN 'ALL' ELSE scope END
              WHERE company_id = $1 AND id = $2`, [id, u.id, want]);
    await logEvent(null, 'ADMIN_USER_ROLE', { companyId: id, userId: u.id, name: u.name, role: want });
    return { ok: true, warning: u.name + ' is now ' + (want === 'ADMIN' ? 'an administrator.' : 'an ordinary user.') };

  } else if (action === 'userpin') {
    if (!validPin(body.pin)) return { error: 'A PIN of at least 4 characters is required.' };
    const u = (await q(`SELECT id, name FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    await q(`UPDATE company_users SET pin_hash = $3 WHERE company_id = $1 AND id = $2`,
      [id, u.id, hashPin(body.pin)]);
    await logEvent(null, 'ADMIN_USER_PIN', { companyId: id, userId: u.id, name: u.name });
    return { ok: true, warning: 'The PIN for ' + u.name + ' has been set. Tell them directly \u2014 it is not shown again.' };

  } else if (action === 'userdel') {
    const u = (await q(`SELECT id, name, role FROM company_users WHERE company_id = $1 AND id = $2`, [id, +body.userId]))[0];
    if (!u) return { error: 'No such user on this company.' };
    /* A company with nobody who can add anyone is a company nobody can
       get back into, so the last administrator does not go this way.
       Make somebody else an administrator first. */
    if (u.role === 'ADMIN') {
      const admins = await q(
        `SELECT COUNT(*)::int AS n FROM company_users WHERE company_id = $1 AND role = 'ADMIN' AND active = true`, [id]);
      if ((Number(admins[0].n) || 0) <= 1) {
        return { error: u.name + ' is the only administrator. Set another one first \u2014 a company with none cannot add anybody.' };
      }
    }
    /* What they saved stays with the company: it is the company's work,
       and a leaver must not take the plant's costings with them. */
    await q(`DELETE FROM company_users WHERE company_id = $1 AND id = $2`, [id, u.id]);
    await logEvent(null, 'ADMIN_USER_DELETE', { companyId: id, userId: u.id, name: u.name });
    return { ok: true, warning: u.name + ' has been removed and their seat is free. Everything they saved stays with the company.' };

  } else if (action === 'passcode') {
    /* 4.39.0 — SET A NEW COMPANY PASSCODE.

       The passcode is scrypt-hashed (passcode.js), so it cannot be read
       back by anyone, including whoever is reading this. That is right —
       and it left a plant that forgot theirs with no way onto another
       computer at all, because the id and passcode are how a
       self-registered company joins its next seat.

       So the owner can set a new one, and tell the customer. It is
       deliberately SET, never shown: there is nothing to show. The login
       id can be corrected at the same time, because a company that
       cannot remember the passcode often cannot remember the id either,
       and a login needs both halves to be right.

       Only a company that registered itself has either; a company Nexora
       issued a licence key to joins with the key and is told so rather
       than being given a passcode it will never use. */
    const co = (await q(`SELECT id, name, login_id, self_registered FROM companies WHERE id = $1`, [id]))[0];
    if (!co) return { error: 'No such company.' };
    if (!co.self_registered) {
      return { error: co.name + ' did not register itself — it joins with its licence key, not with a passcode.' };
    }
    const passcode = body.passcode == null ? '' : String(body.passcode);
    if (!validPasscode(passcode)) {
      return { error: 'A company passcode needs at least ' + PASSCODE_MIN + ' characters.' };
    }
    let loginId = body.loginId == null ? '' : String(body.loginId).trim().toLowerCase();
    if (loginId && loginId !== co.login_id) {
      const taken = await q(`SELECT id FROM companies WHERE login_id = $1 AND id <> $2 LIMIT 1`, [loginId, id]);
      if (taken.length) return { error: 'Another company already uses the login id "' + loginId + '".' };
    } else {
      loginId = co.login_id;
    }
    await q(`UPDATE companies SET login_id = $2, passcode_hash = $3 WHERE id = $1`,
      [id, loginId, hashPasscode(passcode)]);
    /* Recorded, because changing the way into a company is exactly the
       kind of thing that should be answerable for afterwards. The
       passcode itself is never written down. */
    await logEvent(null, 'ADMIN_COMPANY_PASSCODE', { id, name: co.name, loginId });
    return { ok: true, warning: 'The login for ' + co.name + ' is now id "' + loginId +
      '" with the new passcode. Tell them directly \u2014 it is not shown again.' };

  } else if (action === 'adminuser') {
    /* 4.8.0 — the owner creates (or resets the PIN of) the company's
       administrator. Everything else about users happens inside the
       application, by that administrator. */
    const out = await ensureAdmin(id, { name: body.name, pin: body.pin, email: body.email });
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
    /* 4.42.0 — no seat check: a machine takes no seat, so bringing one
       back cannot take one. What it may DO is decided when a person signs
       in on it, and the people are counted where they are created. */
    const rows = await q(`SELECT company_id FROM licences WHERE device_id = $1`, [deviceId]);
    const companyId = rows.length ? rows[0].company_id : null;
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
<link rel="icon" type="image/png" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">
<style>
/* 4.39.0 — THE CONSOLE WEARS THE APPLICATION'S THEME.

     "make it reach same like app theme"

   It had the application's colours and none of its manners: no brand,
   no mode switch of its own, flat cards, flat buttons. Somebody who
   spends their day in Nexora and then opens this to answer a customer
   should not feel they have left the product.

   These are the application's OWN tokens, values and all \u2014 including the
   4.39.0 dark mode, where the quiet writing was lifted from 3.13:1 to
   4.82:1 against a card. The console is themed BY HAND rather than by
   the OS now, exactly as the app is: data-theme on the root, remembered
   between visits, starting from whatever the machine prefers. */
:root{
  --bg:#f4f6fb;--bg-elevated:#ffffff;--bg-sunken:#eceff5;--surface:#fff;--surface-hover:#f1f4fa;
  --border:#e1e5ee;--border-strong:#cbd2e1;
  --text:#1a2233;--muted:#667085;--faint:#98a2b3;
  --accent:#4f7cff;--accent-rgb:79,124,255;--accentbg:#eaf1fe;
  --ok:#16a34a;--warn:#d97706;--bad:#dc2626;--okbg:#e8f7ee;--warnbg:#fef3e2;--badbg:#fdeaea;
  --shadow-sm:0 1px 2px rgba(20,24,38,.06);
  --shadow:0 4px 16px rgba(20,24,38,.08);
  --shadow-lg:0 12px 32px rgba(20,24,38,.14);
  --radius:12px;--radius-sm:8px;
  --font:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
}
:root[data-theme=dark]{
  --bg:#12141c;--bg-elevated:#1b1e29;--bg-sunken:#0c0e14;--surface:#1b1e29;--surface-hover:#232735;
  --border:#333a4f;--border-strong:#464f6a;
  --text:#eef0f6;--muted:#a8b2ca;--faint:#7f8aa6;
  --accentbg:#1c2740;
  --ok:#34d399;--warn:#fbbf24;--bad:#f87171;--okbg:#12291f;--warnbg:#2c2410;--badbg:#2c1616;
  /* Depth in a dark room comes from the edge: a black shadow on a
     near-black page is invisible, so every raised surface carries a
     hairline of light along its top instead. */
  --shadow-sm:0 1px 2px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.035);
  --shadow:0 4px 20px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.045);
  --shadow-lg:0 16px 40px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);
}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 var(--font);background:var(--bg);color:var(--text);
     -webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0}
.sub{color:var(--muted);margin:0}
/* A card carries the accent down its left edge, painted INSIDE the
   border so the card is exactly the size it was \u2014 the application's
   own signature, and the thing that makes a page of them read as one
   product rather than as a table of boxes. */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:14px;
      box-shadow:var(--shadow-sm),inset 3px 0 0 rgba(var(--accent-rgb),.45);
      transition:box-shadow .16s ease,border-color .16s ease}
.card:hover{box-shadow:var(--shadow),inset 3px 0 0 rgba(var(--accent-rgb),.9)}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.top .grow{flex:1}
.kpis{display:flex;gap:8px;flex-wrap:wrap}
.kpi{background:var(--bg-sunken);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 15px;min-width:100px;
     position:relative;overflow:hidden}
/* the state bar every figure tile in the application wears */
.kpi::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:rgba(var(--accent-rgb),.55)}
.kpi b{display:block;font-size:21px;line-height:1.1;font-weight:800;letter-spacing:-.01em}
.kpi span{color:var(--muted);font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap;border:1px solid transparent}
.s-TRIAL,.s-DEMO{background:var(--okbg);color:var(--ok)}.s-LICENSED{background:var(--accentbg);color:var(--accent)}
.s-EXPIRED{background:var(--warnbg);color:var(--warn)}.s-REVOKED,.s-SUSPENDED,.s-FAILED{background:var(--badbg);color:var(--bad)}
.s-SELF{background:var(--accentbg);color:var(--accent)}.s-UNVERIFIED{background:var(--warnbg);color:var(--warn)}
.key{font:13px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.03em}
code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)}
button{font:inherit;font-weight:700;padding:7px 13px;border:1px solid var(--border);border-radius:var(--radius-sm);
       background:var(--surface);color:var(--text);cursor:pointer;
       transition:transform .12s cubic-bezier(.2,.8,.3,1),box-shadow .12s ease,border-color .12s ease,color .12s ease,background .12s ease}
button:hover{border-color:var(--accent);color:var(--accent);background:var(--surface-hover);transform:translateY(-1px);box-shadow:var(--shadow-sm)}
button:active{transform:translateY(0)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 2px 6px rgba(var(--accent-rgb),.35)}
button.primary:hover{color:#fff;background:var(--accent);box-shadow:0 4px 12px rgba(var(--accent-rgb),.5)}
button.danger{border-color:var(--bad);color:var(--bad)}button.danger:hover{background:var(--badbg);color:var(--bad)}
button.small{padding:4px 9px;font-size:12px;border-radius:7px}
input,select{font:inherit;padding:8px 10px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);
             background:var(--bg-sunken);color:var(--text);transition:border-color .12s ease,box-shadow .12s ease}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(var(--accent-rgb),.18)}
label{display:inline-flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
label input,label select{font-size:14px;color:var(--text)}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.msg{padding:10px 13px;border-radius:var(--radius-sm);margin:8px 0;font-weight:600;border:1px solid transparent}
.msg.err{background:var(--badbg);color:var(--bad)}.msg.warn{background:var(--warnbg);color:var(--warn)}.msg.ok{background:var(--okbg);color:var(--ok)}
.help{color:var(--muted);font-size:12.5px;margin:6px 0 0}
#gate{max-width:400px;margin:12vh auto}
/* companies */
.co{border:1px solid var(--border);border-radius:var(--radius);padding:15px 17px;margin-bottom:10px;background:var(--surface);
    box-shadow:var(--shadow-sm),inset 3px 0 0 rgba(var(--accent-rgb),.45);
    transition:box-shadow .16s ease,border-color .16s ease}
.co:hover{box-shadow:var(--shadow),inset 3px 0 0 rgba(var(--accent-rgb),.9)}
.co.suspended{border-color:var(--bad)}
.co-head{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
.co-name{font-size:16px;font-weight:700;margin-right:4px}
.co-meta{color:var(--muted);font-size:12.5px;display:flex;gap:14px;flex-wrap:wrap;margin-top:6px}
.co-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
.fact{border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 11px;background:var(--bg-sunken)}
.fact span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.fact b{font-size:15.5px;font-weight:800}
.fact small{color:var(--muted)}
.bar{display:block;height:5px;border-radius:3px;background:var(--border);margin-top:5px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}.bar.full i{background:var(--bad)}
.manage{margin-top:12px;border-top:1px dashed var(--border);padding-top:12px;display:none}
.manage.open{display:block}
.group{margin-bottom:10px}
.group h4{margin:0 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.acts .why{color:var(--muted);font-size:12px;margin-left:4px}
/* 4.45.0 — a row of doors to each section, with what is waiting in each,
   pinned under the title so a long page is one press from anywhere. */
.jump{position:sticky;top:0;z-index:5;display:flex;gap:6px;flex-wrap:wrap;align-items:center;
  padding:8px 0 10px;margin:0 0 6px;background:var(--bg)}
.jump a{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;
  border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);font-weight:700;
  font-size:12.5px;text-decoration:none;box-shadow:var(--shadow-sm)}
.jump a:hover{border-color:var(--accent);color:var(--accent)}
.jump a b{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--accentbg);
  color:var(--accent);font-size:11px;text-align:center;line-height:18px}
.jump a b.hot{background:var(--badbg);color:var(--bad)}
.jump a b.zero{background:var(--bg-sunken);color:var(--muted)}
.say{white-space:pre-wrap;max-width:380px;display:block;line-height:1.45}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:10px}
.legend div{background:var(--bg);border-radius:9px;padding:9px 11px;font-size:12.5px}
.legend b{display:block}
/* ---- the brand, as the application wears it ---- */
.brand{display:flex;align-items:center;gap:11px}
/* 4.44.0 — THE REAL MARK, not a letter in a blue box. The same logo the
   calculation software and the website wear, served by this service itself
   from /logo.png so the console does not depend on anything else being up.
   The dark mode gets a soft halo behind it, because a mark drawn for white
   paper needs a little light under it on a near-black page. */
.brand-mark{width:38px;height:38px;flex:0 0 auto;object-fit:contain;display:block;
  filter:drop-shadow(0 1px 2px rgba(10,14,28,.18))}
:root[data-theme=dark] .brand-mark{
  background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.10) 0%, rgba(255,255,255,0) 70%);
  border-radius:11px;
  filter:drop-shadow(0 0 10px rgba(var(--accent-rgb),.45))}
.brand h1{font-size:18px;letter-spacing:-.01em}
.brand .sub{font-size:11.5px}
/* ---- light and dark, the same switch the application has ---- */
.mode-switch{appearance:none;cursor:pointer;position:relative;width:50px;height:26px;padding:0;flex:0 0 auto;
  border:1px solid var(--border-strong);border-radius:999px;background:var(--bg-sunken);display:inline-flex;align-items:center;
  transition:background .2s ease,border-color .2s ease}
.mode-switch:hover{border-color:rgba(var(--accent-rgb),.75);transform:none;box-shadow:none}
.mode-switch .mode-mark{position:absolute;top:50%;transform:translateY(-50%);width:14px;height:14px;
  display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:11px;transition:opacity .2s ease}
.mode-switch .mode-sun{left:6px}.mode-switch .mode-moon{right:6px}
.mode-switch[aria-checked=false] .mode-sun{opacity:0}
.mode-switch[aria-checked=true] .mode-moon{opacity:0}
.mode-switch .mode-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:11px;
  background:linear-gradient(180deg,#fff 0%,#e6e9f2 100%);color:#d38b0c;
  box-shadow:0 1px 3px rgba(10,14,28,.45),inset 0 1px 0 rgba(255,255,255,.9);
  transition:transform .22s cubic-bezier(.2,.8,.3,1),background .2s ease,color .2s ease}
.mode-switch[aria-checked=true] .mode-knob{transform:translateX(24px);
  background:linear-gradient(180deg,#39415c 0%,#232a3d 100%);color:#cfe0ff}
@media(prefers-reduced-motion:reduce){.mode-switch .mode-knob{transition:none}button{transition:none}}
/* The people panel is a sunken surface, the way the application makes
   a panel that belongs INSIDE a card \u2014 and it takes its colours from
   the tokens rather than from a hard-coded grey, so it follows the
   theme instead of fighting it. */
.users-panel{margin:8px 0 4px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);
             background:var(--bg-sunken);width:100%}
.users-panel table.users{width:100%;border-collapse:collapse;margin:6px 0}
.users-panel table.users th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.7;padding:4px 8px 4px 0}
.users-panel table.users td{padding:7px 10px 7px 0;border-top:1px solid var(--border);font-size:13px}
.users-panel tr.off{opacity:.55}
</style></head><body>
<div class="wrap">
  <div id="gate" class="card">
    <div class="brand" style="margin-bottom:10px"><img class="brand-mark" src="/logo.png" alt="Nexora" width="38" height="38">
      <div><h1 style="margin:0">NEXORA</h1><p class="sub" style="margin:0">Licence console</p></div></div>
    <p class="sub" style="margin:4px 0 12px">Enter the admin key (NEXORA_ADMIN_KEY on the service).</p>
    <div id="gateErr"></div>
    <div class="row"><input id="key" type="password" placeholder="Admin key" style="flex:1" onkeydown="if(event.key==='Enter')load()"><button class="primary" onclick="load()">Open</button></div>
  </div>

  <div id="app" style="display:none">
    <div class="top">
      <div class="grow brand"><img class="brand-mark" src="/logo.png" alt="Nexora" width="38" height="38">
        <div><h1 style="margin:0">NEXORA <span class="sub" style="font-weight:600">Licence console</span></h1>
        <p class="sub" id="sub"></p></div></div>
      <div class="kpis" id="kpi"></div>
      <button class="mode-switch" id="mode-switch" role="switch" aria-checked="false" onclick="flipMode()" title="Light \u2014 click for dark">
        <span class="mode-mark mode-sun">\u2600</span><span class="mode-mark mode-moon">\u263e</span>
        <span class="mode-knob">\u2600</span></button>
      <button onclick="load()">Refresh</button>
      <button data-target="settings" onclick="toggle(this)">Service settings</button>
      <button onclick="signOut()" title="Forget the key in this browser tab">Sign out</button>
    </div>
    <nav class="jump" id="jump">
      <a href="#sec-companies">Companies <b id="jump-co">–</b></a>
      <a href="#sec-inquiries">Enquiries <b id="jump-q">–</b></a>
      <a href="#sec-feedback">Feedback &amp; problems <b id="jump-fb">–</b></a>
      <a href="#sec-installations">Installations <b id="jump-inst">–</b></a>
      <a href="#appcard">Phone app</a>
      <a href="#settings" onclick="document.getElementById('settings').style.display='';">Service settings</a>
    </nav>

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

    <div class="card" id="sec-companies">
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
        <div><b>Revoke</b>(on one installation) stops that one machine. It frees no seat — seats are people, and a machine never held one. The company keeps running.</div>
        <div><b>Delete</b>removes the company, its machines, its people and everything they synced. It cannot be undone from here — the name must be typed to confirm.</div>
        <div><b>Transactions and hours</b>are what the company has used — saved records, and time in the application — summed over its machines. A limit of 0 means none.</div>
      </div>
    </div>

    <!-- 4.44.0 — THE PHONE CONSOLE'S RELEASES.

         The Android console is not on Play, so this is what tells it a new
         build exists. The APK is not stored here: the address points at
         wherever the file actually lives. -->
    <div class="card" id="appcard">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Phone app <span class="sub" style="font-weight:400" id="appsub"></span></h2>
        <button class="primary" data-target="newrel" onclick="toggle(this)">Publish a build</button>
      </div>
      <div id="newrel" style="display:none;border:1px solid var(--border);border-radius:10px;padding:12px;margin:8px 0 12px">
        <div class="row">
          <label>Version code<input id="rCode" type="number" min="1" step="1" style="width:120px" placeholder="4"></label>
          <label>Version name<input id="rName" style="width:140px" placeholder="1.3.0"></label>
          <label style="flex:1;min-width:280px">Download address (https)<input id="rUrl" placeholder="https://github.com/…/nexora-console-1.3.0.apk" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label style="flex:1">What changed<input id="rNotes" placeholder="Shown on the phone before it installs" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label>SHA-256 <span class="hint">optional</span><input id="rSha" placeholder="checked before installing" style="min-width:260px"></label>
          <label style="flex-direction:row;align-items:center;gap:8px;color:var(--text)"><input id="rMust" type="checkbox">Must install</label>
          <button class="primary" onclick="publishRelease()">Publish</button>
        </div>
        <p class="help">The version code is the number Android compares, and it only ever goes up &mdash; it is <code>versionCode</code> in the app&rsquo;s build file. The address can point anywhere the phone can reach over https: a GitHub release asset, a file on the site, anywhere. Publishing the same code again replaces it.</p>
      </div>
      <!-- 4.44.0 — the repository publishes itself: one small JSON beside
           the APK, and pushing a build is all a new version needs. -->
      <div class="row" style="margin:6px 0 10px">
        <label style="flex:1;min-width:300px">Build repository <span class="hint">a version file the service reads; a push is then all it takes</span>
          <input id="rSource" placeholder="https://raw.githubusercontent.com/…/main/releases/latest.json" style="width:100%"></label>
        <button onclick="saveSource()">Save</button>
      </div>
      <div id="repoLine"></div>
      <div id="appMsg"></div>
      <div style="overflow-x:auto"><table id="apptbl">
        <thead><tr><th>Version</th><th>Code</th><th>Published</th><th>What changed</th><th>Address</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">Every phone running the console checks this and offers the newest build it finds &mdash; whichever is higher, the repository&rsquo;s file or a version published here. Withdrawing one makes the phones offer the version below it instead.</p>
    </div>

    <!-- 4.42.0 — THE ENQUIRIES.

         Everybody who has asked about the software and not yet bought it.
         The website's contact and demo forms post straight in; the ones
         that arrive by phone are typed in here. The phone console shows
         exactly this table from exactly this service, so the two are never
         out of step with each other. -->
    <div class="card" id="sec-inquiries">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Enquiries <span class="sub" style="font-weight:400" id="qsub"></span></h2>
        <input id="qq" placeholder="Find a name, plant, number, product…" oninput="renderInquiries()" style="min-width:240px">
        <button class="primary" data-target="newq" onclick="toggle(this)">New enquiry</button>
      </div>
      <div id="qstates" class="acts" style="margin:8px 0"></div>
      <div id="newq" style="display:none;border:1px solid var(--border);border-radius:10px;padding:12px;margin:8px 0 12px">
        <input type="hidden" id="qId" value="">
        <div class="row">
          <label>Name<input id="qName" placeholder="Who asked" style="min-width:180px"></label>
          <label>Company / plant<input id="qCompany" placeholder="Their plant" style="min-width:200px"></label>
          <label>Mobile<input id="qPhone" placeholder="WhatsApp / mobile" style="min-width:150px"></label>
          <label>Email<input id="qEmail" placeholder="address" style="min-width:180px"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label>Which software<select id="qProduct" style="min-width:230px"></select></label>
          <label>How it came<select id="qSource" style="min-width:150px"></select></label>
          <label>Where it has got to<select id="qState" style="min-width:150px"></select></label>
          <label>Follow up on<input id="qFollow" type="date" style="min-width:150px"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label style="flex:1">What they asked<input id="qMessage" placeholder="Constructions, volume, what they want" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label style="flex:1">Your note<input id="qNotes" placeholder="What you told them, what to do next" style="width:100%"></label>
          <button class="primary" onclick="saveInquiry()">Save enquiry</button>
          <button onclick="clearInquiryForm()">Clear</button>
        </div>
        <p class="help">For the ones that come by phone, on WhatsApp or at an exhibition. The website&rsquo;s own form fills this table by itself.</p>
      </div>
      <div id="qMsg"></div>
      <div style="overflow-x:auto"><table id="qtbl">
        <thead><tr><th>Who</th><th>Software</th><th>State</th><th>Came</th><th>Reach them</th><th>Asked</th><th>Follow up</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">An enquiry is not a customer. When one becomes a customer, create the company in the ordinary way above; the enquiry stays here as the record of where they came from.</p>
    </div>

    <!-- 4.45.0 — what the plants say from inside the application:
         Help → Nexora Contact → Send feedback / Report a problem. The
         phone console lists the same rows from the same service. -->
    <div class="card" id="sec-feedback">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Feedback &amp; problem reports <span class="sub" style="font-weight:400" id="fbsub"></span></h2>
        <input id="fq" placeholder="Find a plant, person, word…" oninput="renderFeedback()" style="min-width:240px">
        <button onclick="loadFeedback()">Refresh</button>
      </div>
      <div id="fbstates" class="acts" style="margin:8px 0"></div>
      <div id="fbMsg"></div>
      <div style="overflow-x:auto"><table id="fbtbl">
        <thead><tr><th>Kind</th><th>From</th><th>Says</th><th>Where</th><th>Screen</th><th>State</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">Sent from <b>Help &rarr; Nexora Contact</b> inside the application. A problem report carries a picture of the screen as it was when the person opened the menu &mdash; <b>View</b> opens it full size. <b>Note</b> is yours: it stays here and on the phone and is never sent back to the plant. Call-back numbers are the ones the plant typed, or its registered mobile.</p>
    </div>

    <div class="card" id="sec-installations">
      <div class="top" style="margin-bottom:6px">
        <h2 class="grow">Installations <span class="sub" style="font-weight:400" id="instsub"></span></h2>
        <input id="q" placeholder="Search company, key, email, device…" oninput="render()" style="min-width:240px">
        <button class="small" id="clearFilter" style="display:none" onclick="clearCompanyFilter()">Show all companies</button>
      </div>
      <div style="overflow-x:auto"><table id="tbl">
        <thead><tr><th>Company · machine</th><th>State</th><th>Email</th><th>Days left</th><th>Started</th><th>Last seen</th><th>Version</th><th>Transactions</th><th>Hours</th><th></th></tr></thead><tbody></tbody></table></div>
      <p class="help">The clock belongs to the company, not the machine. Machines take no seat — revoke one to stop that computer, suspend the company to stop all of them. Seats are the people, under Manage &rarr; People.</p>
    </div>
  </div>
</div>
<script>
let KEY='', DATA={licences:[],companies:[],settings:{}}, OPEN=null, COFILTER=null;
/* Themed by hand and remembered, exactly as the application is: the
   machine's preference decides only where you START. */
function setMode(m){
  document.documentElement.setAttribute('data-theme',m);
  const s=document.getElementById('mode-switch');
  if(s){
    s.setAttribute('aria-checked',m==='dark'?'true':'false');
    s.title=m==='dark'?'Dark \u2014 click for light':'Light \u2014 click for dark';
    s.querySelector('.mode-knob').textContent=m==='dark'?'\u263e':'\u2600';
  }
  try{localStorage.setItem('nexora.console.mode',m)}catch(e){}
}
function flipMode(){setMode(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');}
(function(){
  let m=null;
  try{m=localStorage.getItem('nexora.console.mode')}catch(e){}
  if(m!=='dark'&&m!=='light'){
    m=(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light';
  }
  document.addEventListener('DOMContentLoaded',()=>setMode(m));
  document.documentElement.setAttribute('data-theme',m);
})();
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmt(d){return d?new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'2-digit'}):'—'}
function toggle(btn){const id=typeof btn==='string'?btn:btn.dataset.target;const n=document.getElementById(id);n.style.display=n.style.display==='none'?'':'none';}
function say(html){document.getElementById('coMsg').innerHTML=html;if(html)setTimeout(()=>{if(document.getElementById('coMsg').innerHTML===html)say('')},6000);}
function signOut(){try{sessionStorage.removeItem('nexora_admin_key')}catch(e){}location.reload();}
async function api(path,opts){
  const r=await fetch(path,Object.assign({headers:{'x-admin-key':KEY,'content-type':'application/json'}},opts||{}));
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
    /* 4.42.0 — the leads come with everything else, and never hold up the
       rest of the page if the service has not been deployed with them. */
    loadInquiries();
    loadReleases();
    loadFeedback();
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
/* 4.42.0 — a company with no people cannot USE the software at all.

     "without user sign in app should not work ... means to run software
      both login is required, apply this rule in console also"

   The company login joins a computer; a person's sign-in is what lets
   anything be written. So a company with nobody on it is not merely
   untidy \u2014 every seat it has is read-only, and the plant will ring to
   ask why the software does nothing. The console says that here, in the
   words somebody answering the telephone needs. */
function usersCell(c){
  const n=+c.users_count||0;
  const max=+c.seats||1;   /* one seat = one person */
  const total=+c.users_total||n;
  if(!n&&!total)return '<b style="color:var(--bad)">nobody \u2014 every seat is read-only</b>'+
    '<small> \u2014 set an administrator under People; nothing can be saved until somebody signs in</small>';
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
        /* 4.42.0 — A SEAT IS A PERSON, and a plant asking for another one
           wants to know how many are LEFT, which 'seat 3 of 5' never said.
           Machines are counted underneath, and are not rationed: since a
           computer with nobody signed in can only read, charging for it
           would be charging for a locked door. */
        '<div class="fact"><span>Seats (people)</span><b>'+used+' of '+seats+'</b>'+
          '<small>'+(seats-used>0?(seats-used)+' available':'none available')+'</small>'+
          '<span class="bar'+(used>=seats?' full':'')+'"><i style="width:'+pct+'%"></i></span></div>'+
        '<div class="fact"><span>Computers</span><b>'+(c.machines_used||0)+'</b>'+
          '<small>not counted against seats</small></div>'+
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
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" data-login="'+esc(c.login_id||'')+'" onclick="coPasscode(this)">New company passcode…</button><span class="why">for a plant that has forgotten the one it chose; it cannot be read back</span>'+
          '<button data-id="'+c.id+'" data-name="'+esc(c.name)+'" onclick="coUsers(this)">Refresh the list</button><span class="why">the plant adds and removes people too, from inside the application</span>'+
          /* 4.39.0 — the people are shown WITH the company, not behind
             another click. Opening a company to see who is on it is the
             commonest reason for opening one at all. */
          '<div id="users-'+c.id+'" class="users-panel"><p class="help">Reading…</p></div>'+
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
function manage(btn){
  const id=+btn.dataset.id;
  OPEN=OPEN===id?null:id;
  renderCompanies();
  if(OPEN){
    document.getElementById('co-'+OPEN).scrollIntoView({block:'nearest'});
    /* The people come with the company. */
    coUsers({dataset:{id:OPEN}});
  }
}
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
/* 4.39.0 — the people on a company. What is shown is everything there
   IS to show: a PIN is a scrypt hash, so there is no PIN to print here
   or anywhere else. A forgotten one is SET again, not read. */
/* 4.43.0 — WHO IS ON WHICH MACHINE, RIGHT NOW.

     "update in console that i can know which user is currently online on
      machine"

   One person may be signed in at one place at a time, so there is a
   single honest answer for each name and this is where it is shown. It
   is the first thing needed when somebody rings to say they were signed
   out: they were not " thrown out", somebody signed in as them
   somewhere, and the console can say where.

   A person's session ends when the application is closed, so a name with
   nothing here is simply not working at the moment. */
function onlineCell(u){
  if(!u.sessionDevice)return '<span class="why">not signed in</span>';
  const where=u.sessionDeviceName||u.sessionDevice.slice(0,12);
  return '<b style="color:var(--good)">on '+esc(where)+'</b>'+
    (u.sessionAt?'<br><span class="why">since '+esc(fmt(u.sessionAt))+'</span>':'');
}
function userRow(cid,u){
  const when=u.lastLoginAt?('last signed in '+fmt(u.lastLoginAt)):'never signed in';
  return '<tr'+(u.active?'':' class="off"')+'>'+
    '<td><b>'+esc(u.name)+'</b>'+(u.active?'':' <span class="why">switched off</span>')+
      (u.sessionDevice?' <span class="pill s-LICENSED">signed in</span>':'')+'</td>'+
    '<td>'+(u.role==='ADMIN'?'<b>administrator</b>':'user')+'</td>'+
    '<td>'+(u.scope==='ALL'?'sees everyone&rsquo;s work':'sees own work')+'</td>'+
    /* 4.42.0 — their own address. A person without one is not broken; they
       simply do not receive the circulars, and it says so plainly. */
    '<td>'+(u.email?'<code>'+esc(u.email)+'</code>':'<span class="why">no address</span>')+'</td>'+
    '<td>'+onlineCell(u)+'</td>'+
    '<td class="why">'+esc(when)+'</td>'+
    '<td>'+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" data-role="'+(u.role==='ADMIN'?'USER':'ADMIN')+'" onclick="uRole(this)">'+
        (u.role==='ADMIN'?'Make ordinary user':'Make administrator')+'</button> '+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" data-email="'+esc(u.email||'')+'" onclick="uEmail(this)">Email…</button> '+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" onclick="uPin(this)">Set PIN…</button> '+
      (u.sessionDevice?'<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" onclick="uSignOut(this)">Sign out…</button> ':'')+
      '<button class="small" data-cid="'+cid+'" data-uid="'+u.id+'" data-name="'+esc(u.name)+'" onclick="uDel(this)">Remove…</button>'+
    '</td></tr>';
}
async function coUsers(btn){
  const cid=+btn.dataset.id, host=document.getElementById('users-'+cid);
  if(!host)return;
  host.style.display='';
  host.innerHTML='<p class="help">Reading…</p>';
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'users'})});
  if(r.error){host.innerHTML='<div class="msg err">'+esc(r.error)+'</div>';return;}
  const cap=r.cap||{max:0,count:0};
  host.innerHTML=
    '<p class="help"><b>'+cap.count+' of '+cap.max+' seat(s) taken'+
      (cap.max-cap.count>0?', '+(cap.max-cap.count)+' available':'; none available')+'.</b> '+
      (cap.count===0?'<b style="color:var(--bad)">Nobody can do any work on this company yet:</b> '+
        'the company login joins a computer, but nothing can be created or saved until a PERSON signs in. '+
        'Set an administrator first. ':'')+
      'A PIN cannot be shown here or anywhere else \u2014 it is stored scrambled, which is what stops anyone who gets the database from signing in as your customers. '+
      'When somebody forgets theirs, set a new one and tell them.</p>'+
    (r.users&&r.users.length
      ? '<table class="users"><thead><tr><th>Name</th><th>Role</th><th>Sees</th><th>Email</th><th>Signed in now</th><th>Last signed in</th><th></th></tr></thead><tbody>'+
        r.users.map(u=>userRow(cid,u)).join('')+'</tbody></table>'
      : '<p class="help">Nobody has been added to this company yet.</p>')+
    '<button data-id="'+cid+'" onclick="uAdd(this)">Add a person…</button>';
}
async function uAdd(btn){
  const cid=+btn.dataset.id;
  const name=prompt('Name of the person to add.\\n\\nThey sign in with this name and a PIN.');
  if(name===null||!name.trim())return;
  const pin=prompt('PIN for '+name.trim()+' (at least 4 characters). Tell it to them directly; it is not shown again.');
  if(pin===null)return;
  /* 4.42.0 — their own address, asked for once while we are already asking.
     Blank is fine; it only means they will not get the circulars. */
  const email=prompt('Email for '+name.trim()+' (optional).\\n\\nThis is where notices about new versions are sent. Leave it blank if they have none.','');
  if(email===null)return;
  const admin=confirm('Make '+name.trim()+' an ADMINISTRATOR?\\n\\nOK = administrator (can add and remove people from inside the application).\\nCancel = ordinary user.');
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'useradd',name:name.trim(),pin,email:email.trim(),role:admin?'ADMIN':'USER'})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Added.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
  await load();
}
async function uRole(btn){
  const to=btn.dataset.role;
  const word=to==='ADMIN'?'an ADMINISTRATOR':'an ordinary user';
  if(!confirm('Make '+btn.dataset.name+' '+word+'?\\n\\n'+(to==='ADMIN'
    ?'They will be able to add and remove people from inside the application, and see everyone\u2019s work.'
    :'They will no longer be able to add or remove anybody.')))return;
  const cid=+btn.dataset.cid;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'userrole',userId:+btn.dataset.uid,role:to})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
}
/* 4.42.0 — a person's own address, set or taken off. This is what makes
   "tell every customer about the new version" reach the people who use the
   software rather than one inbox per plant. */
async function uEmail(btn){
  const cid=+btn.dataset.cid;
  const now=btn.dataset.email||'';
  const email=prompt('Email for '+btn.dataset.name+'.\\n\\nNotices about new versions are sent here. Leave it blank to take the address off.',now);
  if(email===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'useremail',userId:+btn.dataset.uid,email:email.trim()})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
  await load();
}
async function uPin(btn){
  const cid=+btn.dataset.cid;
  const pin=prompt('New PIN for '+btn.dataset.name+' (at least 4 characters).\\n\\nThe old one cannot be read back. Tell them this one directly.');
  if(pin===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'userpin',userId:+btn.dataset.uid,pin})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
}
/* 4.43.0 — the button beside somebody who is signed in. Only needed
   when the machine they are on will never close tidily — stolen, wiped,
   or switched off in a shed — because an ordinary close ends the session
   by itself. */
async function uSignOut(btn){
  const cid=+btn.dataset.cid;
  if(!confirm('Sign '+btn.dataset.name+' out?\\n\\nUse this when the computer they were on is gone or will not be opened again. '+
    'Their PIN does not change and nothing they saved is touched — they can simply sign in again anywhere.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'usersignout',userId:+btn.dataset.uid})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Signed out.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
}
async function uDel(btn){
  const cid=+btn.dataset.cid;
  if(!confirm('Remove '+btn.dataset.name+' from this company?\\n\\nTheir seat is freed. Everything they saved stays with the company.'))return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:cid,action:'userdel',userId:+btn.dataset.uid})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Removed.')+'</div>');
  document.getElementById('users-'+cid).innerHTML='';
  await coUsers({dataset:{id:cid}});
  await load();
}
async function coPasscode(btn){
  const name=btn.dataset.name;
  const id=prompt('Company login id for '+name+'\\n\\nThis is the first half of their login. Leave it as it is unless they want it changed.',btn.dataset.login||'');
  if(id===null)return;
  const pass=prompt('New company passcode for '+name+' (at least 6 characters).\\n\\nNobody can read the old one \u2014 it is stored scrambled. Tell them this new one directly; it is not shown again.');
  if(pass===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'passcode',loginId:id.trim(),passcode:pass})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  await load();
}
async function coAdmin(btn){
  const name=btn.dataset.name;
  const who=prompt('Administrator for '+name+'\\n\\nName the person who will manage users and see every calculation. If a user of that name exists, they become the administrator and get the new PIN.','Administrator');
  if(who===null||!who.trim())return;
  const pin=prompt('PIN for '+who.trim()+' (at least 4 characters). Tell it to them directly; it is not shown again.');
  if(pin===null)return;
  const email=prompt('Email for '+who.trim()+' (optional).\\n\\nWhere notices about new versions are sent. Blank leaves any address they already have alone.','');
  if(email===null)return;
  const r=await api('/admin/api/company',{method:'POST',body:JSON.stringify({id:+btn.dataset.id,action:'adminuser',name:who.trim(),pin,email:email.trim()})});
  if(r.error){say('<div class="msg err">'+esc(r.error)+'</div>');return;}
  say('<div class="msg ok">'+esc(r.warning||'Done.')+'</div>');
  await load();
}
async function coDelete(btn){
  const name=btn.dataset.name;
  const typed=prompt('Delete '+name+'?\\n\\nThis removes the company, its machines, its people and everything they synced. It cannot be undone from here.\\n\\nType the company name exactly to confirm:');
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
/* ---------- the phone app's releases (4.44.0) -------------------------- */
let RELEASES=[];
function appsay(html){
  const n=document.getElementById('appMsg');
  if(!n)return;
  n.innerHTML=html;
  if(html)setTimeout(()=>{if(n.innerHTML===html)appsay('')},6000);
}
let REPO_RELEASE=null;
async function loadReleases(){
  try{
    const r=await api('/admin/api/app');
    RELEASES=r.releases||[];
    REPO_RELEASE=r.fromRepository||null;
    const s=document.getElementById('rSource');
    if(s&&document.activeElement!==s)s.value=r.manifestUrl||'';
  }catch(e){
    RELEASES=[];
    document.querySelector('#apptbl tbody').innerHTML=
      '<tr><td colspan="6" class="help">This service does not carry phone builds yet — deploy the API to switch them on.</td></tr>';
    return;
  }
  renderReleases();
}
async function saveSource(){
  const url=document.getElementById('rSource').value.trim();
  const r=await api('/admin/api/app',{method:'POST',body:JSON.stringify({action:'source',manifestUrl:url})});
  if(r.error){appsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  appsay('<div class="msg ok">'+esc(r.warning||'Saved.')+'</div>');
  await loadReleases();
}
function renderReleases(){
  const latest=RELEASES[0];
  /* Whichever is newer is what the phones will actually be offered. */
  const offered=(REPO_RELEASE&&(!latest||REPO_RELEASE.versionCode>latest.versionCode))?REPO_RELEASE:latest;
  document.getElementById('appsub').textContent=
    offered?('— phones are offered '+offered.versionName+' (code '+offered.versionCode+')')
           :'— nothing published yet';
  document.getElementById('repoLine').innerHTML=REPO_RELEASE
    ? '<div class="msg ok">The repository is offering <b>'+esc(REPO_RELEASE.versionName)+
      '</b> (code '+REPO_RELEASE.versionCode+')'+
      (REPO_RELEASE.notes?' &mdash; '+esc(REPO_RELEASE.notes):'')+
      '. Pushing a new build there is all a new version needs.</div>'
    : '';
  document.querySelector('#apptbl tbody').innerHTML=RELEASES.map((r,i)=>
    '<tr>'+
      '<td><b>'+esc(r.versionName)+'</b>'+(i===0?' <span class="pill s-LICENSED">newest</span>':'')+
        (r.mandatory?' <span class="pill s-EXPIRED">must install</span>':'')+'</td>'+
      '<td><code>'+r.versionCode+'</code></td>'+
      '<td class="why">'+fmt(r.publishedAt)+'</td>'+
      '<td class="why" style="max-width:280px">'+esc(r.notes||'')+'</td>'+
      '<td><a href="'+esc(r.url)+'" target="_blank" rel="noopener"><code>'+esc(String(r.url).slice(0,48))+'…</code></a></td>'+
      '<td><div class="acts">'+
        '<button class="small" data-code="'+r.versionCode+'" onclick="editRelease(this)">Edit</button>'+
        '<button class="small danger" data-code="'+r.versionCode+'" data-name="'+esc(r.versionName)+'" onclick="withdrawRelease(this)">Withdraw</button>'+
      '</div></td></tr>'
  ).join('')||'<tr><td colspan="6" class="help">Nothing published yet. Build the APK, put it somewhere the phones can reach over https, and publish its version code and address here.</td></tr>';
}
function editRelease(btn){
  const r=RELEASES.find(x=>x.versionCode===+btn.dataset.code);
  if(!r)return;
  document.getElementById('newrel').style.display='';
  document.getElementById('rCode').value=r.versionCode;
  document.getElementById('rName').value=r.versionName||'';
  document.getElementById('rUrl').value=r.url||'';
  document.getElementById('rNotes').value=r.notes||'';
  document.getElementById('rSha').value=r.sha256||'';
  document.getElementById('rMust').checked=!!r.mandatory;
  document.getElementById('newrel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function publishRelease(){
  const body={
    action:'publish',
    versionCode:+document.getElementById('rCode').value,
    versionName:document.getElementById('rName').value.trim(),
    url:document.getElementById('rUrl').value.trim(),
    notes:document.getElementById('rNotes').value.trim(),
    sha256:document.getElementById('rSha').value.trim(),
    mandatory:document.getElementById('rMust').checked
  };
  const r=await api('/admin/api/app',{method:'POST',body:JSON.stringify(body)});
  if(r.error){appsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  document.getElementById('newrel').style.display='none';
  appsay('<div class="msg ok">'+esc(r.warning||'Published.')+'</div>');
  await loadReleases();
}
async function withdrawRelease(btn){
  if(!confirm('Withdraw version '+btn.dataset.name+'?\\n\\nPhones will offer the version below it instead. Nothing already installed is touched.'))return;
  const r=await api('/admin/api/app',{method:'POST',body:JSON.stringify({action:'delete',versionCode:+btn.dataset.code})});
  if(r.error){appsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  appsay('<div class="msg ok">'+esc(r.warning||'Withdrawn.')+'</div>');
  await loadReleases();
}

/* ---------- enquiries (4.42.0) ----------------------------------------
   The same rows the phone console shows, from the same service. Nothing
   is cached here and nothing is merged: both read /admin/api/inquiries,
   so "in step" is not a thing that has to be arranged. */
let QDATA={inquiries:[],products:[],states:[],sources:[]}, QSTATE=null;

function qsay(html){
  const n=document.getElementById('qMsg');
  if(!n)return;
  n.innerHTML=html;
  if(html)setTimeout(()=>{if(n.innerHTML===html)qsay('')},6000);
}
async function loadInquiries(){
  try{
    QDATA=await api('/admin/api/inquiries');
  }catch(e){
    /* A service that has not been deployed with enquiries yet. The rest of
       the console is perfectly usable, so this says so once and stops. */
    QDATA={inquiries:[],products:[],states:[],sources:[]};
    document.querySelector('#qtbl tbody').innerHTML=
      '<tr><td colspan="8" class="help">This service does not have enquiries yet — deploy the API to switch them on.</td></tr>';
    return;
  }
  fillSelect('qProduct',QDATA.products);
  fillSelect('qSource',QDATA.sources);
  fillSelect('qState',QDATA.states);
  renderInquiries();
}
function fillSelect(id,list){
  const s=document.getElementById(id);
  if(!s||!list||!list.length)return;
  const keep=s.value;
  /* A code like WEBSITE or QUOTED reads better in lower case; a product
     name like "AMC & Support" is written the way it is written. All-capitals
     is the difference, and it is exactly the difference we mean. */
  s.innerHTML=list.map(v=>'<option value="'+esc(v)+'">'+esc(v===v.toUpperCase()?v.toLowerCase():v)+'</option>').join('');
  if(keep&&list.indexOf(keep)>=0)s.value=keep;
}
function qPill(state){
  const map={NEW:'TRIAL',CONTACTED:'SELF',DEMO:'EXPIRED',QUOTED:'EXPIRED',WON:'LICENSED',LOST:'REVOKED'};
  return map[state]||'SELF';
}
function renderInquiries(){
  const term=(document.getElementById('qq').value||'').toLowerCase();
  const all=QDATA.inquiries||[];
  const rows=all.filter(q=>(!QSTATE||q.state===QSTATE)&&(!term||
    [q.name,q.company,q.phone,q.email,q.product,q.message,q.notes].some(v=>String(v||'').toLowerCase().includes(term))));
  document.getElementById('qsub').textContent='— '+rows.length+' of '+all.length;
  const jq=document.getElementById('jump-q');if(jq){const nn=all.filter(q=>q.state==='NEW').length;jq.textContent=nn;jq.className=nn?'hot':'zero';}

  /* The states, as filters that also count. */
  document.getElementById('qstates').innerHTML=
    '<button class="small'+(QSTATE?'':' primary')+'" onclick="qFilter(null)">All '+all.length+'</button>'+
    (QDATA.states||[]).map(s=>{
      const n=all.filter(q=>q.state===s).length;
      return '<button class="small'+(QSTATE===s?' primary':'')+'" data-state="'+s+'" onclick="qFilter(this.dataset.state)">'+s.toLowerCase()+' '+n+'</button>';
    }).join('');

  const today=new Date().toISOString().slice(0,10);
  document.querySelector('#qtbl tbody').innerHTML=rows.map(q=>{
    const due=q.followUp&&String(q.followUp).slice(0,10)<=today&&q.state!=='WON'&&q.state!=='LOST';
    const reach=[];
    if(q.phone)reach.push('<a href="tel:'+esc(q.phone)+'"><code>'+esc(q.phone)+'</code></a>');
    if(q.email)reach.push('<a href="mailto:'+esc(q.email)+'"><code>'+esc(q.email)+'</code></a>');
    return '<tr>'+
      '<td><b>'+esc(q.name)+'</b>'+(q.company?'<br><span class="why">'+esc(q.company)+'</span>':'')+'</td>'+
      '<td>'+esc(q.product||'—')+'</td>'+
      '<td><span class="pill s-'+qPill(q.state)+'">'+esc(String(q.state).toLowerCase())+'</span></td>'+
      '<td class="why">'+esc(String(q.source||'').toLowerCase())+'<br>'+fmt(q.createdAt)+'</td>'+
      '<td>'+(reach.join('<br>')||'<span class="why">nothing given</span>')+'</td>'+
      '<td class="why" style="max-width:260px">'+esc(q.message||'')+(q.notes?'<br><b>note:</b> '+esc(q.notes):'')+'</td>'+
      '<td'+(due?' style="color:var(--warn);font-weight:700"':' class="why"')+'>'+(q.followUp?esc(String(q.followUp).slice(0,10)):'—')+'</td>'+
      '<td><div class="acts">'+
        (QDATA.states||[]).filter(s=>s!==q.state).map(s=>
          '<button class="small'+(s==='WON'?' primary':'')+'" data-id="'+q.id+'" data-state="'+s+'" onclick="qState(this)">→ '+s.toLowerCase()+'</button>').join('')+
        '<button class="small" data-id="'+q.id+'" onclick="qEdit(this)">Edit</button>'+
        '<button class="small danger" data-id="'+q.id+'" data-name="'+esc(q.name)+'" onclick="qDelete(this)">Remove</button>'+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="8" class="help">Nothing here yet. The website&rsquo;s form fills this on its own; add the ones that come by phone with New enquiry.</td></tr>';
}
function qFilter(state){QSTATE=state||null;renderInquiries();}
function clearInquiryForm(){
  ['qId','qName','qCompany','qPhone','qEmail','qMessage','qNotes','qFollow'].forEach(id=>{
    const n=document.getElementById(id);if(n)n.value='';
  });
}
function qEdit(btn){
  const q=(QDATA.inquiries||[]).find(x=>x.id===+btn.dataset.id);
  if(!q)return;
  document.getElementById('newq').style.display='';
  document.getElementById('qId').value=q.id;
  document.getElementById('qName').value=q.name||'';
  document.getElementById('qCompany').value=q.company||'';
  document.getElementById('qPhone').value=q.phone||'';
  document.getElementById('qEmail').value=q.email||'';
  document.getElementById('qMessage').value=q.message||'';
  document.getElementById('qNotes').value=q.notes||'';
  document.getElementById('qFollow').value=q.followUp?String(q.followUp).slice(0,10):'';
  if(q.product)document.getElementById('qProduct').value=q.product;
  if(q.source)document.getElementById('qSource').value=q.source;
  if(q.state)document.getElementById('qState').value=q.state;
  document.getElementById('newq').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function saveInquiry(){
  const id=+document.getElementById('qId').value||0;
  const name=document.getElementById('qName').value.trim();
  if(!name){qsay('<div class="msg err">A name is required.</div>');return;}
  const body={
    action:id?'update':'create',
    name,
    company:document.getElementById('qCompany').value.trim(),
    phone:document.getElementById('qPhone').value.trim(),
    email:document.getElementById('qEmail').value.trim(),
    product:document.getElementById('qProduct').value,
    source:document.getElementById('qSource').value,
    state:document.getElementById('qState').value,
    message:document.getElementById('qMessage').value.trim(),
    notes:document.getElementById('qNotes').value.trim(),
    followUp:document.getElementById('qFollow').value||''
  };
  if(id)body.id=id;
  const r=await api('/admin/api/inquiry',{method:'POST',body:JSON.stringify(body)});
  if(r.error){qsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  clearInquiryForm();
  document.getElementById('newq').style.display='none';
  qsay('<div class="msg ok">'+(id?'Saved.':'Enquiry added.')+'</div>');
  await loadInquiries();
}
async function qState(btn){
  const r=await api('/admin/api/inquiry',{method:'POST',body:JSON.stringify({action:'state',id:+btn.dataset.id,state:btn.dataset.state})});
  if(r.error){qsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await loadInquiries();
}
async function qDelete(btn){
  if(!confirm('Remove '+btn.dataset.name+' from the enquiries?\\n\\nThe row is deleted. If they became a customer, their company is not touched.'))return;
  const r=await api('/admin/api/inquiry',{method:'POST',body:JSON.stringify({action:'delete',id:+btn.dataset.id})});
  if(r.error){qsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  qsay('<div class="msg ok">Removed.</div>');
  await loadInquiries();
}

/* ---------- feedback & problem reports (4.45.0) ----------------------
   The same rows the phone console shows, from the same service. The
   picture is fetched only when View is pressed: a table of three hundred
   reports must not weigh three hundred screenshots. */
let FBDATA={feedback:[],kinds:[],states:[]}, FBKIND=null, FBSTATE=null, FBOPEN=0;
function fbsay(html){
  const n=document.getElementById('fbMsg');
  if(!n)return;
  n.innerHTML=html;
  if(html)setTimeout(()=>{if(n.innerHTML===html)fbsay('')},6000);
}
async function loadFeedback(){
  try{
    FBDATA=await api('/admin/api/feedback');
  }catch(e){
    FBDATA={feedback:[],kinds:[],states:[]};
    document.querySelector('#fbtbl tbody').innerHTML=
      '<tr><td colspan="7" class="help">This service does not have reports yet \u2014 deploy the API to switch them on.</td></tr>';
    return;
  }
  FBOPEN=(FBDATA.feedback||[]).filter(f=>f.state==='NEW'||f.state==='SEEN').length;
  const k=document.getElementById('kpiFbN');if(k)k.textContent=FBOPEN;
  renderFeedback();
}
function fbPill(state){
  return {NEW:'TRIAL',SEEN:'SELF',FIXED:'LICENSED',CLOSED:'REVOKED'}[state]||'SELF';
}
function renderFeedback(){
  const term=(document.getElementById('fq').value||'').toLowerCase();
  const all=FBDATA.feedback||[];
  const rows=all.filter(f=>(!FBKIND||f.kind===FBKIND)&&(!FBSTATE||f.state===FBSTATE)&&(!term||
    [f.subject,f.message,f.name,f.company,f.coName,f.userName,f.deviceName,f.view,f.reply,f.appVersion].some(v=>String(v||'').toLowerCase().includes(term))));
  document.getElementById('fbsub').textContent='\u2014 '+rows.length+' of '+all.length;
  const jf=document.getElementById('jump-fb');
  if(jf){const nn=all.filter(f=>f.state==='NEW').length;jf.textContent=nn;jf.className=nn?'hot':'zero';}
  document.getElementById('fbstates').innerHTML=
    '<button class="small'+(FBKIND?'':' primary')+'" onclick="fbKind(null)">All '+all.length+'</button>'+
    (FBDATA.kinds||[]).map(k=>'<button class="small'+(FBKIND===k?' primary':'')+'" data-kind="'+k+'" onclick="fbKind(this.dataset.kind)">'+(k==='BUG'?'problems':'feedback')+' '+all.filter(f=>f.kind===k).length+'</button>').join('')+
    '<span class="why">\u00b7</span>'+
    (FBDATA.states||[]).map(s=>'<button class="small'+(FBSTATE===s?' primary':'')+'" data-state="'+s+'" onclick="fbState(this.dataset.state)">'+s.toLowerCase()+' '+all.filter(f=>f.state===s).length+'</button>').join('');
  document.querySelector('#fbtbl tbody').innerHTML=rows.map(f=>{
    const reach=[];
    if(f.phone)reach.push('<a href="tel:'+esc(f.phone)+'"><code>'+esc(f.phone)+'</code></a>');
    if(f.email)reach.push('<a href="mailto:'+esc(f.email)+'"><code>'+esc(f.email)+'</code></a>');
    return '<tr>'+
      '<td><span class="pill s-'+(f.kind==='BUG'?'REVOKED':'LICENSED')+'">'+(f.kind==='BUG'?'problem':'feedback')+'</span><br><span class="why">'+fmt(f.createdAt)+'</span></td>'+
      '<td><b>'+esc(f.coName||f.company||'\u2014')+'</b>'+((f.name||f.userName)?'<br>'+esc(f.name||f.userName):'')+(reach.length?'<br>'+reach.join('<br>'):'')+'</td>'+
      '<td><b>'+esc(f.subject||'')+'</b><span class="say why">'+esc(f.message||'')+'</span>'+(f.reply?'<span class="say"><b>note:</b> '+esc(f.reply)+'</span>':'')+'</td>'+
      '<td class="why">'+esc(f.view||'\u2014')+'<br>'+esc(f.appVersion||'')+(f.edition?' '+esc(String(f.edition).toLowerCase()):'')+(f.deviceName?'<br><code>'+esc(f.deviceName)+'</code>':'')+'</td>'+
      '<td>'+(f.hasShot?'<button class="small" data-id="'+f.id+'" onclick="fbShot(this)">View</button>':'<span class="why">none</span>')+'</td>'+
      '<td><span class="pill s-'+fbPill(f.state)+'">'+esc(String(f.state).toLowerCase())+'</span></td>'+
      '<td><div class="acts">'+
        (FBDATA.states||[]).filter(s=>s!==f.state).map(s=>
          '<button class="small'+(s==='FIXED'?' primary':'')+'" data-id="'+f.id+'" data-state="'+s+'" onclick="fbMove(this)">\u2192 '+s.toLowerCase()+'</button>').join('')+
        '<button class="small" data-id="'+f.id+'" onclick="fbReply(this)">Note</button>'+
        '<button class="small danger" data-id="'+f.id+'" onclick="fbDelete(this)">Remove</button>'+
      '</div></td></tr>';
  }).join('')||'<tr><td colspan="7" class="help">Nothing here yet. Reports arrive from Help \u2192 Nexora Contact inside the application.</td></tr>';
}
function fbKind(k){FBKIND=k||null;renderFeedback();}
function fbState(s){FBSTATE=(FBSTATE===s)?null:s;renderFeedback();}
async function fbMove(btn){
  const r=await api('/admin/api/feedback',{method:'POST',body:JSON.stringify({action:'state',id:+btn.dataset.id,state:btn.dataset.state})});
  if(r.error){fbsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await loadFeedback();
}
async function fbReply(btn){
  const f=(FBDATA.feedback||[]).find(x=>x.id===+btn.dataset.id);
  const note=prompt('Your note on this report (kept here and on the phone, never sent to the plant):',(f&&f.reply)||'');
  if(note===null)return;
  const r=await api('/admin/api/feedback',{method:'POST',body:JSON.stringify({action:'reply',id:+btn.dataset.id,reply:note})});
  if(r.error){fbsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  await loadFeedback();
}
async function fbDelete(btn){
  if(!confirm('Remove this report?\\n\\nThe row and its picture are deleted.'))return;
  const r=await api('/admin/api/feedback',{method:'POST',body:JSON.stringify({action:'delete',id:+btn.dataset.id})});
  if(r.error){fbsay('<div class="msg err">'+esc(r.error)+'</div>');return;}
  fbsay('<div class="msg ok">Removed.</div>');
  await loadFeedback();
}
async function fbShot(btn){
  btn.disabled=true;btn.textContent='Loading\u2026';
  try{
    const r=await api('/admin/api/feedback/shot?id='+(+btn.dataset.id));
    if(r.error||!r.shot){fbsay('<div class="msg err">'+esc(r.error||'No picture on that report.')+'</div>');return;}
    const w=window.open('','_blank');
    if(!w){fbsay('<div class="msg warn">The browser blocked the window \u2014 allow pop-ups for this page.</div>');return;}
    w.document.write('<!doctype html><title>Report #'+(+btn.dataset.id)+'</title><body style="margin:0;background:#12141c;display:flex;align-items:flex-start;justify-content:center"><img src="'+r.shot+'" style="max-width:100%;height:auto"></body>');
    w.document.close();
  }catch(e){
    fbsay('<div class="msg err">'+esc(e.message||'Could not fetch the picture.')+'</div>');
  }finally{btn.disabled=false;btn.textContent='View';}
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
    '<div class="kpi"><b>'+live+'</b><span>Running</span></div>'+
    '<div class="kpi"><b id="kpiFbN">'+FBOPEN+'</b><span>Reports open</span></div>';
  const jc=document.getElementById('jump-co');if(jc){jc.textContent=cos.length;jc.className=cos.length?'':'zero';}
  const ji=document.getElementById('jump-inst');if(ji){ji.textContent=all.length;ji.className=all.length?'':'zero';}
  document.getElementById('sub').textContent=cos.length+' compan'+(cos.length===1?'y':'ies')+' · '+all.length+' installation'+(all.length===1?'':'s');
  const fc=COFILTER?cos.find(c=>c.id===COFILTER):null;
  document.getElementById('instsub').textContent=fc?'— '+fc.name+' only':'— '+rows.length+' of '+all.length;
  document.getElementById('clearFilter').style.display=COFILTER?'':'none';
  document.querySelector('#tbl tbody').innerHTML=rows.map(l=>{
    let state=(l.state==='TRIAL'&&l.expired)?'EXPIRED':l.state;
    if(l.co_state==='SUSPENDED'&&state!=='REVOKED')state='SUSPENDED';
    return '<tr>'+
      '<td><b>'+esc(l.co_name||l.company||'—')+'</b>'+(l.seat_no?' <code>computer '+l.seat_no+'</code>':'')+
        (l.on_user
          ? '<br><span class="pill s-LICENSED">'+esc(l.on_user)+' is signed in</span>'
          : '<br><span class="why">nobody signed in — this machine shows its sign-in screen</span>')+
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
          :'<button class="small danger" data-device="'+esc(l.device_id)+'" data-action="revoke" onclick="act(this)" title="Stops this machine. It frees no seat: seats are people">Revoke</button>')+
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

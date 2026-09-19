/**
 * Nexora API — the phone console's own updates
 * ----------------------------------------------------------------------
 *
 *   "add features in app that everytime we can update app via app,
 *    use github or server to push update directly to apk file"
 *
 * The phone application is not on Play, so nothing tells it when a new
 * build exists. This does: the owner publishes a release here — a version
 * code, a name, a URL and what changed — and every phone running the
 * console sees it at its next check and can install it in two taps.
 *
 * WHAT THIS DOES NOT DO is hold the APK. The URL points wherever the file
 * actually lives: a GitHub release asset, a Vercel file, this service, a
 * Drive link. That keeps a sixteen-megabyte binary out of the service's
 * repository and out of its bandwidth, and it means changing where builds
 * are hosted never needs a new version of the phone application.
 *
 * Releases are kept rather than overwritten, so "which build is on that
 * phone" is still answerable a year later, and a bad one can be withdrawn
 * by deleting its row — the phones then offer the one below it.
 */
import { q, logEvent } from './db.js';

function clean(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function describe(r) {
  return {
    versionCode: Number(r.version_code),
    versionName: r.version_name,
    url: r.url,
    notes: r.notes,
    sha256: r.sha256,
    sizeBytes: r.size_bytes ? Number(r.size_bytes) : null,
    mandatory: r.mandatory === true,
    publishedAt: r.published_at
  };
}

/* ---- the repository publishes itself -----------------------------------
   4.44.0 — "github tamare j push krvanu, darek var jyare app update thay"

   Publishing by hand in the console works, but it is a form to fill in
   every time a build is made. So the service can instead watch a file in
   the repository the builds are pushed to: a small JSON beside the APK
   saying which version it is. Push, and every phone knows — nothing to
   type, nothing to remember.

   Whichever is newer wins, the row or the file, so publishing by hand
   still works and can still overrule a bad manifest.

   The fetch is cached, because a phone checking every quarter of an hour
   must not mean a request to GitHub every quarter of an hour per phone. */
const MANIFEST_TTL_MS = 5 * 60 * 1000;
let manifestCache = { at: 0, release: null, url: null };

async function manifestUrl() {
  const rows = await q(`SELECT value FROM settings WHERE key = 'app_manifest_url'`);
  const v = rows.length ? String(rows[0].value || '').trim() : '';
  return v && /^https:\/\//i.test(v) ? v : null;
}

async function fromManifest() {
  const url = await manifestUrl();
  if (!url) return null;

  const fresh = Date.now() - manifestCache.at < MANIFEST_TTL_MS;
  if (fresh && manifestCache.url === url) return manifestCache.release;

  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();
    const code = parseInt(m.versionCode, 10);
    const href = clean(m.url, 500);
    if (!(code > 0) || !href || !/^https:\/\//i.test(href)) throw new Error('manifest incomplete');

    const release = {
      versionCode: code,
      versionName: clean(m.versionName, 40) || String(code),
      url: href,
      notes: clean(m.notes, 4000),
      sha256: clean(m.sha256, 64),
      sizeBytes: parseInt(m.sizeBytes, 10) || null,
      mandatory: m.mandatory === true,
      publishedAt: clean(m.publishedAt, 40) || null,
      fromRepository: true
    };
    manifestCache = { at: Date.now(), release, url };
    return release;
  } catch (e) {
    /* A repository that cannot be reached must not take the console down
       with it: the rows published by hand still answer. The stale copy is
       kept rather than dropped, for the same reason. */
    if (manifestCache.url === url && manifestCache.release) return manifestCache.release;
    manifestCache = { at: Date.now(), release: null, url };
    return null;
  }
}

/** What a phone asks for: the newest release, or nothing at all. */
export async function latestRelease() {
  const rows = await q(
    `SELECT * FROM app_releases ORDER BY version_code DESC LIMIT 1`);
  const published = rows.length ? describe(rows[0]) : null;
  const repo = await fromManifest();

  if (!published && !repo) return { release: null };
  if (!repo) return { release: published };
  if (!published) return { release: repo };
  return { release: repo.versionCode > published.versionCode ? repo : published };
}

export async function listReleases() {
  const rows = await q(
    `SELECT * FROM app_releases ORDER BY version_code DESC LIMIT 50`);
  return {
    releases: rows.map(describe),
    manifestUrl: await manifestUrl(),
    fromRepository: await fromManifest()
  };
}

export async function releaseAction(body) {
  const action = String(body.action || '');

  if (action === 'publish') {
    const code = parseInt(body.versionCode, 10);
    if (!(code > 0)) return { error: 'A version code is required — a whole number that only ever goes up.' };

    const url = clean(body.url, 500);
    if (!url) return { error: 'The download address is required.' };
    /* Only somewhere a phone can actually fetch from, and only over TLS:
       an APK is executable code and must not arrive over plain http. */
    if (!/^https:\/\//i.test(url)) return { error: 'The address must start with https://' };

    const name = clean(body.versionName, 40) || String(code);

    /* Re-publishing the same code replaces it, which is what somebody
       means when they fix the link five minutes after pasting it. */
    const rows = await q(
      `INSERT INTO app_releases (version_code, version_name, url, notes, sha256, size_bytes, mandatory)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (version_code) DO UPDATE SET
         version_name = EXCLUDED.version_name,
         url          = EXCLUDED.url,
         notes        = EXCLUDED.notes,
         sha256       = EXCLUDED.sha256,
         size_bytes   = EXCLUDED.size_bytes,
         mandatory    = EXCLUDED.mandatory,
         published_at = now()
       RETURNING *`,
      [
        code,
        name,
        url,
        clean(body.notes, 4000),
        clean(body.sha256, 64),
        parseInt(body.sizeBytes, 10) || null,
        body.mandatory === true
      ]);
    await logEvent(null, 'ADMIN_APP_PUBLISH', { versionCode: code, versionName: name });
    return { ok: true, release: describe(rows[0]), warning: 'Version ' + name + ' published. Every phone offers it at its next check.' };
  }

  if (action === 'source') {
    /* Where the build repository says what it has. Blank switches it off
       and leaves only what has been published by hand. */
    const raw = String(body.manifestUrl == null ? '' : body.manifestUrl).trim();
    if (raw && !/^https:\/\//i.test(raw)) return { error: 'The address must start with https://' };
    await q(
      `INSERT INTO settings (key, value) VALUES ('app_manifest_url', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [raw]);
    manifestCache = { at: 0, release: null, url: null };
    await logEvent(null, 'ADMIN_APP_SOURCE', { set: !!raw });
    return {
      ok: true,
      warning: raw
        ? 'The service will read that file from now on; a push is all a new build needs.'
        : 'The build repository is no longer watched. Publish by hand instead.'
    };
  }

  if (action === 'delete') {
    const code = parseInt(body.versionCode, 10);
    if (!(code > 0)) return { error: 'Which version?' };
    const rows = await q(`DELETE FROM app_releases WHERE version_code = $1 RETURNING version_name`, [code]);
    if (!rows.length) return { error: 'There is no such version here.' };
    await logEvent(null, 'ADMIN_APP_WITHDRAW', { versionCode: code });
    return { ok: true, warning: 'Version ' + rows[0].version_name + ' withdrawn. Phones now offer the one below it.' };
  }

  return { error: 'That is not something that can be done to a release.' };
}

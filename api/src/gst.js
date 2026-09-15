/**
 * Nexora API — GSTIN verification  (4.23.0)
 * ======================================================================
 * "gst will be checked via online also."
 *
 * Two halves, and the split matters:
 *
 *   SHAPE   is checked here, always, offline. A GSTIN is fifteen
 *           characters with a fixed pattern — two digits of state code,
 *           the PAN, an entity digit, a Z, a checksum character. A string
 *           that does not fit is refused before anything is stored.
 *
 *   TRUTH   — that the number is live on the GST portal and belongs to
 *           the company named — needs a verification service, and every
 *           real one (the government API, and the commercial wrappers) is
 *           behind an API key that is paid for or rate-limited. So this is
 *           a HOOK: with NEXORA_GST_API_URL and NEXORA_GST_API_KEY set it
 *           asks; with them unset it answers UNVERIFIED and says why. The
 *           owner's decision (2026-09-15): add the hook, validate the
 *           shape locally, and show "Not yet verified" until a key is
 *           configured.
 *
 * A registration is NEVER blocked by the verification service being
 * unreachable, unconfigured or slow. A plant on a bad line at 6 pm must
 * still be able to register; the answer is recorded as UNVERIFIED and the
 * owner can re-run it from the console when the line — or the key — is
 * there. What the service DOES block is a wrong shape, and a definite
 * "this GSTIN does not exist" from a configured service.
 *
 * The request that goes out carries the GSTIN and nothing else.
 */

/* Two-digit state code · PAN (5 letters, 4 digits, 1 letter) · entity
   code · the literal Z · checksum. Upper case only; the caller upper-cases
   before asking, because a legal identifier is never "corrected". */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export function validGstinShape(gstin) {
  return GSTIN_RE.test(String(gstin || '').trim());
}

/** Is a verification service configured at all? */
export function gstServiceConfigured() {
  return !!(process.env.NEXORA_GST_API_URL && process.env.NEXORA_GST_API_KEY);
}

/**
 * Ask the configured service. Resolves one of
 *   { status: 'VERIFIED',   legalName, tradeName, checkedAt }
 *   { status: 'FAILED',     reason, checkedAt }      — the service is sure it is not a live GSTIN
 *   { status: 'UNVERIFIED', reason, checkedAt }      — could not ask, or no service configured
 * and never throws.
 *
 * The service is expected to answer JSON. The fields read are generous —
 * `valid` / `status` / `active` for the verdict, `legalName` /
 * `lgnm` / `tradeName` / `tradeNam` for the names — so the common
 * commercial wrappers and the portal's own shape both map without a
 * change here. Anything unreadable is UNVERIFIED, not FAILED: an odd
 * answer is not proof the number is bad.
 */
export async function verifyGstin(gstin, opts) {
  const o = opts || {};
  const checkedAt = new Date().toISOString();
  const g = String(gstin || '').trim().toUpperCase();
  if (!validGstinShape(g)) {
    return { status: 'FAILED', reason: 'That is not the shape of a GSTIN.', checkedAt };
  }
  const url = o.url || process.env.NEXORA_GST_API_URL;
  const key = o.key || process.env.NEXORA_GST_API_KEY;
  if (!url || !key) {
    return { status: 'UNVERIFIED', reason: 'No GST verification service is configured yet. The number was checked for shape only.', checkedAt };
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs || 8000) : null;
  try {
    const target = url.indexOf('{gstin}') > -1 ? url.split('{gstin}').join(encodeURIComponent(g))
      : url + (url.indexOf('?') > -1 ? '&' : '?') + 'gstin=' + encodeURIComponent(g);
    const r = await fetch(target, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key, 'x-api-key': key, accept: 'application/json' },
      signal: ctrl ? ctrl.signal : undefined
    });
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    if (timer) clearTimeout(timer);
    if (!body || typeof body !== 'object') {
      return { status: 'UNVERIFIED', reason: 'The verification service answered in a form Nexora could not read (HTTP ' + r.status + ').', checkedAt };
    }
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    const verdictRaw = data.valid !== undefined ? data.valid
      : data.active !== undefined ? data.active
      : data.status !== undefined ? data.status
      : data.sts !== undefined ? data.sts : undefined;
    const verdict = typeof verdictRaw === 'boolean' ? verdictRaw
      : /^(true|active|valid|ok|success)$/i.test(String(verdictRaw || '')) ? true
      : /^(false|inactive|invalid|cancelled|canceled|not found|notfound)$/i.test(String(verdictRaw || '')) ? false
      : undefined;
    if (verdict === true) {
      return { status: 'VERIFIED', legalName: data.legalName || data.lgnm || data.legal_name || null,
        tradeName: data.tradeName || data.tradeNam || data.trade_name || null, checkedAt };
    }
    if (verdict === false || r.status === 404) {
      return { status: 'FAILED', reason: (data.message || data.error || 'The verification service does not know this GSTIN.'), checkedAt };
    }
    return { status: 'UNVERIFIED', reason: 'The verification service gave no clear answer (HTTP ' + r.status + ').', checkedAt };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { status: 'UNVERIFIED',
      reason: (e && e.name === 'AbortError') ? 'The verification service did not answer in time.'
        : 'The verification service could not be reached.', checkedAt };
  }
}

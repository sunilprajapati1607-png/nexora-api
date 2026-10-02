/**
 * Nexora API — ink models  (4.19.0, BETA)
 * ======================================================================
 * A company's fitted ink coefficients, one row per substrate, and the
 * two calls the application makes against them: train, and predict.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 * ----------------------------------------------------------------------
 * Stored: five coefficients, the thinner ratio learned from the jobs that
 * measured their solvent, how many jobs it was fitted on, how well it fits,
 * and when. That is the whole row.
 *
 * NOT stored, not received, not logged: the artwork. The application
 * measures its own images and sends coverage — four fractions and a bare
 * share. A picture cannot be reconstructed from them, and none is ever
 * uploaded. The training samples themselves are not kept either: the fit
 * is done in the request and only its result is written, so a plant's job
 * history stays in the plant.
 *
 * WHY THE ENGINE IS HERE AND NOT IN THE EXE
 * ----------------------------------------------------------------------
 * Because it is the part worth protecting. The application can read a
 * picture; what that picture costs in ink — the substrates, the transfer
 * behaviour, the fitting — is the product, and it runs where it can be
 * licensed. An installation without the service can read its artwork and
 * see the coverage; it cannot turn coverage into grams.
 */
import { q } from './db.js';
import { fit, predict, defaultCoefficients, sampleFromJob, substrate, SUBSTRATES, WHITE_MODES, CHANNELS } from './ink.js';

export async function ensureInkSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS ink_models (
      company_id  BIGINT NOT NULL,
      substrate   TEXT   NOT NULL,
      coeffs      JSONB  NOT NULL,
      samples     INT    NOT NULL DEFAULT 0,
      r2          REAL,
      rmse        REAL,
      confidence  TEXT,
      thinner     REAL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by  BIGINT,
      PRIMARY KEY (company_id, substrate)
    )`);
  /* 4.19.0 — thinner.
     CREATE TABLE IF NOT EXISTS does NOTHING to a table that already
     exists, so the column above reaches a fresh database and no other.
     Every installation that ran 4.16.0 already has this table without
     it, and the very next SELECT would fail on a column that is not
     there. A column added after the fact needs its own statement, and
     that statement has to be safe to run on every boot — which ADD
     COLUMN IF NOT EXISTS is.

     Every migration from here on belongs in this list, in order. The
     table definition above is only ever read by a database that has
     never seen Nexora. */
  await q('ALTER TABLE ink_models ADD COLUMN IF NOT EXISTS thinner REAL');
  /* 4.72.0 (audit 100) — THE MODEL BEFORE. A model fitted from months of
     measured jobs was overwritten by the next training and thrown away by a
     reset, with nothing kept. The row being replaced is now copied here first
     (the last INK_KEEP per substrate), and restore() puts the latest one
     back. Its own table rather than columns on ink_models, so ink_models —
     and every reader of it — is exactly as it was. */
  await q(`
    CREATE TABLE IF NOT EXISTS ink_model_history (
      history_id  BIGSERIAL PRIMARY KEY,
      company_id  BIGINT NOT NULL,
      substrate   TEXT   NOT NULL,
      coeffs      JSONB  NOT NULL,
      samples     INT    NOT NULL DEFAULT 0,
      r2          REAL,
      rmse        REAL,
      confidence  TEXT,
      thinner     REAL,
      updated_at  TIMESTAMPTZ,
      updated_by  BIGINT,
      replaced_by BIGINT,
      replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      how         TEXT
    )`);
  await q('CREATE INDEX IF NOT EXISTS ink_model_history_idx ON ink_model_history (company_id, substrate, history_id DESC)');
  return true;
}

const INK_KEEP = 5;
/** 4.72.0 — copy the company's current model for this substrate (if it has one) into ink_model_history. */
async function keepModel(companyId, sub, byUserId, how) {
  const kept = await q(
    `INSERT INTO ink_model_history (company_id, substrate, coeffs, samples, r2, rmse, confidence, thinner, updated_at, updated_by, replaced_by, how)
     SELECT company_id, substrate, coeffs, samples, r2, rmse, confidence, thinner, updated_at, updated_by, $3::bigint, $4::text
       FROM ink_models WHERE company_id = $1 AND substrate = $2
     RETURNING history_id`, [companyId, sub, byUserId == null ? null : byUserId, how]);
  await q(`DELETE FROM ink_model_history WHERE company_id = $1 AND substrate = $2 AND history_id NOT IN
           (SELECT history_id FROM ink_model_history WHERE company_id = $1 AND substrate = $2 ORDER BY history_id DESC LIMIT ${INK_KEEP})`,
  [companyId, sub]);
  return kept.length > 0;
}

const SUB = (v) => substrate(v).id;

/** The model a company is working to, or the physics if it has none. */
export async function getModel(companyId, substrateId) {
  const sub = SUB(substrateId);
  if (!companyId) return { coefficients: defaultCoefficients(sub), n: 0, source: 'DEFAULT', substrate: sub };
  const rows = await q(
    `SELECT coeffs, samples, r2, rmse, confidence, thinner, updated_at FROM ink_models WHERE company_id = $1 AND substrate = $2`,
    [companyId, sub]);
  const row = rows && rows[0];
  if (!row) return { coefficients: defaultCoefficients(sub), n: 0, source: 'DEFAULT', substrate: sub };
  const coeffs = typeof row.coeffs === 'string' ? JSON.parse(row.coeffs) : row.coeffs;
  return {
    coefficients: Object.assign({ source: 'TRAINED', substrate: sub }, coeffs),
    n: row.samples || 0,
    r2: row.r2,
    rmse: row.rmse,
    thinner: row.thinner == null ? null : Number(row.thinner),
    confidence: row.confidence || null,
    updatedAt: row.updated_at,
    source: 'TRAINED',
    substrate: sub
  };
}

/** Every substrate this company has trained. */
export async function listModels(companyId) {
  const out = {};
  for (const id of Object.keys(SUBSTRATES)) out[id] = await getModel(companyId, id);
  return out;
}

/**
 * Fit a company's coefficients from the jobs it has measured.
 * The samples arrive as coverage + what the job actually drew; they are
 * fitted here and thrown away.
 */
export async function train(companyId, userId, body) {
  /* 4.72.0 (audit 100) — training changes the company's model: a person signed in does it, never a
     computer with nobody on it (index.js passes userId = a.user's id, or null) */
  if (!userId) {
    return { httpStatus: 401, body: { error: 'SIGN_IN', message: 'Sign in to train the company’s ink model.' } };
  }
  const sub = SUB(body && body.substrate);
  const raw = (body && Array.isArray(body.samples) ? body.samples : []);
  if (!raw.length) {
    return { httpStatus: 400, body: { error: 'NO_SAMPLES', message: 'Send at least one measured job to train on.' } };
  }
  if (raw.length > 500) {
    return { httpStatus: 400, body: { error: 'TOO_MANY', message: 'Train on at most 500 jobs at a time.' } };
  }
  /* A sample is either already in grams per square metre, or a job that
     can be turned into one. Anything else is dropped rather than guessed
     at, and the count of what was used comes back. */
  const samples = raw.map((s) => {
    if (s && isFinite(Number(s.gsmPerM2)) && Number(s.gsmPerM2) > 0 && s.coverage) {
      const row = { id: s.id || null, coverage: s.coverage, gsmPerM2: Number(s.gsmPerM2) };
      if (isFinite(Number(s.solventRatio)) && Number(s.solventRatio) >= 0) row.solventRatio = Number(s.solventRatio);
      return row;
    }
    return sampleFromJob(s);
  }).filter(Boolean);

  if (!samples.length) {
    return { httpStatus: 400, body: { error: 'NO_USABLE_SAMPLES',
      message: 'None of those jobs carried both an ink weight and an area, so there is nothing to fit.' } };
  }

  const result = fit(samples, { substrate: sub });
  if (!result.ok) return { httpStatus: 400, body: { error: 'FIT_FAILED', message: result.reason } };

  const coeffs = {};
  CHANNELS.forEach((ch) => { coeffs[ch] = result.coefficients[ch]; });

  if (companyId) {
    /* 4.72.0 — the model this replaces is kept (restore puts it back) */
    await keepModel(companyId, sub, userId, 'train');
    await q(
      `INSERT INTO ink_models (company_id, substrate, coeffs, samples, r2, rmse, confidence, thinner, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       ON CONFLICT (company_id, substrate) DO UPDATE SET
         coeffs = EXCLUDED.coeffs, samples = EXCLUDED.samples, r2 = EXCLUDED.r2,
         rmse = EXCLUDED.rmse, confidence = EXCLUDED.confidence,
         /* A run in which nobody measured the solvent must not erase
            what earlier runs learned about it. */
         thinner = COALESCE(EXCLUDED.thinner, ink_models.thinner),
         updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [companyId, sub, JSON.stringify(coeffs), result.n, result.r2, result.rmse, result.confidence, result.thinner, userId || null]);
  }

  return {
    httpStatus: 200,
    body: {
      substrate: sub,
      coefficients: result.coefficients,
      n: result.n,
      used: samples.length,
      offered: raw.length,
      r2: result.r2,
      rmse: result.rmse,
      mape: result.mape,
      lambda: result.lambda,
      confidence: result.confidence,
      thinner: result.thinner,
      thinnerFrom: result.thinnerFrom,
      residuals: result.residuals,
      stored: !!companyId
    }
  };
}

/** What this artwork costs, on this company's model. */
export async function estimate(companyId, body) {
  const b = body || {};
  const sub = SUB(b.substrate);
  const analysis = b.analysis || {};
  if (!analysis.coverage) {
    return { httpStatus: 400, body: { error: 'NO_ANALYSIS', message: 'Send the artwork\'s coverage, measured on the computer.' } };
  }
  const model = await getModel(companyId, sub);
  const out = predict({
    substrate: sub,
    analysis: analysis,
    /* 4.19.0 — the patch the plant chose, the laydown it stated, and its
       own solvent figures where it has them. The white INSIDE the design
       comes with the analysis, not from here. */
    whitePatch: b.whitePatch || b.whiteMode,
    inkGsm: b.inkGsm || null,
    solvent: b.solvent || (model.thinner != null ? { thinner: model.thinner } : null),
    model: model.coefficients,
    area: b.area || {}
  });
  return {
    httpStatus: 200,
    body: Object.assign(out, {
      trainedOn: model.n,
      confidence: model.confidence || (model.n ? 'FAIR' : 'NONE'),
      r2: model.r2 == null ? null : model.r2,
      modelUpdatedAt: model.updatedAt || null,
      substrateNote: substrate(sub).note,
      whiteModes: WHITE_MODES
    })
  };
}

/** Throw a company's model away and go back to the physics.
 *  4.72.0 (audit 100) — `actor`: the person asking (index.js passes a.user). When it is passed, only an
 *  ADMINISTRATOR may reset (403 ADMIN_ONLY otherwise, and nobody signed in is refused too); and the
 *  model thrown away is kept, so restore() can bring it back (restorable: true). */
export async function reset(companyId, substrateId, actor) {
  const sub = SUB(substrateId);
  if (actor !== undefined && !(actor && actor.role === 'ADMIN')) {
    return { httpStatus: 403, body: { error: 'ADMIN_ONLY', message: 'Only your Nexora administrator can reset the company’s ink model.' } };
  }
  let restorable = false;
  if (companyId) {
    restorable = await keepModel(companyId, sub, actor && actor.id != null ? actor.id : null, 'reset');
    await q(`DELETE FROM ink_models WHERE company_id = $1 AND substrate = $2`, [companyId, sub]);
  }
  return { httpStatus: 200, body: { substrate: sub, coefficients: defaultCoefficients(sub), n: 0, source: 'DEFAULT', restorable } };
}

/** 4.72.0 (audit 100) — put back the model this company had before its last training or reset (the
 *  latest kept in ink_model_history). The model it replaces is kept in turn, so a restore can be undone
 *  the same way. ADMINISTRATOR only: `actor` must be passed (index.js: a.user). */
export async function restore(companyId, substrateId, actor) {
  const sub = SUB(substrateId);
  if (!actor || actor.role !== 'ADMIN') {
    return { httpStatus: 403, body: { error: 'ADMIN_ONLY', message: 'Only your Nexora administrator can restore the company’s ink model.' } };
  }
  if (!companyId) return { httpStatus: 404, body: { error: 'NO_PREVIOUS', message: 'There is no earlier ink model to go back to.' } };
  const h = (await q(
    `SELECT * FROM ink_model_history WHERE company_id = $1 AND substrate = $2 ORDER BY history_id DESC LIMIT 1`, [companyId, sub]))[0];
  if (!h) return { httpStatus: 404, body: { error: 'NO_PREVIOUS', message: 'There is no earlier ink model to go back to.' } };
  await keepModel(companyId, sub, actor.id, 'restore');
  await q(
    `INSERT INTO ink_models (company_id, substrate, coeffs, samples, r2, rmse, confidence, thinner, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10)
     ON CONFLICT (company_id, substrate) DO UPDATE SET
       coeffs = EXCLUDED.coeffs, samples = EXCLUDED.samples, r2 = EXCLUDED.r2, rmse = EXCLUDED.rmse,
       confidence = EXCLUDED.confidence, thinner = EXCLUDED.thinner,
       updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [companyId, sub, JSON.stringify(typeof h.coeffs === 'string' ? JSON.parse(h.coeffs) : h.coeffs), h.samples || 0, h.r2, h.rmse, h.confidence,
     h.thinner, h.updated_at || null, h.updated_by == null ? null : h.updated_by]);
  await q(`DELETE FROM ink_model_history WHERE history_id = $1`, [h.history_id]);
  return { httpStatus: 200, body: Object.assign({ restored: true }, await getModel(companyId, sub)) };
}

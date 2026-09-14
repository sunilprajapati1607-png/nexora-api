/**
 * Nexora — Ink assumption engine  (4.16.0, BETA)
 * ======================================================================
 * "user will train the machine with first 10 to 100 jpg or png, it will
 *  create one ML module; when user uploads his png/jpg they can know how
 *  much ink per kg / BOPP this item will consume. CMYK base, with solvent
 *  as per the model. All jpg/png stay in the local system but the
 *  algorithm engine is server based. Used in the BOM where flexo printing
 *  or BOPP is required. Also add a background white patch option."
 *
 * WHAT THIS FILE IS, AND IS NOT
 * ----------------------------------------------------------------------
 * It is the arithmetic: how a picture becomes ink, and how a plant's own
 * measurements correct that arithmetic. It is a pure module — same inputs,
 * same outputs, no storage, no network, no DOM — so the same code can run
 * in the window and on the server, and be tested without either.
 *
 * It is NOT a claim to know a plant's ink usage. Until a plant has trained
 * it, every figure it produces comes from published trade practice and is
 * labelled an assumption. After training it produces the plant's own
 * numbers and says how well they fit.
 *
 * THE PHYSICS  (why the numbers are what they are)
 * ----------------------------------------------------------------------
 * An anilox roll (flexo) or an engraved cylinder (gravure) carries a
 * measured volume of ink per unit area. Part of it transfers to the plate
 * and then to the substrate; the rest stays in the cells.
 *
 *     anilox volume        BCM (billion cubic microns per square inch)
 *     1 BCM/in²          = 1.550 cm³/m²   (645.16 mm² per in²)
 *     1 cm³/m² over 1 m² = 1 µm of wet film
 *
 *     wet ink (g/m²) = volume(cm³/m²) × transfer × coverage × density
 *     dry ink (g/m²) = wet × solids
 *     solvent (g/m²) = wet − dry
 *
 * Published practice, used here as the untrained defaults:
 *   · an 8 BCM anilox at ~30% transfer lays ≈ 3.7 g/m² wet at 100%
 *     coverage, which dries to ≈ 1.2 g/m² — the figure the trade quotes.
 *   · gravure process colours run 0.4–0.7 g/m² dry at working coverage.
 *   · a flood white on film needs 2–3 g/m², white being opaque and laid
 *     solid rather than screened.
 *   · solvent inks arrive at 25–35% solids and are thinned 2–5% at the
 *     press to hold viscosity.
 *
 * THE MODEL  (what training actually changes)
 * ----------------------------------------------------------------------
 * Coverage per channel is measured from the artwork; what is unknown is
 * how many grams of press-ready ink this plant lays per square metre at
 * 100% coverage — its anilox, its transfer, its ink, its press. That is
 * one coefficient per channel:
 *
 *     ink(g/m²) = kC·covC + kM·covM + kY·covY + kK·covK + kW·covW
 *
 * Five numbers, fitted by ridge regression against the plant's own
 * measured jobs, pulled towards the physics defaults by the ridge term so
 * that ten jobs give a usable model and a hundred give a good one. The
 * coefficients are clamped non-negative: no channel can consume less than
 * nothing, however the arithmetic falls out.
 *
 * Ridge, not something cleverer, on purpose: with ten samples and five
 * coefficients anything with more capacity would fit the noise, and a
 * costing figure nobody can explain is worse than one that is slightly
 * wrong. Every coefficient here is a number a print manager can read:
 * "we lay 3.4 grams of cyan per square metre at full coverage."
 */
const CHANNELS = ['c', 'm', 'y', 'k', 'w'];
const CHANNEL_LABEL = { c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black', w: 'White' };

/* 1 BCM per square inch, in cm³ per square metre. */
const BCM_TO_CM3_M2 = 1.5500031;

/**
 * What a substrate is, and how it behaves.
 *   anilox     cell volume actually in use, cm³/m²
 *   transfer   share of that volume reaching the substrate
 *   density    press-ready ink, g/cm³
 *   solids     share of the wet film left after the solvent has gone
 *   dilution   solvent added at the press, as a share of ink weight
 *   whiteBoost white is opaque and laid heavier than a process colour
 */
const SUBSTRATES = {
  FABRIC: {
    id: 'FABRIC',
    label: 'Woven PP fabric — flexo',
    note: 'Printed directly on the woven sack. A rough, absorbent surface takes more ink than film.',
    anilox: 8 * BCM_TO_CM3_M2,     /* an 8 BCM anilox */
    transfer: 0.30,
    density: 1.02,
    solids: 0.30,
    dilution: 0.04,
    whiteBoost: 1.9,
    absorb: 1.10                    /* woven fabric drinks ink film does not */
  },
  BOPP: {
    id: 'BOPP',
    label: 'BOPP film — gravure / flexo',
    note: 'Reverse-printed film, laminated to the sack afterwards. A smooth surface: less ink, sharper dot.',
    anilox: 6,                      /* engraved cylinder for process work, cm³/m² */
    transfer: 0.50,
    density: 1.05,
    solids: 0.28,
    dilution: 0.05,
    whiteBoost: 2.2,
    absorb: 1.0
  }
};
const substrate = (id) => SUBSTRATES[String(id || '').toUpperCase()] || SUBSTRATES.FABRIC;

/** The untrained coefficients: grams of press-ready ink per m² at 100%. */
function defaultCoefficients(substrateId) {
  const s = substrate(substrateId);
  const base = s.anilox * s.transfer * s.density * s.absorb;
  return {
    c: round4(base),
    m: round4(base),
    y: round4(base),
    k: round4(base * 0.95),         /* black screens lighter in practice */
    w: round4(base * s.whiteBoost),
    source: 'DEFAULT',
    substrate: s.id
  };
}

function round4(v) { return Math.round(v * 10000) / 10000; }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ==================================================================
   1.  THE ARTWORK
   ==================================================================
   A picture becomes five numbers: how much of the sheet each channel
   covers, on average. Nothing else about the image is kept, and the
   image itself never leaves the computer — these five numbers are all
   that is ever sent anywhere.

   sRGB is converted to CMYK the way a printer does it for separation
   without a colour profile: the black is the darkest the three inks
   have in common, and the three are reduced by it. It is not
   colorimetric and does not pretend to be; it is the same arithmetic a
   prepress operator gets from "convert to CMYK, GCR" and it is stable,
   which matters more here than colorimetric truth because the plant's
   own training corrects the level.  */
function rgbToCmyk(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 0.9999) return { c: 0, m: 0, y: 0, k: 1 };
  const d = 1 - k;
  return { c: (1 - R - k) / d, m: (1 - G - k) / d, y: (1 - B - k) / d, k: k };
}

/**
 * Analyse raw RGBA pixels.
 *   data      Uint8ClampedArray | array, 4 bytes per pixel
 *   opts.whiteAt   a pixel this pale counts as unprinted (default 0.95)
 *   opts.alphaAt   a pixel this transparent is ignored (default 0.5)
 *
 * Returns the mean coverage of each channel over the WHOLE artwork,
 * the share that is bare (white) and the total area coverage.
 */
function analysePixels(data, opts) {
  const o = opts || {};
  const whiteAt = o.whiteAt == null ? 0.95 : o.whiteAt;
  const alphaAt = o.alphaAt == null ? 0.5 : o.alphaAt;
  let n = 0, white = 0;
  let sc = 0, sm = 0, sy = 0, sk = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < alphaAt) continue;            /* transparent: no ink there */
    const r = data[i], g = data[i + 1], b = data[i + 2];
    n++;
    if (r / 255 >= whiteAt && g / 255 >= whiteAt && b / 255 >= whiteAt) { white++; continue; }
    const p = rgbToCmyk(r, g, b);
    sc += p.c; sm += p.m; sy += p.y; sk += p.k;
  }
  if (!n) return { coverage: { c: 0, m: 0, y: 0, k: 0 }, white: 1, tac: 0, pixels: 0 };
  const cov = { c: sc / n, m: sm / n, y: sy / n, k: sk / n };
  return {
    coverage: { c: round4(cov.c), m: round4(cov.m), y: round4(cov.y), k: round4(cov.k) },
    white: round4(white / n),
    tac: round4(cov.c + cov.m + cov.y + cov.k),
    pixels: n
  };
}

/* ==================================================================
   2.  WHITE, AND WHERE IT GOES
   ==================================================================
   "also add background white patch option."

   A woven sack is not white and BOPP is clear, so a colour only reads
   if there is white under it. Three ways a plant does it, and they cost
   very different amounts:

     NONE    no white is printed at all
     PATCH   white goes behind the artwork only — the printed area
     FLOOD   white goes over the whole face, artwork or not             */
const WHITE_MODES = [
  { id: 'NONE', label: 'No white', note: 'Nothing is laid under the colours.' },
  { id: 'PATCH', label: 'White patch behind the artwork', note: 'White goes only where there is something printed. Cheaper, and the usual choice on fabric.' },
  { id: 'FLOOD', label: 'Flood white over the whole face', note: 'The whole printed face is laid white first. The most ink, and the most even colour.' }
];
function whiteCoverage(mode, analysis) {
  const m = String(mode || 'NONE').toUpperCase();
  if (m === 'FLOOD') return 1;
  if (m === 'PATCH') return round4(clamp01(1 - (analysis && analysis.white != null ? analysis.white : 1)));
  return 0;
}

/* ==================================================================
   3.  AREA — the only place GSM and micron enter
   ==================================================================
   Ink is laid per square metre; the plant buys by the kilogram and
   sells by the bag. Both conversions are area.

     fabric:  1 kg at G g/m²      = 1000 / G      m²
     film:    1 kg at T µm        = 1000 / (T × ρ) m², ρ = 0.91 for BOPP

   That is the whole of the "GSM and micron effect": a 60 GSM fabric has
   a third more area per kilogram than an 80, so the same artwork costs
   a third more ink per kilogram of fabric.  */
const BOPP_DENSITY = 0.91;          /* g/cm³ — BOPP film */
function areaPerKg(spec) {
  const s = spec || {};
  const kind = String(s.substrate || 'FABRIC').toUpperCase();
  if (kind === 'BOPP') {
    const micron = Number(s.micron);
    if (!isFinite(micron) || micron <= 0) return null;
    const gsm = micron * (isFinite(Number(s.density)) && Number(s.density) > 0 ? Number(s.density) : BOPP_DENSITY);
    return round4(1000 / gsm);
  }
  const gsm = Number(s.gsm);
  if (!isFinite(gsm) || gsm <= 0) return null;
  return round4(1000 / gsm);
}

/**
 * The printed area of one bag, in m².
 *   width, length   mm, the lay-flat bag
 *   faces           how many faces carry print (1 or 2; default 2)
 *   printedShare    the share of a face the design covers (default 1)
 */
function printedAreaPerBag(spec) {
  const s = spec || {};
  const w = Number(s.width), l = Number(s.length);
  if (!isFinite(w) || !isFinite(l) || w <= 0 || l <= 0) return null;
  const faces = isFinite(Number(s.faces)) && Number(s.faces) > 0 ? Number(s.faces) : 2;
  const share = isFinite(Number(s.printedShare)) && Number(s.printedShare) > 0 ? Math.min(1, Number(s.printedShare)) : 1;
  return round4((w / 1000) * (l / 1000) * faces * share);
}

/* ==================================================================
   4.  THE PREDICTION
   ==================================================================  */
/**
 * What this artwork costs in ink.
 *   analysis     from analysePixels()
 *   model        coefficients (trained or default)
 *   whiteMode    NONE | PATCH | FLOOD
 *   substrate    FABRIC | BOPP
 *   area         optional { gsm | micron, width, length, faces, printedShare }
 *
 * Everything is press-ready ink — what the plant actually draws from the
 * store — with the solids and the solvent split out beneath it.
 */
function predict(input) {
  const i = input || {};
  const s = substrate(i.substrate);
  const model = i.model && i.model.c != null ? i.model : defaultCoefficients(s.id);
  const analysis = i.analysis || { coverage: { c: 0, m: 0, y: 0, k: 0 }, white: 1 };
  const cov = Object.assign({ c: 0, m: 0, y: 0, k: 0 }, analysis.coverage || {});
  cov.w = whiteCoverage(i.whiteMode, analysis);

  const perChannel = {};
  let wet = 0;
  CHANNELS.forEach((ch) => {
    const k = Number(model[ch]);
    const g = (isFinite(k) ? Math.max(0, k) : 0) * clamp01(Number(cov[ch]) || 0);
    perChannel[ch] = round4(g);
    wet += g;
  });
  wet = round4(wet);
  const dry = round4(wet * s.solids);
  /* The solvent a plant buys is what evaporates out of the ink plus what
     it adds at the press to hold viscosity. Both are consumed. */
  const solventInInk = round4(wet - dry);
  const solventAdded = round4(wet * s.dilution);

  const out = {
    substrate: s.id,
    model: model.source || (i.model ? 'TRAINED' : 'DEFAULT'),
    coverage: cov,
    perChannel: perChannel,
    gsmPerM2: wet,                 /* press-ready ink, g/m² */
    dryPerM2: dry,
    solventPerM2: round4(solventInInk + solventAdded),
    solventInInk: solventInInk,
    solventAdded: solventAdded,
    totalWithSolvent: round4(wet + solventAdded)
  };

  const a = i.area || {};
  const perKgArea = areaPerKg({ substrate: s.id, gsm: a.gsm, micron: a.micron, density: a.density });
  if (perKgArea) {
    out.areaPerKg = perKgArea;
    out.perKgSubstrate = round4(out.totalWithSolvent * perKgArea / 1000);   /* kg ink per kg substrate */
    out.gramsPerKgSubstrate = round4(out.totalWithSolvent * perKgArea);
  }
  const bagArea = printedAreaPerBag({ width: a.width, length: a.length, faces: a.faces, printedShare: a.printedShare });
  if (bagArea) {
    out.areaPerBag = bagArea;
    out.gramsPerBag = round4(out.totalWithSolvent * bagArea);
    out.kgPer1000Bags = round4(out.totalWithSolvent * bagArea);             /* g/bag × 1000 ÷ 1000 */
    out.perChannelPerBag = {};
    CHANNELS.forEach((ch) => { out.perChannelPerBag[ch] = round4(perChannel[ch] * bagArea); });
  }
  return out;
}

/* ==================================================================
   5.  TRAINING
   ==================================================================
   Ridge regression, pulled towards the physics defaults.

       minimise  Σ (kᵀx − y)²  +  λ Σ (k − prior)²

   which is the ordinary normal equations with λ added down the diagonal
   and λ·prior added to the right-hand side. Solved by Gauss-Jordan on a
   5×5 — small enough that nothing clever is warranted — then clamped
   non-negative and re-fitted on the remaining channels, because a
   negative coefficient is not a cheaper ink, it is a fitting artefact.
   A channel no sample used keeps its prior rather than drifting.       */
function fit(samples, opts) {
  const o = opts || {};
  const sub = substrate(o.substrate);
  const prior = o.prior && o.prior.c != null ? o.prior : defaultCoefficients(sub.id);
  const rows = (samples || []).filter((s) => s && s.coverage && isFinite(Number(s.gsmPerM2)) && Number(s.gsmPerM2) > 0);
  const n = rows.length;
  if (!n) return { ok: false, reason: 'No usable samples yet.', coefficients: Object.assign({}, prior, { source: 'DEFAULT' }), n: 0 };

  /* λ falls as the evidence grows: ten samples lean on the physics,
     a hundred barely do. */
  const lambda = o.lambda != null ? Number(o.lambda) : Math.max(0.25, 12 / n);

  const X = rows.map((s) => CHANNELS.map((ch) => clamp01(Number(s.coverage[ch]) || 0)));
  const y = rows.map((s) => Number(s.gsmPerM2));
  const used = CHANNELS.map((ch, j) => X.some((r) => r[j] > 0.001));

  let coef = solveRidge(X, y, CHANNELS.map((ch) => Number(prior[ch]) || 0), lambda, used);
  /* Non-negative: drop any channel that came out below zero and refit. */
  let guard = 0;
  while (guard++ < 5) {
    const bad = coef.map((v, j) => v < 0 && used[j]);
    if (!bad.some(Boolean)) break;
    bad.forEach((isBad, j) => { if (isBad) used[j] = false; });
    coef = solveRidge(X, y, CHANNELS.map((ch) => Number(prior[ch]) || 0), lambda, used);
  }
  CHANNELS.forEach((ch, j) => { if (!used[j]) coef[j] = Number(prior[ch]) || 0; });

  /* How well it fits, in the units the user measured in. */
  const pred = X.map((r) => r.reduce((a, v, j) => a + v * coef[j], 0));
  const mean = y.reduce((a, v) => a + v, 0) / n;
  const ssTot = y.reduce((a, v) => a + (v - mean) * (v - mean), 0);
  const ssRes = y.reduce((a, v, i2) => a + (v - pred[i2]) * (v - pred[i2]), 0);
  const r2 = ssTot > 1e-9 ? 1 - ssRes / ssTot : null;
  const rmse = Math.sqrt(ssRes / n);
  const mape = y.reduce((a, v, i2) => a + Math.abs(v - pred[i2]) / (Math.abs(v) > 1e-9 ? Math.abs(v) : 1), 0) / n;

  const coefficients = { source: 'TRAINED', substrate: sub.id };
  CHANNELS.forEach((ch, j) => { coefficients[ch] = round4(Math.max(0, coef[j])); });

  return {
    ok: true,
    coefficients: coefficients,
    n: n,
    lambda: round4(lambda),
    r2: r2 == null ? null : round4(r2),
    rmse: round4(rmse),
    mape: round4(mape),
    /* An honest word about how much to trust it. */
    confidence: n >= 40 && r2 != null && r2 > 0.8 ? 'GOOD' : n >= 10 ? 'FAIR' : 'WEAK',
    residuals: rows.map((s, i2) => ({ id: s.id || null, measured: round4(y[i2]), predicted: round4(pred[i2]), error: round4(pred[i2] - y[i2]) }))
  };
}

/** (XᵀX + λI)k = Xᵀy + λ·prior, by Gauss-Jordan with partial pivoting. */
function solveRidge(X, y, prior, lambda, used) {
  const p = prior.length;
  const A = [], b = [];
  for (let i = 0; i < p; i++) {
    A.push(new Array(p).fill(0));
    b.push(0);
  }
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let v = 0;
      for (let r = 0; r < X.length; r++) v += X[r][i] * X[r][j];
      A[i][j] = v;
    }
    A[i][i] += lambda;
    let v2 = 0;
    for (let r = 0; r < X.length; r++) v2 += X[r][i] * y[r];
    b[i] = v2 + lambda * prior[i];
  }
  /* A channel that is not in play is pinned to its prior. */
  for (let i = 0; i < p; i++) {
    if (used && !used[i]) {
      for (let j = 0; j < p; j++) { A[i][j] = (i === j) ? 1 : 0; A[j][i] = (i === j) ? 1 : A[j][i]; }
      b[i] = prior[i];
    }
  }
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) continue;
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; const tb = b[piv]; b[piv] = b[col]; b[col] = tb; }
    const d = A[col][col];
    for (let j = 0; j < p; j++) A[col][j] /= d;
    b[col] /= d;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let j = 0; j < p; j++) A[r][j] -= f * A[col][j];
      b[r] -= f * b[col];
    }
  }
  return b;
}

/**
 * One training sample, from what the plant knows: an artwork's coverage
 * and how much ink the job actually drew.
 *   ink      kg of press-ready ink used
 *   area     m² printed  (or bags × area per bag)
 */
function sampleFromJob(job) {
  const j = job || {};
  const area = Number(j.areaM2) > 0 ? Number(j.areaM2)
    : (Number(j.bags) > 0 && Number(j.areaPerBag) > 0 ? Number(j.bags) * Number(j.areaPerBag) : null);
  const inkG = Number(j.inkKg) > 0 ? Number(j.inkKg) * 1000 : Number(j.inkGrams);
  if (!area || !isFinite(inkG) || inkG <= 0) return null;
  const cov = Object.assign({ c: 0, m: 0, y: 0, k: 0, w: 0 }, (j.analysis && j.analysis.coverage) || j.coverage || {});
  if (j.whiteMode && j.analysis) cov.w = whiteCoverage(j.whiteMode, j.analysis);
  return {
    id: j.id || null,
    coverage: cov,
    gsmPerM2: round4(inkG / area),
    areaM2: round4(area),
    substrate: String(j.substrate || 'FABRIC').toUpperCase()
  };
}


export {
  CHANNELS, CHANNEL_LABEL, SUBSTRATES, WHITE_MODES, BCM_TO_CM3_M2, BOPP_DENSITY,
  substrate, defaultCoefficients, rgbToCmyk, analysePixels, whiteCoverage,
  areaPerKg, printedAreaPerBag, predict, fit, sampleFromJob
};

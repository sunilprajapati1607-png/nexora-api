/**
 * Nexora — Ink assumption engine  (4.19.0, BETA)  ·  runs on the SERVICE
 * ======================================================================
 * The arithmetic that turns a measured artwork into ink, solvent and
 * money. It lives here and not in the application: the application can
 * read a picture; what that picture costs is the product.
 *
 * REDEFINED IN 4.19.0, after reading the trade's own figures
 * ----------------------------------------------------------------------
 * The first cut treated both printing processes as one thing with a
 * different anilox. They are not, and the difference shows up in the
 * solvent more than anywhere else:
 *
 *   WOVEN PP FABRIC — flexo, water-based
 *     · layer 2–5 µm wet at full coverage, i.e. 2–5 g/m²
 *     · anilox 80–100 lpi for sacks (coarse, high volume); an 8 BCM roll
 *       is the common reference, and 1 BCM/in² = 1.55 cm³/m²
 *     · transfer ~25–35% of cell volume
 *     · WATER-BASED inks dominate here: solids 40–50%, so what dries on
 *       the bag is nearly half of what is drawn from the drum
 *     · thinner added at the press 20–30%
 *
 *   BOPP FILM — rotogravure, solvent-based, reverse printed
 *     · the cylinder's engraved cells meter the ink; consumption is
 *       Σ(cell volume by tone) × impressions × a transfer constant that
 *       covers incomplete release
 *     · process colours land at 0.4–0.7 g/m² DRY at working coverage
 *     · white is an underbase, printed first and solid: 2–3 g/m² for a
 *       flood, and it is what makes colour read on a clear film
 *     · SOLVENT inks: solids 25–35%, thinner 20–30% at the press
 *     · film 15–40 µm, so a kilogram of film is 25–70 m² — which is why
 *       ink per kilogram of film is several times ink per kilogram of
 *       fabric for the same design
 *
 * THE TWO WHITES  (4.19.0)
 * ----------------------------------------------------------------------
 * A white patch and white inside the design are different inks on the
 * same press:
 *
 *   white patch   a deliberate underbase — none, behind the design, or a
 *                 flood over the whole face. The plant chooses it.
 *   design white  white shapes ENCLOSED by printing. They are printed
 *                 whether or not there is a patch, and the artwork is
 *                 what says how much there is.
 *
 * They are ONE PASS on the press, not two: a patch behind the design
 * already covers the white shapes inside it, so the white laid is the
 * larger of the two, never their sum. Both are still reported, because a
 * plant thinks about them separately and needs to see which one is
 * driving the figure.
 *
 * INK GSM  (4.19.0)
 * ----------------------------------------------------------------------
 * A BOPP job is often specified as a laydown: "white at 6 g/m², colours
 * at 3". Where a plant states it, that IS the coefficient for that
 * channel and no fitting overrides it — a stated figure beats a guessed
 * one, and beats a fitted one too, because it is the instruction the
 * press is actually run to.
 *
 * WHAT TRAINING CHANGES
 * ----------------------------------------------------------------------
 *   ink(g/m²) = kC·covC + kM·covM + kY·covY + kK·covK + kW·covW
 *
 * Five coefficients, fitted by ridge regression against the plant's own
 * measured jobs and pulled towards the published figures above, so ten
 * jobs give a usable model and a hundred a good one. The thinner ratio is
 * learned the same way when a plant records its solvent separately:
 * measured, not assumed.
 */

const CHANNELS = ['c', 'm', 'y', 'k', 'w'];
const CHANNEL_LABEL = { c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black', w: 'White' };

/* 1 BCM per square inch, in cm³ per square metre. */
const BCM_TO_CM3_M2 = 1.5500031;
const BOPP_DENSITY = 0.91;          /* g/cm³ — BOPP film */

/**
 * A substrate, and how its press behaves.
 *   anilox     cell volume actually in use, cm³/m²
 *   transfer   share of that volume reaching the substrate
 *   density    press-ready ink, g/cm³
 *   solids     share of the wet film left after the solvent has gone
 *   thinner    solvent added at the press, as a share of ink weight
 *   whiteBoost white is opaque and laid heavier than a process colour
 *   absorb     a rough surface takes more than a smooth one
 */
const SUBSTRATES = {
  FABRIC: {
    id: 'FABRIC',
    label: 'Woven PP fabric — flexo, water-based',
    note: 'Printed directly on the sack. A rough, absorbent surface, coarse anilox, and water-based ink at 40–50% solids.',
    ink: 'Water-based flexo',
    anilox: 8 * BCM_TO_CM3_M2,      /* an 8 BCM anilox — the sack trade's reference */
    transfer: 0.27,
    density: 1.05,
    solids: 0.45,                   /* water-based: 40–50% */
    thinner: 0.25,                  /* 20–30% added at the press */
    whiteBoost: 1.9,
    absorb: 1.10
  },
  BOPP: {
    id: 'BOPP',
    label: 'BOPP film — rotogravure, solvent-based',
    note: 'Reverse-printed film, laminated to the sack afterwards. Smooth, engraved cylinder, solvent ink at 25–35% solids, white laid first as an underbase.',
    ink: 'Solvent gravure',
    anilox: 6,                      /* engraved cylinder for process work, cm³/m² */
    transfer: 0.50,
    density: 1.05,
    solids: 0.30,                   /* solvent: 25–35% */
    thinner: 0.25,
    whiteBoost: 2.2,
    absorb: 1.0
  }
};
const substrate = (id) => SUBSTRATES[String(id || '').toUpperCase()] || SUBSTRATES.FABRIC;

function round4(v) { return Math.round(v * 10000) / 10000; }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Number(v));

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

/* ==================================================================
   1.  THE ARTWORK, AS IT ARRIVES
   ==================================================================
   The application measures the picture and sends numbers. Nothing here
   ever sees an image.

     coverage        {c,m,y,k} mean coverage over the DESIGN
     white           the share that is bare substrate — no ink
     whiteInDesign   white shapes enclosed by printing — white INK      */
function readAnalysis(a) {
  const an = a || {};
  const cov = an.coverage || {};
  return {
    c: clamp01(Number(cov.c) || 0),
    m: clamp01(Number(cov.m) || 0),
    y: clamp01(Number(cov.y) || 0),
    k: clamp01(Number(cov.k) || 0),
    white: clamp01(an.white == null ? 1 : Number(an.white)),
    whiteInDesign: clamp01(Number(an.whiteInDesign) || 0)
  };
}

/* ==================================================================
   2.  THE WHITE PATCH — the plant's choice, not the artwork's
   ================================================================== */
const WHITE_MODES = [
  { id: 'NONE', label: 'No white patch', note: 'Nothing is laid under the colours. White inside the design is still printed.' },
  { id: 'PATCH', label: 'White patch behind the design', note: 'White goes only where there is printing. The usual choice on fabric.' },
  { id: 'FLOOD', label: 'Flood white over the whole face', note: 'The whole printed face is laid white first. The most ink, the most even colour, and what a clear film usually needs.' }
];
function whitePatchCoverage(mode, an) {
  const m = String(mode || 'NONE').toUpperCase();
  if (m === 'FLOOD') return 1;
  if (m === 'PATCH') return round4(clamp01(1 - (an && an.white != null ? an.white : 1)));
  return 0;
}

/* ==================================================================
   3.  AREA — where GSM, micron and the design's own size come in
   ==================================================================
     fabric:  1 kg at G g/m²      = 1000 / G       m²
     film:    1 kg at T µm        = 1000 / (T × ρ) m²,  ρ = 0.91

   And the printed area itself. 4.19.0 takes the DESIGN's size where it
   is known — "design size and design length will be valuable" — because
   a 300 × 200 mm design repeated twice on a 600 × 900 bag prints 0.12 m²,
   not the 1.08 m² of the whole bag. Where no design size is given the
   old face calculation still answers, so nothing that worked stops.     */
function areaPerKg(spec) {
  const s = spec || {};
  const kind = String(s.substrate || 'FABRIC').toUpperCase();
  if (kind === 'BOPP') {
    const micron = num(s.micron);
    if (!micron || micron <= 0) return null;
    const gsm = micron * (num(s.density) > 0 ? num(s.density) : BOPP_DENSITY);
    return round4(1000 / gsm);
  }
  const gsm = num(s.gsm);
  if (!gsm || gsm <= 0) return null;
  return round4(1000 / gsm);
}

/** The printed area of one bag, in m². Design size wins where it is given. */
function printedAreaPerBag(spec) {
  const s = spec || {};
  const dw = num(s.designWidth), dl = num(s.designLength);
  if (dw && dl && dw > 0 && dl > 0) {
    const repeats = num(s.repeats) > 0 ? num(s.repeats) : 1;
    return round4((dw / 1000) * (dl / 1000) * repeats);
  }
  const w = num(s.width), l = num(s.length);
  if (!w || !l || w <= 0 || l <= 0) return null;
  const faces = num(s.faces) > 0 ? num(s.faces) : 2;
  const share = num(s.printedShare) > 0 ? Math.min(1, num(s.printedShare)) : 1;
  return round4((w / 1000) * (l / 1000) * faces * share);
}

/* ==================================================================
   4.  THE PREDICTION
   ================================================================== */
/**
 * What this artwork costs in ink.
 *   analysis     { coverage, white, whiteInDesign } from the application
 *   model        fitted coefficients, or none
 *   inkGsm       {c,m,y,k,w} the plant's stated laydown at 100% — wins
 *   whitePatch   NONE | PATCH | FLOOD
 *   solvent      { solids, thinner } overriding the substrate's
 *   area         { gsm | micron, designWidth, designLength, repeats,
 *                  width, length, faces, printedShare }
 */
function predict(input) {
  const i = input || {};
  const s = substrate(i.substrate);
  const fitted = i.model && i.model.c != null ? i.model : defaultCoefficients(s.id);
  const stated = i.inkGsm || {};
  const an = readAnalysis(i.analysis);

  const patch = whitePatchCoverage(i.whitePatch || i.whiteMode, an);
  const designWhite = an.whiteInDesign;
  /* The two whites are one PASS. A patch behind the design already covers
     the white shapes inside it — the design's white IS the underbase
     showing through where no colour is laid over it. So the white ink is
     the larger of the two, not their sum: with no patch it is the design's
     own white, with a patch it is the patch, and a flood is everything.
     Both are still reported, because a plant thinks about them separately
     and needs to see which one is driving the figure. */
  const whiteCoverage = round4(Math.max(patch, designWhite));
  const cov = { c: an.c, m: an.m, y: an.y, k: an.k, w: whiteCoverage };

  /* Where each coefficient came from is part of the answer. */
  const used = {}, source = {};
  CHANNELS.forEach((ch) => {
    const st = num(stated[ch]);
    if (st != null && st >= 0) { used[ch] = st; source[ch] = 'STATED'; }
    else { used[ch] = Math.max(0, Number(fitted[ch]) || 0); source[ch] = fitted.source === 'TRAINED' ? 'TRAINED' : 'DEFAULT'; }
  });

  const perChannel = {};
  let wet = 0;
  CHANNELS.forEach((ch) => {
    const g = used[ch] * clamp01(cov[ch]);
    perChannel[ch] = round4(g);
    wet += g;
  });
  wet = round4(wet);

  /* The white, split the way the plant thinks about it. */
  const whitePatchG = round4(used.w * patch);
  const whiteDesignG = round4(used.w * designWhite);
  const whiteCountedAs = patch >= designWhite && patch > 0 ? 'PATCH_COVERS_THE_DESIGN_WHITE'
    : designWhite > 0 ? 'THE_DESIGN_WHITE_ALONE' : 'NO_WHITE';

  const solids = num(i.solvent && i.solvent.solids) != null ? clamp01(num(i.solvent.solids)) : s.solids;
  const thinner = num(i.solvent && i.solvent.thinner) != null ? Math.max(0, num(i.solvent.thinner)) : s.thinner;
  const dry = round4(wet * solids);
  const solventInInk = round4(wet - dry);
  const solventAdded = round4(wet * thinner);

  const out = {
    substrate: s.id,
    substrateLabel: s.label,
    inkSystem: s.ink,
    model: fitted.source === 'TRAINED' ? 'TRAINED' : 'DEFAULT',
    coefficients: used,
    coefficientSource: source,
    coverage: cov,
    whitePatchCoverage: patch,
    whiteInDesignCoverage: designWhite,
    perChannel: perChannel,
    whitePatchPerM2: whitePatchG,
    whiteInDesignPerM2: whiteDesignG,
    whiteCoverage: whiteCoverage,
    whiteCountedAs: whiteCountedAs,
    gsmPerM2: wet,                    /* press-ready ink, g/m² */
    dryPerM2: dry,
    solids: round4(solids),
    thinner: round4(thinner),
    solventInInk: solventInInk,
    solventAdded: solventAdded,
    solventPerM2: round4(solventInInk + solventAdded),
    totalWithSolvent: round4(wet + solventAdded)
  };

  const a = i.area || {};
  const perKgArea = areaPerKg({ substrate: s.id, gsm: a.gsm, micron: a.micron, density: a.density });
  if (perKgArea) {
    out.areaPerKg = perKgArea;
    out.gramsPerKgSubstrate = round4(out.totalWithSolvent * perKgArea);
    out.perKgSubstrate = round4(out.totalWithSolvent * perKgArea / 1000);
  }
  const bagArea = printedAreaPerBag(a);
  if (bagArea) {
    out.areaPerBag = bagArea;
    out.areaBasis = (num(a.designWidth) && num(a.designLength)) ? 'DESIGN' : 'FACE';
    out.gramsPerBag = round4(out.totalWithSolvent * bagArea);
    out.kgPer1000Bags = round4(out.totalWithSolvent * bagArea);
    out.perChannelPerBag = {};
    CHANNELS.forEach((ch) => { out.perChannelPerBag[ch] = round4(perChannel[ch] * bagArea); });
    out.solventPerBag = round4(out.solventPerM2 * bagArea);
  }
  return out;
}

/* ==================================================================
   5.  TRAINING
   ==================================================================
   Ridge regression pulled towards the published figures:

       minimise  Σ (kᵀx − y)²  +  λ Σ (k − prior)²

   λ falls as the evidence grows, so ten jobs lean on the trade's numbers
   and a hundred barely do. Coefficients are clamped non-negative — a
   negative ink is a fitting artefact, not a cheaper colour — and a
   channel no job ever printed keeps its prior rather than drifting.

   4.19.0 also learns the THINNER from the jobs that recorded their
   solvent separately, instead of assuming the trade's 20–30%.            */
function fit(samples, opts) {
  const o = opts || {};
  const sub = substrate(o.substrate);
  const prior = o.prior && o.prior.c != null ? o.prior : defaultCoefficients(sub.id);
  const rows = (samples || []).filter((s) => s && s.coverage && isFinite(Number(s.gsmPerM2)) && Number(s.gsmPerM2) > 0);
  const n = rows.length;
  if (!n) return { ok: false, reason: 'No usable samples yet.', coefficients: Object.assign({}, prior, { source: 'DEFAULT' }), n: 0 };

  const lambda = o.lambda != null ? Number(o.lambda) : Math.max(0.25, 12 / n);

  const X = rows.map((s) => CHANNELS.map((ch) => clamp01(Number(s.coverage[ch]) || 0)));
  const y = rows.map((s) => Number(s.gsmPerM2));
  const used = CHANNELS.map((ch, j) => X.some((r) => r[j] > 0.001));

  let coef = solveRidge(X, y, CHANNELS.map((ch) => Number(prior[ch]) || 0), lambda, used);
  let guard = 0;
  while (guard++ < 5) {
    const bad = coef.map((v, j) => v < 0 && used[j]);
    if (!bad.some(Boolean)) break;
    bad.forEach((isBad, j) => { if (isBad) used[j] = false; });
    coef = solveRidge(X, y, CHANNELS.map((ch) => Number(prior[ch]) || 0), lambda, used);
  }
  CHANNELS.forEach((ch, j) => { if (!used[j]) coef[j] = Number(prior[ch]) || 0; });

  const pred = X.map((r) => r.reduce((a, v, j) => a + v * coef[j], 0));
  const mean = y.reduce((a, v) => a + v, 0) / n;
  const ssTot = y.reduce((a, v) => a + (v - mean) * (v - mean), 0);
  const ssRes = y.reduce((a, v, i2) => a + (v - pred[i2]) * (v - pred[i2]), 0);
  const r2 = ssTot > 1e-9 ? 1 - ssRes / ssTot : null;
  const rmse = Math.sqrt(ssRes / n);
  const mape = y.reduce((a, v, i2) => a + Math.abs(v - pred[i2]) / (Math.abs(v) > 1e-9 ? Math.abs(v) : 1), 0) / n;

  /* The thinner, where it was measured. Solvent divided by ink, averaged
     over the jobs that recorded both — the trade's 20–30% is only the
     starting point. */
  const withSolvent = rows.filter((s) => isFinite(Number(s.solventRatio)) && Number(s.solventRatio) >= 0);
  const thinner = withSolvent.length
    ? round4(withSolvent.reduce((a, s) => a + Number(s.solventRatio), 0) / withSolvent.length)
    : null;

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
    thinner: thinner,
    thinnerFrom: withSolvent.length,
    confidence: n >= 40 && r2 != null && r2 > 0.8 ? 'GOOD' : n >= 10 ? 'FAIR' : 'WEAK',
    residuals: rows.map((s, i2) => ({ id: s.id || null, measured: round4(y[i2]), predicted: round4(pred[i2]), error: round4(pred[i2] - y[i2]) }))
  };
}

/** (XᵀX + λI)k = Xᵀy + λ·prior, by Gauss-Jordan with partial pivoting. */
function solveRidge(X, y, prior, lambda, used) {
  const p = prior.length;
  const A = [], b = [];
  for (let i = 0; i < p; i++) { A.push(new Array(p).fill(0)); b.push(0); }
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
 * and what the job actually drew.
 *   inkKg / inkGrams   press-ready ink used
 *   solventKg          solvent added at the press, where it was measured
 *   areaM2, or bags × areaPerBag
 */
function sampleFromJob(job) {
  const j = job || {};
  const area = num(j.areaM2) > 0 ? num(j.areaM2)
    : (num(j.bags) > 0 && num(j.areaPerBag) > 0 ? num(j.bags) * num(j.areaPerBag) : null);
  const inkG = num(j.inkKg) > 0 ? num(j.inkKg) * 1000 : num(j.inkGrams);
  if (!area || !inkG || inkG <= 0) return null;
  const an = readAnalysis(j.analysis || { coverage: j.coverage, white: j.white, whiteInDesign: j.whiteInDesign });
  const cov = { c: an.c, m: an.m, y: an.y, k: an.k, w: 0 };
  /* The white that was actually laid: the patch the job ran, plus the
     white inside the design. */
  cov.w = round4(whitePatchCoverage(j.whitePatch || j.whiteMode, an) + an.whiteInDesign);
  const out = {
    id: j.id || null,
    coverage: cov,
    gsmPerM2: round4(inkG / area),
    areaM2: round4(area),
    substrate: String(j.substrate || 'FABRIC').toUpperCase()
  };
  const solventG = num(j.solventKg) > 0 ? num(j.solventKg) * 1000 : num(j.solventGrams);
  if (solventG != null && solventG >= 0) out.solventRatio = round4(solventG / inkG);
  return out;
}

export {
  CHANNELS, CHANNEL_LABEL, SUBSTRATES, WHITE_MODES, BCM_TO_CM3_M2, BOPP_DENSITY,
  substrate, defaultCoefficients, readAnalysis, whitePatchCoverage,
  areaPerKg, printedAreaPerBag, predict, fit, sampleFromJob
};

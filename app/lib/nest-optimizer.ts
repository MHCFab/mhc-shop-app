/**
 * nest-optimizer.ts - linear (1D) cutting nest optimizer with miter support.
 *
 * This is the ONLY place the nesting math lives. The Cutting Nest tab calls
 * optimizeNest() and renders what comes back; it must never re-implement any
 * of this inline.
 *
 * UNITS: inches, everywhere in this file. Raw material inventory stores FEET,
 * so the caller multiplies stock lengths by 12 on the way in and divides by 12
 * on the way out (see planToInventoryOps at the bottom). Part lengths are
 * LONG POINT, the way a cut is called out on a shop drawing.
 *
 * THE MITER MODEL
 * A cut is a plane through the stick. For a member of depth H (how far the
 * blade travels across the profile in the plane of the cut), a cut at angle t
 * off square shifts the top face relative to the bottom face by
 *
 *     s = H * tan(t) * dir            dir = +1 ("/")  or  -1 ("\")
 *
 * `s` is the signed miter offset. Two neighbouring parts SHARE a cut - one
 * blade pass yields both faces - exactly when the trailing offset of the
 * upstream part equals the leading offset of the downstream part. When they
 * differ, a wedge of scrap falls out between them and the second cut has to
 * clear the first at every height:
 *
 *     b_next >= b_prev + kerfAxial + max(0, s_prev - s_next)
 *
 * Kerf is measured perpendicular to the blade, so along the stick axis it
 * costs kerf / cos(t) = kerf * sqrt(H^2 + s^2) / H.
 *
 * A material with no depth recorded (height 0) is treated as all square cuts.
 * That is deliberate: guessing a depth would quietly overstate yield.
 */

export type MiterDir = 1 | -1;

/** One line of a cut list: a mark, a length, how many, and both ends. */
export type CutPartInput = {
  id: string;
  label: string;
  /** Long point, inches. */
  length: number;
  qty: number;
  leadAngle?: number;
  leadDir?: MiterDir;
  trailAngle?: number;
  trailDir?: MiterDir;
  /** May the piece be turned end-for-end or rolled over? False for handed parts. */
  allowFlip?: boolean;
  /** raw_material_id. */
  material: string;
};

/** One length of stock on the rack. */
export type CutStockInput = {
  id: string;
  label: string;
  /** Inches. */
  length: number;
  /** How many sticks on hand; null means unlimited. */
  qty: number | null;
  /** Profile depth in the plane of the cut, inches. 0 = treat cuts as square. */
  height: number;
  costPerFoot?: number | null;
  /** raw_material_id. */
  material: string;
};

export type NestSettings = {
  kerf: number;
  trimStart: number;
  trimEnd: number;
  minDrop: number;
  /** What a usable leftover is worth when scoring: 0 = burn the stick, 1 = full credit. */
  dropCredit: number;
  allowFlip: boolean;
  iterations: number;
  timeBudgetMs: number;
  seed: number;
};

export type PlacedPiece = {
  rowId: string;
  label: string;
  /** Long point, inches. */
  length: number;
  sLead: number;
  sTrail: number;
  bottomLen: number;
  /** Where the piece starts and ends along the stick, outermost faces. */
  startX: number;
  endX: number;
  pBottom: number;
  qBottom: number;
  /** True when this piece's leading cut was the same blade pass as its neighbour's trailing cut. */
  sharedCut: boolean;
  flipped: boolean;
};

export type NestStick = {
  material: string;
  stockId: string;
  stockLabel: string;
  stockLength: number;
  height: number;
  costPerFoot: number | null;
  consumed: number;
  drop: number;
  usableDrop: boolean;
  cuts: number;
  sharedCuts: number;
  trimStart: number;
  trimEnd: number;
  pieces: PlacedPiece[];
};

export type UnplacedPiece = {
  label: string;
  length: number;
  material: string;
  reason: string;
};

export type NestError = {
  part: string;
  message: string;
};

export type NestSummary = {
  sticks: number;
  stockTotal: number;
  partTotal: number;
  dropTotal: number;
  usableDropTotal: number;
  scrapTotal: number;
  yield: number;
  yieldWithDrops: number;
  cuts: number;
  sharedCuts: number;
};

export type NestResult = {
  sticks: NestStick[];
  unplaced: UnplacedPiece[];
  errors: NestError[];
  settings: NestSettings;
  summary: NestSummary;
};

/* ------------------------------------------------------------------ */
/* Length parsing / formatting                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse a shop-notation length into inches.
 * Accepts: 96 | 96.5 | 96 1/2 | 96-1/2 | 1/2 | 8' | 8'6 | 8'-6 1/2" | 8' 6-1/2"
 * Returns null when the text cannot be read as a length.
 */
export function parseLength(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return isFinite(input) ? input : null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[”"]/g, "").replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  if (!s) return null;

  let feet = 0;
  const tick = s.indexOf("'");
  if (tick >= 0) {
    const f = Number(s.slice(0, tick).trim());
    if (!isFinite(f)) return null;
    feet = f;
    s = s.slice(tick + 1).trim();
    s = s.replace(/^[-\s]+/, "");
    if (!s) return feet * 12;
  }

  const parts = s.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return feet * 12;
  if (parts.length > 2) return null;

  const num = (tok: string): number | null => {
    if (tok.includes("/")) {
      const [a, b] = tok.split("/");
      const n = Number(a);
      const d = Number(b);
      if (!isFinite(n) || !isFinite(d) || d === 0) return null;
      return n / d;
    }
    const v = Number(tok);
    return isFinite(v) ? v : null;
  };

  if (parts.length === 1) {
    const v = num(parts[0]);
    return v === null ? null : feet * 12 + v;
  }
  const whole = num(parts[0]);
  const frac = num(parts[1]);
  if (whole === null || frac === null) return null;
  if (!parts[1].includes("/")) return null; // "96 5" is not a length
  return feet * 12 + whole + frac;
}

/** Format inches the way the shop reads them, e.g. 246.5 -> 20'-6 1/2" */
export function formatLength(value: number, opts?: { denom?: number; useFeet?: boolean }): string {
  const denom = opts?.denom || 16;
  const useFeet = opts?.useFeet !== false;
  const sign = value < 0 ? "-" : "";
  let v = Math.abs(value);

  v = Math.round(v * denom) / denom;

  let feet = 0;
  let inches = v;
  if (useFeet && v >= 12) {
    feet = Math.floor(v / 12 + 1e-9);
    inches = v - feet * 12;
  }

  let whole = Math.floor(inches + 1e-9);
  let rem = Math.round((inches - whole) * denom);
  if (rem === denom) {
    whole += 1;
    rem = 0;
  }
  if (useFeet && whole === 12) {
    feet += 1;
    whole = 0;
  }

  let fracStr = "";
  if (rem > 0) {
    let n = rem;
    let d = denom;
    while (n % 2 === 0 && d % 2 === 0) {
      n /= 2;
      d /= 2;
    }
    fracStr = n + "/" + d;
  }

  let inchStr: string;
  if (fracStr && whole) inchStr = whole + " " + fracStr;
  else if (fracStr) inchStr = fracStr;
  else inchStr = String(whole);

  if (feet > 0) return sign + feet + "'-" + inchStr + '"';
  return sign + inchStr + '"';
}

/* ------------------------------------------------------------------ */
/* Suggesting a depth from a material size                             */
/* ------------------------------------------------------------------ */

/**
 * Depths worth offering for a material, read out of its size text.
 *
 * Depth is a property of how the stick is LYING IN THE SAW, not of the
 * material, so this only ever suggests - the nest stores what was actually
 * chosen. Rectangle tube and angle legitimately have two answers.
 *
 * The shape matters, because the second number does not always mean the same
 * thing. A channel written "C6 x 10.5" is 6 inches deep and weighs 10.5 lb per
 * foot; offering 10.5 as a depth would be nonsense. Same for "W10 x 15".
 */
export function depthCandidates(shape: string, size: string): number[] {
  const text = String(size || "").trim();
  if (!text) return [];
  // Numbers as the shop writes them: 2, 1.5, .75, 1/2, 2.375
  const tokens = text.match(/\d*\.?\d+(?:\s*\/\s*\d+)?/g) || [];
  const nums: number[] = [];
  for (const t of tokens) {
    const v = parseLength(t);
    if (v !== null && v > 0) nums.push(v);
  }
  if (!nums.length) return [];

  switch (shape) {
    // One dimension, and it is the depth whichever way the stick lies.
    case "square_tube":
    case "round_tube":
    case "flat_bar":
      return [nums[0]];

    // Rolled sections: first number is the nominal depth, second is weight
    // per foot. Only the first is a dimension.
    case "channel":
    case "i_beam":
      return [nums[0]];

    // Two real dimensions - either can be the one facing the blade.
    case "rectangle_tube":
    case "angle":
    default:
      return Array.from(new Set(nums.slice(0, 2)));
  }
}

/** A plain-language note about what depth means for this shape. */
export function depthHint(shape: string): string {
  switch (shape) {
    case "square_tube":
      return "Square tube - the depth is the tube dimension.";
    case "round_tube":
      return "Round tube - the depth is the outside diameter.";
    case "rectangle_tube":
      return "Rectangle tube - whichever face the blade crosses, so it depends which way it lies in the saw.";
    case "angle":
      return "Angle - the leg standing up in the saw.";
    case "channel":
    case "i_beam":
      return "The first number in the size is the depth; the second is weight per foot, not a dimension.";
    case "flat_bar":
      return "Flat bar - the dimension the blade crosses.";
    default:
      return "The dimension the blade travels across as it cuts.";
  }
}

/* ------------------------------------------------------------------ */
/* Miter geometry                                                      */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/** Signed miter offset for one end. angle in degrees off square, dir +1/-1. */
function miterOffset(angleDeg: number, dir: MiterDir, height: number): number {
  const a = Number(angleDeg) || 0;
  if (!a) return 0;
  const h = Number(height) || 0;
  if (!h) return 0;
  const d: number = dir < 0 ? -1 : 1;
  return h * Math.tan(a * DEG) * d;
}

/** Axial cost of one blade pass at miter offset s on a profile of depth h. */
function kerfAxial(kerf: number, s: number, height: number): number {
  const h = Number(height) || 0;
  if (!h || !s) return kerf;
  return (kerf * Math.sqrt(h * h + s * s)) / h;
}

/**
 * The orientations a part can be placed in: identity, end-for-end (yaw),
 * rolled over (roll), and both. Duplicates are dropped.
 */
function orientations(sLead: number, sTrail: number, allowFlip: boolean): [number, number][] {
  if (!allowFlip) return [[sLead, sTrail]];
  const cand: [number, number][] = [
    [sLead, sTrail],
    [-sTrail, -sLead],
    [-sLead, -sTrail],
    [sTrail, sLead],
  ];
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const [a, b] of cand) {
    const k = a.toFixed(6) + "|" + b.toFixed(6);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([a, b]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stick state machine                                                 */
/* ------------------------------------------------------------------ */

/**
 * A stick under construction.
 *   b : bottom-face position of the most recent cut plane
 *   s : signed miter offset of that plane
 */
type StickState = { b: number; s: number; started: boolean; cuts: number; shared: number };

function newState(): StickState {
  return { b: 0, s: 0, started: false, cuts: 0, shared: 0 };
}

type AppendCtx = { kerf: number; height: number; capacity: number };

type AppendResult = {
  ok: boolean;
  state: StickState;
  startX: number;
  endX: number;
  pBottom: number;
  qBottom: number;
  sLead: number;
  sTrail: number;
  consumed: number;
  sharedCut: boolean;
};

/** Try to append one placement to a stick. bottomLen = long point minus long-point excess. */
function tryAppend(
  state: StickState,
  item: { bottomLen: number; sLead: number; sTrail: number },
  ctx: AppendCtx
): AppendResult {
  const { kerf, height, capacity } = ctx;
  let b: number;
  let s: number;
  let sharedCut = false;
  let cuts = state.cuts;
  let shared = state.shared;

  if (!state.started) {
    s = item.sLead;
    b = Math.max(0, -s);
  } else if (Math.abs(state.s - item.sLead) < 1e-9) {
    // one blade pass serves both faces
    b = state.b;
    s = state.s;
    sharedCut = true;
    shared += 1;
  } else {
    b = state.b + kerfAxial(kerf, state.s, height) + Math.max(0, state.s - item.sLead);
    s = item.sLead;
    cuts += 1; // the extra pass that drops the wedge
  }

  const p = b + kerfAxial(kerf, s, height);
  const q = p + item.bottomLen;
  const next: StickState = { b: q, s: item.sTrail, started: true, cuts: cuts + 1, shared };
  const consumed = q + kerfAxial(kerf, item.sTrail, height) + Math.max(0, item.sTrail);

  return {
    ok: consumed <= capacity + 1e-7,
    state: next,
    startX: Math.min(p, p + s),
    endX: Math.max(q, q + item.sTrail),
    pBottom: p,
    qBottom: q,
    sLead: s,
    sTrail: item.sTrail,
    consumed,
    sharedCut,
  };
}

function consumedOf(state: StickState, ctx: AppendCtx): number {
  if (!state.started) return 0;
  return state.b + kerfAxial(ctx.kerf, state.s, ctx.height) + Math.max(0, state.s);
}

/* ------------------------------------------------------------------ */
/* Seeded RNG - same seed gives the same nest, so Re-run is meaningful */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Input normalisation                                                 */
/* ------------------------------------------------------------------ */

export const NEST_DEFAULTS: NestSettings = {
  kerf: 0.125,
  trimStart: 0,
  trimEnd: 0,
  minDrop: 12,
  dropCredit: 0.5,
  allowFlip: true,
  iterations: 900,
  timeBudgetMs: 700,
  seed: 1,
};

/** Search effort presets: [iterations, timeBudgetMs] */
export const NEST_EFFORT: Record<string, [number, number]> = {
  quick: [200, 250],
  normal: [900, 700],
  thorough: [5000, 3000],
};

function normSettings(s?: Partial<NestSettings>): NestSettings {
  const out: NestSettings = { ...NEST_DEFAULTS, ...(s || {}) };
  out.kerf = Math.max(0, Number(out.kerf) || 0);
  out.trimStart = Math.max(0, Number(out.trimStart) || 0);
  out.trimEnd = Math.max(0, Number(out.trimEnd) || 0);
  out.minDrop = Math.max(0, Number(out.minDrop) || 0);
  out.dropCredit = Math.min(1, Math.max(0, Number(out.dropCredit) || 0));
  out.iterations = Math.max(1, Math.floor(Number(out.iterations) || 1));
  return out;
}

type Piece = {
  rowId: string;
  label: string;
  length: number;
  leadAngle: number;
  leadDir: MiterDir;
  trailAngle: number;
  trailDir: MiterDir;
  allowFlip: boolean;
};

type PreparedPiece = Piece & { sLead: number; sTrail: number };

type StockRow = {
  id: string;
  label: string;
  length: number;
  qty: number;
  costPerFoot: number | null;
  height: number;
};

type Group = {
  key: string;
  pieces: Piece[];
  stock: StockRow[];
  height: number;
};

/** Expand cut-list rows into individual pieces, grouped by material. */
function buildGroups(
  parts: CutPartInput[],
  stock: CutStockInput[],
  settings: NestSettings
): { groups: Group[]; errors: NestError[] } {
  const groups = new Map<string, Group>();
  const errors: NestError[] = [];

  const g = (key: string): Group => {
    let grp = groups.get(key);
    if (!grp) {
      grp = { key, pieces: [], stock: [], height: 0 };
      groups.set(key, grp);
    }
    return grp;
  };

  for (const st of stock) {
    const len = Number(st.length);
    if (!isFinite(len) || len <= 0) continue;
    const qty = st.qty === null || st.qty === undefined ? Infinity : Number(st.qty);
    if (qty <= 0) continue;
    const grp = g(st.material);
    grp.stock.push({
      id: st.id,
      label: st.label || formatLength(len),
      length: len,
      qty,
      costPerFoot:
        st.costPerFoot === undefined || st.costPerFoot === null ? null : Number(st.costPerFoot),
      height: Number(st.height) || 0,
    });
    grp.height = Math.max(grp.height, Number(st.height) || 0);
  }

  for (const p of parts) {
    const qty = Math.max(0, Math.floor(Number(p.qty) || 0));
    const len = Number(p.length);
    if (!qty) continue;
    if (!isFinite(len) || len <= 0) {
      errors.push({ part: p.label, message: "Length is missing or not a valid measurement." });
      continue;
    }
    const grp = g(p.material);
    for (let i = 0; i < qty; i++) {
      grp.pieces.push({
        rowId: p.id,
        label: p.label || "Part",
        length: len,
        leadAngle: Number(p.leadAngle) || 0,
        leadDir: p.leadDir === -1 ? -1 : 1,
        trailAngle: Number(p.trailAngle) || 0,
        trailDir: p.trailDir === -1 ? -1 : 1,
        allowFlip: p.allowFlip === undefined ? settings.allowFlip : !!p.allowFlip,
      });
    }
  }
  return { groups: Array.from(groups.values()), errors };
}

/* ------------------------------------------------------------------ */
/* Packing one stick                                                   */
/* ------------------------------------------------------------------ */

function prepPiece(piece: Piece, height: number): PreparedPiece {
  return {
    ...piece,
    sLead: miterOffset(piece.leadAngle, piece.leadDir, height),
    sTrail: miterOffset(piece.trailAngle, piece.trailDir, height),
  };
}

/** Bottom-face length for a given orientation of a long-point length. */
function bottomLenFor(length: number, sLead: number, sTrail: number): number {
  return length - Math.max(0, sTrail - sLead);
}

type FillResult = {
  seq: PlacedPiece[];
  usedIdx: Set<number>;
  consumed: number;
  cuts: number;
  shared: number;
  drop: number;
};

/** Greedily fill one stick from `pool`. */
function fillStick(
  pool: PreparedPiece[],
  stockLen: number,
  ctx: { kerf: number; height: number; trimStart: number; trimEnd: number },
  rnd: () => number,
  greedy: boolean
): FillResult {
  const capacity = stockLen - ctx.trimStart - ctx.trimEnd;
  const c: AppendCtx = { kerf: ctx.kerf, height: ctx.height, capacity };
  let state = newState();
  const seq: PlacedPiece[] = [];
  const used = new Set<number>();

  for (;;) {
    type Candidate = {
      i: number;
      piece: PreparedPiece;
      r: AppendResult;
      sl: number;
      st: number;
      bl: number;
      grow: number;
      score: number;
    };
    const cands: Candidate[] = [];

    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      const piece = pool[i];
      const oris = orientations(piece.sLead, piece.sTrail, piece.allowFlip);
      let best: { r: AppendResult; sl: number; st: number; bl: number } | null = null;
      for (const [sl, st] of oris) {
        const bl = bottomLenFor(piece.length, sl, st);
        if (bl <= 0) continue;
        const r = tryAppend(state, { bottomLen: bl, sLead: sl, sTrail: st }, c);
        if (!r.ok) continue;
        // prefer the orientation that eats the least stock
        if (!best || r.consumed < best.r.consumed - 1e-9) best = { r, sl, st, bl };
      }
      if (best) {
        const grow = best.r.consumed - consumedOf(state, c);
        cands.push({
          i,
          piece,
          r: best.r,
          sl: best.sl,
          st: best.st,
          bl: best.bl,
          grow,
          // least stock eaten per inch of part delivered; shared cuts win naturally
          score: grow - piece.length,
        });
      }
    }
    if (!cands.length) break;

    cands.sort((a, b) => a.score - b.score || b.piece.length - a.piece.length);

    let pick: Candidate;
    if (greedy || cands.length === 1) {
      pick = cands[0];
    } else {
      const k = Math.min(3, cands.length);
      const r = rnd();
      const idx = r < 0.7 ? 0 : r < 0.9 ? 1 % k : k - 1;
      pick = cands[idx];
    }

    state = pick.r.state;
    used.add(pick.i);
    seq.push({
      rowId: pick.piece.rowId,
      label: pick.piece.label,
      length: pick.piece.length,
      sLead: pick.sl,
      sTrail: pick.st,
      bottomLen: pick.bl,
      startX: pick.r.startX + ctx.trimStart,
      endX: pick.r.endX + ctx.trimStart,
      pBottom: pick.r.pBottom + ctx.trimStart,
      qBottom: pick.r.qBottom + ctx.trimStart,
      sharedCut: pick.r.sharedCut,
      flipped: !(
        Math.abs(pick.sl - pick.piece.sLead) < 1e-9 && Math.abs(pick.st - pick.piece.sTrail) < 1e-9
      ),
    });
  }

  const consumed = consumedOf(state, c);
  return {
    seq,
    usedIdx: used,
    consumed,
    cuts: state.cuts,
    shared: state.shared,
    drop: stockLen - ctx.trimStart - ctx.trimEnd - consumed,
  };
}

/* ------------------------------------------------------------------ */
/* Solve one material group                                            */
/* ------------------------------------------------------------------ */

function solveGroup(
  group: Group,
  settings: NestSettings,
  rnd: () => number,
  greedy: boolean
): { sticks: NestStick[]; unplaced: PreparedPiece[] } {
  const pool = group.pieces.map((p) => prepPiece(p, group.height));
  const sticks: NestStick[] = [];
  const avail = group.stock.map((s) => ({ ...s, left: s.qty }));
  const leftover = new Set<number>(pool.map((_, i) => i));
  let guard = 0;

  while (leftover.size && guard++ < 10000) {
    const idxList = Array.from(leftover);
    const live = idxList.map((i) => pool[i]);
    let bestStick: {
      st: (typeof avail)[number];
      res: FillResult;
      score: number;
      ctx: { kerf: number; height: number; trimStart: number; trimEnd: number };
    } | null = null;

    for (const st of avail) {
      if (st.left <= 0) continue;
      const ctx = {
        kerf: settings.kerf,
        height: st.height || group.height,
        trimStart: settings.trimStart,
        trimEnd: settings.trimEnd,
      };
      const res = fillStick(live, st.length, ctx, rnd, greedy);
      if (!res.seq.length) continue;
      const usableDrop = res.drop >= settings.minDrop ? res.drop : 0;
      const netUsed = st.length - usableDrop * settings.dropCredit;
      const partLen = res.seq.reduce((a, x) => a + x.length, 0);
      const score = netUsed - partLen; // material burned beyond the parts themselves
      if (
        !bestStick ||
        score < bestStick.score - 1e-9 ||
        (Math.abs(score - bestStick.score) < 1e-9 && res.seq.length > bestStick.res.seq.length)
      ) {
        bestStick = { st, res, score, ctx };
      }
    }

    if (!bestStick) break; // nothing left fits any available stock

    bestStick.st.left -= 1;
    // fillStick indexed into `live`; map those back to pool indices
    for (const li of bestStick.res.usedIdx) leftover.delete(idxList[li]);

    sticks.push({
      material: group.key,
      stockId: bestStick.st.id,
      stockLabel: bestStick.st.label,
      stockLength: bestStick.st.length,
      height: bestStick.ctx.height,
      costPerFoot: bestStick.st.costPerFoot,
      consumed: bestStick.res.consumed,
      drop: bestStick.res.drop,
      usableDrop: bestStick.res.drop >= settings.minDrop,
      cuts: bestStick.res.cuts,
      sharedCuts: bestStick.res.shared,
      trimStart: settings.trimStart,
      trimEnd: settings.trimEnd,
      pieces: bestStick.res.seq,
    });
  }

  return { sticks, unplaced: Array.from(leftover).map((i) => pool[i]) };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export function optimizeNest(input: {
  parts: CutPartInput[];
  stock: CutStockInput[];
  settings?: Partial<NestSettings>;
}): NestResult {
  const cfg = normSettings(input.settings);
  const { groups, errors } = buildGroups(input.parts || [], input.stock || [], cfg);

  const sticks: NestStick[] = [];
  const unplaced: UnplacedPiece[] = [];

  for (const group of groups) {
    if (!group.pieces.length) continue;
    if (!group.stock.length) {
      for (const p of group.pieces) {
        unplaced.push({
          label: p.label,
          length: p.length,
          material: group.key,
          reason: "No stock on hand for this material.",
        });
      }
      continue;
    }

    let best: {
      sticks: NestStick[];
      unplaced: PreparedPiece[];
      net: number;
      n: number;
      cuts: number;
      unplacedN: number;
    } | null = null;

    const started = Date.now();
    for (let it = 0; it < cfg.iterations; it++) {
      const rnd = mulberry32(cfg.seed + it * 7919);
      const res = solveGroup(group, cfg, rnd, it === 0);
      const net = res.sticks.reduce(
        (a, s) => a + s.stockLength - (s.usableDrop ? s.drop * cfg.dropCredit : 0),
        0
      );
      const cand = {
        ...res,
        net,
        n: res.sticks.length,
        cuts: res.sticks.reduce((a, s) => a + s.cuts, 0),
        unplacedN: res.unplaced.length,
      };
      const better =
        !best ||
        cand.unplacedN < best.unplacedN ||
        (cand.unplacedN === best.unplacedN && cand.net < best.net - 1e-7) ||
        (cand.unplacedN === best.unplacedN &&
          Math.abs(cand.net - best.net) < 1e-7 &&
          cand.n < best.n) ||
        (cand.unplacedN === best.unplacedN &&
          Math.abs(cand.net - best.net) < 1e-7 &&
          cand.n === best.n &&
          cand.cuts < best.cuts);
      if (better) best = cand;
      if (Date.now() - started > cfg.timeBudgetMs) break;
    }

    if (!best) continue;
    sticks.push(...best.sticks);
    for (const p of best.unplaced) {
      unplaced.push({
        label: p.label,
        length: p.length,
        material: group.key,
        reason: "Too long for the stock on hand, or the stock ran out.",
      });
    }
  }

  let stockTotal = 0;
  let partTotal = 0;
  let dropTotal = 0;
  let usableDropTotal = 0;
  let cuts = 0;
  let shared = 0;
  for (const s of sticks) {
    stockTotal += s.stockLength;
    dropTotal += s.drop + s.trimStart + s.trimEnd;
    if (s.usableDrop) usableDropTotal += s.drop;
    cuts += s.cuts;
    shared += s.sharedCuts;
    for (const p of s.pieces) partTotal += p.length;
  }

  return {
    sticks,
    unplaced,
    errors,
    settings: cfg,
    summary: {
      sticks: sticks.length,
      stockTotal,
      partTotal,
      dropTotal,
      usableDropTotal,
      scrapTotal: stockTotal - partTotal - usableDropTotal,
      yield: stockTotal ? partTotal / stockTotal : 0,
      yieldWithDrops: stockTotal ? (partTotal + usableDropTotal) / stockTotal : 0,
      cuts,
      sharedCuts: shared,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Turning a plan into inventory movements                             */
/* ------------------------------------------------------------------ */

export type InventoryOp = {
  rawMaterialId: string;
  /** FEET - inventory's unit, not the optimizer's. */
  lengthFeet: number;
  quantity: number;
};

export type InventoryOps = {
  pulls: InventoryOp[];
  drops: InventoryOp[];
};

/**
 * Collapse a plan into the stick pulls and saved drops the Apply button runs.
 *
 * Pulls are grouped by material and stock length, so eight 20' sticks are one
 * pull of eight, matching how getAvailableLengths reports stock.
 *
 * Drop lengths are rounded DOWN to the given fraction (1/16" by default) before
 * grouping. Rounding down means a saved drop is never longer than the steel
 * actually is, and rounding at all keeps the rack from filling with
 * near-identical lengths - inventory nets remnants BY LENGTH, so 37.5" and
 * 37.4999" would sit in stock as two different things.
 */
export function planToInventoryOps(result: NestResult, denom = 16): InventoryOps {
  const pullMap = new Map<string, InventoryOp>();
  const dropMap = new Map<string, InventoryOp>();

  const bump = (map: Map<string, InventoryOp>, rawMaterialId: string, lengthFeet: number) => {
    const key = rawMaterialId + "|" + lengthFeet.toFixed(6);
    const row = map.get(key);
    if (row) row.quantity += 1;
    else map.set(key, { rawMaterialId, lengthFeet, quantity: 1 });
  };

  for (const s of result.sticks) {
    bump(pullMap, s.material, s.stockLength / 12);
    if (s.usableDrop && s.drop > 0) {
      const roundedInches = Math.floor(s.drop * denom) / denom;
      if (roundedInches > 0) bump(dropMap, s.material, roundedInches / 12);
    }
  }

  return {
    pulls: Array.from(pullMap.values()),
    drops: Array.from(dropMap.values()),
  };
}

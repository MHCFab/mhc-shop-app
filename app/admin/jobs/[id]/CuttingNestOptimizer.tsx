"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "../../../lib/supabase";
import { pullSticks, saveDrop } from "../../../lib/inventory";
import NestSticksView from "../../../components/NestSticksView";
import {
  optimizeNest,
  planToInventoryOps,
  parseLength,
  formatLength,
  NEST_EFFORT,
  depthCandidates,
  depthHint,
  reservePlannedStock,
  type PlannedDrop,
  type CutPartInput,
  type CutStockInput,
  type NestResult,
  type MiterDir,
} from "../../../lib/nest-optimizer";

type CutRow = {
  id: string;
  mark: string;
  length: string;
  quantity: string;
  leadAngle: string;
  leadDir: MiterDir;
  trailAngle: string;
  trailDir: MiterDir;
  allowFlip: boolean;
  isNew?: boolean;
  /**
   * Where this line came from. 'template' means a Fill from products put it
   * here and a later fill may replace it; 'manual' means somebody typed or
   * changed it and a fill must leave it alone. Undefined counts as manual.
   */
  source?: "manual" | "template";
  /** Which product template a filled line came off. Kept for provenance. */
  productTemplateId?: string | null;
};

/** Another job's nest on the same material that's planned but not applied yet. */
type OtherNest = {
  id: string;
  jobNumber: string;
  createdAt: string;
  optimizedAt: string | null;
  result: NestResult;
};

/** Job statuses that are still open - same list the Jobs page uses. */
const OPEN_JOB_STATUSES = ["pending", "ordered", "ready", "in_progress"];

type NestSettingsRow = {
  kerf: string;
  minDrop: string;
  trimStart: string;
  trimEnd: string;
  dropCredit: string;
  effort: string;
  /** How the stick lies in the saw. Blank = treat every cut as square. */
  depth: string;
};

const DEFAULT_SETTINGS: NestSettingsRow = {
  kerf: "0.035",
  minDrop: "12",
  trimStart: "0",
  trimEnd: "0",
  dropCredit: "1",
  effort: "normal",
  depth: "",
};

/**
 * Stick lengths the nest can plan on when the rack runs short, in inches.
 * "auto" tries both and keeps whichever buys the least steel.
 */
const ORDER_CHOICES: Record<string, number[]> = {
  auto: [240, 288],
  "240": [240],
  "288": [288],
};

/**
 * The paper cut sheet is rendered into document.body and printed with the
 * browser's own print. On paper, everything else on the page is hidden, so it
 * works no matter what layout the panel sits in.
 */
const PRINT_CSS = `
#nest-print-root { display: none; }
@media print {
  body > *:not(#nest-print-root) { display: none !important; }
  #nest-print-root { display: block; }
  #nest-print-root, #nest-print-root * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  #nest-print-root .nest-stick { break-inside: avoid; page-break-inside: avoid; }
  @page { margin: 0.4in; }
}
`;

/** 288 -> 24'-0" */
function feetText(v: number) {
  return formatLength(v);
}

function newRowId() {
  return "new-" + Math.random().toString(36).slice(2, 10);
}

function blankRow(): CutRow {
  return {
    id: newRowId(),
    mark: "",
    length: "",
    quantity: "1",
    leadAngle: "0",
    leadDir: 1,
    trailAngle: "0",
    trailDir: 1,
    allowFlip: true,
    isNew: true,
  };
}

/** Inches, no feet - cut lists read in inches on the shop floor. */
function inches(v: number) {
  return formatLength(v, { useFeet: false });
}

/**
 * Parse a pasted cut list. One part per line:
 *   mark, length, qty, left angle, right angle
 * Angles optional; a trailing \ or / on an angle sets which way it leans.
 *   RAIL-1, 76 1/2, 6, 35/, 35/
 */
function parsePastedRows(text: string): { rows: CutRow[]; skipped: number } {
  const rows: CutRow[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/[,\t]/).map((c) => c.trim());
    const length = parseLength(cols[1] !== undefined && cols[1] !== "" ? cols[1] : cols[0]);
    if (length === null || length <= 0) {
      skipped += 1;
      continue;
    }
    const angleAt = (i: number): { angle: string; dir: MiterDir } => {
      const t = (cols[i] || "").trim();
      if (!t) return { angle: "0", dir: 1 };
      const dir: MiterDir = t.includes("\\") ? -1 : 1;
      const n = parseFloat(t.replace(/[\\/]/g, ""));
      return { angle: isFinite(n) ? String(n) : "0", dir };
    };
    const lead = angleAt(3);
    const trail = angleAt(4);
    const qty = parseInt(cols[2] || "1", 10);
    rows.push({
      id: newRowId(),
      mark: cols[1] !== undefined && cols[1] !== "" ? cols[0] : "",
      length: String(length),
      quantity: String(!isNaN(qty) && qty > 0 ? qty : 1),
      leadAngle: lead.angle,
      leadDir: lead.dir,
      trailAngle: trail.angle,
      trailDir: trail.dir,
      allowFlip: true,
      isNew: true,
    });
  }
  return { rows, skipped };
}

export default function CuttingNestOptimizer({
  jobId,
  jobNumber,
  companyId,
  rawMaterialId,
  materialLabel,
  costPerFoot,
  shape,
  size,
  materialDepth,
  availableLengths,
  trackDrops,
  companyKerf,
  companyMinDrop,
  reloadKey,
  onChanged,
}: {
  jobId: string;
  jobNumber: string;
  companyId: string;
  rawMaterialId: string;
  materialLabel: string;
  costPerFoot: number;
  /** raw_materials.shape and size, used only to suggest a depth. */
  shape: string;
  size: string;
  /** raw_materials.nest_depth_inches, if a usual depth was ever recorded. */
  materialDepth: number | null;
  /** From getAvailableLengths - lengths in FEET, as inventory stores them. */
  availableLengths: { length: number; sticks: number }[];
  trackDrops: boolean;
  companyKerf: number;
  companyMinDrop: number;
  /**
   * Bumped by the parent when something outside this panel changed the cut
   * list -- a Fill from products. Any new value re-runs load().
   */
  reloadKey?: number;
  onChanged?: () => void;
}) {
  const supabase = createClient();

  const [rows, setRows] = useState<CutRow[]>([]);
  const [settings, setSettings] = useState<NestSettingsRow>(DEFAULT_SETTINGS);
  const [nestId, setNestId] = useState<string | null>(null);
  const [plan, setPlan] = useState<NestResult | null>(null);
  const [appliedAt, setAppliedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  /** Which lengths to plan on when the rack runs short - a key of ORDER_CHOICES. */
  const [orderChoice, setOrderChoice] = useState<string>("auto");
  /** Set when Print is pressed; the cut sheet exists only while this is set. */
  const [printedAt, setPrintedAt] = useState<string | null>(null);
  /** Other jobs' unapplied nests on this material, oldest first. */
  const [others, setOthers] = useState<OtherNest[]>([]);
  /** When this nest's row was first made - decides which nests come ahead of it. */
  const [myCreatedAt, setMyCreatedAt] = useState<string | null>(null);
  /** Nests this plan leaned on that have been APPLIED since - their drops are real now. */
  const [appliedRefs, setAppliedRefs] = useState<string[]>([]);

  const suggested = useMemo(() => depthCandidates(shape, size), [shape, size]);

  /**
   * Every other open job's nest on this material that has a plan but hasn't
   * been applied. Their sticks are spoken for and their drops are coming.
   */
  const fetchOthers = useCallback(async (): Promise<OtherNest[]> => {
    const { data } = await supabase
      .from("job_cut_nests")
      .select("id, created_at, optimized_at, result, jobs(job_number, status, cutting_nest_finalized_at)")
      .eq("raw_material_id", rawMaterialId)
      .neq("job_id", jobId)
      .eq("enabled", true)
      .is("applied_at", null)
      .not("result", "is", null);
    type JobBit = { job_number: string | number; status: string; cutting_nest_finalized_at: string | null };
    type Row = {
      id: string;
      created_at: string;
      optimized_at: string | null;
      result: NestResult | null;
      jobs: JobBit | JobBit[] | null;
    };
    const out: OtherNest[] = [];
    for (const r of (data || []) as unknown as Row[]) {
      const j = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
      if (!j || !OPEN_JOB_STATUSES.includes(j.status) || j.cutting_nest_finalized_at) continue;
      if (!r.result || !Array.isArray(r.result.sticks) || !r.result.sticks.length) continue;
      out.push({
        id: r.id,
        jobNumber: String(j.job_number),
        createdAt: r.created_at,
        optimizedAt: r.optimized_at,
        result: r.result,
      });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [supabase, jobId, rawMaterialId]);

  const load = useCallback(async () => {
    // Referenced on purpose. reloadKey carries no information -- the parent
    // just bumps it after a Fill from products -- but naming it here is what
    // makes it a real dependency, rather than one lint has to be told to
    // ignore.
    void reloadKey;
    setLoading(true);
    const [cutRes, nestRes] = await Promise.all([
      supabase
        .from("job_cut_list_items")
        .select("*")
        .eq("job_id", jobId)
        .eq("raw_material_id", rawMaterialId)
        .order("sort_order"),
      supabase
        .from("job_cut_nests")
        .select("*")
        .eq("job_id", jobId)
        .eq("raw_material_id", rawMaterialId)
        .maybeSingle(),
    ]);

    const loaded: CutRow[] = (cutRes.data || []).map((r) => ({
      id: r.id as string,
      mark: (r.mark as string) || "",
      length: String(r.length_inches),
      quantity: String(r.quantity),
      leadAngle: String(r.lead_angle),
      leadDir: (Number(r.lead_dir) === -1 ? -1 : 1) as MiterDir,
      trailAngle: String(r.trail_angle),
      trailDir: (Number(r.trail_dir) === -1 ? -1 : 1) as MiterDir,
      allowFlip: r.allow_flip !== false,
      source: (r.source as string) === "template" ? "template" : "manual",
      productTemplateId: (r.product_template_id as string | null) ?? null,
    }));
    setRows(loaded.length ? loaded : [blankRow()]);

    const nest = nestRes.data;

    // Other jobs' planned nests, and which of the ones this plan leaned on
    // have been applied since (so their drops are real inventory now).
    const oth = await fetchOthers();
    setOthers(oth);
    setMyCreatedAt((nest?.created_at as string | undefined) ?? null);
    const saved = (nest?.result as NestResult | null) || null;
    const refs = new Set<string>();
    for (const b of saved?.basedOn || []) refs.add(b.nestId);
    for (const st of saved?.sticks || []) if (st.plannedFrom) refs.add(st.plannedFrom.nestId);
    const missing = Array.from(refs).filter((id) => !oth.some((o) => o.id === id));
    let applied: string[] = [];
    if (missing.length) {
      const { data: ap } = await supabase.from("job_cut_nests").select("id, applied_at").in("id", missing);
      applied = (ap || []).filter((a) => a.applied_at).map((a) => a.id as string);
    }
    setAppliedRefs(applied);

    if (nest) {
      setNestId(nest.id as string);
      setSettings({
        kerf: String(nest.kerf_inches),
        minDrop: String(nest.min_drop_inches),
        trimStart: String(nest.trim_start_inches),
        trimEnd: String(nest.trim_end_inches),
        dropCredit: String(nest.drop_credit),
        effort: (nest.effort as string) || "normal",
        depth:
          nest.depth_inches !== null && nest.depth_inches !== undefined
            ? String(nest.depth_inches)
            : String(materialDepth ?? suggested[0] ?? ""),
      });
      setPlan((nest.result as NestResult | null) || null);
      setAppliedAt((nest.applied_at as string | null) || null);
      // Put the order-length picker back the way it was when this nest was made.
      const offered = (nest.result as NestResult | null)?.orderLengths || [];
      setOrderChoice(offered.length === 1 && ORDER_CHOICES[String(offered[0])] ? String(offered[0]) : "auto");
    } else {
      setNestId(null);
      setSettings({
        ...DEFAULT_SETTINGS,
        kerf: String(companyKerf),
        minDrop: String(companyMinDrop),
        depth: String(materialDepth ?? suggested[0] ?? ""),
      });
      setPlan(null);
      setAppliedAt(null);
      setOrderChoice("auto");
    }
    setDirty(false);
    setLoading(false);
  }, [supabase, jobId, rawMaterialId, companyKerf, companyMinDrop, materialDepth, suggested, reloadKey, fetchOthers]);

  useEffect(() => {
    load();
  }, [load]);

  // Print once the cut sheet has rendered, and take it away again afterwards.
  useEffect(() => {
    if (!printedAt) return;
    const done = () => setPrintedAt(null);
    window.addEventListener("afterprint", done, { once: true });
    const t = window.setTimeout(() => window.print(), 150);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [printedAt]);

  // ---- sharing stock with other jobs' planned nests ----
  // The older nest always gets first claim. A nest with no row yet is newer
  // than all of them.
  const earlier = others.filter((o) => !myCreatedAt || o.createdAt < myCreatedAt);
  const held = reservePlannedStock(
    availableLengths,
    earlier.map((o) => ({ nestId: o.id, jobNumber: o.jobNumber, result: o.result })),
    trackDrops
  );

  /** Why this plan is out of date because of another job's nest, or null. */
  function staleReason(): string | null {
    if (!plan || !plan.basedOn || appliedAt) return null;
    for (const b of plan.basedOn) {
      const cur = earlier.find((o) => o.id === b.nestId);
      if (cur) {
        if (cur.optimizedAt !== b.optimizedAt) return "Job " + b.jobNumber + "'s nest was re-optimized";
      } else if (
        !appliedRefs.includes(b.nestId) &&
        plan.sticks.some((st) => st.plannedFrom?.nestId === b.nestId)
      ) {
        return "Job " + b.jobNumber + "'s nest was removed or turned off, and this one uses its drop";
      }
    }
    for (const o of earlier) {
      if (!plan.basedOn.some((b) => b.nestId === o.id)) return "Job " + o.jobNumber + "'s nest now comes ahead of this one";
    }
    return null;
  }
  const staleMsg = staleReason();

  /** Jobs whose drop this plan cuts from and that haven't been applied yet. */
  const waitingOn =
    plan && !appliedAt
      ? Array.from(
          new Set(
            plan.sticks
              .filter((st) => st.plannedFrom && !appliedRefs.includes(st.plannedFrom.nestId))
              .map((st) => "Job " + st.plannedFrom!.jobNumber)
          )
        )
      : [];

  /** Later jobs that are counting on a drop from THIS nest. */
  const dependents = nestId
    ? Array.from(
        new Set(
          others
            .filter((o) => o.result.sticks.some((st) => st.plannedFrom?.nestId === nestId))
            .map((o) => "Job " + o.jobNumber)
        )
      )
    : [];

  function patchRow(id: string, patch: Partial<CutRow>) {
    // Touching a line that came from a product template makes it YOURS: it
    // flips to manual so the next Fill from products leaves it standing
    // instead of quietly overwriting the change you just made. The template it
    // came from is kept, so you can still see where it started.
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch, source: "manual" as const } : r))
    );
    setDirty(true);
  }

  function addRow() {
    setRows((prev) => [...prev, blankRow()]);
    setDirty(true);
  }

  function removeRow(id: string) {
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length ? next : [blankRow()];
    });
    setDirty(true);
  }

  function applyPaste() {
    const { rows: added, skipped } = parsePastedRows(pasteText);
    if (!added.length) {
      setError("Couldn't read any parts out of that. One per line: mark, length, qty.");
      return;
    }
    setError(null);
    setRows((prev) => {
      const keep = prev.filter((r) => r.length.trim() !== "");
      return [...keep, ...added];
    });
    setDirty(true);
    setPasteText("");
    setShowPaste(false);
    setNote("Added " + added.length + " part" + (added.length === 1 ? "" : "s") +
      (skipped ? ", skipped " + skipped + " line" + (skipped === 1 ? "" : "s") + " it couldn't read" : "") + ".");
  }

  /** Rows that have a readable length and a quantity - the ones worth saving or nesting. */
  function usableRows() {
    return rows.filter((r) => {
      const len = parseLength(r.length);
      const qty = parseInt(r.quantity, 10);
      return len !== null && len > 0 && !isNaN(qty) && qty > 0;
    });
  }

  async function saveCutList(): Promise<boolean> {
    const good = usableRows();
    if (!good.length) {
      setError("Add at least one part with a length and a quantity.");
      return false;
    }
    setError(null);
    // Small lists, and the whole set always saves together, so replace rather
    // than diffing row by row.
    const del = await supabase
      .from("job_cut_list_items")
      .delete()
      .eq("job_id", jobId)
      .eq("raw_material_id", rawMaterialId);
    if (del.error) {
      setError(del.error.message);
      return false;
    }
    const payload = good.map((r, i) => ({
      company_id: companyId,
      job_id: jobId,
      raw_material_id: rawMaterialId,
      mark: r.mark.trim() || null,
      length_inches: parseLength(r.length),
      quantity: parseInt(r.quantity, 10),
      lead_angle: Math.abs(parseFloat(r.leadAngle) || 0),
      lead_dir: r.leadDir,
      trail_angle: Math.abs(parseFloat(r.trailAngle) || 0),
      trail_dir: r.trailDir,
      allow_flip: r.allowFlip,
      sort_order: i,
      // Was hardcoded to "manual", which silently converted every filled line
      // the first time this list was saved -- and then a re-fill duplicated
      // them all, because nothing was left for it to replace.
      source: r.source === "template" ? "template" : "manual",
      product_template_id: r.productTemplateId ?? null,
    }));
    const ins = await supabase.from("job_cut_list_items").insert(payload);
    if (ins.error) {
      setError(ins.error.message);
      return false;
    }
    await load();
    return true;
  }

  function buildInputs(rack: { length: number; sticks: number }[], planned: PlannedDrop[]) {
    const parts: CutPartInput[] = usableRows().map((r) => ({
      id: r.id,
      label: r.mark.trim() || "Part",
      length: parseLength(r.length) as number,
      qty: parseInt(r.quantity, 10),
      leadAngle: Math.abs(parseFloat(r.leadAngle) || 0),
      leadDir: r.leadDir,
      trailAngle: Math.abs(parseFloat(r.trailAngle) || 0),
      trailDir: r.trailDir,
      allowFlip: r.allowFlip,
      material: rawMaterialId,
    }));
    // getAvailableLengths gives FEET; the optimizer works in inches.
    const stock: CutStockInput[] = rack.map((l) => ({
      id: rawMaterialId + "-" + l.length,
      label: inches(l.length * 12),
      length: l.length * 12,
      qty: l.sticks,
      height: parseLength(settings.depth) ?? 0,
      costPerFoot,
      material: rawMaterialId,
    }));
    // Drops other jobs' nests are going to leave - used just like stock on hand.
    for (const p of planned) {
      stock.push({
        id: "planned-" + p.nestId + "-" + p.length,
        label: inches(p.length) + " (Job " + p.jobNumber + " drop)",
        length: p.length,
        qty: p.qty,
        height: parseLength(settings.depth) ?? 0,
        costPerFoot,
        material: rawMaterialId,
        plannedFrom: { nestId: p.nestId, jobNumber: p.jobNumber },
      });
    }
    // Lengths that can be bought. The optimizer only plans on these once the
    // rack is used up, so whatever lands on them is what has to be ordered.
    for (const len of ORDER_CHOICES[orderChoice] || ORDER_CHOICES.auto) {
      stock.push({
        id: rawMaterialId + "-order-" + len,
        label: feetText(len) + " (to order)",
        length: len,
        qty: null,
        height: parseLength(settings.depth) ?? 0,
        costPerFoot,
        material: rawMaterialId,
        toOrder: true,
      });
    }
    const [iterations, timeBudgetMs] = NEST_EFFORT[settings.effort] || NEST_EFFORT.normal;
    return {
      parts,
      stock,
      settings: {
        kerf: parseLength(settings.kerf) ?? 0.125,
        minDrop: parseLength(settings.minDrop) ?? 0,
        trimStart: parseLength(settings.trimStart) ?? 0,
        trimEnd: parseLength(settings.trimEnd) ?? 0,
        dropCredit: parseFloat(settings.dropCredit) || 0,
        iterations,
        timeBudgetMs,
        seed: 1,
      },
    };
  }

  async function runOptimize() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (dirty && !(await saveCutList())) return;
      // Read the other jobs' nests fresh - one may have changed in another tab.
      const fresh = await fetchOthers();
      setOthers(fresh);
      const ahead = fresh.filter((o) => !myCreatedAt || o.createdAt < myCreatedAt);
      const hold = reservePlannedStock(
        availableLengths,
        ahead.map((o) => ({ nestId: o.id, jobNumber: o.jobNumber, result: o.result })),
        trackDrops
      );
      const result = optimizeNest(buildInputs(hold.rack, hold.planned));
      result.basedOn = ahead.map((o) => ({ nestId: o.id, jobNumber: o.jobNumber, optimizedAt: o.optimizedAt }));
      setPlan(result);
      setAppliedAt(null);
      setAppliedRefs([]);

      const row = {
        company_id: companyId,
        job_id: jobId,
        raw_material_id: rawMaterialId,
        kerf_inches: parseLength(settings.kerf) ?? 0.125,
        min_drop_inches: parseLength(settings.minDrop) ?? 0,
        trim_start_inches: parseLength(settings.trimStart) ?? 0,
        trim_end_inches: parseLength(settings.trimEnd) ?? 0,
        drop_credit: parseFloat(settings.dropCredit) || 0,
        effort: settings.effort,
        depth_inches: parseLength(settings.depth),
        result: result as unknown as Record<string, unknown>,
        optimized_at: new Date().toISOString(),
        applied_at: null,
        updated_at: new Date().toISOString(),
      };
      if (nestId) {
        await supabase.from("job_cut_nests").update(row).eq("id", nestId);
      } else {
        const { data } = await supabase.from("job_cut_nests").insert(row).select("id, created_at").single();
        if (data) {
          setNestId(data.id as string);
          setMyCreatedAt(data.created_at as string);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyPlan() {
    if (!plan || !plan.sticks.length) return;
    if (plan.sticks.some((st) => st.toOrder)) {
      setError(
        "Part of this nest is planned on material you still have to order. Once it's received, " +
          "Re-optimize, then Apply."
      );
      return;
    }
    if (staleMsg) {
      setError(staleMsg + " since this nest was made. Re-optimize, then Apply.");
      return;
    }
    if (waitingOn.length) {
      setError(
        "This nest cuts from a drop that " + waitingOn.join(", ") + " hasn't cut yet. Apply " +
          waitingOn.join(", ") + "'s nest first, then come back and Apply this one."
      );
      return;
    }
    const ops = planToInventoryOps(plan);
    // The rack can change between Optimize and Apply (another job pulls from
    // it). Never pull a stick that isn't there - that is what drives a length
    // negative. Make them re-run the nest against what's really on hand.
    // Each pull is snapped to the length inventory actually holds (within
    // 1/32"), so a drop another job saved nets against the right rack line.
    const TOL_FEET = 1 / 32 / 12;
    const snapped = ops.pulls.map((p) => {
      let best: { length: number; sticks: number } | null = null;
      for (const l of availableLengths) {
        const d = Math.abs(l.length - p.lengthFeet);
        if (d <= TOL_FEET && (!best || d < Math.abs(best.length - p.lengthFeet))) best = l;
      }
      return { ...p, lengthFeet: best ? best.length : p.lengthFeet, have: best ? best.sticks : 0 };
    });
    const short = snapped.filter((p) => p.have < p.quantity);
    if (short.length) {
      setError(
        "Stock has changed since this nest was made - not enough on hand at " +
          short.map((p) => inches(p.lengthFeet * 12)).join(", ") +
          ". Re-optimize, then Apply."
      );
      return;
    }
    const pullCount = ops.pulls.reduce((a, p) => a + p.quantity, 0);
    const dropCount = trackDrops ? ops.drops.reduce((a, d) => a + d.quantity, 0) : 0;
    const msg =
      "Apply this nest to inventory?\n\n" +
      "Pull " + pullCount + " stick" + (pullCount === 1 ? "" : "s") + " of " + materialLabel +
      (dropCount ? "\nSave " + dropCount + " drop" + (dropCount === 1 ? "" : "s") + " back to stock" : "") +
      "\n\nEach entry can still be undone one at a time afterwards.";
    if (!confirm(msg)) return;

    setBusy(true);
    setError(null);
    try {
      for (const p of snapped) {
        await pullSticks({
          companyId,
          jobId,
          rawMaterialId,
          length: p.lengthFeet,
          quantity: p.quantity,
          costPerFoot,
        });
      }
      if (trackDrops) {
        for (const d of ops.drops) {
          await saveDrop({
            companyId,
            jobId,
            rawMaterialId,
            length: d.lengthFeet,
            quantity: d.quantity,
            costPerFoot,
            jobNumber,
          });
        }
      }
      const stamp = new Date().toISOString();
      if (nestId) {
        await supabase
          .from("job_cut_nests")
          .update({ applied_at: stamp, updated_at: stamp })
          .eq("id", nestId);
      }
      setAppliedAt(stamp);
      setNote("Applied. The pulls and drops are listed above, each with its own Undo.");
      if (onChanged) onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-600">Loading the cut list...</p>;

  const s = plan?.summary;
  const depthNum = parseLength(settings.depth) || 0;
  // The drawing's vertical units are inches of profile depth. With no depth
  // recorded every cut is square, so any positive number gives flat rectangles.
  const vbDepth = depthNum > 0 ? depthNum : 1;
  const orderLines = plan?.order || [];
  const needsOrder = !!plan && plan.sticks.some((st) => st.toOrder);
  const orderSticks = plan ? plan.sticks.filter((st) => st.toOrder).length : 0;
  const orderFeet = orderLines.reduce((a, o) => a + (o.length * o.qty) / 12, 0);
  const pieceCount = plan ? plan.sticks.reduce((a, st) => a + st.pieces.length, 0) : 0;
  const planDepth = plan?.sticks[0]?.height || 0;

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>
      )}
      {note && (
        <div className="text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-md p-3">{note}</div>
      )}

      {/* ---------- cut list ---------- */}
      <div className="border border-gray-200 rounded-md overflow-hidden">
        <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Cut list</span>
          <div className="flex items-center gap-3">
            <button onClick={() => setShowPaste(!showPaste)} className="text-xs font-medium text-blue-600 hover:text-blue-800">
              {showPaste ? "Cancel paste" : "Paste a list"}
            </button>
            <button onClick={addRow} className="text-xs font-medium text-blue-600 hover:text-blue-800">+ Add part</button>
          </div>
        </div>

        {showPaste && (
          <div className="p-3 border-b border-gray-200 bg-gray-50">
            <p className="text-xs text-gray-600 mb-2">
              One part per line: mark, length, qty, left angle, right angle. Angles are optional &mdash; add
              &nbsp;/&nbsp; or &nbsp;\&nbsp; after an angle to say which way it leans. Lengths can be written
              like 76 1/2 or 6&apos;-4 1/2.
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={4}
              placeholder={"RAIL-A, 76 1/2, 6, 35/, 35/\nPOST, 42, 8"}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button onClick={applyPaste} className="mt-2 px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700">
              Add these parts
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2 text-left font-medium">Mark</th>
                <th className="px-3 py-2 text-left font-medium">Length (long pt.)</th>
                <th className="px-3 py-2 text-left font-medium">Qty</th>
                <th className="px-3 py-2 text-left font-medium">Left end</th>
                <th className="px-3 py-2 text-left font-medium">Right end</th>
                <th className="px-3 py-2 text-left font-medium" title="May the piece be turned end-for-end or rolled over?">Flip</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5">
                    <input type="text" value={r.mark} onChange={(e) => patchRow(r.id, { mark: e.target.value })}
                      className="w-28 px-2 py-1 border border-gray-300 rounded text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </td>
                  <td className="px-3 py-1.5">
                    <input type="text" value={r.length} onChange={(e) => patchRow(r.id, { length: e.target.value })}
                      placeholder={'76 1/2'}
                      className="w-28 px-2 py-1 border border-gray-300 rounded text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </td>
                  <td className="px-3 py-1.5">
                    <input type="number" min="1" step="1" value={r.quantity} onChange={(e) => patchRow(r.id, { quantity: e.target.value })}
                      className="w-16 px-2 py-1 border border-gray-300 rounded text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1">
                      <input type="number" min="0" max="89" step="0.5" value={r.leadAngle} onChange={(e) => patchRow(r.id, { leadAngle: e.target.value })}
                        className="w-16 px-2 py-1 border border-gray-300 rounded text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <button type="button" onClick={() => patchRow(r.id, { leadDir: (r.leadDir === 1 ? -1 : 1) as MiterDir })}
                        disabled={!(parseFloat(r.leadAngle) > 0)}
                        title="Which way the cut leans as the stick lies in the saw"
                        className="w-8 h-7 border border-gray-300 rounded font-mono text-blue-700 disabled:text-gray-300 disabled:cursor-default hover:border-blue-500">
                        {r.leadDir === -1 ? "\\" : "/"}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1">
                      <input type="number" min="0" max="89" step="0.5" value={r.trailAngle} onChange={(e) => patchRow(r.id, { trailAngle: e.target.value })}
                        className="w-16 px-2 py-1 border border-gray-300 rounded text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <button type="button" onClick={() => patchRow(r.id, { trailDir: (r.trailDir === 1 ? -1 : 1) as MiterDir })}
                        disabled={!(parseFloat(r.trailAngle) > 0)}
                        title="Which way the cut leans as the stick lies in the saw"
                        className="w-8 h-7 border border-gray-300 rounded font-mono text-blue-700 disabled:text-gray-300 disabled:cursor-default hover:border-blue-500">
                        {r.trailDir === -1 ? "\\" : "/"}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <input type="checkbox" checked={r.allowFlip} onChange={(e) => patchRow(r.id, { allowFlip: e.target.checked })}
                      className="w-4 h-4" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button onClick={() => removeRow(r.id)} className="text-gray-400 hover:text-red-600 text-lg leading-none px-1" title="Remove">&times;</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-3 py-2 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-gray-600">
            Lengths are long point to long point. {parseLength(settings.depth)
              ? "Cutting " + inches(parseLength(settings.depth) as number) + " deep, so miters can share a blade pass."
              : "No depth set below, so every cut is treated as square."}
          </p>
          <button onClick={saveCutList} disabled={busy || !dirty}
            className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-100 disabled:opacity-50">
            {dirty ? "Save cut list" : "Saved"}
          </button>
        </div>
      </div>

      {/* ---------- settings + stock ---------- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
          <p className="text-sm font-medium text-gray-900 mb-2">Saw settings</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 pb-3 mb-1 border-b border-gray-200">
              <label className="block text-xs font-medium text-gray-700 mb-1">Depth in the saw (in)</label>
              <div className="flex items-center gap-2 flex-wrap">
                <input type="text" value={settings.depth} placeholder="square cuts"
                  onChange={(e) => setSettings({ ...settings, depth: e.target.value })}
                  className="w-24 px-2 py-1.5 border border-gray-300 rounded text-gray-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {suggested.map((d) => (
                  <button key={d} type="button" onClick={() => setSettings({ ...settings, depth: String(d) })}
                    className={
                      "px-2 py-1 rounded border text-sm font-mono " +
                      (parseLength(settings.depth) === d
                        ? "bg-blue-600 border-blue-600 text-white"
                        : "bg-white border-gray-300 text-gray-700 hover:border-blue-500")
                    }>
                    {inches(d)}
                  </button>
                ))}
                {settings.depth !== "" && (
                  <button type="button" onClick={() => setSettings({ ...settings, depth: "" })}
                    className="text-xs text-gray-500 hover:text-gray-800 underline">all square</button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1.5">{depthHint(shape)}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Kerf (in)</label>
              <input type="text" value={settings.kerf} onChange={(e) => setSettings({ ...settings, kerf: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-gray-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Min usable drop (in)</label>
              <input type="text" value={settings.minDrop} onChange={(e) => setSettings({ ...settings, minDrop: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-gray-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Trim, head (in)</label>
              <input type="text" value={settings.trimStart} onChange={(e) => setSettings({ ...settings, trimStart: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-gray-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Trim, tail (in)</label>
              <input type="text" value={settings.trimEnd} onChange={(e) => setSettings({ ...settings, trimEnd: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-gray-900 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">A usable drop is worth</label>
              <select value={settings.dropCredit} onChange={(e) => setSettings({ ...settings, dropCredit: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-gray-900 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="1">Full &mdash; it goes back on the rack</option>
                <option value="0.5">Half &mdash; split the difference</option>
                <option value="0">Nothing &mdash; count the whole stick</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Search effort</label>
              <select value={settings.effort} onChange={(e) => setSettings({ ...settings, effort: e.target.value })}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-gray-900 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="quick">Quick</option>
                <option value="normal">Normal</option>
                <option value="thorough">Thorough</option>
              </select>
            </div>
          </div>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
          <p className="text-sm font-medium text-gray-900 mb-2">Stock it can cut from</p>
          {availableLengths.length === 0 && held.planned.length === 0 ? (
            <p className="text-sm text-gray-600">
              Nothing on hand for this material. Optimize will plan the whole list on sticks to order.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {availableLengths.map((l) => {
                  const free = held.rack.find((r) => Math.abs(r.length - l.length) < 1e-9)?.sticks ?? 0;
                  const spoken = l.sticks - free;
                  return (
                    <tr key={l.length} className="border-t border-gray-200 first:border-t-0">
                      <td className="py-1 font-mono text-gray-900">{inches(l.length * 12)}</td>
                      <td className="py-1 text-gray-600 text-right">
                        {free} free
                        {spoken > 0 && (
                          <span className="text-xs text-gray-500"> &middot; {spoken} held for other jobs&apos; nests</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {held.planned.map((p) => (
                  <tr key={p.nestId + "-" + p.length} className="border-t border-gray-200 first:border-t-0">
                    <td className="py-1 font-mono text-purple-800">{inches(p.length)}</td>
                    <td className="py-1 text-purple-800 text-right">
                      {p.qty} &middot; drop from Job {p.jobNumber} <span className="text-xs">(not cut yet)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Shortest lengths get used first, so remnants come off the rack before full sticks.
          </p>
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-700 mb-1">If there isn&apos;t enough, plan the rest on</label>
            <select value={orderChoice} onChange={(e) => setOrderChoice(e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-gray-900 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="auto">20&apos; or 24&apos; sticks &mdash; whichever buys less</option>
              <option value="240">20&apos; sticks</option>
              <option value="288">24&apos; sticks</option>
            </select>
          </div>
          <button onClick={runOptimize} disabled={busy}
            className="mt-3 w-full px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50">
            {busy ? "Working..." : plan ? "Re-optimize" : "Optimize"}
          </button>
        </div>
      </div>

      {/* ---------- the plan ---------- */}
      {plan && s && (
        <div className="border border-gray-200 rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              The nest {appliedAt ? "(applied)" : "(not applied yet)"}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => setPrintedAt(new Date().toLocaleString())} disabled={!plan.sticks.length}
                className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-100 disabled:opacity-50">
                Print cut sheet
              </button>
              {appliedAt ? (
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  Applied to inventory
                </span>
              ) : staleMsg ? (
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800"
                  title={staleMsg}>
                  Re-optimize before applying
                </span>
              ) : waitingOn.length > 0 ? (
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
                  title="Apply that job's nest first">
                  Waiting on {waitingOn.join(", ")}
                </span>
              ) : needsOrder ? (
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800"
                  title="Receive the material, Re-optimize, then Apply">
                  Order material before applying
                </span>
              ) : (
                <button onClick={applyPlan} disabled={busy || !plan.sticks.length}
                  className="px-4 py-1.5 bg-green-600 text-white rounded-md font-medium text-sm hover:bg-green-700 disabled:opacity-50">
                  Apply to inventory
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-3 text-sm border-b border-gray-200">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Sticks</div>
              <div className="font-mono text-gray-900 mt-1">{s.sticks}</div>
              {orderSticks > 0 && <div className="text-xs text-red-700">{orderSticks} to order</div>}
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Stock used</div>
              <div className="font-mono text-gray-900 mt-1">{(s.stockTotal / 12).toFixed(2)} ft</div>
              <div className="text-xs text-gray-500">${((s.stockTotal / 12) * costPerFoot).toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Yield</div>
              <div className="font-mono text-gray-900 mt-1">{(s.yield * 100).toFixed(1)}%</div>
              <div className="text-xs text-gray-500">{(s.yieldWithDrops * 100).toFixed(1)}% with drops</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Back on the rack</div>
              <div className="font-mono text-gray-900 mt-1">{(s.usableDropTotal / 12).toFixed(2)} ft</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Scrap</div>
              <div className="font-mono text-gray-900 mt-1">{(s.scrapTotal / 12).toFixed(2)} ft</div>
              <div className="text-xs text-gray-500">{s.sharedCuts} shared cuts</div>
            </div>
          </div>

          {staleMsg && (
            <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-800">
              {staleMsg} since this nest was made, so the stock it planned on may not be right any more.
              Re-optimize this one before you print or apply it.
            </div>
          )}

          {waitingOn.length > 0 && !staleMsg && (
            <div className="px-3 py-2 bg-purple-50 border-b border-purple-200 text-sm text-purple-800">
              Some sticks below are drops {waitingOn.join(", ")} will leave (tagged in purple). They don&apos;t
              exist yet &mdash; cut and Apply {waitingOn.join(", ")} first, then Apply this one.
            </div>
          )}

          {dependents.length > 0 && !appliedAt && (
            <div className="px-3 py-2 bg-blue-50 border-b border-blue-200 text-sm text-blue-800">
              {dependents.join(", ")} {dependents.length === 1 ? "is" : "are"} planned on a drop from this nest.
              If you re-optimize here, {dependents.length === 1 ? "that nest" : "those nests"} will need re-optimizing too.
            </div>
          )}

          {orderLines.length > 0 && (
            <div className="px-3 py-3 bg-red-50 border-b border-red-200 text-sm text-red-800">
              <div className="font-semibold">Not enough {materialLabel} on hand. Order before cutting:</div>
              <ul className="mt-1 font-mono">
                {orderLines.map((o) => (
                  <li key={o.length}>
                    {o.qty} &times; {feetText(o.length)} stick{o.qty === 1 ? "" : "s"} ({((o.length * o.qty) / 12).toFixed(0)} ft)
                  </li>
                ))}
              </ul>
              <div className="text-xs mt-1">
                {orderFeet.toFixed(0)} ft total, about ${(orderFeet * costPerFoot).toFixed(2)} at the current cost.
                Sticks tagged TO ORDER below are planned on steel you don&apos;t have yet. Apply stays off until
                it&apos;s received and you Re-optimize.
              </div>
            </div>
          )}

          {plan.unplaced.length > 0 && (
            <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-800">
              <b>{plan.unplaced.length}</b> piece{plan.unplaced.length === 1 ? "" : "s"} wouldn&apos;t fit any
              stick: {plan.unplaced.slice(0, 4).map((u) => u.label + " " + inches(u.length)).join(", ")}
              {plan.unplaced.length > 4 ? "..." : ""}. They&apos;re longer than the longest stock &mdash; splice them
              or shorten the list.
            </div>
          )}

          <div className="px-3 py-2 border-b border-gray-200 text-xs text-gray-500">
            Each stick is drawn to scale along its length. Angled ends lean the way they sit in the saw,
            and where two pieces share one blade pass they meet on a single line. Depth is stretched top
            to bottom so the lean is visible &mdash; a half-inch of miter on a 20-foot stick is otherwise a hair.
          </div>

          <NestSticksView sticks={plan.sticks} fallbackDepth={vbDepth} />
        </div>
      )}

      {/* ---------- the paper cut sheet (only exists while printing) ---------- */}
      {printedAt && plan && typeof document !== "undefined" &&
        createPortal(
          <div id="nest-print-root" className="bg-white text-gray-900">
            <style>{PRINT_CSS}</style>
            <div className="flex items-start justify-between gap-4 border-b-2 border-gray-900 pb-2 mb-2">
              <div>
                <div className="text-xl font-bold">Cut sheet &mdash; Job {jobNumber}</div>
                <div className="text-base mt-0.5">{materialLabel}</div>
              </div>
              <div className="text-right text-xs text-gray-600">
                <div>Printed {printedAt}</div>
                <div>{appliedAt ? "Applied to inventory" : "Plan only - not applied to inventory"}</div>
              </div>
            </div>
            <div className="text-sm mb-1">
              {plan.sticks.length} stick{plan.sticks.length === 1 ? "" : "s"} ({plan.sticks.length - orderSticks} from
              the rack{orderSticks ? ", " + orderSticks + " to order" : ""}) &middot; {pieceCount} piece
              {pieceCount === 1 ? "" : "s"} &middot; {planDepth ? inches(planDepth) + " deep in the saw" : "square cuts"}
              &nbsp;&middot; kerf {plan.settings.kerf}&quot;
            </div>
            <p className="text-xs text-gray-600 mb-3">
              Lengths are LONG POINT, in inches. Where two pieces meet on one line, that is one blade pass &mdash;
              do not cut it twice. Tick each piece as it comes off the saw.
            </p>
            {orderLines.length > 0 && (
              <div className="border-2 border-red-700 rounded p-2 mb-3 text-sm">
                <div className="font-bold text-red-800">MATERIAL TO ORDER</div>
                {orderLines.map((o) => (
                  <div key={o.length} className="font-mono">
                    {o.qty} &times; {feetText(o.length)} {materialLabel}
                  </div>
                ))}
                <div className="text-xs mt-1">
                  Sticks tagged TO ORDER are planned on this steel. Don&apos;t cut them until it&apos;s in.
                </div>
              </div>
            )}
            {plan.unplaced.length > 0 && (
              <div className="border border-amber-600 rounded p-2 mb-3 text-sm">
                Not on this sheet (longer than any stick):{" "}
                {plan.unplaced.map((u) => u.label + " " + inches(u.length)).join(", ")}
              </div>
            )}
            <NestSticksView sticks={plan.sticks} fallbackDepth={vbDepth} showAngles large printable />
          </div>,
          document.body
        )}
    </div>
  );
}

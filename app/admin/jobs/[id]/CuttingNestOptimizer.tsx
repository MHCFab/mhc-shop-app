"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "../../../lib/supabase";
import { pullSticks, saveDrop } from "../../../lib/inventory";
import {
  optimizeNest,
  planToInventoryOps,
  parseLength,
  formatLength,
  NEST_EFFORT,
  depthCandidates,
  depthHint,
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
};

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

  const suggested = useMemo(() => depthCandidates(shape, size), [shape, size]);

  const load = useCallback(async () => {
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
    }));
    setRows(loaded.length ? loaded : [blankRow()]);

    const nest = nestRes.data;
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
    }
    setDirty(false);
    setLoading(false);
  }, [supabase, jobId, rawMaterialId, companyKerf, companyMinDrop, materialDepth, suggested]);

  useEffect(() => {
    load();
  }, [load]);

  function patchRow(id: string, patch: Partial<CutRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
      source: "manual",
    }));
    const ins = await supabase.from("job_cut_list_items").insert(payload);
    if (ins.error) {
      setError(ins.error.message);
      return false;
    }
    await load();
    return true;
  }

  function buildInputs() {
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
    const stock: CutStockInput[] = availableLengths.map((l) => ({
      id: rawMaterialId + "-" + l.length,
      label: inches(l.length * 12),
      length: l.length * 12,
      qty: l.sticks,
      height: parseLength(settings.depth) ?? 0,
      costPerFoot,
      material: rawMaterialId,
    }));
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
    if (!availableLengths.length) {
      setError("There's no " + materialLabel + " in stock to nest against.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (dirty && !(await saveCutList())) return;
      const result = optimizeNest(buildInputs());
      setPlan(result);
      setAppliedAt(null);

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
        const { data } = await supabase.from("job_cut_nests").insert(row).select("id").single();
        if (data) setNestId(data.id as string);
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyPlan() {
    if (!plan || !plan.sticks.length) return;
    const ops = planToInventoryOps(plan);
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
      for (const p of ops.pulls) {
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
  const stockTotalSticks = availableLengths.reduce((a, l) => a + l.sticks, 0);

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
          {availableLengths.length === 0 ? (
            <p className="text-sm text-gray-600">Nothing on hand for this material.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {availableLengths.map((l) => (
                  <tr key={l.length} className="border-t border-gray-200 first:border-t-0">
                    <td className="py-1 font-mono text-gray-900">{inches(l.length * 12)}</td>
                    <td className="py-1 text-gray-600 text-right">{l.sticks} on hand</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Shortest lengths get used first, so remnants come off the rack before full sticks.
          </p>
          <button onClick={runOptimize} disabled={busy || stockTotalSticks === 0}
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
            {appliedAt ? (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                Applied to inventory
              </span>
            ) : (
              <button onClick={applyPlan} disabled={busy || !plan.sticks.length}
                className="px-4 py-1.5 bg-green-600 text-white rounded-md font-medium text-sm hover:bg-green-700 disabled:opacity-50">
                Apply to inventory
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-3 text-sm border-b border-gray-200">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Sticks</div>
              <div className="font-mono text-gray-900 mt-1">{s.sticks}</div>
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

          {plan.unplaced.length > 0 && (
            <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-800">
              <b>{plan.unplaced.length}</b> piece{plan.unplaced.length === 1 ? "" : "s"} wouldn&apos;t fit the stock on
              hand: {plan.unplaced.slice(0, 4).map((u) => u.label + " " + inches(u.length)).join(", ")}
              {plan.unplaced.length > 4 ? "..." : ""}. Buy longer stock or shorten the list.
            </div>
          )}

          <div className="px-3 py-2 border-b border-gray-200 text-xs text-gray-500">
            Each stick is drawn to scale along its length. Angled ends lean the way they sit in the saw,
            and where two pieces share one blade pass they meet on a single line. Depth is stretched top
            to bottom so the lean is visible &mdash; a half-inch of miter on a 20-foot stick is otherwise a hair.
          </div>

          <div className="divide-y divide-gray-100">
            {plan.sticks.map((st, i) => {
              return (
                <div key={i} className="p-3">
                  <div className="flex items-baseline gap-3 flex-wrap mb-2">
                    <span className="text-sm font-semibold text-gray-900">Stick {i + 1}</span>
                    <span className="text-sm text-gray-600 font-mono">{inches(st.stockLength)}</span>
                    <span className="ml-auto text-xs font-mono text-gray-500">
                      used {inches(st.consumed)} &middot; drop {inches(st.drop)}{" "}
                      {st.usableDrop ? (
                        <span className="text-green-700">back on the rack</span>
                      ) : (
                        <span className="text-amber-700">scrap</span>
                      )}
                    </span>
                  </div>

                  {/* One bar per stick. Each piece is drawn as the four-sided shape
                      it really is: the bottom face runs pBottom -> qBottom, and the
                      top face is shifted by the miter offset at each end. So a
                      mitered end leans, and two ends cut in one blade pass share an
                      edge instead of sitting square against each other. */}
                  <div className="relative h-12 w-full bg-gray-100 border border-gray-300 rounded-sm overflow-hidden">
                    <svg
                      viewBox={"0 0 " + st.stockLength + " " + vbDepth}
                      preserveAspectRatio="none"
                      className="absolute inset-0 h-full w-full"
                      aria-hidden="true"
                    >
                      {st.pieces.map((p, j) => (
                        <polygon
                          key={j}
                          points={
                            (p.pBottom + p.sLead) + ",0 " +
                            (p.qBottom + p.sTrail) + ",0 " +
                            p.qBottom + "," + vbDepth + " " +
                            p.pBottom + "," + vbDepth
                          }
                          fill={p.sharedCut ? "#a5c8fb" : "#bfdbfe"}
                          stroke="#2563eb"
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                    </svg>
                    {st.pieces.map((p, j) => (
                      <span
                        key={j}
                        title={p.label + " " + inches(p.length) + (p.sharedCut ? " — shares the previous cut" : "")}
                        className="pointer-events-none absolute top-1/2 -translate-y-1/2 truncate px-0.5 text-center text-[10px] font-medium text-blue-900"
                        style={{
                          left: (p.startX / st.stockLength) * 100 + "%",
                          width: ((p.endX - p.startX) / st.stockLength) * 100 + "%",
                        }}
                      >
                        {p.label}
                      </span>
                    ))}
                  </div>

                  <table className="w-full text-sm mt-2">
                    <tbody>
                      {st.pieces.map((p, j) => (
                        <tr key={j} className="border-t border-gray-100 first:border-t-0">
                          <td className="py-1 text-gray-900">{p.label}</td>
                          <td className="py-1 font-mono text-gray-700">{inches(p.length)}</td>
                          <td className="py-1 text-xs text-gray-500">
                            {p.sLead || p.sTrail ? "mitered" : "square"}
                            {p.sharedCut ? " · shares the previous cut" : ""}
                            {p.flipped ? " · turned" : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

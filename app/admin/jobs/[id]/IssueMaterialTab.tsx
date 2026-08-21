"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";
import {
  getAvailableRawMaterials,
  pullSticks,
  reverseCuttingNestEntry,
  type AvailableRawMaterial,
} from "../../../lib/inventory";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

type RawMat = {
  id: string;
  shape: string;
  size: string;
  wall_thickness: string | null;
  grade: string;
  current_cost_per_foot: number;
};

type PickItem = {
  id: string;
  raw_material_id: string;
  planned_quantity: number;
  raw_materials: RawMat | null;
};

type NestEntry = {
  id: string;
  raw_material_id: string;
  entry_type: "pull" | "drop";
  length_feet: number;
  quantity: number;
  cost_per_foot: number;
  created_inventory_id: string | null;
  company_id: string;
  job_id: string;
};

function describeMaterial(m: { shape: string; size: string; wall_thickness: string | null; grade: string } | null) {
  if (!m) return "Unknown material";
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  const grade = m.grade ? " (" + m.grade + ")" : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + grade;
}

export default function IssueMaterialTab({
  jobId,
  jobStatus,
  onChanged,
}: {
  jobId: string;
  jobStatus: string;
  onChanged?: () => void;
}) {
  const supabase = createClient();
  const [items, setItems] = useState<PickItem[]>([]);
  const [entries, setEntries] = useState<NestEntry[]>([]);
  const [available, setAvailable] = useState<AvailableRawMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Issue form per pick-list item
  const [issueForm, setIssueForm] = useState<Record<string, { length: string; unit: "ft" | "in" }>>({});
  // Ad-hoc: issue a material that isn't on the pick list
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<{ rawMaterialId: string; length: string; unit: "ft" | "in" }>({
    rawMaterialId: "",
    length: "",
    unit: "ft",
  });

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [pickRes, entriesRes, jobRes, availRes] = await Promise.all([
      supabase
        .from("job_pick_list_items")
        .select("id, raw_material_id, planned_quantity, raw_materials(id, shape, size, wall_thickness, grade, current_cost_per_foot)")
        .eq("job_id", jobId)
        .eq("item_type", "raw_material"),
      supabase
        .from("cutting_nest_entries")
        .select("*")
        .eq("job_id", jobId)
        .order("created_at"),
      supabase.from("jobs").select("cutting_nest_finalized_at").eq("id", jobId).single(),
      getAvailableRawMaterials(),
    ]);

    setItems((pickRes.data || []) as unknown as PickItem[]);
    setEntries((entriesRes.data || []) as unknown as NestEntry[]);
    setFinalizedAt(jobRes.data?.cutting_nest_finalized_at || null);
    setAvailable(availRes.filter((m) => m.is_active));
    setLoading(false);
  }, [supabase, jobId]);

  // Keep each raw pick item's actual_quantity equal to the net feet issued, because
  // the job cost report bills raw material as actual_quantity x cost per foot.
  const syncPickListActuals = useCallback(async () => {
    const { data: latestEntries } = await supabase
      .from("cutting_nest_entries")
      .select("raw_material_id, entry_type, length_feet, quantity")
      .eq("job_id", jobId);

    const { data: pickItems } = await supabase
      .from("job_pick_list_items")
      .select("id, raw_material_id")
      .eq("job_id", jobId)
      .eq("item_type", "raw_material");

    if (!pickItems) return;

    for (const item of pickItems) {
      const mine = (latestEntries || []).filter((e) => e.raw_material_id === item.raw_material_id);
      const issued = mine.filter((e) => e.entry_type === "pull").reduce((s, e) => s + Number(e.length_feet) * Number(e.quantity), 0);
      const returned = mine.filter((e) => e.entry_type === "drop").reduce((s, e) => s + Number(e.length_feet) * Number(e.quantity), 0);
      const net = issued - returned;
      await supabase
        .from("job_pick_list_items")
        .update({ actual_quantity: net > 0 ? net : 0 })
        .eq("id", item.id);
    }
  }, [supabase, jobId]);

  useEffect(() => {
    loadCompanyId();
    loadData();
  }, [loadCompanyId, loadData]);

  function entriesFor(rawMaterialId: string) {
    return entries.filter((e) => e.raw_material_id === rawMaterialId && e.entry_type === "pull");
  }

  function issuedFeet(rawMaterialId: string) {
    return entriesFor(rawMaterialId).reduce((sum, e) => sum + Number(e.length_feet) * Number(e.quantity), 0);
  }

  function stockFor(rawMaterialId: string) {
    return available.find((m) => m.id === rawMaterialId) || null;
  }

  function costFor(item: PickItem) {
    const stock = stockFor(item.raw_material_id);
    if (stock && stock.costPerFoot > 0) return stock.costPerFoot;
    return Number(item.raw_materials?.current_cost_per_foot || 0);
  }

  function feetFrom(length: string, unit: "ft" | "in") {
    const n = parseFloat(length);
    if (isNaN(n) || n <= 0) return 0;
    return unit === "in" ? n / 12 : n;
  }

  async function handleIssue(item: PickItem) {
    if (!companyId) return;
    const form = issueForm[item.id] || { length: "", unit: "ft" as const };
    const feet = feetFrom(form.length, form.unit);
    if (feet <= 0) {
      setError("Enter how much material you issued.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await pullSticks({
        companyId,
        jobId,
        rawMaterialId: item.raw_material_id,
        length: feet,
        quantity: 1,
        costPerFoot: costFor(item),
      });
      setIssueForm({ ...issueForm, [item.id]: { length: "", unit: form.unit } });
      await syncPickListActuals();
      await loadData();
      if (onChanged) onChanged();
    } finally {
      setBusy(false);
    }
  }

  // Issue a material that isn't on the pick list: add a pick-list row for it first
  // (planned 0, so it doesn't reserve stock), then issue against it.
  async function handleAdHocIssue() {
    if (!companyId) return;
    const feet = feetFrom(addForm.length, addForm.unit);
    if (!addForm.rawMaterialId || feet <= 0) {
      setError("Pick a material and enter how much you issued.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const existing = items.find((i) => i.raw_material_id === addForm.rawMaterialId);
      if (!existing) {
        const { error: insErr } = await supabase.from("job_pick_list_items").insert({
          company_id: companyId,
          job_id: jobId,
          item_type: "raw_material",
          raw_material_id: addForm.rawMaterialId,
          purchased_part_id: null,
          planned_quantity: 0,
          actual_quantity: 0,
          unit: "ft",
          notes: "Added when material was issued",
        });
        if (insErr) {
          setError("Could not add that material to the job: " + insErr.message);
          return;
        }
      }

      const stock = stockFor(addForm.rawMaterialId);
      await pullSticks({
        companyId,
        jobId,
        rawMaterialId: addForm.rawMaterialId,
        length: feet,
        quantity: 1,
        costPerFoot: stock ? stock.costPerFoot : 0,
      });
      setAddForm({ rawMaterialId: "", length: "", unit: addForm.unit });
      setShowAdd(false);
      await syncPickListActuals();
      await loadData();
      if (onChanged) onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo(entry: NestEntry) {
    if (!confirm("Undo this issue? The material goes back into stock.")) return;
    setBusy(true);
    try {
      await reverseCuttingNestEntry(entry);
      await syncPickListActuals();
      await loadData();
      if (onChanged) onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    if (!companyId) return;
    if (!confirm("Finalize material for this job? This locks what was used for costing. You can un-finalize later if needed.")) return;
    setBusy(true);

    // Each material's reservation becomes what was actually issued, basis 'actual'.
    for (const item of items) {
      const net = issuedFeet(item.raw_material_id);
      const { data: existing } = await supabase
        .from("inventory_allocations")
        .select("id")
        .eq("job_id", jobId)
        .eq("item_type", "raw_material")
        .eq("raw_material_id", item.raw_material_id)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("inventory_allocations")
          .update({ allocated_quantity: net > 0 ? net : 0, basis: "actual" })
          .eq("id", existing.id);
      } else if (net > 0) {
        await supabase.from("inventory_allocations").insert({
          company_id: companyId,
          job_id: jobId,
          item_type: "raw_material",
          raw_material_id: item.raw_material_id,
          purchased_part_id: null,
          allocated_quantity: net,
          unit: "ft",
          basis: "actual",
        });
      }
    }

    // Purchased parts don't get issued here, so default their actual usage to planned
    // (only when nothing has been entered yet) so actual cost is complete.
    const { data: partItems } = await supabase
      .from("job_pick_list_items")
      .select("id, planned_quantity, actual_quantity")
      .eq("job_id", jobId)
      .eq("item_type", "purchased_part");

    for (const p of partItems || []) {
      if (Number(p.actual_quantity) === 0) {
        await supabase
          .from("job_pick_list_items")
          .update({ actual_quantity: Number(p.planned_quantity) })
          .eq("id", p.id);
      }
    }

    await syncPickListActuals();
    await supabase.from("jobs").update({ cutting_nest_finalized_at: new Date().toISOString() }).eq("id", jobId);
    setBusy(false);
    await loadData();
    if (onChanged) onChanged();
  }

  async function unfinalize() {
    if (!confirm("Un-finalize this job's material so you can make changes?")) return;
    setBusy(true);
    await supabase.from("jobs").update({ cutting_nest_finalized_at: null }).eq("id", jobId);
    setBusy(false);
    await loadData();
    if (onChanged) onChanged();
  }

  if (loading) return <p className="text-gray-600">Loading...</p>;

  const isFinalized = !!finalizedAt;
  const onPickList = new Set(items.map((i) => i.raw_material_id));
  const addChoices = available.filter((m) => !onPickList.has(m.id));

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      {jobStatus === "ordered" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-sm text-amber-800">
            This job is still in Ordered status &mdash; you can issue material now. Material you issue comes straight out of stock, and marking the job Ready will only reserve the estimated material you haven&apos;t already issued.
          </p>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Issue material</h3>
          <p className="text-sm text-gray-600 mt-1">
            Record the material you took out for this job. Stock comes down the moment you issue it, and Undo puts it back.
          </p>
        </div>
        {isFinalized ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Finalized</span>
            <button onClick={unfinalize} disabled={busy} className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">Un-finalize</button>
          </div>
        ) : (
          <button onClick={finalize} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors">
            Finalize material
          </button>
        )}
      </div>

      {items.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-gray-600">No raw materials on this job yet. Use &ldquo;Issue another material&rdquo; below to add one.</p>
        </div>
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const issues = entriesFor(item.raw_material_id);
          const used = issuedFeet(item.raw_material_id);
          const planned = Number(item.planned_quantity);
          const costPerFoot = costFor(item);
          const stock = stockFor(item.raw_material_id);
          const form = issueForm[item.id] || { length: "", unit: "ft" as const };

          return (
            <div key={item.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between flex-wrap gap-2">
                <h4 className="text-sm font-semibold text-gray-900">{describeMaterial(item.raw_materials)}</h4>
                {stock && (
                  <span className="text-xs text-gray-600">
                    In stock: <span className="font-mono">{stock.totalInStock.toFixed(2)} ft</span>
                  </span>
                )}
              </div>

              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Estimated</div>
                    <div className="font-mono text-gray-900 mt-1">{planned.toFixed(2)} ft</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Issued</div>
                    <div className="font-mono text-gray-900 mt-1">{used.toFixed(2)} ft</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Vs estimate</div>
                    <div className={"font-mono mt-1 " + (used > planned ? "text-red-600" : "text-gray-900")}>
                      {(used - planned >= 0 ? "+" : "") + (used - planned).toFixed(2)} ft
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Material cost</div>
                    <div className="font-mono text-gray-900 mt-1">${(used * costPerFoot).toFixed(2)}</div>
                    <div className="text-xs text-gray-500">${costPerFoot.toFixed(2)}/ft</div>
                  </div>
                </div>

                {issues.length > 0 && (
                  <div className="border border-gray-200 rounded-md overflow-hidden">
                    <div className="px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-700 uppercase tracking-wide">Issued to this job</div>
                    <table className="w-full text-sm">
                      <tbody>
                        {issues.map((e) => {
                          const feet = Number(e.length_feet) * Number(e.quantity);
                          return (
                            <tr key={e.id} className="border-t border-gray-100">
                              <td className="px-3 py-2 text-gray-900 font-mono">{feet.toFixed(2)} ft</td>
                              <td className="px-3 py-2 text-gray-600 font-mono">{(feet * 12).toFixed(1)} in</td>
                              <td className="px-3 py-2 text-gray-700 font-mono text-right">${(feet * Number(e.cost_per_foot)).toFixed(2)}</td>
                              <td className="px-3 py-2 text-right">
                                {!isFinalized && (
                                  <button onClick={() => handleUndo(e)} disabled={busy} className="text-red-600 hover:text-red-800 font-medium text-xs disabled:opacity-50">Undo</button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {!isFinalized && (
                  <div className="bg-gray-50 border border-gray-200 rounded-md p-3 space-y-2 max-w-md">
                    <p className="text-sm font-medium text-gray-900">Issue material</p>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-700 mb-1">How much</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={form.length}
                          onChange={(e) => setIssueForm({ ...issueForm, [item.id]: { ...form, length: e.target.value } })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Unit</label>
                        <select
                          value={form.unit}
                          onChange={(e) => setIssueForm({ ...issueForm, [item.id]: { ...form, unit: e.target.value as "ft" | "in" } })}
                          className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="ft">ft</option>
                          <option value="in">in</option>
                        </select>
                      </div>
                      <div className="flex items-end">
                        <button onClick={() => handleIssue(item)} disabled={busy} className="px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50">Issue</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!isFinalized && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          {!showAdd ? (
            <button onClick={() => { setShowAdd(true); setError(null); }} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
              + Issue another material
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium text-gray-900">Issue a material that isn&apos;t on this job yet</p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Material</label>
                  <select
                    value={addForm.rawMaterialId}
                    onChange={(e) => setAddForm({ ...addForm, rawMaterialId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- Select material --</option>
                    {addChoices.map((m) => (
                      <option key={m.id} value={m.id}>
                        {describeMaterial(m)} &mdash; {m.totalInStock.toFixed(2)} ft in stock
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">How much</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={addForm.length}
                    onChange={(e) => setAddForm({ ...addForm, length: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Unit</label>
                  <select
                    value={addForm.unit}
                    onChange={(e) => setAddForm({ ...addForm, unit: e.target.value as "ft" | "in" })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="ft">ft</option>
                    <option value="in">in</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={handleAdHocIssue} disabled={busy} className="px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50">Issue</button>
                <button onClick={() => { setShowAdd(false); setError(null); }} disabled={busy} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md font-medium text-sm hover:bg-gray-100 disabled:opacity-50">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

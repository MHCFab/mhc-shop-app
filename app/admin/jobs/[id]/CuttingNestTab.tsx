"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";
import {
  getAvailableLengths,
  pullSticks,
  saveDrop,
  reverseCuttingNestEntry,
} from "../../../lib/inventory";

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
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

function describeMaterial(m: RawMat | null) {
  if (!m) return "Unknown material";
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

export default function CuttingNestTab({
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
  const [availableLengths, setAvailableLengths] = useState<Record<string, { length: number; sticks: number }[]>>({});
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [jobNumber, setJobNumber] = useState("");
  const [finalizedAt, setFinalizedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Pull form per material
  const [pullForm, setPullForm] = useState<Record<string, { length: string; qty: string }>>({});
  // Drop form per material
  const [dropForm, setDropForm] = useState<Record<string, { length: string; unit: "ft" | "in"; qty: string }>>({});

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [pickRes, entriesRes, jobRes] = await Promise.all([
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
      supabase.from("jobs").select("job_number, cutting_nest_finalized_at").eq("id", jobId).single(),
    ]);

    

    const pickItems = (pickRes.data || []) as PickItem[];
    setItems(pickItems);
    setEntries((entriesRes.data || []) as NestEntry[]);
    setJobNumber(jobRes.data?.job_number || "");
    setFinalizedAt(jobRes.data?.cutting_nest_finalized_at || null);

    // Load available lengths for each material
    const lengthsMap: Record<string, { length: number; sticks: number }[]> = {};
    await Promise.all(
      pickItems.map(async (item) => {
        lengthsMap[item.raw_material_id] = await getAvailableLengths(item.raw_material_id);
      })
    );
    setAvailableLengths(lengthsMap);
    setLoading(false);
  }, [supabase, jobId]);

  const syncPickListActuals = useCallback(async () => {
    // Recompute net consumed per material from the latest entries and write to the pick list
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
      const pulled = mine.filter((e) => e.entry_type === "pull").reduce((s, e) => s + Number(e.length_feet) * Number(e.quantity), 0);
      const saved = mine.filter((e) => e.entry_type === "drop").reduce((s, e) => s + Number(e.length_feet) * Number(e.quantity), 0);
      const net = pulled - saved;
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

  function entriesFor(rawMaterialId: string, type: "pull" | "drop") {
    return entries.filter((e) => e.raw_material_id === rawMaterialId && e.entry_type === type);
  }

  function pulledFeet(rawMaterialId: string) {
    return entriesFor(rawMaterialId, "pull").reduce((sum, e) => sum + Number(e.length_feet) * Number(e.quantity), 0);
  }

  function savedFeet(rawMaterialId: string) {
    return entriesFor(rawMaterialId, "drop").reduce((sum, e) => sum + Number(e.length_feet) * Number(e.quantity), 0);
  }

  async function handlePull(item: PickItem) {
    if (!companyId || !item.raw_materials) return;
    const form = pullForm[item.id] || { length: "", qty: "" };
    const length = parseFloat(form.length);
    const qty = parseInt(form.qty);
    if (isNaN(length) || length <= 0 || isNaN(qty) || qty <= 0) {
      setError("Pick a length and enter how many sticks you pulled.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await pullSticks({
        companyId,
        jobId,
        rawMaterialId: item.raw_material_id,
        length,
        quantity: qty,
        costPerFoot: Number(item.raw_materials.current_cost_per_foot),
      });
      setPullForm({ ...pullForm, [item.id]: { length: "", qty: "" } });
      await syncPickListActuals();
      await loadData();
      if (onChanged) onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDrop(item: PickItem) {
    if (!companyId || !item.raw_materials) return;
    const form = dropForm[item.id] || { length: "", unit: "ft", qty: "" };
    let length = parseFloat(form.length);
    const qty = parseInt(form.qty);
    if (isNaN(length) || length <= 0 || isNaN(qty) || qty <= 0) {
      setError("Enter a drop length and how many.");
      return;
    }
    if (form.unit === "in") length = length / 12;
    setError(null);
    setBusy(true);
    try {
      await saveDrop({
        companyId,
        jobId,
        rawMaterialId: item.raw_material_id,
        length,
        quantity: qty,
        costPerFoot: Number(item.raw_materials.current_cost_per_foot),
        jobNumber,
      });
      setDropForm({ ...dropForm, [item.id]: { length: "", unit: "ft", qty: "" } });
      await syncPickListActuals();
      await loadData();
      if (onChanged) onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleReverse(entry: NestEntry) {
    if (!confirm("Undo this entry? It will reverse the inventory change.")) return;
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
    if (!confirm("Finalize the cutting nest? This locks net consumption for costing. You can un-finalize later if needed.")) return;
    setBusy(true);

    // Set each material's allocation to its net consumed (pulled - saved), basis 'actual'
    for (const item of items) {
      const net = pulledFeet(item.raw_material_id) - savedFeet(item.raw_material_id);
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

    // Set purchased parts' actual usage to their planned quantity (parts don't go through the nest).
    // This makes actual cost complete. Scrap logging or manual edits can adjust later.
    const { data: partItems } = await supabase
      .from("job_pick_list_items")
      .select("id, planned_quantity, actual_quantity")
      .eq("job_id", jobId)
      .eq("item_type", "purchased_part");

    for (const p of partItems || []) {
      // Only default it if no actual has been entered yet
      if (Number(p.actual_quantity) === 0) {
        await supabase
          .from("job_pick_list_items")
          .update({ actual_quantity: Number(p.planned_quantity) })
          .eq("id", p.id);
      }
    }

    await syncPickListActuals();
    await supabase.from("jobs").update({ cutting_nest_finalized_at: new Date().toISOString() }).eq("id", jobId);

    await supabase.from("jobs").update({ cutting_nest_finalized_at: new Date().toISOString() }).eq("id", jobId);
    setBusy(false);
    await loadData();
    if (onChanged) onChanged();
  }

  async function unfinalize() {
    if (!confirm("Un-finalize the cutting nest so you can make changes?")) return;
    setBusy(true);
    await supabase.from("jobs").update({ cutting_nest_finalized_at: null }).eq("id", jobId);
    setBusy(false);
    await loadData();
    if (onChanged) onChanged();
  }

  if (loading) return <p className="text-gray-600">Loading...</p>;

  if (jobStatus === "ordered") {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-6">
        <p className="text-sm text-amber-800">
          This job is still in Ordered status. Mark it Ready first to reserve material, then pull sticks for your cutting nest here.
        </p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
        <p className="text-gray-600">No raw materials on this job&apos;s pick list.</p>
      </div>
    );
  }

  const isFinalized = !!finalizedAt;

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Cutting nest</h3>
          <p className="text-sm text-gray-600 mt-1">
            Pull the sticks you used from inventory, then log the drops you saved. Net consumed = pulled minus saved.
          </p>
        </div>
        {isFinalized ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Finalized</span>
            <button onClick={unfinalize} disabled={busy} className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">Un-finalize</button>
          </div>
        ) : (
          <button onClick={finalize} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors">
            Finalize cutting nest
          </button>
        )}
      </div>

      <div className="space-y-3">
        {items.map((item) => {
          const lengths = availableLengths[item.raw_material_id] || [];
          const pulls = entriesFor(item.raw_material_id, "pull");
          const drops = entriesFor(item.raw_material_id, "drop");
          const pf = pulledFeet(item.raw_material_id);
          const sf = savedFeet(item.raw_material_id);
          const net = pf - sf;
          const costPerFoot = Number(item.raw_materials?.current_cost_per_foot || 0);
          const pForm = pullForm[item.id] || { length: "", qty: "" };
          const dForm = dropForm[item.id] || { length: "", unit: "ft" as const, qty: "" };

          return (
            <div key={item.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h4 className="text-sm font-semibold text-gray-900">{describeMaterial(item.raw_materials)}</h4>
              </div>

              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Estimated</div>
                    <div className="font-mono text-gray-900 mt-1">{Number(item.planned_quantity).toFixed(2)} ft</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Pulled</div>
                    <div className="font-mono text-gray-900 mt-1">{pf.toFixed(2)} ft</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Saved drops</div>
                    <div className="font-mono text-gray-900 mt-1">{sf.toFixed(2)} ft</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Net consumed</div>
                    <div className="font-mono text-gray-900 mt-1">{net.toFixed(2)} ft</div>
                    <div className="text-xs text-gray-500">${(net * costPerFoot).toFixed(2)}</div>
                  </div>
                </div>

                {/* Pulled sticks list */}
                {pulls.length > 0 && (
                  <div className="border border-gray-200 rounded-md overflow-hidden">
                    <div className="px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-700 uppercase tracking-wide">Sticks pulled</div>
                    <table className="w-full text-sm">
                      <tbody>
                        {pulls.map((e) => (
                          <tr key={e.id} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-900 font-mono">{Number(e.length_feet).toFixed(2)} ft</td>
                            <td className="px-3 py-2 text-gray-700">× {e.quantity}</td>
                            <td className="px-3 py-2 text-gray-700 font-mono text-right">{(Number(e.length_feet) * e.quantity).toFixed(2)} ft</td>
                            <td className="px-3 py-2 text-right">
                              {!isFinalized && (
                                <button onClick={() => handleReverse(e)} disabled={busy} className="text-red-600 hover:text-red-800 font-medium text-xs disabled:opacity-50">Undo</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Saved drops list */}
                {drops.length > 0 && (
                  <div className="border border-gray-200 rounded-md overflow-hidden">
                    <div className="px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-700 uppercase tracking-wide">Drops saved back to inventory</div>
                    <table className="w-full text-sm">
                      <tbody>
                        {drops.map((e) => (
                          <tr key={e.id} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-900 font-mono">{Number(e.length_feet).toFixed(2)} ft</td>
                            <td className="px-3 py-2 text-gray-700">× {e.quantity}</td>
                            <td className="px-3 py-2 text-gray-700 font-mono text-right">{(Number(e.length_feet) * e.quantity).toFixed(2)} ft</td>
                            <td className="px-3 py-2 text-right">
                              {!isFinalized && (
                                <button onClick={() => handleReverse(e)} disabled={busy} className="text-red-600 hover:text-red-800 font-medium text-xs disabled:opacity-50">Undo</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {!isFinalized && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Pull sticks form */}
                    <div className="bg-gray-50 border border-gray-200 rounded-md p-3 space-y-2">
                      <p className="text-sm font-medium text-gray-900">Pull sticks</p>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Length in stock</label>
                        <select
                          value={pForm.length}
                          onChange={(e) => setPullForm({ ...pullForm, [item.id]: { ...pForm, length: e.target.value } })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">-- Select length --</option>
                          {lengths.map((l) => (
                            <option key={l.length} value={l.length}>{l.length.toFixed(2)} ft ({l.sticks} available)</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-gray-700 mb-1">How many pulled</label>
                          <input type="number" step="1" min="1" value={pForm.qty} onChange={(e) => setPullForm({ ...pullForm, [item.id]: { ...pForm, qty: e.target.value } })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                        <button onClick={() => handlePull(item)} disabled={busy} className="px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50">Pull</button>
                      </div>
                    </div>

                    {/* Save drop form */}
                    <div className="bg-gray-50 border border-gray-200 rounded-md p-3 space-y-2">
                      <p className="text-sm font-medium text-gray-900">Log a saved drop</p>
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-gray-700 mb-1">Drop length</label>
                          <input type="number" step="0.01" min="0" value={dForm.length} onChange={(e) => setDropForm({ ...dropForm, [item.id]: { ...dForm, length: e.target.value } })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">Unit</label>
                          <select value={dForm.unit} onChange={(e) => setDropForm({ ...dropForm, [item.id]: { ...dForm, unit: e.target.value as "ft" | "in" } })} className="px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                            <option value="ft">ft</option>
                            <option value="in">in</option>
                          </select>
                        </div>
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-gray-700 mb-1">How many</label>
                          <input type="number" step="1" min="1" value={dForm.qty} onChange={(e) => setDropForm({ ...dropForm, [item.id]: { ...dForm, qty: e.target.value } })} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                        <button onClick={() => handleSaveDrop(item)} disabled={busy} className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md font-medium text-sm hover:bg-gray-100 disabled:opacity-50">Save drop</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
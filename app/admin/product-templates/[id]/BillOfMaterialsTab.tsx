"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";

const SHAPES = [
  { value: "round_tube", label: "Round Tube" },
  { value: "square_tube", label: "Square Tube" },
  { value: "rectangle_tube", label: "Rectangle Tube" },
  { value: "channel", label: "Channel" },
  { value: "i_beam", label: "I-Beam" },
  { value: "angle", label: "Angle" },
] as const;

type Shape = (typeof SHAPES)[number]["value"];

type RawMaterial = {
  id: string;
  shape: Shape;
  size: string;
  wall_thickness: string | null;
  grade: string;
  current_cost_per_foot: number;
};

type PurchasedPart = {
  id: string;
  name: string;
  part_number: string | null;
  current_cost_each: number;
};

type Template = {
  id: string;
  name: string;
  product_number: string | null;
};

type MaterialRow = {
  id: string;
  raw_material_id: string;
  feet_per_unit: number;
  notes: string | null;
  raw_materials: RawMaterial | null;
};

type PartRow = {
  id: string;
  purchased_part_id: string;
  quantity_per_unit: number;
  notes: string | null;
  purchased_parts: PurchasedPart | null;
};

type SubRow = {
  id: string;
  child_template_id: string;
  quantity_per_unit: number;
  notes: string | null;
  product_templates: Template | null;
};

function shapeLabel(s: Shape) {
  return SHAPES.find((x) => x.value === s)?.label || s;
}

function describeMaterial(m: RawMaterial | null) {
  if (!m) return "Unknown material";
  const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
  return shapeLabel(m.shape) + " " + m.size + wall + " (" + m.grade + ")";
}

export default function BillOfMaterialsTab({ templateId }: { templateId: string }) {
  const supabase = createClient();
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [subAssemblyCosts, setSubAssemblyCosts] = useState<Record<string, number>>({});
  const [allMaterials, setAllMaterials] = useState<RawMaterial[]>([]);
  const [allParts, setAllParts] = useState<PurchasedPart[]>([]);
  const [allTemplates, setAllTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const [addingMat, setAddingMat] = useState(false);
  const [addingPart, setAddingPart] = useState(false);
  const [addingSub, setAddingSub] = useState(false);

  // Multi-select state for each add form
  const [matChecked, setMatChecked] = useState<Set<string>>(new Set());
  const [partChecked, setPartChecked] = useState<Set<string>>(new Set());
  const [subChecked, setSubChecked] = useState<Set<string>>(new Set());
  const [matSearch, setMatSearch] = useState("");
  const [partSearch, setPartSearch] = useState("");
  const [subSearch, setSubSearch] = useState("");
  const [savingAdd, setSavingAdd] = useState(false);

  // Inline edit state (one row at a time, across all three sections)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const [error, setError] = useState<string | null>(null);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [matsRes, partsRes, subsRes, allMatsRes, allPartsRes, allTplRes] = await Promise.all([
      supabase
        .from("product_template_materials")
        .select("*, raw_materials(id, shape, size, wall_thickness, grade, current_cost_per_foot)")
        .eq("product_template_id", templateId)
        .order("sort_order"),
      supabase
        .from("product_template_parts")
        .select("*, purchased_parts(id, name, part_number, current_cost_each)")
        .eq("product_template_id", templateId)
        .order("sort_order"),
      supabase
        .from("product_template_sub_assemblies")
        .select("*, product_templates!product_template_sub_assemblies_child_template_id_fkey(id, name, product_number)")
        .eq("parent_template_id", templateId)
        .order("sort_order"),
      supabase
        .from("raw_materials")
        .select("id, shape, size, wall_thickness, grade, current_cost_per_foot")
        .eq("is_active", true)
        .order("shape")
        .order("size"),
      supabase
        .from("purchased_parts")
        .select("id, name, part_number, current_cost_each")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("product_templates")
        .select("id, name, product_number")
        .eq("is_active", true)
        .neq("id", templateId)
        .order("name"),
    ]);

    const subRows = (subsRes.data || []) as unknown as SubRow[];

    // For each sub-assembly, calculate its per-unit cost by summing its own materials and parts
    const subTemplateIds = Array.from(new Set(subRows.map((s) => s.child_template_id)));
    const subCosts: Record<string, number> = {};

    if (subTemplateIds.length > 0) {
      const [subMatsRes, subPartsRes] = await Promise.all([
        supabase
          .from("product_template_materials")
          .select("product_template_id, feet_per_unit, raw_materials(current_cost_per_foot)")
          .in("product_template_id", subTemplateIds),
        supabase
          .from("product_template_parts")
          .select("product_template_id, quantity_per_unit, purchased_parts(current_cost_each)")
          .in("product_template_id", subTemplateIds),
      ]);

      type SubMatRow = {
        product_template_id: string;
        feet_per_unit: number;
        raw_materials: { current_cost_per_foot: number } | null;
      };
      type SubPartRow = {
        product_template_id: string;
        quantity_per_unit: number;
        purchased_parts: { current_cost_each: number } | null;
      };

      const subMats = (subMatsRes.data || []) as unknown as SubMatRow[];
      const subParts = (subPartsRes.data || []) as unknown as SubPartRow[];

      for (const id of subTemplateIds) {
        const matCost = subMats
          .filter((m) => m.product_template_id === id)
          .reduce((sum, m) => sum + Number(m.feet_per_unit) * Number(m.raw_materials?.current_cost_per_foot || 0), 0);
        const partCost = subParts
          .filter((p) => p.product_template_id === id)
          .reduce((sum, p) => sum + Number(p.quantity_per_unit) * Number(p.purchased_parts?.current_cost_each || 0), 0);
        subCosts[id] = matCost + partCost;
      }
    }

    setMaterials((matsRes.data || []) as unknown as MaterialRow[]);
    setParts((partsRes.data || []) as unknown as PartRow[]);
    setSubs(subRows);
    setSubAssemblyCosts(subCosts);
    setAllMaterials((allMatsRes.data || []) as unknown as RawMaterial[]);
    setAllParts((allPartsRes.data || []) as unknown as PurchasedPart[]);
    setAllTemplates((allTplRes.data || []) as unknown as Template[]);
    setLoading(false);
  }, [supabase, templateId]);

  useEffect(() => {
    loadCompanyId();
    loadAll();
  }, [loadCompanyId, loadAll]);

  // ---- Multi-add handlers ----

  function openAddMat() {
    setMatChecked(new Set());
    setMatSearch("");
    setError(null);
    setAddingMat(true);
  }
  function openAddPart() {
    setPartChecked(new Set());
    setPartSearch("");
    setError(null);
    setAddingPart(true);
  }
  function openAddSub() {
    setSubChecked(new Set());
    setSubSearch("");
    setError(null);
    setAddingSub(true);
  }

  function toggle(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  async function addMaterials() {
    setError(null);
    if (!companyId) return;
    if (matChecked.size === 0) {
      setError("Pick at least one material to add.");
      return;
    }
    setSavingAdd(true);
    const ids = Array.from(matChecked);
    const rows = ids.map((rmId, i) => ({
      company_id: companyId,
      product_template_id: templateId,
      raw_material_id: rmId,
      feet_per_unit: 1,
      notes: null,
      sort_order: materials.length + i,
    }));
    const { error } = await supabase.from("product_template_materials").insert(rows);
    setSavingAdd(false);
    if (error) {
      setError(error.message);
      return;
    }
    setAddingMat(false);
    loadAll();
  }

  async function addPartsBatch() {
    setError(null);
    if (!companyId) return;
    if (partChecked.size === 0) {
      setError("Pick at least one part to add.");
      return;
    }
    setSavingAdd(true);
    const ids = Array.from(partChecked);
    const rows = ids.map((ppId, i) => ({
      company_id: companyId,
      product_template_id: templateId,
      purchased_part_id: ppId,
      quantity_per_unit: 1,
      notes: null,
      sort_order: parts.length + i,
    }));
    const { error } = await supabase.from("product_template_parts").insert(rows);
    setSavingAdd(false);
    if (error) {
      setError(error.message);
      return;
    }
    setAddingPart(false);
    loadAll();
  }

  async function addSubsBatch() {
    setError(null);
    if (!companyId) return;
    if (subChecked.size === 0) {
      setError("Pick at least one sub-assembly to add.");
      return;
    }
    setSavingAdd(true);
    const ids = Array.from(subChecked);
    const rows = ids.map((childId, i) => ({
      company_id: companyId,
      parent_template_id: templateId,
      child_template_id: childId,
      quantity_per_unit: 1,
      notes: null,
      sort_order: subs.length + i,
    }));
    const { error } = await supabase.from("product_template_sub_assemblies").insert(rows);
    setSavingAdd(false);
    if (error) {
      setError(error.message);
      return;
    }
    setAddingSub(false);
    loadAll();
  }

  // ---- Inline edit (qty + notes) ----

  function startEdit(rowId: string, qty: number, notes: string | null) {
    setEditingId(rowId);
    setEditQty(String(qty));
    setEditNotes(notes || "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditQty("");
    setEditNotes("");
  }

  async function saveEditMaterial(rowId: string) {
    const qty = parseFloat(editQty);
    if (isNaN(qty) || qty <= 0) {
      alert("Feet per unit must be greater than 0.");
      return;
    }
    const { error } = await supabase
      .from("product_template_materials")
      .update({ feet_per_unit: qty, notes: editNotes.trim() || null })
      .eq("id", rowId);
    if (error) {
      alert("Failed to save: " + error.message);
      return;
    }
    cancelEdit();
    loadAll();
  }

  async function saveEditPart(rowId: string) {
    const qty = parseFloat(editQty);
    if (isNaN(qty) || qty <= 0) {
      alert("Quantity per unit must be greater than 0.");
      return;
    }
    const { error } = await supabase
      .from("product_template_parts")
      .update({ quantity_per_unit: qty, notes: editNotes.trim() || null })
      .eq("id", rowId);
    if (error) {
      alert("Failed to save: " + error.message);
      return;
    }
    cancelEdit();
    loadAll();
  }

  async function saveEditSub(rowId: string) {
    const qty = parseFloat(editQty);
    if (isNaN(qty) || qty <= 0) {
      alert("Quantity per unit must be greater than 0.");
      return;
    }
    const { error } = await supabase
      .from("product_template_sub_assemblies")
      .update({ quantity_per_unit: qty, notes: editNotes.trim() || null })
      .eq("id", rowId);
    if (error) {
      alert("Failed to save: " + error.message);
      return;
    }
    cancelEdit();
    loadAll();
  }

  async function deleteMaterial(rowId: string) {
    if (!confirm("Remove this material from the BOM?")) return;
    await supabase.from("product_template_materials").delete().eq("id", rowId);
    loadAll();
  }

  async function deletePart(rowId: string) {
    if (!confirm("Remove this part from the BOM?")) return;
    await supabase.from("product_template_parts").delete().eq("id", rowId);
    loadAll();
  }

  async function deleteSub(rowId: string) {
    if (!confirm("Remove this sub-assembly from the BOM?")) return;
    await supabase.from("product_template_sub_assemblies").delete().eq("id", rowId);
    loadAll();
  }

  const materialCost = materials.reduce(
    (sum, m) => sum + Number(m.feet_per_unit) * Number(m.raw_materials?.current_cost_per_foot || 0),
    0
  );
  const partCost = parts.reduce(
    (sum, p) => sum + Number(p.quantity_per_unit) * Number(p.purchased_parts?.current_cost_each || 0),
    0
  );
  const subAssemblyCost = subs.reduce(
    (sum, s) => sum + Number(s.quantity_per_unit) * (subAssemblyCosts[s.child_template_id] || 0),
    0
  );

  // Items not already in the BOM (so you can't double-add)
  const usedMaterialIds = new Set(materials.map((m) => m.raw_material_id));
  const usedPartIds = new Set(parts.map((p) => p.purchased_part_id));
  const usedSubIds = new Set(subs.map((s) => s.child_template_id));

  const availableMaterials = allMaterials
    .filter((m) => !usedMaterialIds.has(m.id))
    .filter((m) => !matSearch || describeMaterial(m).toLowerCase().includes(matSearch.toLowerCase()));
  const availableParts = allParts
    .filter((p) => !usedPartIds.has(p.id))
    .filter((p) => !partSearch || (p.name + " " + (p.part_number || "")).toLowerCase().includes(partSearch.toLowerCase()));
  const availableTemplates = allTemplates
    .filter((t) => !usedSubIds.has(t.id))
    .filter((t) => !subSearch || (t.name + " " + (t.product_number || "")).toLowerCase().includes(subSearch.toLowerCase()));

  if (loading) {
    return <p className="text-gray-600">Loading...</p>;
  }

  return (
    <div className="space-y-8">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Material cost</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${materialCost.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Parts cost</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${partCost.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Sub-assemblies</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${subAssemblyCost.toFixed(2)}</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-blue-700 font-medium">Total cost per unit</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${(materialCost + partCost + subAssemblyCost).toFixed(2)}</div>
          <div className="text-xs text-gray-500 mt-1">Labor not included</div>
        </div>
      </div>

      {/* ---------------- Raw Materials ---------------- */}
      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Raw Materials</h3>
          {!addingMat && (
            <button onClick={openAddMat} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Add</button>
          )}
        </div>

        {materials.length > 0 ? (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Material</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Feet / unit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / ft</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / unit</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => {
                const cf = Number(m.raw_materials?.current_cost_per_foot || 0);
                const unitCost = Number(m.feet_per_unit) * cf;
                const isEditing = editingId === m.id;
                return (
                  <tr key={m.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900">{describeMaterial(m.raw_materials)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">
                      {isEditing ? (
                        <input type="number" step="0.01" min="0" value={editQty} onChange={(e) => setEditQty(e.target.value)} className="w-24 px-2 py-1 border border-gray-300 rounded text-right text-gray-900" />
                      ) : (
                        Number(m.feet_per_unit).toFixed(2)
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${cf.toFixed(4)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {isEditing ? (
                        <input type="text" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className="w-full px-2 py-1 border border-gray-300 rounded text-gray-900" />
                      ) : (
                        m.notes || "-"
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      {isEditing ? (
                        <>
                          <button onClick={() => saveEditMaterial(m.id)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Save</button>
                          <button onClick={cancelEdit} className="text-gray-600 hover:text-gray-900 font-medium">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(m.id, Number(m.feet_per_unit), m.notes)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Edit</button>
                          <button onClick={() => deleteMaterial(m.id)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          !addingMat && <p className="px-4 py-6 text-sm text-gray-600">No raw materials added yet.</p>
        )}

        {addingMat && (
          <div className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-gray-900">Select materials to add (each starts at 1 ft/unit — edit after)</h4>
              <span className="text-xs text-gray-500">{matChecked.size} selected</span>
            </div>
            <input
              type="text"
              placeholder="Search materials..."
              value={matSearch}
              onChange={(e) => setMatSearch(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100">
              {availableMaterials.length === 0 ? (
                <p className="px-3 py-3 text-sm text-gray-500">No matching materials available.</p>
              ) : (
                availableMaterials.map((m) => (
                  <label key={m.id} className="flex items-center gap-3 px-3 py-2 hover:bg-blue-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={matChecked.has(m.id)}
                      onChange={() => toggle(matChecked, m.id, setMatChecked)}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-900">{describeMaterial(m)}</span>
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddingMat(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
              <button type="button" onClick={addMaterials} disabled={savingAdd || matChecked.size === 0} className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium disabled:opacity-50">
                {savingAdd ? "Adding..." : "Add selected (" + matChecked.size + ")"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ---------------- Purchased Parts ---------------- */}
      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Purchased Parts</h3>
          {!addingPart && (
            <button onClick={openAddPart} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Add</button>
          )}
        </div>

        {parts.length > 0 ? (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Part</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty / unit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ each</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / unit</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => {
                const ce = Number(p.purchased_parts?.current_cost_each || 0);
                const unitCost = Number(p.quantity_per_unit) * ce;
                const isEditing = editingId === p.id;
                return (
                  <tr key={p.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900">{p.purchased_parts?.name || "Unknown"}{p.purchased_parts?.part_number ? " (" + p.purchased_parts.part_number + ")" : ""}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">
                      {isEditing ? (
                        <input type="number" step="0.01" min="0" value={editQty} onChange={(e) => setEditQty(e.target.value)} className="w-24 px-2 py-1 border border-gray-300 rounded text-right text-gray-900" />
                      ) : (
                        Number(p.quantity_per_unit).toFixed(2)
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${ce.toFixed(4)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {isEditing ? (
                        <input type="text" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className="w-full px-2 py-1 border border-gray-300 rounded text-gray-900" />
                      ) : (
                        p.notes || "-"
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      {isEditing ? (
                        <>
                          <button onClick={() => saveEditPart(p.id)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Save</button>
                          <button onClick={cancelEdit} className="text-gray-600 hover:text-gray-900 font-medium">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(p.id, Number(p.quantity_per_unit), p.notes)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Edit</button>
                          <button onClick={() => deletePart(p.id)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          !addingPart && <p className="px-4 py-6 text-sm text-gray-600">No purchased parts added yet.</p>
        )}

        {addingPart && (
          <div className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-gray-900">Select parts to add (each starts at 1/unit — edit after)</h4>
              <span className="text-xs text-gray-500">{partChecked.size} selected</span>
            </div>
            <input
              type="text"
              placeholder="Search parts..."
              value={partSearch}
              onChange={(e) => setPartSearch(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100">
              {availableParts.length === 0 ? (
                <p className="px-3 py-3 text-sm text-gray-500">No matching parts available.</p>
              ) : (
                availableParts.map((p) => (
                  <label key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-blue-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={partChecked.has(p.id)}
                      onChange={() => toggle(partChecked, p.id, setPartChecked)}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-900">{p.name}{p.part_number ? " (" + p.part_number + ")" : ""}</span>
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddingPart(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
              <button type="button" onClick={addPartsBatch} disabled={savingAdd || partChecked.size === 0} className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium disabled:opacity-50">
                {savingAdd ? "Adding..." : "Add selected (" + partChecked.size + ")"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ---------------- Sub-Assemblies ---------------- */}
      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Sub-Assemblies</h3>
          {!addingSub && (
            <button onClick={openAddSub} className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Add</button>
          )}
        </div>

        {subs.length > 0 ? (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Sub-assembly</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty / unit</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / sub</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$ / unit</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Notes</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => {
                const costPerSub = subAssemblyCosts[s.child_template_id] || 0;
                const unitCost = Number(s.quantity_per_unit) * costPerSub;
                const isEditing = editingId === s.id;
                return (
                  <tr key={s.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900">{s.product_templates?.name || "Unknown"}{s.product_templates?.product_number ? " (" + s.product_templates.product_number + ")" : ""}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">
                      {isEditing ? (
                        <input type="number" step="0.01" min="0" value={editQty} onChange={(e) => setEditQty(e.target.value)} className="w-24 px-2 py-1 border border-gray-300 rounded text-right text-gray-900" />
                      ) : (
                        Number(s.quantity_per_unit).toFixed(2)
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">${costPerSub.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">
                      {isEditing ? (
                        <input type="text" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className="w-full px-2 py-1 border border-gray-300 rounded text-gray-900" />
                      ) : (
                        s.notes || "-"
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      {isEditing ? (
                        <>
                          <button onClick={() => saveEditSub(s.id)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Save</button>
                          <button onClick={cancelEdit} className="text-gray-600 hover:text-gray-900 font-medium">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(s.id, Number(s.quantity_per_unit), s.notes)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Edit</button>
                          <button onClick={() => deleteSub(s.id)} className="text-red-600 hover:text-red-800 font-medium">Remove</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          !addingSub && <p className="px-4 py-6 text-sm text-gray-600">No sub-assemblies added yet.</p>
        )}

        {addingSub && (
          <div className="p-4 bg-gray-50 border-t border-gray-200 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-gray-900">Select sub-assemblies to add (each starts at 1/unit — edit after)</h4>
              <span className="text-xs text-gray-500">{subChecked.size} selected</span>
            </div>
            <input
              type="text"
              placeholder="Search templates..."
              value={subSearch}
              onChange={(e) => setSubSearch(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100">
              {availableTemplates.length === 0 ? (
                <p className="px-3 py-3 text-sm text-gray-500">No matching templates available.</p>
              ) : (
                availableTemplates.map((t) => (
                  <label key={t.id} className="flex items-center gap-3 px-3 py-2 hover:bg-blue-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={subChecked.has(t.id)}
                      onChange={() => toggle(subChecked, t.id, setSubChecked)}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-900">{t.name}{t.product_number ? " (" + t.product_number + ")" : ""}</span>
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddingSub(false)} className="px-3 py-1.5 text-gray-700 hover:bg-gray-100 rounded-md text-sm font-medium">Cancel</button>
              <button type="button" onClick={addSubsBatch} disabled={savingAdd || subChecked.size === 0} className="px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-md text-sm font-medium disabled:opacity-50">
                {savingAdd ? "Adding..." : "Add selected (" + subChecked.size + ")"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
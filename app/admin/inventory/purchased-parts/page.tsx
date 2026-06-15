"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "../../../lib/supabase";

const CATEGORIES = [
  { value: "laser_part", label: "Laser Part" },
  { value: "fastener", label: "Fastener" },
  { value: "caster", label: "Caster" },
  { value: "machined_part", label: "Machined Part" },
  { value: "electrical", label: "Electrical" },
  { value: "hardware", label: "Hardware" },
  { value: "other", label: "Other" },
] as const;

type Category = (typeof CATEGORIES)[number]["value"];

type PurchasedPart = {
  id: string;
  name: string;
  part_number: string | null;
  category: Category;
  is_active: boolean;
};

type Supplier = {
  id: string;
  name: string;
};

type InventoryBatch = {
  id: string;
  purchased_part_id: string;
  supplier_id: string | null;
  quantity: number;
  cost_each: number;
  purchase_date: string | null;
  notes: string | null;
  purchased_parts: PurchasedPart | null;
  suppliers: Supplier | null;
};

type Form = {
  purchased_part_id: string;
  supplier_id: string;
  quantity: string;
  cost_each: string;
  purchase_date: string;
  notes: string;
};

const emptyForm: Form = {
  purchased_part_id: "",
  supplier_id: "",
  quantity: "",
  cost_each: "",
  purchase_date: "",
  notes: "",
};

function categoryLabel(category: Category) {
  return CATEGORIES.find((c) => c.value === category)?.label || category;
}

function describePart(p: PurchasedPart | null) {
  if (!p) return "Unknown part";
  const pn = p.part_number ? " (" + p.part_number + ")" : "";
  return p.name + pn;
}

export default function PurchasedPartsInventoryPage() {
  const supabase = createClient();
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [parts, setParts] = useState<PurchasedPart[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);

  async function loadCompanyId() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("profiles")
      .select("company_id")
      .eq("id", user.id)
      .single();
    if (data) setCompanyId(data.company_id);
  }

  async function loadAll() {
    setLoading(true);
    const [batchesRes, partsRes, supsRes] = await Promise.all([
      supabase
        .from("purchased_parts_inventory")
        .select("*, purchased_parts(id, name, part_number, category, is_active), suppliers(id, name)")
        .order("purchase_date", { ascending: false }),
      supabase.from("purchased_parts").select("id, name, part_number, category, is_active").eq("is_active", true).order("name"),
      supabase.from("suppliers").select("id, name").order("name"),
    ]);

    if (batchesRes.error) setError(batchesRes.error.message);
    else setBatches((batchesRes.data || []) as InventoryBatch[]);

    if (partsRes.data) setParts(partsRes.data as PurchasedPart[]);
    if (supsRes.data) setSuppliers(supsRes.data as Supplier[]);

    setLoading(false);
  }

  useEffect(() => {
    loadCompanyId();
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    if (!search) return batches;
    const s = search.toLowerCase();
    return batches.filter((b) => {
      const text = (describePart(b.purchased_parts) + " " + (b.suppliers?.name || "")).toLowerCase();
      return text.includes(s);
    });
  }, [batches, search]);

  function openNew() {
    setForm({ ...emptyForm, purchase_date: new Date().toISOString().slice(0, 10) });
    setEditingId(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(b: InventoryBatch) {
    setForm({
      purchased_part_id: b.purchased_part_id,
      supplier_id: b.supplier_id || "",
      quantity: String(b.quantity),
      cost_each: String(b.cost_each),
      purchase_date: b.purchase_date || "",
      notes: b.notes || "",
    });
    setEditingId(b.id);
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    if (!form.purchased_part_id) {
      setError("Please select a part.");
      setSaving(false);
      return;
    }
    const qty = parseFloat(form.quantity);
    const cost = parseFloat(form.cost_each);

    if (isNaN(qty) || qty < 0) {
      setError("Quantity must be 0 or more.");
      setSaving(false);
      return;
    }
    if (isNaN(cost) || cost < 0) {
      setError("Cost each must be a valid number.");
      setSaving(false);
      return;
    }

    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      setSaving(false);
      return;
    }

    const payload = {
      purchased_part_id: form.purchased_part_id,
      supplier_id: form.supplier_id || null,
      quantity: qty,
      cost_each: cost,
      purchase_date: form.purchase_date || null,
      notes: form.notes.trim() || null,
    };

    const { error } = editingId
      ? await supabase.from("purchased_parts_inventory").update(payload).eq("id", editingId)
      : await supabase.from("purchased_parts_inventory").insert({ ...payload, company_id: companyId });

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    loadAll();
  }

  async function handleDelete(b: InventoryBatch) {
    const ok = confirm("Delete this inventory batch? This cannot be undone.");
    if (!ok) return;
    const { error } = await supabase.from("purchased_parts_inventory").delete().eq("id", b.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadAll();
  }

  const totalQuantity = filtered.reduce((sum, b) => sum + Number(b.quantity), 0);
  const totalValue = filtered.reduce((sum, b) => sum + Number(b.quantity) * Number(b.cost_each), 0);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Parts Inventory</h1>
          <p className="text-gray-600 mt-1">Track quantities on hand, purchase batches, and supplier history per part.</p>
        </div>
        <button
          onClick={openNew}
          disabled={parts.length === 0}
          className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={parts.length === 0 ? "Add a purchased part first" : ""}
        >
          Add inventory batch
        </button>
      </div>

      {parts.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-4">
          <p className="text-sm text-amber-800">You need to add at least one purchased part before you can record inventory. Go to the Purchased Parts page to add some.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Total quantity on hand</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{totalQuantity.toFixed(0)}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Inventory value</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">${totalValue.toFixed(2)}</div>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search by part name, part number, or supplier..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
      />

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">
            {batches.length === 0 ? "No inventory batches yet. Click Add inventory batch to record your first purchase." : "No batches match your search."}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Part</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Category</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Supplier</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Qty</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">$/each paid</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Batch value</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Purchased</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b) => {
                const value = Number(b.quantity) * Number(b.cost_each);
                return (
                  <tr key={b.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm text-gray-900 font-medium">{describePart(b.purchased_parts)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{b.purchased_parts ? categoryLabel(b.purchased_parts.category) : "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{b.suppliers?.name || "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{Number(b.quantity).toFixed(0)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${Number(b.cost_each).toFixed(4)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">${value.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{b.purchase_date || "-"}</td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      <button onClick={() => openEdit(b)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">
                        Edit
                      </button>
                      <button onClick={() => handleDelete(b)} className="text-red-600 hover:text-red-800 font-medium">
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSave} className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">{editingId ? "Edit inventory batch" : "Add inventory batch"}</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Part <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={form.purchased_part_id}
                    onChange={(e) => setForm({ ...form, purchased_part_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">-- Select a part --</option>
                    {parts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {describePart(p)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
                  <select
                    value={form.supplier_id}
                    onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- None / Unknown --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Quantity <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      required
                      placeholder="e.g. 100"
                      value={form.quantity}
                      onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Cost each (paid) <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      required
                      placeholder="0.00"
                      value={form.cost_each}
                      onChange={(e) => setForm({ ...form, cost_each: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Purchase date</label>
                  <input
                    type="date"
                    value={form.purchase_date}
                    onChange={(e) => setForm({ ...form, purchase_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <button type="button" onClick={closeForm} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
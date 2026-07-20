"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../../lib/supabase";

type Customer = { id: string; name: string };

type RecipeHeader = {
  id: string;
  job_number: string;
  line_item_name: string | null;
  customer_name: string | null;
  customer_po: string | null;
  quantity: number;
  unit_price: number | null;
  job_notes: string | null;
};

type RecipeItem = {
  item_type: "raw_material" | "purchased_part";
  raw_material_id: string | null;
  purchased_part_id: string | null;
  description: string;
  part_number: string | null;
  planned_quantity: number;
  unit: string;
  notes: string | null;
  sort_order: number;
};

type RecipeTask = {
  name: string;
  description: string | null;
  minutes_per_unit: number;
  sort_order: number;
};

export default function ReproduceModal({
  recipe,
  onClose,
}: {
  recipe: RecipeHeader;
  onClose: () => void;
}) {
  const supabase = createClient();
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<RecipeItem[]>([]);
  const [tasks, setTasks] = useState<RecipeTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form
  const [customerId, setCustomerId] = useState("");
  const [jobNumber, setJobNumber] = useState(recipe.job_number);
  const [buildName, setBuildName] = useState(recipe.line_item_name || recipe.job_number);
  const [quantity, setQuantity] = useState(String(recipe.quantity || 1));
  const [unitPrice, setUnitPrice] = useState(recipe.unit_price != null ? String(recipe.unit_price) : "");
  const [customerPo, setCustomerPo] = useState("");
  const [dueDate, setDueDate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
      if (profile) setCompanyId(profile.company_id);
    }

    const [custRes, itemRes, taskRes] = await Promise.all([
      supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
      supabase
        .from("archived_job_recipe_items")
        .select("item_type, raw_material_id, purchased_part_id, description, part_number, planned_quantity, unit, notes, sort_order")
        .eq("recipe_id", recipe.id)
        .order("sort_order"),
      supabase
        .from("archived_job_recipe_tasks")
        .select("name, description, minutes_per_unit, sort_order")
        .eq("recipe_id", recipe.id)
        .order("sort_order"),
    ]);

    const custs = (custRes.data || []) as unknown as Customer[];
    setCustomers(custs);
    setItems((itemRes.data || []) as unknown as RecipeItem[]);
    setTasks((taskRes.data || []) as unknown as RecipeTask[]);

    // Pre-select the customer if the saved name still matches one on file
    if (recipe.customer_name) {
      const match = custs.find((c) => c.name.toLowerCase() === recipe.customer_name!.toLowerCase());
      if (match) setCustomerId(match.id);
    }

    setLoading(false);
  }, [supabase, recipe.id, recipe.customer_name]);

  useEffect(() => {
    load();
  }, [load]);

  // How many recipe items can't be auto-added because the catalog item was since deleted
  const missingItems = items.filter((i) => !i.raw_material_id && !i.purchased_part_id);

  async function handleCreate() {
    setError(null);
    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      return;
    }
    if (!customerId) {
      setError("Pick a customer for the new job.");
      return;
    }
    if (!buildName.trim()) {
      setError("Describe what you're building.");
      return;
    }
    if (!jobNumber.trim()) {
      setError("Job number is required.");
      return;
    }
    const newQty = parseInt(quantity, 10);
    if (isNaN(newQty) || newQty < 1) {
      setError("Quantity must be at least 1.");
      return;
    }
    let unitPriceValue: number | null = null;
    if (unitPrice.trim()) {
      const up = parseFloat(unitPrice);
      if (isNaN(up) || up < 0) {
        setError("Price per unit must be 0 or more.");
        return;
      }
      unitPriceValue = up;
    }

    // Ratio rescales the saved (planned) quantities to the new job quantity.
    const recipeQty = Number(recipe.quantity) || 1;
    const ratio = newQty / recipeQty;

    setSaving(true);
    try {
      // New jobs land at the bottom of the customer's board group.
      const { data: existingJobs } = await supabase
        .from("jobs")
        .select("board_order")
        .eq("company_id", companyId)
        .eq("customer_id", customerId)
        .in("status", ["ordered", "ready", "in_progress"]);
      const maxBoardOrder = (existingJobs || []).reduce(
        (max, j) => Math.max(max, Number((j as { board_order: number | null }).board_order ?? 0)),
        -1
      );

      // 1) Job
      const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .insert({
          company_id: companyId,
          customer_id: customerId,
          job_number: jobNumber.trim(),
          customer_po: customerPo.trim() || null,
          status: "ordered",
          due_date: dueDate || null,
          notes: recipe.job_notes || null,
          board_order: maxBoardOrder + 1,
        })
        .select()
        .single();
      if (jobErr || !job) throw new Error(jobErr?.message || "Failed to create job.");

      // 2) Custom line item (no template)
      const { data: liRows, error: liErr } = await supabase
        .from("job_line_items")
        .insert({
          company_id: companyId,
          job_id: job.id,
          product_template_id: null,
          quantity: newQty,
          notes: null,
          sort_order: 0,
          name: buildName.trim(),
          unit_price: unitPriceValue,
        })
        .select();
      if (liErr || !liRows || liRows.length === 0) throw new Error(liErr?.message || "Failed to create line item.");
      const lineItemId = liRows[0].id as string;

      // 3) Pick list — only items that still point at a live catalog item.
      const pickRows = items
        .filter((i) => i.raw_material_id || i.purchased_part_id)
        .map((i) => {
          const scaledQty = Math.round(Number(i.planned_quantity) * ratio * 10000) / 10000;
          return {
            company_id: companyId,
            job_id: job.id,
            item_type: i.item_type,
            raw_material_id: i.item_type === "raw_material" ? i.raw_material_id : null,
            purchased_part_id: i.item_type === "purchased_part" ? i.purchased_part_id : null,
            planned_quantity: scaledQty,
            // Parts default to "all used"; material actuals come from the cutting nest.
            actual_quantity: i.item_type === "purchased_part" ? scaledQty : 0,
            unit: i.unit || (i.item_type === "raw_material" ? "ft" : "ea"),
            notes: i.notes,
          };
        });
      if (pickRows.length > 0) {
        const { error: pickErr } = await supabase.from("job_pick_list_items").insert(pickRows);
        if (pickErr) throw new Error("Job created, but pick list failed: " + pickErr.message);
      }

      // 4) Tasks — rescaled to the new quantity via saved minutes-per-unit.
      const taskRows = tasks.map((t, idx) => ({
        company_id: companyId,
        job_id: job.id,
        job_line_item_id: lineItemId,
        source_task_id: null,
        name: t.name,
        description: t.description,
        batch_quantity: newQty,
        estimated_minutes_total: Math.round(Number(t.minutes_per_unit) * newQty * 100) / 100,
        status: "not_started",
        sort_order: t.sort_order ?? idx,
      }));
      if (taskRows.length > 0) {
        const { error: taskErr } = await supabase.from("job_tasks").insert(taskRows);
        if (taskErr) throw new Error("Job created, but tasks failed: " + taskErr.message);
      }

      router.push("/admin/jobs/" + job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reproduce the job.");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Reproduce custom job</h2>
        <p className="text-sm text-gray-600 mb-4">
          Rebuilds <span className="font-medium">{recipe.job_number}</span> as a new custom job. The saved materials,
          parts, and tasks are copied in and rescaled to the quantity you choose.
        </p>

        {loading ? (
          <p className="text-gray-600">Loading recipe...</p>
        ) : (
          <>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer <span className="text-red-600">*</span></label>
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">-- Select customer --</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {recipe.customer_name && !customerId && (
                  <p className="text-xs text-amber-700 mt-1">Originally for &quot;{recipe.customer_name}&quot; — pick the matching customer.</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">What are you building? <span className="text-red-600">*</span></label>
                <input
                  type="text"
                  value={buildName}
                  onChange={(e) => setBuildName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Quantity <span className="text-red-600">*</span></label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Originally built {recipe.quantity}. Pick list and task times rescale to match.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Job number <span className="text-red-600">*</span></label>
                  <input
                    type="text"
                    value={jobNumber}
                    onChange={(e) => setJobNumber(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price per unit</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={unitPrice}
                    onChange={(e) => setUnitPrice(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer PO</label>
                  <input
                    type="text"
                    value={customerPo}
                    onChange={(e) => setCustomerPo(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Due date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Recipe preview */}
            <div className="mt-5 border-t border-gray-200 pt-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Materials &amp; parts ({items.length})</h3>
                {items.length === 0 ? (
                  <p className="text-sm text-gray-500 mt-1">None saved.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {items.map((i, idx) => (
                      <li key={idx} className="text-sm text-gray-700 flex justify-between gap-3">
                        <span>
                          {i.description}{i.part_number ? " (" + i.part_number + ")" : ""}
                          {!i.raw_material_id && !i.purchased_part_id && (
                            <span className="text-amber-600"> — no longer in catalog</span>
                          )}
                        </span>
                        <span className="font-mono text-gray-500 whitespace-nowrap">{Number(i.planned_quantity).toFixed(2)} {i.unit}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Tasks ({tasks.length})</h3>
                {tasks.length === 0 ? (
                  <p className="text-sm text-gray-500 mt-1">None saved.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {tasks.map((t, idx) => (
                      <li key={idx} className="text-sm text-gray-700 flex justify-between gap-3">
                        <span>{t.name}</span>
                        <span className="font-mono text-gray-500 whitespace-nowrap">{Number(t.minutes_per_unit).toFixed(2)} min/unit</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {missingItems.length > 0 && (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  {missingItems.length} item{missingItems.length === 1 ? "" : "s"} can&apos;t be added automatically because the catalog
                  item was deleted since this job ran. The new job will be created without {missingItems.length === 1 ? "it" : "them"} —
                  add a replacement on the Pick List tab.
                </p>
              )}
            </div>

            {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mt-4">{error}</div>}

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={onClose}
                disabled={saving}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={saving}
                className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? "Creating job..." : "Create new job"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

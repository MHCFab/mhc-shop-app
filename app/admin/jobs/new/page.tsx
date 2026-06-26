"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../../lib/supabase";

type Customer = { id: string; name: string };
type Template = { id: string; name: string; product_number: string | null; customer_id: string | null };

const SHAPES_MAP: Record<string, string> = {
  round_tube: "Round Tube",
  square_tube: "Square Tube",
  rectangle_tube: "Rectangle Tube",
  channel: "Channel",
  i_beam: "I-Beam",
  angle: "Angle",
  flat_bar: "Flat Bar",
};

export default function NewJobPage() {
  const supabase = createClient();
  const router = useRouter();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [stockableTemplates, setStockableTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [jobNumberEdited, setJobNumberEdited] = useState(false);

  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [showProductList, setShowProductList] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [jobNumber, setJobNumber] = useState("");
  const [customerPo, setCustomerPo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");

  // Custom one-off job
  const [isCustom, setIsCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [unitPrice, setUnitPrice] = useState("");

  // Build order (build a stockable item to stock)
  const [isBuild, setIsBuild] = useState(false);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [custsRes, tplsRes, stockRes] = await Promise.all([
      supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
      supabase
        .from("product_templates")
        .select("id, name, product_number, customer_id")
        .eq("is_active", true)
        .eq("is_sub_assembly", false)
        .order("name"),
      supabase
        .from("product_templates")
        .select("id, name, product_number, customer_id")
        .eq("is_active", true)
        .eq("is_stockable", true)
        .order("name"),
    ]);
    if (custsRes.data) setCustomers(custsRes.data as Customer[]);
    if (tplsRes.data) setTemplates(tplsRes.data as Template[]);
    if (stockRes.data) setStockableTemplates(stockRes.data as Template[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadCompanyId();
    loadData();
  }, [loadCompanyId, loadData]);

  // Products available for the chosen customer
  const customerProducts = templates.filter((t) => t.customer_id === customerId);

  // The source list for the product picker depends on the mode.
  const pickerSource = isBuild ? stockableTemplates : customerProducts;

  // Filtered by the type-ahead search
  const filteredProducts = pickerSource.filter((t) => {
    if (!productSearch) return true;
    const s = productSearch.toLowerCase();
    return (t.name + " " + (t.product_number || "")).toLowerCase().includes(s);
  });

  // selectedProduct may come from either list (build mode uses stockable templates)
  const selectedProduct = [...templates, ...stockableTemplates].find((t) => t.id === productId);

  function pickProduct(t: Template) {
    setProductId(t.id);
    setProductSearch(t.name);
    setShowProductList(false);
    if (!jobNumberEdited) {
      setJobNumber(isBuild ? "Build: " + t.name : t.name);
    }
  }

  function onCustomerChange(newCustomerId: string) {
    setCustomerId(newCustomerId);
    // Reset product selection when customer changes (build mode ignores customer for products)
    if (!isBuild) {
      setProductId("");
      setProductSearch("");
      setShowProductList(false);
    }
  }

  function toggleCustom(checked: boolean) {
    setIsCustom(checked);
    // Clear product selection; custom and build are mutually exclusive
    setProductId("");
    setProductSearch("");
    setShowProductList(false);
    if (checked) {
      setIsBuild(false);
    } else {
      setCustomName("");
      setUnitPrice("");
    }
  }

  function toggleBuild(checked: boolean) {
    setIsBuild(checked);
    // Clear product selection; build and custom are mutually exclusive
    setProductId("");
    setProductSearch("");
    setShowProductList(false);
    if (checked) {
      setIsCustom(false);
      setCustomName("");
      setUnitPrice("");
      // Default the customer to your internal "MHC" customer so builds group together.
      const mhc = customers.find((c) => c.name.trim().toLowerCase() === "mhc");
      if (mhc) setCustomerId(mhc.id);
    }
  }

  function describeMaterial(m: {
    shape: string;
    size: string;
    wall_thickness: string | null;
    grade: string;
  }) {
    const wall = m.wall_thickness ? " x " + m.wall_thickness : "";
    return (SHAPES_MAP[m.shape] || m.shape) + " " + m.size + wall + " (" + m.grade + ")";
  }

  async function generatePickListAndTasks(jobId: string, items: { lineItemId: string; templateId: string; quantity: number }[]) {
    if (!companyId) return;

    const allTemplateIds = new Set<string>();
    const queue = [...new Set(items.map((i) => i.templateId))];
    while (queue.length > 0) {
      const tid = queue.shift()!;
      if (allTemplateIds.has(tid)) continue;
      allTemplateIds.add(tid);
      const { data } = await supabase
        .from("product_template_sub_assemblies")
        .select("child_template_id")
        .eq("parent_template_id", tid);
      if (data) {
        for (const row of data) {
          if (!allTemplateIds.has(row.child_template_id)) queue.push(row.child_template_id);
        }
      }
    }

    const templateIdArr = Array.from(allTemplateIds);

    const [matsRes, partsRes, subLinksRes, tasksRes, templatesData] = await Promise.all([
      supabase
        .from("product_template_materials")
        .select("product_template_id, feet_per_unit, raw_materials(id, shape, size, wall_thickness, grade)")
        .in("product_template_id", templateIdArr),
      supabase
        .from("product_template_parts")
        .select("product_template_id, quantity_per_unit, purchased_parts(id, name, part_number)")
        .in("product_template_id", templateIdArr),
      supabase
        .from("product_template_sub_assemblies")
        .select("parent_template_id, child_template_id, quantity_per_unit")
        .in("parent_template_id", templateIdArr),
      supabase
        .from("product_template_tasks")
        .select("*")
        .in("product_template_id", templateIdArr)
        .order("sort_order"),
      supabase
        .from("product_templates")
        .select("id, name")
        .in("id", templateIdArr),
    ]);

    type TplMatRow = {
      product_template_id: string;
      feet_per_unit: number;
      raw_materials: { id: string; shape: string; size: string; wall_thickness: string | null; grade: string } | null;
    };
    type TplPartRow = {
      product_template_id: string;
      quantity_per_unit: number;
      purchased_parts: { id: string; name: string; part_number: string | null } | null;
    };
    type TplSubRow = { parent_template_id: string; child_template_id: string; quantity_per_unit: number };
    type TplTaskRow = {
      id: string;
      product_template_id: string;
      name: string;
      description: string | null;
      estimated_minutes_per_unit: number;
      sort_order: number;
    };

    const tplMaterials = (matsRes.data || []) as unknown as TplMatRow[];
    const tplParts = (partsRes.data || []) as unknown as TplPartRow[];
    const tplSubs = (subLinksRes.data || []) as unknown as TplSubRow[];
    const tplTasks = (tasksRes.data || []) as unknown as TplTaskRow[];
    const templateNames = new Map<string, string>(
      (templatesData.data || []).map((t: { id: string; name: string }) => [t.id, t.name])
    );

    const templateQtyTotals = new Map<string, number>();
    function expandTemplate(templateId: string, multiplier: number) {
      templateQtyTotals.set(templateId, (templateQtyTotals.get(templateId) || 0) + multiplier);
      const childLinks = tplSubs.filter((s) => s.parent_template_id === templateId);
      for (const link of childLinks) {
        expandTemplate(link.child_template_id, multiplier * Number(link.quantity_per_unit));
      }
    }
    for (const item of items) {
      expandTemplate(item.templateId, item.quantity);
    }

    const matMap = new Map<string, { quantity: number; description: string }>();
    const partMap = new Map<string, { quantity: number; name: string; partNumber: string | null }>();

    for (const [tid, totalQty] of templateQtyTotals.entries()) {
      for (const m of tplMaterials.filter((x) => x.product_template_id === tid)) {
        if (!m.raw_materials) continue;
        const key = m.raw_materials.id;
        const total = Number(m.feet_per_unit) * totalQty;
        const existing = matMap.get(key);
        if (existing) existing.quantity += total;
        else matMap.set(key, { quantity: total, description: describeMaterial(m.raw_materials) });
      }
      for (const p of tplParts.filter((x) => x.product_template_id === tid)) {
        if (!p.purchased_parts) continue;
        const key = p.purchased_parts.id;
        const total = Number(p.quantity_per_unit) * totalQty;
        const existing = partMap.get(key);
        if (existing) existing.quantity += total;
        else partMap.set(key, { quantity: total, name: p.purchased_parts.name, partNumber: p.purchased_parts.part_number });
      }
    }

    const pickListRows = [
      ...Array.from(matMap.entries()).map(([rawMaterialId, info]) => ({
        company_id: companyId,
        job_id: jobId,
        item_type: "raw_material" as const,
        raw_material_id: rawMaterialId,
        purchased_part_id: null,
        planned_quantity: info.quantity,
        actual_quantity: 0,
        unit: "ft",
        notes: null,
      })),
      ...Array.from(partMap.entries()).map(([partId, info]) => ({
        company_id: companyId,
        job_id: jobId,
        item_type: "purchased_part" as const,
        purchased_part_id: partId,
        raw_material_id: null,
        planned_quantity: info.quantity,
        actual_quantity: 0,
        unit: "ea",
        notes: null,
      })),
    ];

    if (pickListRows.length > 0) {
      await supabase.from("job_pick_list_items").insert(pickListRows);
    }

    function expandForLine(templateId: string, multiplier: number, accumulator: Map<string, number>) {
      accumulator.set(templateId, (accumulator.get(templateId) || 0) + multiplier);
      const childLinks = tplSubs.filter((s) => s.parent_template_id === templateId);
      for (const link of childLinks) {
        expandForLine(link.child_template_id, multiplier * Number(link.quantity_per_unit), accumulator);
      }
    }

    const taskRows: Array<{
      company_id: string;
      job_id: string;
      job_line_item_id: string;
      source_task_id: string;
      name: string;
      description: string | null;
      batch_quantity: number;
      estimated_minutes_total: number;
      sort_order: number;
    }> = [];

    for (const item of items) {
      const perLineMap = new Map<string, number>();
      expandForLine(item.templateId, item.quantity, perLineMap);
      const orderedEntries = Array.from(perLineMap.entries()).sort((a, b) => {
        if (a[0] === item.templateId) return -1;
        if (b[0] === item.templateId) return 1;
        return 0;
      });
      let runningSortOrder = 0;
      for (const [tid, totalQty] of orderedEntries) {
        const tasksForTpl = tplTasks.filter((t) => t.product_template_id === tid).sort((a, b) => a.sort_order - b.sort_order);
        const isSubAssembly = tid !== item.templateId;
        const tplName = templateNames.get(tid) || "Sub-assembly";
        for (const t of tasksForTpl) {
          const labeledName = isSubAssembly ? t.name + " (" + tplName + ")" : t.name;
          taskRows.push({
            company_id: companyId,
            job_id: jobId,
            job_line_item_id: item.lineItemId,
            source_task_id: t.id,
            name: labeledName,
            description: t.description,
            batch_quantity: totalQty,
            estimated_minutes_total: Number(t.estimated_minutes_per_unit) * totalQty,
            sort_order: runningSortOrder++,
          });
        }
      }
    }

    if (taskRows.length > 0) {
      await supabase.from("job_tasks").insert(taskRows);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      return;
    }
    if (!customerId) {
      setError(isBuild ? "Please select the customer to file this build under (your internal MHC customer)." : "Please select a customer.");
      return;
    }
    if (isBuild) {
      if (!productId) {
        setError("Please select the stockable item to build.");
        return;
      }
    } else if (isCustom) {
      if (!customName.trim()) {
        setError("Please describe what you're building.");
        return;
      }
    } else {
      if (!productId) {
        setError("Please select a product.");
        return;
      }
    }
    if (parseInt(quantity) <= 0 || isNaN(parseInt(quantity))) {
      setError("Quantity must be at least 1.");
      return;
    }
    if (!jobNumber.trim()) {
      setError("Job number is required.");
      return;
    }

    // Validate the optional per-unit price on a custom job
    let unitPriceValue: number | null = null;
    if (isCustom && unitPrice.trim()) {
      const up = parseFloat(unitPrice);
      if (isNaN(up) || up < 0) {
        setError("Price per unit must be 0 or more.");
        return;
      }
      unitPriceValue = up;
    }

    setSaving(true);

    // Put the new job at the bottom of this customer's board:
    // find the highest board_order among the customer's open jobs and add 1.
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
    const newBoardOrder = maxBoardOrder + 1;

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .insert({
        company_id: companyId,
        customer_id: customerId,
        job_number: jobNumber.trim(),
        customer_po: customerPo.trim() || null,
        status: "ordered",
        due_date: dueDate || null,
        notes: notes.trim() || null,
        board_order: newBoardOrder,
        is_build_order: isBuild,
        build_template_id: isBuild ? productId : null,
        build_quantity: isBuild ? parseInt(quantity) : null,
      })
      .select()
      .single();

    if (jobError || !job) {
      setError(jobError?.message || "Failed to create job.");
      setSaving(false);
      return;
    }

    const { data: insertedLineItems, error: lineError } = await supabase
      .from("job_line_items")
      .insert({
        company_id: companyId,
        job_id: job.id,
        product_template_id: isCustom ? null : productId,
        quantity: parseInt(quantity),
        notes: null,
        sort_order: 0,
        name: isCustom ? customName.trim() : null,
        unit_price: isCustom ? unitPriceValue : null,
      })
      .select();

    if (lineError || !insertedLineItems || insertedLineItems.length === 0) {
      setError(lineError?.message || "Failed to create line item.");
      setSaving(false);
      return;
    }

    // Templated jobs AND build orders auto-generate their pick list and tasks.
    // Custom jobs come in blank — you build the pick list and tasks by hand.
    if (!isCustom) {
      const itemsForGeneration = [{
        lineItemId: insertedLineItems[0].id,
        templateId: productId,
        quantity: parseInt(quantity),
      }];

      try {
        await generatePickListAndTasks(job.id, itemsForGeneration);
      } catch (e) {
        console.error("Pick list/task generation failed:", e);
        setError("Job created, but failed to generate pick list or tasks. You can regenerate them from the job page.");
        router.push("/admin/jobs/" + job.id);
        return;
      }
    }

    setSaving(false);
    router.push("/admin/jobs/" + job.id);
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/admin/jobs" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; Back to jobs
      </Link>

      <h1 className="text-3xl font-bold text-gray-900 mb-6">New Job</h1>

      {customers.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-4">
          <p className="text-sm text-amber-800">You need at least one customer first. <Link href="/admin/customers" className="underline font-medium">Add a customer</Link></p>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <h2 className="text-base font-semibold text-gray-900">Job details</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Customer <span className="text-red-600">*</span>
            </label>
            <select
              value={customerId}
              onChange={(e) => onCustomerChange(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- Select customer --</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {isBuild && (
              <p className="text-xs text-gray-500 mt-1">Build orders are filed under your internal customer so they group together on the board.</p>
            )}
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isBuild}
              onChange={(e) => toggleBuild(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Build order (build a stockable fabricated item to stock)</span>
          </label>

          {!isBuild && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isCustom}
                onChange={(e) => toggleCustom(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Custom one-off job (no product template)</span>
            </label>
          )}

          {isBuild ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Item to build <span className="text-red-600">*</span>
              </label>
              {stockableTemplates.length === 0 ? (
                <p className="text-sm text-amber-700 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                  No stockable items yet. Open a sub-assembly in <Link href="/admin/product-templates" className="underline font-medium">Product Templates</Link> and tick &quot;Stockable fabricated item&quot; on its Settings tab.
                </p>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => { setProductSearch(e.target.value); setShowProductList(true); setProductId(""); }}
                    onFocus={() => setShowProductList(true)}
                    placeholder="Start typing to find a stockable item..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showProductList && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                      {filteredProducts.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-gray-500">No matching items.</p>
                      ) : (
                        filteredProducts.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => pickProduct(t)}
                            className="block w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-blue-50"
                          >
                            {t.name}{t.product_number ? " (" + t.product_number + ")" : ""}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {selectedProduct && (
                    <p className="text-xs text-green-700 mt-1">Building: {selectedProduct.name}</p>
                  )}
                </div>
              )}
            </div>
          ) : !isCustom ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Product <span className="text-red-600">*</span>
              </label>
              {!customerId ? (
                <p className="text-sm text-gray-500 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">Select a customer first to see their products.</p>
              ) : customerProducts.length === 0 ? (
                <p className="text-sm text-amber-700 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                  This customer has no products yet. <Link href="/admin/product-templates" className="underline font-medium">Add one in Product Templates</Link>, or tick &quot;Custom one-off job&quot; above to build something without a template.
                </p>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => { setProductSearch(e.target.value); setShowProductList(true); setProductId(""); }}
                    onFocus={() => setShowProductList(true)}
                    placeholder="Start typing to find a product..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showProductList && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                      {filteredProducts.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-gray-500">No matching products.</p>
                      ) : (
                        filteredProducts.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => pickProduct(t)}
                            className="block w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-blue-50"
                          >
                            {t.name}{t.product_number ? " (" + t.product_number + ")" : ""}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {selectedProduct && (
                    <p className="text-xs text-green-700 mt-1">Selected: {selectedProduct.name}</p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  What are you building? <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => {
                    setCustomName(e.target.value);
                    if (!jobNumberEdited) setJobNumber(e.target.value);
                  }}
                  placeholder="e.g. One-off handrail repair"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">This one-off won&apos;t be added to your product catalog. You&apos;ll add its materials, parts, and tasks on the job itself.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Price per unit</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  placeholder="Optional — you can set this later"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">Your quoted price for one unit. The cost report figures margin and cost-per-unit using the job quantity, so a batch of 2 splits correctly.</p>
              </div>
            </>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isBuild ? "Quantity to build" : "Quantity"} <span className="text-red-600">*</span>
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {isBuild && (
                <p className="text-xs text-gray-500 mt-1">How many units this build adds to fabricated stock when you receive it.</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Job number <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                required
                value={jobNumber}
                onChange={(e) => { setJobNumber(e.target.value); setJobNumberEdited(true); }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

        <div className="flex justify-end gap-2">
          <Link href="/admin/jobs" className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium transition-colors">Cancel</Link>
          <button
            type="submit"
            disabled={saving || customers.length === 0}
            className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Creating job..." : isBuild ? "Create build order" : "Create job"}
          </button>
        </div>
      </form>
    </div>
  );
}

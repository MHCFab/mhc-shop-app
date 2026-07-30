"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../../lib/supabase";
import { generateJobPickListAndTasks } from "../../../lib/job-generation";

type Customer = { id: string; name: string };
type Template = { id: string; name: string; product_number: string | null; customer_id: string | null };
type ProductLine = {
  templateId: string;
  name: string;
  productNumber: string | null;
  quantity: string;
  unitPrice: string;
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
  const [productSearch, setProductSearch] = useState("");
  const [showProductList, setShowProductList] = useState(false);
  // A job can carry several products (e.g. variations of the same part that get
  // built together). Each line has its own quantity and its own price.
  const [productLines, setProductLines] = useState<ProductLine[]>([]);
  // Quantity for a custom one-off job, which has no product template.
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
  const [buildOutputs, setBuildOutputs] = useState<{ templateId: string; name: string; quantity: string }[]>([]);
  const [outputSearch, setOutputSearch] = useState("");
  const [showOutputList, setShowOutputList] = useState(false);

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

  // Filtered by the type-ahead search; products already on the job drop out.
  const filteredProducts = customerProducts.filter((t) => {
    if (productLines.some((l) => l.templateId === t.id)) return false;
    if (!productSearch) return true;
    const s = productSearch.toLowerCase();
    return (t.name + " " + (t.product_number || "")).toLowerCase().includes(s);
  });

  function addProductLine(t: Template) {
    setProductLines((prev) => {
      if (prev.some((l) => l.templateId === t.id)) return prev;
      // Name the job after the first product added, unless you have renamed it.
      if (!jobNumberEdited && prev.length === 0) setJobNumber(t.name);
      return [...prev, { templateId: t.id, name: t.name, productNumber: t.product_number, quantity: "1", unitPrice: "" }];
    });
    setProductSearch("");
    setShowProductList(false);
  }

  function setLineField(templateId: string, field: "quantity" | "unitPrice", value: string) {
    setProductLines((prev) => prev.map((l) => (l.templateId === templateId ? { ...l, [field]: value } : l)));
  }

  function removeProductLine(templateId: string) {
    setProductLines((prev) => prev.filter((l) => l.templateId !== templateId));
  }

  function onCustomerChange(newCustomerId: string) {
    setCustomerId(newCustomerId);
    // Reset product selection when customer changes (build mode ignores customer for products)
    if (!isBuild) {
      setProductLines([]);
      setProductSearch("");
      setShowProductList(false);
    }
  }

  function toggleCustom(checked: boolean) {
    setIsCustom(checked);
    // Clear product selection; custom and build are mutually exclusive
    setProductLines([]);
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
    setProductLines([]);
    setProductSearch("");
    setShowProductList(false);
    setBuildOutputs([]);
    setOutputSearch("");
    setShowOutputList(false);
    if (checked) {
      setIsCustom(false);
      setCustomName("");
      setUnitPrice("");
      // Default the customer to your internal "MHC" customer so builds group together.
      const mhc = customers.find((c) => c.name.trim().toLowerCase() === "mhc");
      if (mhc) setCustomerId(mhc.id);
    }
  }

  // Build outputs (shared-nest builds): the list of stockable items this build produces.
  const filteredOutputs = stockableTemplates.filter((t) => {
    if (buildOutputs.some((o) => o.templateId === t.id)) return false;
    if (!outputSearch) return true;
    const s = outputSearch.toLowerCase();
    return (t.name + " " + (t.product_number || "")).toLowerCase().includes(s);
  });

  function addOutput(t: Template) {
    setBuildOutputs((prev) => {
      if (prev.some((o) => o.templateId === t.id)) return prev;
      if (!jobNumberEdited && prev.length === 0) setJobNumber("Build: " + t.name);
      return [...prev, { templateId: t.id, name: t.name, quantity: "1" }];
    });
    setOutputSearch("");
    setShowOutputList(false);
  }

  function setOutputQty(templateId: string, value: string) {
    setBuildOutputs((prev) => prev.map((o) => (o.templateId === templateId ? { ...o, quantity: value } : o)));
  }

  function removeOutput(templateId: string) {
    setBuildOutputs((prev) => prev.filter((o) => o.templateId !== templateId));
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
      if (buildOutputs.length === 0) {
        setError("Add at least one item to build.");
        return;
      }
      for (const o of buildOutputs) {
        const q = parseInt(o.quantity, 10);
        if (isNaN(q) || q <= 0) {
          setError("Each item to build needs a quantity of at least 1 (" + o.name + ").");
          return;
        }
      }
    } else if (isCustom) {
      if (!customName.trim()) {
        setError("Please describe what you're building.");
        return;
      }
      if (parseInt(quantity) <= 0 || isNaN(parseInt(quantity))) {
        setError("Quantity must be at least 1.");
        return;
      }
    } else {
      if (productLines.length === 0) {
        setError("Please add at least one product.");
        return;
      }
      for (const l of productLines) {
        const q = parseInt(l.quantity, 10);
        if (isNaN(q) || q <= 0) {
          setError("Each product needs a quantity of at least 1 (" + l.name + ").");
          return;
        }
        if (l.unitPrice.trim()) {
          const up = parseFloat(l.unitPrice);
          if (isNaN(up) || up < 0) {
            setError("Price per unit must be 0 or more (" + l.name + ").");
            return;
          }
        }
      }
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
        build_template_id: isBuild ? buildOutputs[0].templateId : null,
        build_quantity: isBuild ? parseInt(buildOutputs[0].quantity, 10) : null,
      })
      .select()
      .single();

    if (jobError || !job) {
      setError(jobError?.message || "Failed to create job.");
      setSaving(false);
      return;
    }

    // A build order creates one line item per output it produces (so each output
    // gets its own tasks); a templated job is a single line item; a custom job is a
    // single line item with no template.
    type DesiredLine = { templateId: string; quantity: number; sort_order: number; unitPrice: number | null };
    const desired: DesiredLine[] = isBuild
      ? buildOutputs.map((o, idx) => ({ templateId: o.templateId, quantity: parseInt(o.quantity, 10), sort_order: idx, unitPrice: null }))
      : isCustom
        ? []
        : productLines.map((l, idx) => ({
            templateId: l.templateId,
            quantity: parseInt(l.quantity, 10),
            sort_order: idx,
            unitPrice: l.unitPrice.trim() ? parseFloat(l.unitPrice) : null,
          }));

    type LineInsert = {
      company_id: string;
      job_id: string;
      product_template_id: string | null;
      quantity: number;
      notes: null;
      sort_order: number;
      name: string | null;
      unit_price: number | null;
    };
    const lineRows: LineInsert[] = isCustom
      ? [{
          company_id: companyId,
          job_id: job.id,
          product_template_id: null,
          quantity: parseInt(quantity),
          notes: null,
          sort_order: 0,
          name: customName.trim(),
          unit_price: unitPriceValue,
        }]
      : desired.map((d) => ({
          company_id: companyId,
          job_id: job.id,
          product_template_id: d.templateId,
          quantity: d.quantity,
          notes: null,
          sort_order: d.sort_order,
          name: null,
          // Blank falls back to the product template's retail price on the cost report.
          unit_price: d.unitPrice,
        }));

    const { data: insertedLineItems, error: lineError } = await supabase
      .from("job_line_items")
      .insert(lineRows)
      .select();

    if (lineError || !insertedLineItems || insertedLineItems.length === 0) {
      setError(lineError?.message || "Failed to create line item.");
      setSaving(false);
      return;
    }

    // Record what a build order produces, so the job page can receive each item into
    // fabricated stock at its own cost per unit.
    if (isBuild) {
      const { error: boError } = await supabase.from("build_outputs").insert(
        buildOutputs.map((o) => ({
          company_id: companyId,
          job_id: job.id,
          product_template_id: o.templateId,
          quantity: parseInt(o.quantity, 10),
        }))
      );
      if (boError) {
        setError("Job created, but failed to save its build outputs: " + boError.message);
        router.push("/admin/jobs/" + job.id);
        return;
      }
    }

    // Templated jobs AND build orders auto-generate their pick list and tasks.
    // Custom jobs come in blank — you build the pick list and tasks by hand.
    if (!isCustom) {
      const insertedArr = insertedLineItems as unknown as { id: string; sort_order: number }[];
      const itemsForGeneration = desired.map((d) => {
        const li = insertedArr.find((x) => Number(x.sort_order) === d.sort_order);
        return { lineItemId: li ? li.id : insertedArr[0].id, templateId: d.templateId, quantity: d.quantity };
      });

      try {
        await generateJobPickListAndTasks(supabase, companyId, job.id, itemsForGeneration, {
          mergeTasks: !isBuild && itemsForGeneration.length > 1,
        });
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
                Items to build <span className="text-red-600">*</span>
              </label>
              {stockableTemplates.length === 0 ? (
                <p className="text-sm text-amber-700 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                  No stockable items yet. Open a sub-assembly in <Link href="/admin/product-templates" className="underline font-medium">Product Templates</Link> and tick &quot;Stockable fabricated item&quot; on its Settings tab.
                </p>
              ) : (
                <>
                  {buildOutputs.length > 0 && (
                    <div className="space-y-2 mb-2">
                      {buildOutputs.map((o) => (
                        <div key={o.templateId} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                          <span className="flex-1 text-sm text-gray-900">{o.name}</span>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={o.quantity}
                            onChange={(e) => setOutputQty(o.templateId, e.target.value)}
                            className="w-20 px-2 py-1 border border-gray-300 rounded-md text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => removeOutput(o.templateId)}
                            className="text-gray-400 hover:text-red-600 text-lg leading-none px-1"
                            aria-label={"Remove " + o.name}
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <input
                      type="text"
                      value={outputSearch}
                      onChange={(e) => { setOutputSearch(e.target.value); setShowOutputList(true); }}
                      onFocus={() => setShowOutputList(true)}
                      placeholder="Start typing to add an item to build..."
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {showOutputList && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                        {filteredOutputs.length === 0 ? (
                          <p className="px-3 py-2 text-sm text-gray-500">No matching items.</p>
                        ) : (
                          filteredOutputs.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => addOutput(t)}
                              className="block w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-blue-50"
                            >
                              {t.name}{t.product_number ? " (" + t.product_number + ")" : ""}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Add one item for a normal build, or several to build them together from one shared cutting nest. Each item is stocked separately at its own cost.</p>
                </>
              )}
            </div>
          ) : !isCustom ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Products <span className="text-red-600">*</span>
              </label>
              {!customerId ? (
                <p className="text-sm text-gray-500 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">Select a customer first to see their products.</p>
              ) : customerProducts.length === 0 ? (
                <p className="text-sm text-amber-700 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                  This customer has no products yet. <Link href="/admin/product-templates" className="underline font-medium">Add one in Product Templates</Link>, or tick &quot;Custom one-off job&quot; above to build something without a template.
                </p>
              ) : (
                <>
                  {productLines.length > 0 && (
                    <div className="space-y-2 mb-2">
                      <div className="hidden sm:flex items-center gap-2 px-3 text-xs uppercase tracking-wide text-gray-500 font-medium">
                        <span className="flex-1">Product</span>
                        <span className="w-20 text-center">Qty</span>
                        <span className="w-28 text-center">Price each</span>
                        <span className="w-6" />
                      </div>
                      {productLines.map((l) => (
                        <div key={l.templateId} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                          <span className="flex-1 text-sm text-gray-900">
                            {l.name}{l.productNumber ? " (" + l.productNumber + ")" : ""}
                          </span>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={l.quantity}
                            onChange={(e) => setLineField(l.templateId, "quantity", e.target.value)}
                            aria-label={"Quantity for " + l.name}
                            className="w-20 px-2 py-1 border border-gray-300 rounded-md text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={l.unitPrice}
                            onChange={(e) => setLineField(l.templateId, "unitPrice", e.target.value)}
                            placeholder="Catalog"
                            aria-label={"Price per unit for " + l.name}
                            className="w-28 px-2 py-1 border border-gray-300 rounded-md text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => removeProductLine(l.templateId)}
                            className="text-gray-400 hover:text-red-600 text-lg leading-none px-1"
                            aria-label={"Remove " + l.name}
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <input
                      type="text"
                      value={productSearch}
                      onChange={(e) => { setProductSearch(e.target.value); setShowProductList(true); }}
                      onFocus={() => setShowProductList(true)}
                      placeholder={productLines.length === 0 ? "Start typing to find a product..." : "Add another product..."}
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
                              onClick={() => addProductLine(t)}
                              className="block w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-blue-50"
                            >
                              {t.name}{t.product_number ? " (" + t.product_number + ")" : ""}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Add one product, or several variations that get built together on the same job. Leave a price blank to use the product&apos;s catalog price. Material and parts combine into one pick list, and tasks with the same name become one shared task.
                  </p>
                </>
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
            {isCustom && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Quantity <span className="text-red-600">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
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

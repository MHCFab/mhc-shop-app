"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../lib/supabase";

type Product = {
  id: string;
  name: string;
  product_number: string | null;
  description: string | null;
  is_sub_assembly: boolean;
};

type EditJob = {
  id: string;
  job_number: string;
  status: string;
  customer_po: string | null;
  due_date: string | null;
  notes: string | null;
  job_line_items: { id: string; quantity: number; product_template_id: string | null }[];
};

type OpenJob = {
  id: string;
  job_number: string;
  status: string;
  job_line_items: { product_template_id: string | null }[];
};

const OPEN_STATUS_LABEL: Record<string, string> = {
  pending: "awaiting approval",
  ordered: "ordered",
  ready: "released to the shop",
  in_progress: "in production",
};

export default function OrderForm({ editJobId, initialProductId }: { editJobId?: string; initialProductId?: string }) {
  const supabase = createClient();
  const router = useRouter();
  const isEdit = !!editJobId;

  const [products, setProducts] = useState<Product[]>([]);
  const [openJobs, setOpenJobs] = useState<OpenJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEditable, setNotEditable] = useState(false);
  const [editJobNumber, setEditJobNumber] = useState("");

  const [productTemplateId, setProductTemplateId] = useState(initialProductId || "");
  const [quantity, setQuantity] = useState("1");
  const [customerPo, setCustomerPo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);

      const { data, error: prodError } = await supabase
        .from("product_templates")
        .select("id, name, product_number, description, is_sub_assembly")
        .order("name");
      if (prodError) {
        setError(prodError.message);
        setLoading(false);
        return;
      }
      // Sub-assemblies are internal components, not orderable products
      const rows = ((data || []) as unknown as Product[]).filter((p) => !p.is_sub_assembly);
      setProducts(rows);

      // Open jobs, so we can point out "you already have an order for this"
      // when the same product is picked again. Never blocks — just steers.
      const { data: ojData } = await supabase
        .from("jobs")
        .select("id, job_number, status, job_line_items(product_template_id)")
        .in("status", ["pending", "ordered", "ready", "in_progress"]);
      setOpenJobs((ojData || []) as unknown as OpenJob[]);

      if (editJobId) {
        const { data: jobData, error: jobError } = await supabase
          .from("jobs")
          .select("id, job_number, status, customer_po, due_date, notes, job_line_items(id, quantity, product_template_id)")
          .eq("id", editJobId)
          .single();
        if (jobError || !jobData) {
          setError("Could not load that order.");
          setLoading(false);
          return;
        }
        const job = jobData as unknown as EditJob;
        setEditJobNumber(job.job_number);
        if (job.status !== "pending") {
          setNotEditable(true);
        } else {
          const line = job.job_line_items[0];
          setProductTemplateId(line?.product_template_id || "");
          setQuantity(line ? String(line.quantity) : "1");
          setCustomerPo(job.customer_po || "");
          setDueDate(job.due_date || "");
          setNotes(job.notes || "");
        }
      }
      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editJobId]);

  const selectedProduct = products.find((p) => p.id === productTemplateId);

  // Existing open jobs for the picked product (new orders only)
  const duplicateJobs = !isEdit && productTemplateId
    ? openJobs.filter((oj) => oj.job_line_items.some((li) => li.product_template_id === productTemplateId))
    : [];
  const duplicatePending = duplicateJobs.find((oj) => oj.status === "pending");
  const duplicateActive = duplicateJobs.find((oj) => oj.status !== "pending");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isEdit && !productTemplateId) {
      setError("Please pick a product.");
      return;
    }
    const q = parseInt(quantity, 10);
    if (isNaN(q) || q < 1) {
      setError("Quantity must be at least 1.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/portal/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit
            ? { action: "update", jobId: editJobId, quantity: q, customerPo, dueDate, notes }
            : { action: "create", productTemplateId, quantity: q, customerPo, dueDate, notes }
        ),
      });
      const result = await res.json();
      if (!res.ok || result.error) {
        setError(result.error || "Something went wrong. Please try again.");
        setSaving(false);
        return;
      }
      router.push("/portal");
    } catch {
      setError("Something went wrong. Please try again.");
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-gray-600">Loading...</p>;
  }

  if (notEditable) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
        <p className="text-gray-900 font-medium mb-1">{editJobNumber}</p>
        <p className="text-gray-600 mb-4">
          This order has already been approved, so it can&apos;t be edited online anymore.
          Give us a call if something needs to change.
        </p>
        <Link href="/portal" className="text-blue-600 hover:text-blue-800 font-medium">&larr; Back to your jobs</Link>
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <Link href="/portal" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; Back to your jobs
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">{isEdit ? "Edit order" : "Place an order"}</h1>
      <p className="text-gray-600 mb-6">
        {isEdit
          ? "Update " + editJobNumber + " — you can adjust this order until we approve it."
          : "Orders come to us for approval before they hit the shop schedule."}
      </p>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

      {!isEdit && products.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No products on file yet. Contact us to get your products set up, then order here.</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Product <span className="text-red-600">*</span>
            </label>
            {isEdit ? (
              <p className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-900">
                {selectedProduct
                  ? selectedProduct.name + (selectedProduct.product_number ? " (" + selectedProduct.product_number + ")" : "")
                  : "Product"}
                <span className="block text-xs text-gray-500 mt-0.5">To order a different product, cancel this order and place a new one.</span>
              </p>
            ) : (
              <select
                value={productTemplateId}
                onChange={(e) => setProductTemplateId(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">-- Pick a product --</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.product_number ? " (" + p.product_number + ")" : ""}
                  </option>
                ))}
              </select>
            )}
            {!isEdit && selectedProduct?.description && (
              <p className="text-xs text-gray-500 mt-1">{selectedProduct.description}</p>
            )}
          </div>

          {duplicatePending && (
            <div className="text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded-md p-3">
              <p className="font-medium">You already have an order for this product awaiting approval.</p>
              <p className="mt-1">
                <Link href={"/portal/order/" + duplicatePending.id} className="text-blue-600 hover:text-blue-800 font-medium underline">
                  Edit that order instead
                </Link>
                {" "}if you just need a different quantity or date — or keep going if you really want a separate order.
              </p>
            </div>
          )}

          {!duplicatePending && duplicateActive && (
            <div className="text-sm text-blue-900 bg-blue-50 border border-blue-200 rounded-md p-3">
              <p className="font-medium">
                We&apos;re already working on this product for you ({OPEN_STATUS_LABEL[duplicateActive.status] || duplicateActive.status}).
              </p>
              <p className="mt-1">
                If you just need more or fewer,{" "}
                <Link href="/portal" className="text-blue-600 hover:text-blue-800 font-medium underline">
                  request a quantity change on that job
                </Link>
                {" "}instead — or keep going if this is really a new, separate order.
              </p>
            </div>
          )}

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
              required
              className="w-32 px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Your PO number</label>
            <input
              type="text"
              value={customerPo}
              onChange={(e) => setCustomerPo(e.target.value)}
              placeholder="Optional"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Requested date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">Optional — when you&apos;d like it by. We&apos;ll confirm when we approve the order.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Anything we should know about this order (optional)"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? (isEdit ? "Saving..." : "Placing order...") : (isEdit ? "Save changes" : "Place order")}
            </button>
            <Link href="/portal" className="text-sm text-gray-600 hover:text-gray-900 font-medium">Cancel</Link>
          </div>
        </form>
      )}
    </div>
  );
}

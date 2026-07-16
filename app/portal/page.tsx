"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "../lib/supabase";

// What each status means from the customer's point of view.
const STATUS_INFO: Record<string, { label: string; color: string }> = {
  pending: { label: "Awaiting approval", color: "bg-yellow-100 text-yellow-800" },
  ordered: { label: "Ordered", color: "bg-gray-100 text-gray-800" },
  ready: { label: "Released to shop", color: "bg-blue-100 text-blue-800" },
  in_progress: { label: "In production", color: "bg-amber-100 text-amber-800" },
};

type LineItem = {
  id: string;
  quantity: number;
  name: string | null;
  product_templates: { name: string } | null;
};

type Job = {
  id: string;
  job_number: string;
  customer_po: string | null;
  status: string;
  due_date: string | null;
  board_order: number;
  created_at: string;
  job_line_items: LineItem[];
};

type ChangeRequest = {
  id: string;
  job_id: string;
  request_type: "quantity" | "cancel";
  requested_quantity: number | null;
  customer_note: string | null;
  status: "open" | "approved" | "declined";
  response_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

function lineItemLabel(li: LineItem) {
  const name = li.name || li.product_templates?.name || "Item";
  return name + " × " + li.quantity;
}

// Show resolved (approved/declined) requests for a week so the customer
// sees what happened, then let them fade away.
function isRecentlyResolved(r: ChangeRequest) {
  if (!r.resolved_at) return false;
  return Date.now() - new Date(r.resolved_at).getTime() < 7 * 24 * 60 * 60 * 1000;
}

export default function PortalJobsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [requests, setRequests] = useState<Map<string, ChangeRequest>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  // Change-request form (one open at a time, inline under the job row)
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [reqType, setReqType] = useState<"quantity" | "cancel">("quantity");
  const [reqQty, setReqQty] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [reqBusy, setReqBusy] = useState(false);
  const [withdrawBusyId, setWithdrawBusyId] = useState<string | null>(null);

  // Priority drag
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  async function loadJobs() {
    setLoading(true);
    const { data, error } = await supabase
      .from("jobs")
      .select("id, job_number, customer_po, status, due_date, board_order, created_at, job_line_items(id, quantity, name, product_templates(name))")
      .in("status", ["pending", "ordered", "ready", "in_progress"])
      .order("board_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) setError(error.message);
    else setJobs((data || []) as unknown as Job[]);

    // Latest change request per job (newest first, keep the first we see)
    const { data: reqData } = await supabase
      .from("job_change_requests")
      .select("id, job_id, request_type, requested_quantity, customer_note, status, response_note, created_at, resolved_at")
      .order("created_at", { ascending: false });
    const map = new Map<string, ChangeRequest>();
    for (const r of (reqData || []) as unknown as ChangeRequest[]) {
      if (!map.has(r.job_id)) map.set(r.job_id, r);
    }
    setRequests(map);

    setLoading(false);
  }

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function postAction(payload: Record<string, unknown>): Promise<string | null> {
    try {
      const res = await fetch("/portal/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok || result.error) return result.error || "Something went wrong. Please try again.";
      return null;
    } catch {
      return "Something went wrong. Please try again.";
    }
  }

  async function cancelOrder(jobId: string) {
    setCancelBusy(true);
    setError(null);
    const err = await postAction({ action: "cancel", jobId });
    if (err) setError(err);
    setCancelBusy(false);
    setCancellingId(null);
    loadJobs();
  }

  function openRequestForm(job: Job) {
    setError(null);
    setRequestingId(job.id);
    setReqType("quantity");
    const li = job.job_line_items[0];
    setReqQty(li ? String(li.quantity) : "");
    setReqNote("");
  }

  async function submitRequest(jobId: string) {
    setError(null);
    if (reqType === "quantity") {
      const q = parseInt(reqQty, 10);
      if (isNaN(q) || q < 1) {
        setError("Quantity must be a whole number of at least 1.");
        return;
      }
    }
    setReqBusy(true);
    const err = await postAction({
      action: "request_change",
      jobId,
      requestType: reqType,
      requestedQuantity: reqType === "quantity" ? parseInt(reqQty, 10) : undefined,
      note: reqNote,
    });
    if (err) setError(err);
    setReqBusy(false);
    setRequestingId(null);
    loadJobs();
  }

  async function withdrawRequest(jobId: string) {
    setError(null);
    setWithdrawBusyId(jobId);
    const err = await postAction({ action: "withdraw_request", jobId });
    if (err) setError(err);
    setWithdrawBusyId(null);
    loadJobs();
  }

  // ---- Priority drag (in-production rows are locked) ----
  const canReorder = jobs.length > 1;

  function onDragStart(index: number) {
    if (jobs[index]?.status === "in_progress") return;
    setDragIndex(index);
  }

  function onDragOver(e: React.DragEvent, index: number) {
    if (dragIndex === null) return;
    e.preventDefault();
    if (dragIndex === index) return;
    setJobs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(index, 0, moved);
      return next;
    });
    setDragIndex(index);
  }

  async function onDrop() {
    if (dragIndex === null) return;
    setDragIndex(null);
    setSavingOrder(true);
    setError(null);
    const err = await postAction({ action: "reorder", jobIds: jobs.map((j) => j.id) });
    if (err) setError(err);
    setSavingOrder(false);
    loadJobs();
  }

  function requestBadge(r: ChangeRequest) {
    const what =
      r.request_type === "quantity"
        ? "Quantity change to " + r.requested_quantity
        : "Cancellation";
    if (r.status === "open") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
          {what} requested
        </span>
      );
    }
    if (r.status === "approved") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
          {what} approved
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
        {what} declined
      </span>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Your jobs</h1>
          <p className="text-gray-600 mt-1">
            Open jobs in shop priority order &mdash; #1 is up first. New orders show as
            &quot;Awaiting approval&quot; until we approve them.
          </p>
        </div>
        <Link
          href="/portal/order"
          className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors whitespace-nowrap"
        >
          Place order
        </Link>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : jobs.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600 mb-3">No open jobs right now.</p>
          <Link href="/portal/order" className="text-blue-600 hover:text-blue-800 font-medium">Place an order</Link>
        </div>
      ) : (
        <>
          {canReorder && (
            <p className="text-xs text-gray-500 mb-2">
              {savingOrder
                ? "Saving order..."
                : "Drag the handle to change priority — #1 is built first. Jobs in production can't be moved."}
            </p>
          )}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {canReorder && <th className="w-8 px-2 py-3"></th>}
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 w-12">#</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Job #</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">PO</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Products</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Due</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700"></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j, idx) => {
                  const status = STATUS_INFO[j.status] || { label: j.status, color: "bg-gray-100 text-gray-700" };
                  const request = requests.get(j.id) || null;
                  const openRequest = request && request.status === "open" ? request : null;
                  const resolvedRequest = request && request.status !== "open" && isRecentlyResolved(request) ? request : null;
                  const canEdit = j.status === "pending";
                  const canCancel = j.status === "pending" || j.status === "ordered";
                  const canRequestQty = (j.status === "ordered" || j.status === "ready" || j.status === "in_progress") && !openRequest;
                  const canRequestCancel = (j.status === "ready" || j.status === "in_progress") && !openRequest;
                  const draggable = canReorder && j.status !== "in_progress";
                  return (
                    <Fragment key={j.id}>
                      <tr
                        draggable={draggable}
                        onDragStart={() => onDragStart(idx)}
                        onDragOver={(e) => onDragOver(e, idx)}
                        onDrop={onDrop}
                        onDragEnd={() => setDragIndex(null)}
                        className={"border-b border-gray-100 last:border-0 " + (dragIndex === idx ? "bg-blue-50" : "")}
                      >
                        {canReorder && (
                          <td
                            className={"px-2 py-3 text-center select-none " + (draggable ? "text-gray-400 cursor-grab active:cursor-grabbing" : "text-gray-200")}
                            title={draggable ? "Drag to change priority" : "In production — can't be moved"}
                          >
                            ⠿
                          </td>
                        )}
                        <td className="px-4 py-3 text-sm text-gray-500 font-mono">{idx + 1}</td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{j.job_number}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">{j.customer_po || "-"}</td>
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {j.job_line_items.length === 0
                            ? "-"
                            : j.job_line_items.map((li) => (
                                <div key={li.id}>{lineItemLabel(li)}</div>
                              ))}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium " + status.color}>
                            {status.label}
                          </span>
                          {openRequest && <div className="mt-1">{requestBadge(openRequest)}</div>}
                          {resolvedRequest && (
                            <div className="mt-1">
                              {requestBadge(resolvedRequest)}
                              {resolvedRequest.response_note && (
                                <p className="text-xs text-gray-500 mt-0.5">&ldquo;{resolvedRequest.response_note}&rdquo;</p>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-700">{j.due_date || "-"}</td>
                        <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                          {cancellingId === j.id ? (
                            <span className="inline-flex items-center gap-2">
                              <span className="text-xs text-gray-600">Cancel this order?</span>
                              <button
                                onClick={() => cancelOrder(j.id)}
                                disabled={cancelBusy}
                                className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                              >
                                {cancelBusy ? "Cancelling..." : "Yes, cancel"}
                              </button>
                              <button
                                onClick={() => setCancellingId(null)}
                                disabled={cancelBusy}
                                className="text-gray-500 hover:text-gray-700 font-medium disabled:opacity-50"
                              >
                                No
                              </button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-3">
                              {openRequest && (
                                <button
                                  onClick={() => withdrawRequest(j.id)}
                                  disabled={withdrawBusyId === j.id}
                                  className="text-gray-500 hover:text-gray-700 font-medium disabled:opacity-50"
                                >
                                  {withdrawBusyId === j.id ? "Withdrawing..." : "Withdraw request"}
                                </button>
                              )}
                              {canEdit && (
                                <Link href={"/portal/order/" + j.id} className="text-blue-600 hover:text-blue-800 font-medium">
                                  Edit
                                </Link>
                              )}
                              {(canRequestQty || canRequestCancel) && (
                                <button
                                  onClick={() => (requestingId === j.id ? setRequestingId(null) : openRequestForm(j))}
                                  className="text-orange-600 hover:text-orange-800 font-medium"
                                >
                                  Request change
                                </button>
                              )}
                              {canCancel && (
                                <button
                                  onClick={() => setCancellingId(j.id)}
                                  className="text-red-600 hover:text-red-800 font-medium"
                                >
                                  Cancel
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                      {requestingId === j.id && (
                        <tr key={j.id + "-request"} className="border-b border-gray-100 last:border-0 bg-orange-50">
                          <td colSpan={canReorder ? 8 : 7} className="px-4 py-4">
                            <div className="max-w-xl">
                              <p className="text-sm font-semibold text-gray-900 mb-2">Request a change to {j.job_number}</p>
                              {canRequestCancel ? (
                                <div className="flex items-center gap-4 mb-3">
                                  <label className="inline-flex items-center gap-1.5 text-sm text-gray-800">
                                    <input
                                      type="radio"
                                      name={"reqtype-" + j.id}
                                      checked={reqType === "quantity"}
                                      onChange={() => setReqType("quantity")}
                                    />
                                    Change the quantity
                                  </label>
                                  <label className="inline-flex items-center gap-1.5 text-sm text-gray-800">
                                    <input
                                      type="radio"
                                      name={"reqtype-" + j.id}
                                      checked={reqType === "cancel"}
                                      onChange={() => setReqType("cancel")}
                                    />
                                    Cancel this job
                                  </label>
                                </div>
                              ) : (
                                <p className="text-sm text-gray-700 mb-3">Ask us to change the quantity on this job.</p>
                              )}

                              {reqType === "quantity" && (
                                <div className="mb-3">
                                  <label className="block text-sm font-medium text-gray-700 mb-1">New quantity</label>
                                  <input
                                    type="number"
                                    min="1"
                                    step="1"
                                    value={reqQty}
                                    onChange={(e) => setReqQty(e.target.value)}
                                    className="w-32 px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  />
                                </div>
                              )}

                              <div className="mb-3">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
                                <textarea
                                  value={reqNote}
                                  onChange={(e) => setReqNote(e.target.value)}
                                  rows={2}
                                  placeholder="Anything we should know (optional)"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </div>

                              <p className="text-xs text-gray-500 mb-3">
                                {reqType === "cancel"
                                  ? "This job is already in the shop, so cancellation needs our review. We'll see your request right away."
                                  : "We'll review the request and apply it if the job hasn't gone too far. You'll see the result here."}
                              </p>

                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => submitRequest(j.id)}
                                  disabled={reqBusy}
                                  className="bg-orange-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-orange-700 disabled:opacity-50"
                                >
                                  {reqBusy ? "Sending..." : "Send request"}
                                </button>
                                <button
                                  onClick={() => setRequestingId(null)}
                                  disabled={reqBusy}
                                  className="text-sm text-gray-600 hover:text-gray-900 font-medium disabled:opacity-50"
                                >
                                  Never mind
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

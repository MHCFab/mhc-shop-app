"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "../../../lib/supabase";

type Message = {
  id: string;
  sender_side: "staff" | "customer";
  sender_id: string | null;
  body: string;
  created_at: string;
  read_by_staff: boolean;
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Admin side of a per-job customer <-> shop thread. Reads/writes go through RLS
// (admins have full access to their company's job_messages). Opening the tab
// marks the customer's messages read; it auto-refreshes every 5 seconds so an
// active back-and-forth doesn't need a page reload.
export default function MessagesTab({
  jobId,
  customerId,
  customerName,
  onReadAll,
}: {
  jobId: string;
  customerId: string;
  customerName: string;
  onReadAll?: () => void;
}) {
  const supabase = createClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadIds = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId((data as { company_id: string }).company_id);
  }, [supabase]);

  // Mark the customer's messages on this job as read by the shop. Only fires a
  // write when there's actually something unread, so the 5s poll stays cheap.
  const markCustomerRead = useCallback(async (rows: Message[]) => {
    if (!rows.some((m) => m.sender_side === "customer" && !m.read_by_staff)) return;
    await supabase
      .from("job_messages")
      .update({ read_by_staff: true })
      .eq("job_id", jobId)
      .eq("sender_side", "customer")
      .eq("read_by_staff", false);
    if (onReadAll) onReadAll();
  }, [supabase, jobId, onReadAll]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("job_messages")
      .select("id, sender_side, sender_id, body, created_at, read_by_staff")
      .eq("job_id", jobId)
      .order("created_at", { ascending: true });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    const rows = (data || []) as unknown as Message[];
    setMessages(rows);
    setLoading(false);
    await markCustomerRead(rows);
  }, [supabase, jobId, markCustomerRead]);

  useEffect(() => {
    loadIds();
  }, [loadIds]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (!companyId || !userId) {
      setError("Couldn't determine your account. Refresh and try again.");
      return;
    }
    setSending(true);
    setError(null);
    const { error } = await supabase.from("job_messages").insert({
      company_id: companyId,
      job_id: jobId,
      customer_id: customerId,
      sender_side: "staff",
      sender_id: userId,
      body: text,
      read_by_staff: true,
      read_by_customer: false,
    });
    setSending(false);
    if (error) {
      setError("Couldn't send: " + error.message);
      return;
    }
    setDraft("");
    await load();
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg flex flex-col" style={{ height: "70vh" }}>
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-base font-semibold text-gray-900">Messages with {customerName || "customer"}</h3>
        <p className="text-xs text-gray-500">Private to you and this customer, tied to this job. Refreshes automatically.</p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50">
        {loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-gray-500">No messages yet. Send the first one below.</p>
        ) : (
          messages.map((m) => {
            const mine = m.sender_side === "staff";
            return (
              <div key={m.id} className={"flex " + (mine ? "justify-end" : "justify-start")}>
                <div className={"max-w-[75%] rounded-lg px-3 py-2 " + (mine ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-900")}>
                  <div className={"text-xs font-medium mb-0.5 " + (mine ? "text-blue-100" : "text-gray-500")}>{mine ? "You" : (customerName || "Customer")}</div>
                  <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
                  <div className={"text-[11px] mt-1 " + (mine ? "text-blue-100" : "text-gray-400")}>{fmtTime(m.created_at)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {error && <div className="px-4 py-2 text-sm text-red-600 bg-red-50 border-t border-red-100">{error}</div>}

      <form onSubmit={send} className="border-t border-gray-200 p-3 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e as unknown as React.FormEvent);
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder="Type a message to the customer..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
        <button type="submit" disabled={sending || !draft.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {sending ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}

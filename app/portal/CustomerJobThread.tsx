"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "../lib/supabase";

type Message = {
  id: string;
  sender_side: "staff" | "customer";
  body: string;
  created_at: string;
  read_by_customer: boolean;
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function postMessageAction(payload: Record<string, unknown>) {
  const res = await fetch("/portal/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// Customer side of a per-job thread. Reads run through RLS (customers can read
// their own jobs' messages); every write goes through /portal/api/messages with
// the service role. Auto-refreshes every 5 seconds so a live back-and-forth
// doesn't need a page reload.
export default function CustomerJobThread({ jobId }: { jobId: string }) {
  const supabase = createClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const markingRef = useRef(false);

  const markRead = useCallback(async () => {
    if (markingRef.current) return;
    markingRef.current = true;
    try {
      await postMessageAction({ action: "mark_read", jobId });
    } catch {
      // ignore; the next poll will retry
    } finally {
      markingRef.current = false;
    }
  }, [jobId]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("job_messages")
      .select("id, sender_side, body, created_at, read_by_customer")
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
    if (rows.some((m) => m.sender_side === "staff" && !m.read_by_customer)) {
      await markRead();
    }
  }, [supabase, jobId, markRead]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      await postMessageAction({ action: "send", jobId, body: text });
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm mt-6 flex flex-col" style={{ height: "60vh" }}>
      <div className="px-4 py-3 border-b border-gray-200">
        <h2 className="text-base font-semibold text-gray-900">Messages about this job</h2>
        <p className="text-xs text-gray-500">Have a question about this order? Message the shop here. New messages appear automatically.</p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50">
        {loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-gray-500">No messages yet. Have a question about this order? Send it below.</p>
        ) : (
          messages.map((m) => {
            const mine = m.sender_side === "customer";
            return (
              <div key={m.id} className={"flex " + (mine ? "justify-end" : "justify-start")}>
                <div className={"max-w-[75%] rounded-lg px-3 py-2 " + (mine ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-900")}>
                  <div className={"text-xs font-medium mb-0.5 " + (mine ? "text-blue-100" : "text-gray-500")}>{mine ? "You" : "Shop"}</div>
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
          placeholder="Type your message..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
        <button type="submit" disabled={sending || !draft.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {sending ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}

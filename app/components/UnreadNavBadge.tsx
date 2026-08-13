"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../lib/supabase";

// Small running-total badge of unread job messages, for the top nav.
//   side="staff"    -> unread customer messages across your company (admin nav)
//   side="customer" -> unread shop messages across this customer's jobs (portal)
// Reads are RLS-scoped, so each side only ever counts its own. Polls every 15s.
export default function UnreadNavBadge({ side }: { side: "staff" | "customer" }) {
  const supabase = createClient();
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    const base = supabase.from("job_messages").select("id", { count: "exact", head: true });
    const { count: c } =
      side === "staff"
        ? await base.eq("sender_side", "customer").eq("read_by_staff", false)
        : await base.eq("sender_side", "staff").eq("read_by_customer", false);
    setCount(c || 0);
  }, [supabase, side]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (count <= 0) return null;

  return (
    <span
      title={count + " unread message" + (count === 1 ? "" : "s")}
      className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[11px] font-semibold"
    >
      {count}
    </span>
  );
}

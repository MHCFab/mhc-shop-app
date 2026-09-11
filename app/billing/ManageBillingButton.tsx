"use client";

// ---------------------------------------------------------------------------
// "Manage billing" - one button, one job: get a Stripe portal link and go.
//
// The portal session is created server-side and is single-use and short-lived,
// so this cannot be a plain link - it has to be fetched at the moment they
// click it.
// ---------------------------------------------------------------------------

import { useState } from "react";

export default function ManageBillingButton({
  label = "Manage billing",
  tone = "primary",
}: {
  label?: string;
  tone?: "primary" | "quiet";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (res.ok && data?.url) {
        window.location.assign(data.url);
        return;
      }
      setError(data?.error || "Could not open billing. Please try again.");
    } catch {
      setError("Could not reach ShopWorks. Please check your connection.");
    }
    setBusy(false);
  }

  const styles =
    tone === "primary"
      ? "bg-blue-600 text-white hover:bg-blue-700"
      : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50";

  return (
    <div>
      <button
        onClick={open}
        disabled={busy}
        className={
          "rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
          styles
        }
      >
        {busy ? "Opening…" : label}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

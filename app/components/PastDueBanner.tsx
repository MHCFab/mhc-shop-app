"use client";

// ---------------------------------------------------------------------------
// The strip along the top when a card has failed.
//
// ⚠️ THIS IS RENDERED IN THE ADMIN LAYOUT ONLY, and that is the whole point.
// The crew does not see it. The shop's own customers do not see it. A
// fabricator's payment trouble is not something their customers should learn
// from us, and it is not something their welders can do anything about. Same
// rule as the locked screen.
//
// It says a DATE, not a countdown. "The app pauses on Tuesday 17 March" is a
// sentence somebody acts on; "4 days left" is one they scroll past. And it
// says plainly that nothing has been lost, because the first thing a shop
// owner thinks when they see a red bar about money is that their data is at
// risk.
//
// The button goes straight to Stripe's billing portal rather than to our own
// billing page, because there is exactly one thing to do here and it is
// updating the card. One click, not two.
// ---------------------------------------------------------------------------

import { useState } from "react";
import Link from "next/link";

export default function PastDueBanner({
  graceEndsAt,
}: {
  graceEndsAt: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function openPortal() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (res.ok && data?.url) {
        window.location.assign(data.url);
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }

  const pausesOn = graceEndsAt
    ? new Date(graceEndsAt).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium">Your last payment did not go through.</span>{" "}
          {pausesOn
            ? "ShopWorks keeps working until " + pausesOn + ", then it pauses until the payment clears."
            : "ShopWorks will pause shortly unless the payment clears."}{" "}
          <span className="opacity-80">Nothing has been deleted.</span>
        </span>

        <span className="flex items-center gap-3">
          {failed && (
            <span className="text-red-700">
              Could not open billing —{" "}
              <Link href="/billing" className="underline">
                try the billing page
              </Link>
            </span>
          )}
          <button
            onClick={openPortal}
            disabled={busy}
            className="rounded-md bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Opening…" : "Update payment method"}
          </button>
        </span>
      </div>
    </div>
  );
}

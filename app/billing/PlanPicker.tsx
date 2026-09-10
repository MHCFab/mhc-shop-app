"use client";

// ---------------------------------------------------------------------------
// The three bands, as buttons.
//
// The wording is careful on one point: this is NOT a checkout, and it must not
// look like one. Somebody who thinks they have just paid and then finds
// themselves still locked out has been lied to by the interface. So the button
// says "Choose this plan", not "Subscribe", and what comes back says a person
// will do something, not that anything is switched on.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { PLANS, planById, type PlanId } from "../lib/plans";

export default function PlanPicker({
  currentRequest,
  requestedAt,
}: {
  currentRequest: string | null;
  requestedAt: string | null;
}) {
  const [chosen, setChosen] = useState<string | null>(currentRequest);
  const [stampedAt, setStampedAt] = useState<string | null>(requestedAt);
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);

  async function choose(plan: PlanId) {
    setError(null);
    setBusy(plan);

    try {
      const res = await fetch("/api/billing/request-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        setBusy(null);
        return;
      }

      setChosen(plan);
      setStampedAt(new Date().toISOString());
      setJustSent(true);
      setBusy(null);
    } catch {
      setError("Could not reach ShopWorks. Please check your connection and try again.");
      setBusy(null);
    }
  }

  const chosenPlan = planById(chosen);

  const when = stampedAt
    ? new Date(stampedAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        {PLANS.map((plan) => {
          const isChosen = chosen === plan.id;
          return (
            <div
              key={plan.id}
              className={
                "border rounded-lg p-4 flex flex-col " +
                (isChosen
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 bg-white")
              }
            >
              <p className="text-2xl font-bold text-gray-900">${plan.monthly}</p>
              <p className="text-sm text-gray-500 mb-1">per month</p>
              <p className="text-sm text-gray-700">{plan.label}</p>
              {plan.blurb && (
                <p className="text-xs text-gray-500 mt-1">{plan.blurb}</p>
              )}
              <div className="flex-1" />
              <button
                onClick={() => choose(plan.id)}
                disabled={busy !== null}
                className={
                  "mt-4 w-full py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
                  (isChosen
                    ? "bg-blue-100 text-blue-800"
                    : "bg-blue-600 text-white hover:bg-blue-700")
                }
              >
                {busy === plan.id
                  ? "Sending..."
                  : isChosen
                  ? "Chosen"
                  : "Choose this plan"}
              </button>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
          {error}
        </div>
      )}

      {chosenPlan && !error && (
        <div className="mt-4 bg-green-50 border border-green-200 rounded-md p-4">
          <p className="text-sm text-green-900 font-medium mb-1">
            {justSent ? "Got it." : "You chose the " + chosenPlan.label + " plan" + (when ? " on " + when : "") + "."}
          </p>
          <p className="text-sm text-green-900">
            {justSent
              ? "We have your choice of the $" +
                chosenPlan.monthly +
                " plan and we'll be in touch to get you set up and switched back on - usually the same working day."
              : "We're on it. If you haven't heard back, email support@mhcfab.com and we'll chase it."}
          </p>
        </div>
      )}

      <p className="mt-4 text-sm text-gray-600">
        Every price includes the whole of ShopWorks — no modules, no feature
        tiers, nothing held back. Shop logins means admin and floor together,
        and only the people who actually log in. Logins for your own customers
        are unlimited and free.
      </p>
    </div>
  );
}

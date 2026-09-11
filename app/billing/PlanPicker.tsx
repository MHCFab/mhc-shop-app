"use client";

// ---------------------------------------------------------------------------
// The three bands, four ways to pay for each, and the button that goes to
// Stripe.
//
// ⚠️ THE WORDING RULE FROM THE PRE-STRIPE VERSION STILL APPLIES, INVERTED.
// The old picker was careful never to look like a checkout, because it wasn't
// one. This one IS one, so it has to be equally careful the other way: the
// button says Subscribe, and the line underneath says exactly what will be
// charged and when. The one thing that must never happen is somebody pressing
// a button expecting a $149 charge and meeting $1,490 on Stripe's page.
//
// That is why the trial line is spelled out. A shop with days left keeps them
// and pays later; a shop with less than two days left, or one already locked
// out, pays today. Stripe will not accept a trial end less than 48 hours away,
// so this is not a choice we are making - it is a rule we have to be honest
// about before they click.
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  PLANS,
  INTERVALS,
  ONBOARDING,
  priceFor,
  perMonth,
  savingVsMonthly,
  intervalById,
  type PlanId,
  type IntervalId,
} from "../lib/plans";

const money = (n: number) =>
  "$" + Math.round(n).toLocaleString("en-US");

export default function PlanPicker({
  /** Days of free trial left, or null if they are not on one. */
  trialDaysLeft,
  /** True when Stripe will carry their remaining trial into the subscription. */
  trialCarriesOver,
  /** Which band their current login count actually needs. */
  suggestedPlan,
  loginCount,
}: {
  trialDaysLeft: number | null;
  trialCarriesOver: boolean;
  suggestedPlan: PlanId | null;
  loginCount: number | null;
}) {
  const [interval, setInterval] = useState<IntervalId>("monthly");
  const [onboarding, setOnboarding] = useState(false);
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const iv = intervalById(interval)!;

  async function subscribe(plan: PlanId) {
    setError(null);
    setBusy(plan);

    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, interval, onboarding }),
      });
      const data = await res.json();

      if (res.ok && data?.url) {
        // Off to Stripe. Deliberately not opened in a new tab: a payment page
        // that appears behind the current one is how people pay twice.
        window.location.assign(data.url);
        return;
      }

      setError(data?.error || "Something went wrong. Please try again.");
      setBusy(null);
    } catch {
      setError(
        "Could not reach ShopWorks. Please check your connection and try again."
      );
      setBusy(null);
    }
  }

  return (
    <div>
      {/* ---------------------------------------------------------------- */}
      {/* How often                                                        */}
      {/* ---------------------------------------------------------------- */}
      <div className="mb-5">
        <div className="inline-flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
          {INTERVALS.map((option) => {
            const on = option.id === interval;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setInterval(option.id)}
                className={
                  "rounded-md px-3 py-1.5 text-sm transition-colors " +
                  (on
                    ? "bg-white text-gray-900 shadow-sm font-medium"
                    : "text-gray-600 hover:text-gray-900")
                }
              >
                {option.label}
                {option.saving && (
                  <span
                    className={
                      "ml-2 text-xs " + (on ? "text-green-700" : "text-green-600")
                    }
                  >
                    {option.saving}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The bands                                                        */}
      {/* ---------------------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-3">
        {PLANS.map((plan) => {
          const amount = priceFor(plan.id, interval);
          const monthly = perMonth(plan.id, interval);
          const saved = savingVsMonthly(plan.id, interval);
          const suggested = suggestedPlan === plan.id;

          return (
            <div
              key={plan.id}
              className={
                "flex flex-col rounded-lg border p-4 " +
                (suggested
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 bg-white")
              }
            >
              {suggested && (
                <p className="mb-1 text-xs font-medium text-blue-700">
                  Fits your shop
                </p>
              )}

              <p className="text-2xl font-bold text-gray-900">{money(amount)}</p>
              <p className="mb-1 text-sm text-gray-500">{iv.cadence}</p>

              {interval !== "monthly" && (
                <p className="mb-1 text-xs text-gray-500">
                  Works out at {money(monthly)} a month
                  {saved > 0 && " — you keep " + money(saved)}
                </p>
              )}

              <p className="text-sm text-gray-700">{plan.label}</p>
              {plan.blurb && (
                <p className="mt-1 text-xs text-gray-500">{plan.blurb}</p>
              )}

              <div className="flex-1" />

              <button
                onClick={() => subscribe(plan.id)}
                disabled={busy !== null}
                className="mt-4 w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === plan.id ? "Opening checkout…" : "Subscribe"}
              </button>
            </div>
          );
        })}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The optional setup                                               */}
      {/* ---------------------------------------------------------------- */}
      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <input
          type="checkbox"
          checked={onboarding}
          onChange={(e) => setOnboarding(e.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="text-sm font-medium text-gray-900">
            Add {ONBOARDING.label} — {money(ONBOARDING.price)}, one time
          </span>
          <span className="block text-sm text-gray-600">{ONBOARDING.blurb}</span>
          {onboarding && (
            <span className="mt-1 block text-xs text-gray-500">
              This goes on your first invoice rather than being spread over the
              subscription.
            </span>
          )}
        </span>
      </label>

      {/* ---------------------------------------------------------------- */}
      {/* What is about to happen                                          */}
      {/* ---------------------------------------------------------------- */}
      <p className="mt-4 text-sm text-gray-600">
        {trialCarriesOver && trialDaysLeft != null ? (
          <>
            <span className="font-medium text-gray-800">
              Your {trialDaysLeft === 1 ? "last trial day is" : trialDaysLeft + " remaining trial days are"} not wasted.
            </span>{" "}
            We pass them to Stripe, so your card is stored now and the first
            subscription charge lands when the trial would have run out anyway.
          </>
        ) : (
          <>
            <span className="font-medium text-gray-800">
              Your first payment is taken today
            </span>{" "}
            and the app comes straight back on. Stripe shows you the exact
            amount before you enter a card.
          </>
        )}{" "}
        You can change plan, switch to yearly or cancel at any time from Manage
        billing.
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <p className="mt-4 text-sm text-gray-600">
        Every price includes the whole of ShopWorks — no modules, no feature
        tiers, nothing held back. Shop logins means admin and floor together,
        and only the people who actually log in
        {loginCount != null && (
          <> — you are using {loginCount} right now</>
        )}
        . Logins for your own customers are unlimited and free.
      </p>
    </div>
  );
}

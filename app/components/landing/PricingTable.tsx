"use client";

// ---------------------------------------------------------------------------
// The pricing table on the landing page.
//
// Every number comes from app/lib/plans.ts - the same file the billing page
// and Stripe checkout use - so this page cannot quote a price the checkout
// will not charge.
// ---------------------------------------------------------------------------

import { useState } from "react";
import Link from "next/link";
import {
  INTERVALS,
  ONBOARDING,
  PLANS,
  type IntervalId,
  intervalById,
  perMonth,
  priceFor,
  savingVsMonthly,
} from "../../lib/plans";

function dollars(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export default function PricingTable() {
  const [interval, setPeriod] = useState<IntervalId>("monthly");
  const iv = intervalById(interval)!;

  return (
    <div>
      <div
        role="tablist"
        aria-label="Billing period"
        className="mx-auto flex w-fit flex-wrap justify-center gap-1 rounded-full border border-[#2a333d] bg-[#11161b] p-1"
      >
        {INTERVALS.map((i) => {
          const active = i.id === interval;
          return (
            <button
              key={i.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setPeriod(i.id)}
              className={
                "rounded-full px-4 py-2 text-sm transition-colors " +
                (active
                  ? "bg-[#c8551f] text-white"
                  : "text-gray-300 hover:text-white")
              }
            >
              {i.label}
              {i.saving && (
                <span className={"ml-2 text-xs " + (active ? "text-orange-100" : "text-[#e08a5c]")}>
                  {i.saving}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {PLANS.map((plan, idx) => {
          const price = priceFor(plan.id, interval);
          const saving = savingVsMonthly(plan.id, interval);
          const featured = idx === 0;
          return (
            <div
              key={plan.id}
              className={
                "flex flex-col rounded-lg border p-7 " +
                (featured
                  ? "border-[#c8551f] bg-white text-gray-900 shadow-xl"
                  : "border-gray-200 bg-white text-gray-900")
              }
            >
              <div className="font-mono text-xs uppercase tracking-widest text-[#a8441a]">
                {plan.label}
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-5xl font-black tracking-tight">{dollars(price)}</span>
                <span className="text-gray-500">{iv.cadence}</span>
              </div>
              <div className="mt-1 h-5 text-sm text-gray-500">
                {interval !== "monthly" &&
                  "Works out to " +
                    dollars(perMonth(plan.id, interval)) +
                    "/mo, saving " +
                    dollars(saving)}
              </div>
              <p className="mt-4 h-6 text-sm text-gray-600">{plan.blurb}</p>
              <ul className="mt-4 space-y-2 text-sm text-gray-700">
                <li>Everything in ShopWorks</li>
                <li>Unlimited customer portal logins</li>
                <li>14-day free trial, no card</li>
              </ul>
              <div className="flex-1" />
              <Link
                href="/signup"
                className={
                  "mt-8 block rounded-md px-4 py-3 text-center font-semibold transition-colors " +
                  (featured
                    ? "bg-[#c8551f] text-white hover:bg-[#a8441a]"
                    : "border border-gray-300 text-gray-900 hover:border-gray-900")
                }
              >
                Start free trial
              </Link>
            </div>
          );
        })}
      </div>

      <div className="mt-8 rounded-lg border border-[#2a333d] bg-[#11161b] p-6 text-gray-300 md:flex md:items-center md:justify-between md:gap-8">
        <div>
          <div className="font-semibold text-white">
            {ONBOARDING.label}: {dollars(ONBOARDING.price) + " once"}, and it&apos;s optional
          </div>
          <p className="mt-1 max-w-2xl text-sm">
            Fill in three spreadsheets &mdash; your raw material, your products, and
            the bill of material behind each one &mdash; and we load them for you, so
            you start with your own shop in ShopWorks instead of an empty one. Tick
            the box when you subscribe.
          </p>
        </div>
      </div>
    </div>
  );
}

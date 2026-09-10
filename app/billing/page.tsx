// ---------------------------------------------------------------------------
// Trial, plan and setup. The only page in the app that talks about money.
//
// ⚠️ WHY THIS IS AT /billing AND NOT UNDER /admin
// The admin layout replaces everything with the locked-out screen when a shop's
// trial has ended - which is the whole point of it. A page whose entire job is
// to get a locked shop UNlocked therefore cannot live underneath that layout,
// or it would lock itself away at exactly the moment it is needed. It sits at
// the top level and does its own checks instead. /admin/billing is kept as a
// redirect so old links and bookmarks still land here.
//
// There is no checkout yet. Choosing a plan records the choice and tells the
// ShopWorks owner; a person does the rest. The wording is careful never to
// imply otherwise.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../lib/supabase-server";
import { getShopAccess } from "../lib/shop-access";
import PlanPicker from "./PlanPicker";

const SUPPORT_EMAIL = "support@mhcfab.com";

const SETUP_STEPS = [
  {
    href: "/admin/settings",
    title: "Set your shop rates",
    body: "Labor rate, shop burden and material markup. Every job cost in ShopWorks is built on these three numbers, so it is worth doing first.",
  },
  {
    href: "/admin/customers",
    title: "Add your customers",
    body: "Just the ones you are actively quoting. You can give each of them a portal login later if you want them to see their own jobs.",
  },
  {
    href: "/admin/inventory",
    title: "Load your material",
    body: "What is on the rack, by shape and length. This is the part a spreadsheet import handles best - send us yours and we will load it for you.",
  },
  {
    href: "/admin/product-templates",
    title: "Build a product template",
    body: "One product, with its bill of materials and its tasks. Once one exists, quoting the next job like it takes a minute.",
  },
  {
    href: "/admin/employees",
    title: "Invite your crew",
    body: "Floor logins are free to add and do not change what you pay. Anyone you invite can clock in and update jobs from a tablet.",
  },
];

export default async function BillingPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const access = await getShopAccess(supabase);

  // This page is the shop owner's. There is nothing here for the crew, and
  // nothing here for a customer portal login.
  if (access && access.role !== "admin") {
    redirect("/");
  }

  const state = access?.state ?? null;
  const daysLeft = access?.daysLeft ?? null;
  const shopName = access?.shopName || "";

  // Read the plan they have already asked for, if any, so the page does not
  // invite them to choose all over again.
  let requestedPlan: string | null = null;
  let requestedAt: string | null = null;

  if (access?.companyId) {
    const { data: companyRow } = await supabase
      .from("companies")
      .select("requested_plan, plan_requested_at")
      .eq("id", access.companyId)
      .maybeSingle();
    requestedPlan = (companyRow?.requested_plan as string) || null;
    requestedAt = (companyRow?.plan_requested_at as string) || null;
  }

  const trialEnds = access?.trialEndsAt
    ? new Date(access.trialEndsAt).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Trial and subscription
            </h1>
            <p className="text-gray-600">{shopName}</p>
          </div>
          {state !== "locked" && (
            <Link href="/admin" className="text-sm text-blue-600 hover:underline">
              Back to the app
            </Link>
          )}
        </div>

        {state === "ok" && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8">
            <p className="text-sm font-medium text-green-700 mb-1">Active</p>
            <p className="text-gray-600">
              This shop&apos;s subscription is active. There is nothing you need
              to do here.
            </p>
          </div>
        )}

        {state === "trial" && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8">
            <p className="text-sm font-medium text-blue-700 mb-1">Free trial</p>
            <p className="text-2xl font-bold text-gray-900 mb-2">
              {daysLeft === 0
                ? "Ends today"
                : daysLeft === 1
                ? "1 day left"
                : daysLeft + " days left"}
            </p>
            {trialEnds && (
              <p className="text-gray-600 mb-4">Your trial runs until {trialEnds}.</p>
            )}
            <p className="text-gray-600">
              Everything is switched on during the trial — there is no cut-down
              version. When it ends, the app pauses until a subscription starts.
              Nothing is deleted: your jobs, material and hours stay exactly
              where they are and come straight back.
            </p>
          </div>
        )}

        {state === "locked" && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 mb-8">
            <p className="text-sm font-medium text-amber-900 mb-1">Paused</p>
            <p className="text-amber-900">
              Your free trial has ended, so the app is paused. Nothing has been
              deleted — every job, every material record and every hour logged
              is exactly where you left it. Pick a plan below and we will switch
              it back on.
            </p>
          </div>
        )}

        {(state === "trial" || state === "locked") && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8">
            <h2 className="text-lg font-bold text-gray-900 mb-1">
              {state === "locked" ? "Choose your plan" : "What it costs afterwards"}
            </h2>
            <p className="text-gray-600 mb-4">
              Tell us which one fits and we will get you set up. There is no card
              form here yet — a person handles it, usually the same working day.
            </p>
            <PlanPicker currentRequest={requestedPlan} requestedAt={requestedAt} />
          </div>
        )}

        {state !== "locked" && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Getting set up</h2>
            <p className="text-gray-600 mb-4">
              A new shop starts empty on purpose — it is your shop, not a demo.
              This is the order that works.
            </p>
            <ol className="space-y-4">
              {SETUP_STEPS.map((step, i) => (
                <li key={step.href} className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-100 text-gray-700 text-sm font-medium flex items-center justify-center">
                    {i + 1}
                  </span>
                  <div>
                    <Link
                      href={step.href}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {step.title}
                    </Link>
                    <p className="text-sm text-gray-600">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="text-sm text-gray-500">
          <a
            href={"mailto:" + SUPPORT_EMAIL}
            className="text-blue-600 hover:underline"
          >
            {SUPPORT_EMAIL}
          </a>
          {state !== "locked" && (
            <>
              <span className="mx-2">&middot;</span>
              <Link href="/new-shop" className="text-blue-600 hover:underline">
                Start another shop
              </Link>
            </>
          )}
          <span className="mx-2">&middot;</span>
          <Link href="/terms" className="hover:text-blue-600 hover:underline">
            Terms of Service
          </Link>
          <span className="mx-2">&middot;</span>
          <Link href="/privacy" className="hover:text-blue-600 hover:underline">
            Privacy Policy
          </Link>
        </div>
      </div>
    </div>
  );
}

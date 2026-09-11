// ---------------------------------------------------------------------------
// Trial, subscription and setup. The only page in the app that talks about
// money.
//
// ⚠️ WHY THIS IS AT /billing AND NOT UNDER /admin
// The admin layout replaces everything with the locked-out screen when a
// shop's subscription lapses - which is the whole point of it. A page whose
// entire job is to get a locked shop UNlocked therefore cannot live underneath
// that layout, or it would lock itself away at exactly the moment it is
// needed. It sits at the top level and does its own checks instead.
// /admin/billing is kept as a redirect so old links and bookmarks still land
// here.
//
// The detail on this page comes from my_billing_summary(), which refuses
// anybody who is not the shop's admin. That is deliberate and it is not the
// same function the layouts use: my_shop_access() is called on every page
// including the customer portal, so a fabricator's customers can read whatever
// it returns. The plan, the price and the renewal date are not their business.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../lib/supabase-server";
import { getShopAccess } from "../lib/shop-access";
import PlanPicker from "./PlanPicker";
import ManageBillingButton from "./ManageBillingButton";
import { isTestMode } from "../lib/stripe";
import {
  planById,
  intervalById,
  priceLabel,
  planForLoginCount,
  trialCanCarryOver,
  type PlanId,
} from "../lib/plans";

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
    body: "Floor logins count towards your plan, and only people who actually log in count. Anyone you invite can clock in and update jobs from a tablet.",
  },
];

type BillingRow = {
  company_id: string;
  shop_name: string;
  subscription_status: string;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  plan_id: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  has_subscription: boolean;
  requested_plan: string | null;
  plan_requested_at: string | null;
  login_count: number;
};

function longDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const checkout = typeof params.checkout === "string" ? params.checkout : null;

  // ⚠️ IS THIS DEPLOYMENT WIRED TO A STRIPE SANDBOX?
  // The one genuinely expensive mistake available here is shipping to real
  // customers with a test key still in Vercel: every checkout would appear to
  // work, nobody would be charged, and there is nothing in the app that would
  // complain. So the page says so, loudly, whenever the key starts sk_test_.
  // In live mode this renders nothing at all.
  const testMode = isTestMode();

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

  // Everything else comes from the admin-only function.
  const { data: summaryData } = await supabase.rpc("my_billing_summary");
  const summary = ((summaryData || []) as unknown as BillingRow[])[0] || null;

  const shopName = summary?.shop_name || access?.shopName || "";
  const plan = planById(summary?.plan_id);
  const interval = intervalById(summary?.billing_interval);
  const loginCount = summary?.login_count ?? null;
  const needsBand =
    loginCount != null ? planForLoginCount(loginCount) : null;

  const trialEnds = longDate(summary?.trial_ends_at ?? access?.trialEndsAt);
  const graceEnds = longDate(summary?.grace_ends_at ?? access?.graceEndsAt);
  const renews = longDate(summary?.current_period_end);

  // Will Stripe accept their remaining trial days, or do they start paying
  // today? The page has to say which before they press a button - see
  // trialCanCarryOver in app/lib/plans.ts for the 48-hour rule behind it.
  const trialCarriesOver =
    state === "trial" &&
    trialCanCarryOver(summary?.trial_ends_at ?? access?.trialEndsAt ?? null);

  const hasSubscription = summary?.has_subscription === true;

  // The pre-Stripe "this is the plan we want" note. Only worth showing if they
  // left one and have not since subscribed.
  const requested = planById(summary?.requested_plan);

  // Offer the picker to anyone who is not already paying through Stripe. That
  // includes a shop on trial (subscribing early is allowed and keeps their
  // trial days) and a shop that is locked out.
  const showPicker = !hasSubscription && state !== "ok";

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-8">
        {testMode && (
          <div className="mb-6 rounded-lg border-2 border-dashed border-amber-400 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">
              Stripe test mode
            </p>
            <p className="text-sm text-amber-900">
              This deployment is pointed at a Stripe sandbox. Anything bought on
              this page uses a test card and takes no real money. If you are
              seeing this on the real shopworks.app, the live Stripe key is
              missing from Vercel.
            </p>
          </div>
        )}

        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Subscription and setup
            </h1>
            <p className="text-gray-600">{shopName}</p>
          </div>
          {state !== "locked" && (
            <Link href="/admin" className="text-sm text-blue-600 hover:underline">
              Back to the app
            </Link>
          )}
        </div>

        {/* --------------------------------------------------------------- */}
        {/* Just back from Stripe                                           */}
        {/* --------------------------------------------------------------- */}
        {checkout === "success" && (
          <div className="mb-8 rounded-lg border border-green-200 bg-green-50 p-6">
            <p className="mb-1 text-sm font-medium text-green-900">Thank you.</p>
            <p className="text-green-900">
              Your payment went through. Stripe tells ShopWorks a second or two
              later, so if this page still shows the old state, refresh it once
              and it will have caught up.
            </p>
          </div>
        )}

        {checkout === "cancelled" && (
          <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
            <p className="mb-1 text-sm font-medium text-gray-900">
              Nothing was charged.
            </p>
            <p className="text-gray-600">
              You came back without finishing. Your shop is exactly as it was.
            </p>
          </div>
        )}

        {/* --------------------------------------------------------------- */}
        {/* Where this shop stands                                          */}
        {/* --------------------------------------------------------------- */}
        {state === "ok" && (
          <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
            <p className="mb-1 text-sm font-medium text-green-700">Active</p>

            {plan && interval ? (
              <>
                <p className="mb-2 text-2xl font-bold text-gray-900">
                  {priceLabel(plan.id as PlanId, interval.id)}
                </p>
                <p className="text-gray-600">
                  {plan.label}, billed {interval.label.toLowerCase()}.
                </p>
              </>
            ) : (
              <p className="text-gray-600">
                This shop&apos;s subscription is active.
              </p>
            )}

            {summary?.cancel_at_period_end ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                This subscription is set to end{renews ? " on " + renews : ""}.
                Everything keeps working until then, and nothing will be
                deleted afterwards. You can turn the cancellation off again in
                Manage billing.
              </p>
            ) : (
              renews && (
                <p className="mt-2 text-sm text-gray-500">Renews {renews}.</p>
              )
            )}

            {hasSubscription && (
              <div className="mt-4">
                <ManageBillingButton tone="quiet" />
                <p className="mt-2 text-sm text-gray-500">
                  Update your card, download invoices, change plan or cancel.
                </p>
              </div>
            )}
          </div>
        )}

        {state === "trial" && (
          <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
            <p className="mb-1 text-sm font-medium text-blue-700">Free trial</p>
            <p className="mb-2 text-2xl font-bold text-gray-900">
              {daysLeft === 0
                ? "Ends today"
                : daysLeft === 1
                ? "1 day left"
                : daysLeft + " days left"}
            </p>
            {trialEnds && (
              <p className="mb-4 text-gray-600">
                Your trial runs until {trialEnds}.
              </p>
            )}
            <p className="text-gray-600">
              Everything is switched on during the trial — there is no cut-down
              version. When it ends, the app pauses until a subscription
              starts. Nothing is deleted: your jobs, material and hours stay
              exactly where they are and come straight back.
            </p>
          </div>
        )}

        {state === "grace" && (
          <div className="mb-8 rounded-lg border border-red-200 bg-red-50 p-6">
            <p className="mb-1 text-sm font-medium text-red-900">
              Payment failed
            </p>
            <p className="mb-4 text-red-900">
              Your last payment did not go through. ShopWorks keeps working
              {graceEnds ? " until " + graceEnds : " for a few more days"}, and
              then it pauses until the payment clears. Nothing has been
              deleted, and nobody else at your shop is being shown this.
            </p>
            <ManageBillingButton label="Update payment method" />
            <p className="mt-3 text-sm text-red-900">
              Stripe keeps retrying the card on its own as well. If one of those
              goes through, this clears by itself.
            </p>
          </div>
        )}

        {state === "locked" && (
          <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-6">
            <p className="mb-1 text-sm font-medium text-amber-900">Paused</p>
            <p className="text-amber-900">
              {hasSubscription
                ? "Your subscription has lapsed, so the app is paused."
                : "Your free trial has ended, so the app is paused."}{" "}
              Nothing has been deleted — every job, every material record and
              every hour logged is exactly where you left it. Start a
              subscription below and it comes straight back on.
            </p>
            {hasSubscription && (
              <div className="mt-4">
                <ManageBillingButton label="Update payment method" />
              </div>
            )}
          </div>
        )}

        {/* --------------------------------------------------------------- */}
        {/* Choose a plan                                                   */}
        {/* --------------------------------------------------------------- */}
        {showPicker && (
          <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="mb-1 text-lg font-bold text-gray-900">
              {state === "locked" ? "Choose your plan" : "What it costs afterwards"}
            </h2>
            <p className="mb-4 text-gray-600">
              Every plan is the whole of ShopWorks. Pick the band that fits how
              many people at your shop log in.
            </p>

            {requested && (
              <p className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
                You told us earlier you wanted the {requested.label} plan. You
                can go ahead and start it yourself now — no waiting for us.
              </p>
            )}

            {needsBand && loginCount != null && loginCount > 15 && (
              <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                You have {loginCount} shop logins, so you need the{" "}
                {needsBand.label} plan or larger.
              </p>
            )}

            <PlanPicker
              trialDaysLeft={state === "trial" ? daysLeft : null}
              trialCarriesOver={trialCarriesOver}
              suggestedPlan={(needsBand?.id as PlanId) ?? null}
              loginCount={loginCount}
            />
          </div>
        )}

        {/* --------------------------------------------------------------- */}
        {/* Getting set up                                                  */}
        {/* --------------------------------------------------------------- */}
        {state !== "locked" && (
          <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="mb-1 text-lg font-bold text-gray-900">
              Getting set up
            </h2>
            <p className="mb-4 text-gray-600">
              A new shop starts empty on purpose — it is your shop, not a demo.
              This is the order that works.
            </p>
            <ol className="space-y-4">
              {SETUP_STEPS.map((step, i) => (
                <li key={step.href} className="flex gap-3">
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-medium text-gray-700">
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

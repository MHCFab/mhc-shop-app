// ---------------------------------------------------------------------------
// Trial and setup. The only page in the app that talks about subscriptions.
//
// Two audiences at once:
//   * a shop on a trial, who needs to know how long is left, what to do
//     before it runs out, and what it costs after;
//   * MHC Fab, which is a paid shop and just sees "active".
//
// There is no self-serve payment here yet - Stripe is the next piece of work -
// so the honest instruction is "email us", and that is what it says. Do not
// let this page promise a checkout that does not exist.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "../../lib/supabase-server";
import { getShopAccess } from "../../lib/shop-access";

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

  // getShopAccess deliberately returns null when it cannot tell. On this page
  // that means we simply do not claim anything about the subscription.
  const state = access?.state ?? null;
  const daysLeft = access?.daysLeft ?? null;
  const shopName = access?.shopName || "";

  const trialEnds = access?.trialEndsAt
    ? new Date(access.trialEndsAt).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Trial and setup</h1>
      <p className="text-gray-600 mb-6">{shopName}</p>

      {state === "ok" && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8">
          <p className="text-sm font-medium text-green-700 mb-1">Active</p>
          <p className="text-gray-600">
            This shop&apos;s subscription is active. There is nothing you need to
            do here.
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
            Nothing is deleted: your jobs, material and hours stay exactly where
            they are and come straight back.
          </p>
        </div>
      )}

      {state === "locked" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 mb-8">
          <p className="text-sm font-medium text-amber-900 mb-1">Paused</p>
          <p className="text-amber-900">
            This shop&apos;s trial has ended. Nothing has been deleted. Email{" "}
            <a href={"mailto:" + SUPPORT_EMAIL} className="underline">
              {SUPPORT_EMAIL}
            </a>{" "}
            and we will switch it back on.
          </p>
        </div>
      )}

      {state === "trial" && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-bold text-gray-900 mb-3">
            What it costs afterwards
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4 font-medium">Shop logins</th>
                  <th className="py-2 font-medium">Per month</th>
                </tr>
              </thead>
              <tbody className="text-gray-900">
                <tr className="border-b border-gray-100">
                  <td className="py-2 pr-4">1 to 15</td>
                  <td className="py-2">$149</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-2 pr-4">16 to 50</td>
                  <td className="py-2">$249</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">51 to 150</td>
                  <td className="py-2">$399</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm text-gray-600 mt-4">
            Every price includes the whole of ShopWorks — no modules, no
            feature tiers, nothing held back. Shop logins means admin and floor
            together, and only the people who actually log in. Logins for your
            own customers are unlimited and free.
          </p>
          <p className="text-sm text-gray-600 mt-3">
            There is no checkout here yet. When you are ready, email{" "}
            <a href={"mailto:" + SUPPORT_EMAIL} className="text-blue-600 hover:underline">
              {SUPPORT_EMAIL}
            </a>{" "}
            and we will get you set up.
          </p>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8">
        <h2 className="text-lg font-bold text-gray-900 mb-1">Getting set up</h2>
        <p className="text-gray-600 mb-4">
          A new shop starts empty on purpose — it is your shop, not a demo. This
          is the order that works.
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

      <div className="text-sm text-gray-500">
        <Link href="/new-shop" className="text-blue-600 hover:underline">
          Start another shop
        </Link>
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
  );
}

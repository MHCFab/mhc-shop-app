// ---------------------------------------------------------------------------
// shopworks.app - the front door.
//
// Signed in?  Straight into the app, exactly as before: admin -> /admin,
//             customer -> /portal, everyone else -> /floor. Nobody at a shop
//             that already uses ShopWorks should ever notice this page exists.
// Not signed in?  The landing page, with Sign in at the top right.
//
// LANDING-PAGE-V1
//
// ⚠️ The Supabase calls here are capped at 2 seconds each. If Supabase is slow
// or down, a visitor gets the landing page (and its Sign in button) instead of
// a page that hangs - the same rule middleware.ts follows.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "./lib/supabase-server";
import PricingTable from "./components/landing/PricingTable";
import AuthHashForwarder from "./components/landing/AuthHashForwarder";
import { PLANS } from "./lib/plans";

// System fonts on purpose: next/font/google fetches from Google AT BUILD TIME,
// and a build that can fail because somebody else's server is slow is not a
// trade worth making for a typeface.
const SANS =
  '"Helvetica Neue", "Segoe UI", Roboto, Arial, system-ui, sans-serif';

const PAGE_TITLE = "ShopWorks | Fabrication & Job Shop Management Software";
const PAGE_DESCRIPTION =
  "Shop management software built by a metal fabricator: jobs, raw material inventory, cutting nests, a shop floor app, job costing and a customer portal. One flat price per shop, from $149/month. 14-day free trial, no card.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "ShopWorks",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

// What Google reads to show ShopWorks as a software product with a price
// (SEO-BASICS-V1). Prices come from plans.ts so they can't drift from checkout.
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ShopWorks",
  url: "https://www.shopworks.app/",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Shop management software for fabrication and job shops",
  operatingSystem: "Web browser",
  description: PAGE_DESCRIPTION,
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: Math.min(...PLANS.map((p) => p.prices.monthly)),
    highPrice: Math.max(...PLANS.map((p) => p.prices.monthly)),
    offerCount: PLANS.length,
  },
  publisher: {
    "@type": "Organization",
    name: "Mad House Customs LLC",
    url: "https://www.shopworks.app/",
    email: "support@mhcfab.com",
  },
};

const TIMEOUT_MS = 2000;

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

async function signedInHome(): Promise<string | null> {
  try {
    const supabase = await createServerSupabaseClient();
    const userResult = await withTimeout(supabase.auth.getUser(), TIMEOUT_MS);
    const user = userResult?.data?.user ?? null;
    if (!user) return null;

    const profileResult = await withTimeout(
      supabase.from("profiles").select("role").eq("id", user.id).single(),
      TIMEOUT_MS
    );
    const role = profileResult?.data?.role;
    if (role === "admin") return "/admin";
    if (role === "customer") return "/portal";
    return "/floor";
  } catch {
    return null;
  }
}

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Jobs from templates",
    body: "Build a product once - bill of material, cut list, tasks - and every new job for it fills itself in. Several products on one job, and changes after it starts.",
  },
  {
    title: "Raw material that adds up",
    body: "Bar, tube, sheet and plate by shape and size. Pull it to jobs, save your drops as remnants, and see shortfalls before the job hits the floor.",
  },
  {
    title: "Cutting nests",
    body: "Lay a job's cut list onto stock lengths, use your drops first, and send the floor a nest they can cut from, one tab per material.",
  },
  {
    title: "A floor screen your crew will use",
    body: "Big buttons on a tablet or phone. Clock onto a task, see the estimated time, read the job notes, and acknowledge them before starting.",
  },
  {
    title: "Real job costing",
    body: "Planned against actual for material, parts and labor on every job, rolled into a cost report and a suggested price - so the next quote is better than the last.",
  },
  {
    title: "A portal for your customers",
    body: "Your customers see their jobs, place orders, ask for changes and message you, without phoning the shop. Customer logins are free and unlimited.",
  },
  {
    title: "Purchased parts and stock items",
    body: "Hardware, fasteners and fabricated items you keep on the shelf, with catalog costs that keep up with what you actually paid.",
  },
  {
    title: "Finances",
    body: "Your shop rate, break-even and monthly targets in one place. Connect QuickBooks Online and it fills in the numbers for you.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need a card for the trial?",
    a: "No. You get 14 days with everything turned on. If you decide to keep going, pick a plan and pay by card through Stripe.",
  },
  {
    q: "What counts as a shop login?",
    a: "Anyone at your shop who signs in - office or floor. If you have 20 people but only 12 of them log in, you are on the 1 to 15 plan. Customer portal logins never count.",
  },
  {
    q: "Are any features held back for bigger plans?",
    a: "No. Every plan gets all of ShopWorks. The only thing that changes is how many people at your shop can log in.",
  },
  {
    q: "What if I stop paying?",
    a: "Your shop is locked, not deleted. Your data stays where it is, and paying again opens it back up.",
  },
  {
    q: "Can I cancel?",
    a: "Any time, from the billing page. You keep access to the end of the period you already paid for.",
  },
  {
    q: "What does onboarding get me?",
    a: "Three spreadsheets to fill in on your own computer - raw material, products, and the bill of material for each product. Send them back and we load them, so day one is your shop, not a blank screen.",
  },
  {
    q: "What does it run on?",
    a: "Any modern web browser - the office PC, a tablet on the floor, or a phone. Nothing to install.",
  },
  {
    q: "How do I get help?",
    a: "Email support@mhcfab.com. We answer Monday to Friday, 7am to 4pm Eastern.",
  },
];

export default async function HomePage() {
  const home = await signedInHome();
  if (home) redirect(home);

  return (
    <div className="bg-[#181e24] text-white antialiased" style={{ fontFamily: SANS }}>
      <AuthHashForwarder />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />

      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-20 border-b border-[#2a333d] bg-[#181e24]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <Link href="/" className="flex items-center gap-2 text-xl font-black tracking-tight">
            <span className="inline-block h-3 w-3 rotate-45 bg-[#c8551f]" aria-hidden />
            ShopWorks
          </Link>
          <nav className="flex items-center gap-2 text-sm sm:gap-5">
            <a href="#features" className="hidden text-gray-300 hover:text-white sm:inline">
              What&apos;s in it
            </a>
            <a href="#pricing" className="hidden text-gray-300 hover:text-white sm:inline">
              Pricing
            </a>
            <Link
              href="/login"
              className="rounded-md border border-gray-500 px-4 py-2 font-semibold hover:border-white"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="hidden rounded-md bg-[#c8551f] px-4 py-2 font-semibold hover:bg-[#a8441a] sm:inline-block"
            >
              Free trial
            </Link>
          </nav>
        </div>
      </header>

      {/* -------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(#ffffff 1px, transparent 1px), linear-gradient(90deg, #ffffff 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-5 pb-24 pt-20 md:pt-28">
          <div className="font-mono text-xs uppercase tracking-[0.25em] text-[#e08a5c]">
            Shop management for fabrication and job shops
          </div>
          <h1 className="mt-5 max-w-4xl text-5xl font-black leading-[1.02] tracking-tight md:text-7xl">
            Shop software built by a fabricator.
          </h1>
          <p className="mt-7 max-w-2xl text-lg text-gray-300 md:text-xl">
            Jobs, material, the shop floor, job costing and a customer portal &mdash; the
            parts of an ERP a real shop uses, without the five-figure price tag or the
            six-month rollout.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href="/signup"
              className="rounded-md bg-[#c8551f] px-6 py-4 text-lg font-bold hover:bg-[#a8441a]"
            >
              Start your 14-day free trial
            </Link>
            <a
              href="#pricing"
              className="rounded-md border border-gray-500 px-6 py-4 text-lg font-semibold hover:border-white"
            >
              See pricing
            </a>
          </div>
          <p className="mt-4 text-sm text-gray-400">No card. No demo call. No sales rep.</p>
        </div>
      </section>

      {/* ------------------------------------------------------------- story */}
      <section className="border-y border-[#2a333d] bg-[#11161b]">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-[1fr_2fr]">
          <div className="font-mono text-xs uppercase tracking-[0.25em] text-[#e08a5c]">
            Where it came from
          </div>
          <div className="space-y-4 text-lg text-gray-300">
            <p>
              ShopWorks was built inside MHC Fab, a miscellaneous metals shop in
              Troutman, North Carolina, to run our own work &mdash; stairs, railings,
              ladders, gates and structural steel &mdash; for commercial construction
              and defense customers.
            </p>
            <p>
              It runs our shop every day: every job, every stick of material, every
              hour on the floor. If something in it is awkward, we&apos;re the first to
              find out, because we use it too.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- features */}
      <section id="features" className="scroll-mt-20 bg-gray-50 text-gray-900">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="font-mono text-xs uppercase tracking-[0.25em] text-[#a8441a]">
            What&apos;s in it
          </div>
          <h2 className="mt-3 max-w-3xl text-4xl font-black tracking-tight md:text-5xl">
            Everything, on every plan.
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-gray-600">
            No add-on modules, no feature tiers, nothing to unlock later. Inventory,
            bills of material and invoicing aren&apos;t extras here &mdash; they&apos;re the
            job.
          </p>
          <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="bg-white p-6">
                <div className="font-mono text-xs text-[#a8441a]">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <h3 className="mt-2 text-lg font-extrabold">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- pricing */}
      <section id="pricing" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="text-center">
            <div className="font-mono text-xs uppercase tracking-[0.25em] text-[#e08a5c]">
              Pricing
            </div>
            <h2 className="mt-3 text-4xl font-black tracking-tight md:text-5xl">
              One price. Everything in it.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-300">
              A flat price per shop, set by how many of your people log in. No per-user
              fees, no quote, no demo to book before you find out what it costs.
            </p>
          </div>
          <div className="mt-10">
            <PricingTable />
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- faq */}
      <section className="bg-gray-50 text-gray-900">
        <div className="mx-auto max-w-4xl px-5 py-20">
          <h2 className="text-4xl font-black tracking-tight">Questions</h2>
          <dl className="mt-10 divide-y divide-gray-200 border-y border-gray-200">
            {FAQ.map((item) => (
              <div key={item.q} className="py-6 md:grid md:grid-cols-[2fr_3fr] md:gap-8">
                <dt className="font-extrabold">{item.q}</dt>
                <dd className="mt-2 text-gray-600 md:mt-0">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* --------------------------------------------------------------- cta */}
      <section className="border-t border-[#2a333d]">
        <div className="mx-auto max-w-6xl px-5 py-20 text-center">
          <h2 className="text-4xl font-black tracking-tight md:text-5xl">
            Put your shop in it for two weeks.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-gray-300">
            Free for 14 days, no card. If it doesn&apos;t earn its keep, walk away.
          </p>
          <Link
            href="/signup"
            className="mt-8 inline-block rounded-md bg-[#c8551f] px-8 py-4 text-lg font-bold hover:bg-[#a8441a]"
          >
            Start your free trial
          </Link>
        </div>
      </section>

      {/* ------------------------------------------------------------ footer */}
      <footer className="border-t border-[#2a333d] bg-[#11161b] text-sm text-gray-400">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 md:flex-row md:items-center md:justify-between">
          <div>&copy; Mad House Customs LLC, Troutman, North Carolina</div>
          <div className="flex flex-wrap gap-5">
            <Link href="/login" className="hover:text-white">Sign in</Link>
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
            <a href="mailto:support@mhcfab.com" className="hover:text-white">support@mhcfab.com</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

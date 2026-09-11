// ---------------------------------------------------------------------------
// "Take me to the checkout."
//
// This route does NOT switch anything on. It builds a Stripe Checkout Session
// and hands back its URL; the browser goes there, Stripe takes the card, and
// the WEBHOOK is what writes to our database. That separation is deliberate:
// a person who closes the tab halfway, or a network that drops on the way
// back, must not leave a shop switched on without a payment or switched off
// with one. Stripe retries the webhook; a browser redirect gets one attempt.
//
// ⚠️ THE TRIAL RULE, AND THE 48-HOUR TRAP.
// A shop part-way through its free trial keeps the days it has left: we pass
// their existing trial_ends_at to Stripe as the subscription's trial end, so
// the first charge lands on the day the trial would have run out anyway.
// BUT STRIPE REFUSES A trial_end LESS THAN 48 HOURS AWAY. So a shop with a day
// and a half left, or a shop already locked out, simply starts paying today.
// That is handled below, and the page says which one is about to happen so
// nobody is surprised by the number on Stripe's page.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { appBaseUrl } from "@/app/lib/email";
import {
  planById,
  intervalById,
  lookupKey,
  trialCanCarryOver,
  ONBOARDING,
  type PlanId,
  type IntervalId,
} from "@/app/lib/plans";
import { getStripe, stripeConfigured, resolvePriceId } from "@/app/lib/stripe";

export async function POST(req: NextRequest) {
  try {
    if (!stripeConfigured()) {
      return NextResponse.json(
        {
          error:
            "Card payments are not switched on yet. Please email " +
            "support@mhcfab.com and we will get you set up.",
        },
        { status: 503 }
      );
    }

    const body = await req.json();
    const planId = String(body?.plan ?? "").trim() as PlanId;
    const intervalId = String(body?.interval ?? "monthly").trim() as IntervalId;
    const wantsOnboarding = body?.onboarding === true;

    const plan = planById(planId);
    const interval = intervalById(intervalId);

    if (!plan || !interval) {
      return NextResponse.json(
        { error: "That is not a plan we offer." },
        { status: 400 }
      );
    }

    // ------------------------------------------------------------------
    // Who is asking, and are they allowed to spend this shop's money?
    // ------------------------------------------------------------------
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {
            // no-op in a route handler
          },
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role, company_id, full_name, email")
      .eq("id", user.id)
      .single();

    if (!profile || profile.role !== "admin") {
      return NextResponse.json(
        { error: "Only the shop owner can start a subscription." },
        { status: 403 }
      );
    }

    const companyId = profile.company_id as string;
    if (!companyId) {
      return NextResponse.json(
        { error: "There is no shop on this login." },
        { status: 400 }
      );
    }

    // ------------------------------------------------------------------
    // The shop's row.
    //
    // Read through the SERVICE ROLE rather than the caller's own permissions,
    // for one reason: this route has to WRITE stripe_customer_id back, and the
    // guard trigger on companies refuses that from a signed-in person by
    // design. Reading through the same client keeps the read and the write
    // looking at the same thing. The company id still comes from the caller's
    // own session above, so this cannot be pointed at somebody else's shop.
    // ------------------------------------------------------------------
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: company, error: companyError } = await admin
      .from("companies")
      .select(
        "id, name, subscription_status, trial_ends_at, stripe_customer_id, stripe_subscription_id"
      )
      .eq("id", companyId)
      .single();

    if (companyError || !company) {
      return NextResponse.json(
        { error: "Could not find this shop." },
        { status: 400 }
      );
    }

    // Already subscribed? Changing plan belongs in the billing portal, where
    // Stripe works out the proration. Sending them through checkout again
    // would create a SECOND subscription and bill them twice.
    if (company.stripe_subscription_id) {
      return NextResponse.json(
        {
          error:
            "This shop already has a subscription. Use Manage billing to " +
            "change plan or update the card.",
          alreadySubscribed: true,
        },
        { status: 409 }
      );
    }

    const stripe = getStripe();

    // ------------------------------------------------------------------
    // One Stripe customer per shop, reused forever.
    //
    // The unique index on companies.stripe_customer_id is the real guarantee
    // here; this is just the ordinary path. Two shops sharing one Stripe
    // customer would mean one shop's card paying for another's subscription.
    // ------------------------------------------------------------------
    let customerId = company.stripe_customer_id as string | null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        name: company.name || undefined,
        email: (profile.email as string) || user.email || undefined,
        metadata: {
          company_id: companyId,
          shop_name: company.name || "",
        },
      });
      customerId = customer.id;

      const { error: saveError } = await admin
        .from("companies")
        .update({ stripe_customer_id: customerId })
        .eq("id", companyId);

      // If we cannot remember the customer we just made, stop. Carrying on
      // would create a fresh Stripe customer on every attempt and leave a
      // trail of duplicates with cards attached to them.
      if (saveError) {
        return NextResponse.json(
          {
            error:
              "Could not save the billing account for this shop. Nothing has " +
              "been charged. Please try again in a moment.",
          },
          { status: 500 }
        );
      }
    }

    // ------------------------------------------------------------------
    // What they are buying.
    // ------------------------------------------------------------------
    const line_items: { price: string; quantity: number }[] = [
      { price: await resolvePriceId(lookupKey(planId, intervalId)), quantity: 1 },
    ];

    if (wantsOnboarding) {
      // ⚠️ A one-time price in a subscription checkout goes on the FIRST
      // invoice only - that is Stripe's documented behaviour. With a trial
      // running, the first invoice is raised when the subscription starts,
      // so this is charged now rather than at the end of the trial. Stripe's
      // own checkout page shows the amount due today either way, so the
      // customer always sees the truth before they type a card.
      line_items.push({
        price: await resolvePriceId(ONBOARDING.lookupKey),
        quantity: 1,
      });
    }

    // ------------------------------------------------------------------
    // Do they have trial days left worth carrying over?
    // ------------------------------------------------------------------
    // The 48-hour rule lives in app/lib/plans.ts, so the sentence the billing
    // page shows them and the decision made here can never disagree.
    let trialEnd: number | undefined;

    if (
      company.subscription_status === "trialing" &&
      trialCanCarryOver(company.trial_ends_at as string | null)
    ) {
      trialEnd = Math.floor(
        new Date(company.trial_ends_at as string).getTime() / 1000
      );
    }

    const base = appBaseUrl(req.headers.get("origin"));

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items,

      // Always take a card, even when the trial makes today's total zero.
      // Without this the shop reaches the end of its trial with nothing to
      // charge, which is the one outcome nobody wants.
      payment_method_collection: "always",

      // The Eurowise deal and anything like it are Stripe coupons, entered
      // here rather than built into the app.
      allow_promotion_codes: true,

      billing_address_collection: "auto",

      subscription_data: {
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        description: "ShopWorks - " + plan.label,
        metadata: {
          company_id: companyId,
          plan_id: planId,
          billing_interval: intervalId,
        },
      },

      // Belt and braces: the webhook reads the subscription's metadata first,
      // but a session that never becomes a subscription still tells us who it
      // was for.
      client_reference_id: companyId,
      metadata: {
        company_id: companyId,
        plan_id: planId,
        billing_interval: intervalId,
        onboarding: wantsOnboarding ? "yes" : "no",
      },

      success_url: base + "/billing?checkout=success",
      cancel_url: base + "/billing?checkout=cancelled",
    });

    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe did not return a checkout page. Please try again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

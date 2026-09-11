// ---------------------------------------------------------------------------
// "Manage billing" - hand them over to Stripe's own portal.
//
// Updating a card, downloading invoices, switching band, changing from monthly
// to yearly and cancelling all happen on Stripe's pages, not ours. That is a
// deliberate choice: those screens have to handle 3-D Secure, declined cards,
// prorations and tax, and every one of them is a place to get something wrong
// with somebody else's money.
//
// ⚠️ WHAT THEY MAY DO IN THERE IS NOT DECIDED HERE. It comes from the portal
// CONFIGURATION, which scripts/stripe-setup.mjs creates. The rules it sets:
//   * upgrades apply immediately and what they already paid is credited;
//   * downgrades and interval shortenings are SCHEDULED for the end of the
//     period they have paid for - they ride it out, no money goes back;
//   * cancelling takes effect at the end of the period, with no refund.
// If you change that, change it in the setup script so it is written down.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { appBaseUrl } from "@/app/lib/email";
import {
  getStripe,
  stripeConfigured,
  resolvePortalConfigurationId,
} from "@/app/lib/stripe";

export async function POST(req: NextRequest) {
  try {
    if (!stripeConfigured()) {
      return NextResponse.json(
        { error: "Card payments are not switched on yet." },
        { status: 503 }
      );
    }

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
      .select("role, company_id")
      .eq("id", user.id)
      .single();

    if (!profile || profile.role !== "admin") {
      return NextResponse.json(
        { error: "Only the shop owner can manage billing." },
        { status: 403 }
      );
    }

    // The customer id is read through the caller's OWN permissions. An admin
    // can read their own shop's row, and companies_self_read makes sure that
    // is the only row they can read - so this cannot be aimed at another shop
    // even if somebody edited the request.
    const { data: company } = await supabase
      .from("companies")
      .select("stripe_customer_id")
      .eq("id", profile.company_id)
      .maybeSingle();

    const customerId = (company?.stripe_customer_id as string) || null;

    if (!customerId) {
      return NextResponse.json(
        {
          error:
            "There is no billing account for this shop yet. Choose a plan " +
            "first.",
        },
        { status: 400 }
      );
    }

    const stripe = getStripe();
    const base = appBaseUrl(req.headers.get("origin"));

    // ⚠️ ALWAYS ASK FOR OUR OWN CONFIGURATION BY NAME, never let Stripe fall
    // back to the account default. The rules above - prorate upgrades, schedule
    // downgrades, no refunds - live in the configuration that
    // scripts/stripe-setup.mjs creates, and the default is whatever else that
    // Stripe account happens to be doing.
    const configuration = await resolvePortalConfigurationId();

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: base + "/billing",
      ...(configuration ? { configuration } : {}),
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

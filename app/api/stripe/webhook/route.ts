// ---------------------------------------------------------------------------
// What Stripe tells us. THIS IS THE ONLY PLACE A SHOP GETS SWITCHED ON.
//
// Nothing a browser can reach writes subscription_status. The guard trigger on
// companies refuses it from a signed-in person, and the checkout route
// deliberately does not do it either - it only sends somebody to Stripe. So
// this file is the whole story of how a shop becomes paid up, and if it is
// broken, nobody can pay. Treat it accordingly.
//
// ⚠️ IT WRITES WITH THE SERVICE ROLE. That is what walks past the guard, and
// it is also why the FIRST thing this route does is check Stripe's signature.
// An unsigned request reaching the code below could switch on any shop it
// liked. Nothing is read out of the body until the signature has passed.
//
// ⚠️ STRIPE SENDS THE SAME EVENT TWICE, and says so - that is how it
// guarantees delivery at all. Every event id is claimed in stripe_events
// before it is acted on, so a repeat is dropped. Without that, a duplicated
// invoice.payment_failed would restart the seven-day clock and a shop would
// have grace forever.
//
// ⚠️ AN ERROR HERE RETURNS 500 ON PURPOSE. Stripe retries a 500 for days. A
// 200 means "dealt with", and a 200 we did not deserve is a shop that paid and
// never got switched on. The claim row is removed on the way out so the retry
// is allowed to try again.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe, stripeConfigured, periodEndOf, toIso } from "@/app/lib/stripe";
import { sendOwnerAlertEmail } from "@/app/lib/email";
import { planById, intervalById, priceLabel } from "@/app/lib/plans";
import type { PlanId, IntervalId } from "@/app/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a shop that has paid before gets when a card starts failing. */
const GRACE_DAYS = 7;

// ---------------------------------------------------------------------------
// Stripe's statuses, mapped onto the four this app understands.
//
// The check constraint on companies.subscription_status allows exactly
// trialing / active / past_due / canceled, so everything has to land on one of
// them. Where it is a judgement call, the kinder answer wins - "incomplete"
// means a first payment needs another step, which is a card problem, not a
// cancellation.
// ---------------------------------------------------------------------------
function mapStatus(s: Stripe.Subscription.Status): string {
  switch (s) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return "canceled";
    default:
      return "past_due";
  }
}

type CompanyRow = {
  id: string;
  name: string | null;
  subscription_status: string | null;
  first_paid_at: string | null;
  grace_ends_at: string | null;
  stripe_subscription_id: string | null;
};

const COMPANY_COLUMNS =
  "id, name, subscription_status, first_paid_at, grace_ends_at, stripe_subscription_id";

/**
 * Which shop is this event about?
 *
 * Asked three ways, best first. metadata.company_id is what we put there
 * ourselves at checkout and is the most trustworthy; the ids are how we find a
 * shop on every event after that.
 */
async function findCompany(
  admin: SupabaseClient,
  opts: {
    companyId?: string | null;
    subscriptionId?: string | null;
    customerId?: string | null;
  }
): Promise<CompanyRow | null> {
  if (opts.companyId) {
    const { data } = await admin
      .from("companies")
      .select(COMPANY_COLUMNS)
      .eq("id", opts.companyId)
      .maybeSingle();
    if (data) return data as unknown as CompanyRow;
  }

  if (opts.subscriptionId) {
    const { data } = await admin
      .from("companies")
      .select(COMPANY_COLUMNS)
      .eq("stripe_subscription_id", opts.subscriptionId)
      .maybeSingle();
    if (data) return data as unknown as CompanyRow;
  }

  if (opts.customerId) {
    const { data } = await admin
      .from("companies")
      .select(COMPANY_COLUMNS)
      .eq("stripe_customer_id", opts.customerId)
      .maybeSingle();
    if (data) return data as unknown as CompanyRow;
  }

  return null;
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

/**
 * Which band and interval is this subscription actually on?
 *
 * Read from the price's lookup key rather than from metadata, because the
 * lookup key follows the subscription when somebody changes plan in the
 * billing portal and the metadata we wrote at checkout does not.
 */
function planFromSubscription(sub: Stripe.Subscription): {
  planId: PlanId | null;
  intervalId: IntervalId | null;
} {
  const key = sub.items?.data?.[0]?.price?.lookup_key || "";
  const stripped = key.replace(/^shopworks_/, "");

  for (const suffix of ["monthly", "quarterly", "semiannual", "annual"] as const) {
    if (stripped.endsWith("_" + suffix)) {
      const planId = stripped.slice(0, -(suffix.length + 1));
      if (planById(planId)) {
        return { planId: planId as PlanId, intervalId: suffix };
      }
    }
  }

  // Fall back to what we recorded at checkout.
  const md = sub.metadata || {};
  return {
    planId: planById(md.plan_id) ? (md.plan_id as PlanId) : null,
    intervalId: intervalById(md.billing_interval)
      ? (md.billing_interval as IntervalId)
      : null,
  };
}

/**
 * Write a subscription's state onto the shop's row.
 *
 * Everything the app decides with comes from here, so it sets all of it at
 * once rather than leaving half-updated rows behind.
 */
async function syncSubscription(
  admin: SupabaseClient,
  sub: Stripe.Subscription
): Promise<{ company: CompanyRow | null; status: string }> {
  const customerId = idOf(sub.customer);

  const company = await findCompany(admin, {
    companyId: sub.metadata?.company_id || null,
    subscriptionId: sub.id,
    customerId,
  });

  const status = mapStatus(sub.status);

  if (!company) {
    return { company: null, status };
  }

  const { planId, intervalId } = planFromSubscription(sub);

  const update: Record<string, unknown> = {
    subscription_status: status,
    stripe_subscription_id: sub.id,
    current_period_end: toIso(periodEndOf(sub)),
    cancel_at_period_end: sub.cancel_at_period_end === true,
  };

  // ⚠️ A DEAD SUBSCRIPTION MUST NOT BE LEFT ON THE ROW.
  // The checkout route refuses to start a second subscription for a shop that
  // already has one - correctly, because two live subscriptions means billing
  // somebody twice. But a CANCELLED subscription is not a live one, and if its
  // id stays on the row that shop can never buy again: checkout turns them
  // away, and Stripe's portal cannot resurrect a subscription that has ended.
  // They would be locked out with no way back in and no error to explain it.
  //
  // So a cancelled subscription is forgotten here. The Stripe CUSTOMER is
  // deliberately kept, so when they come back they are the same customer with
  // their history intact rather than a duplicate.
  //
  // Note this is the terminal state only. cancel_at_period_end = true is NOT
  // this - that subscription is still active and still paid up until the
  // period ends, and Stripe keeps reporting it as active until then.
  if (status === "canceled") {
    update.stripe_subscription_id = null;
  }

  if (customerId) update.stripe_customer_id = customerId;
  if (planId) update.plan_id = planId;
  if (intervalId) update.billing_interval = intervalId;

  if (status === "trialing") {
    // Keep our own trial clock in step with Stripe's, so the trial banner
    // counts down to the day the card will actually be charged.
    update.trial_ends_at = toIso(sub.trial_end);
    update.grace_ends_at = null;
    update.past_due_notified_at = null;
    update.locked_notified_at = null;
  } else if (status === "active") {
    update.trial_ends_at = null;
    update.grace_ends_at = null;
    update.past_due_notified_at = null;
    update.locked_notified_at = null;
    // They are paying now, so the pre-Stripe "this is the plan we want" note
    // has done its job.
    update.requested_plan = null;
    update.plan_requested_at = null;
  } else if (status === "past_due") {
    // ⚠️ Grace is only for a shop that has actually paid us before. A trial
    // that ends on a card that will not go through has had its free period
    // already, and leaving grace_ends_at null is what makes my_shop_access()
    // treat it as locked. This is the same rule as in invoice.payment_failed,
    // repeated here because the two events can arrive in either order.
    if (company.first_paid_at && !company.grace_ends_at) {
      update.grace_ends_at = new Date(
        Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();
    }
  } else if (status === "canceled") {
    update.grace_ends_at = null;
  }

  const { error } = await admin
    .from("companies")
    .update(update)
    .eq("id", company.id);

  if (error) {
    throw new Error(
      "Could not write the subscription onto " +
        (company.name || company.id) +
        ": " +
        error.message
    );
  }

  return { company, status };
}

// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

  if (!stripeConfigured() || !secret) {
    // Nothing is set up, so there is nothing to verify against and no honest
    // way to act on this. 503 so Stripe keeps it and shows it as failing,
    // rather than 200 which would throw it away.
    return NextResponse.json(
      { error: "Stripe is not configured on this deployment." },
      { status: 503 }
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "No signature." }, { status: 400 });
  }

  // The RAW body, byte for byte. Parsing it first would change the bytes and
  // the signature would never match.
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(raw, signature, secret);
  } catch (e) {
    const message = e instanceof Error ? e.message : "bad signature";
    // 400, not 500: this is not worth retrying, and it is what Stripe's own
    // dashboard shows you when a signing secret is wrong.
    return NextResponse.json(
      { error: "Signature check failed: " + message },
      { status: 400 }
    );
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Claim this event. A duplicate collides on the primary key and we stop.
  const { error: claimError } = await admin
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });

  if (claimError) {
    // 23505 is a unique violation: we have seen this one. Anything else is a
    // database problem, and we would rather Stripe retried than acted on an
    // event we could not record.
    if (claimError.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    return NextResponse.json(
      { error: "Could not record the event: " + claimError.message },
      { status: 500 }
    );
  }

  try {
    await handleEvent(admin, event);
    return NextResponse.json({ received: true });
  } catch (e) {
    // Let go of the claim so Stripe's retry is allowed to do the work.
    await admin.from("stripe_events").delete().eq("id", event.id);
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleEvent(admin: SupabaseClient, event: Stripe.Event) {
  const stripe = getStripe();

  switch (event.type) {
    // ------------------------------------------------------------------
    // Somebody finished the checkout.
    //
    // The subscription events below do the real work and would arrive anyway.
    // This one is here so YOU get told, and so the very first sync happens as
    // early as possible.
    // ------------------------------------------------------------------
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const subId = idOf(session.subscription);
      if (!subId) return;

      const sub = await stripe.subscriptions.retrieve(subId);
      const { company } = await syncSubscription(admin, sub);
      if (!company) return;

      const { planId, intervalId } = planFromSubscription(sub);
      const trialing = sub.status === "trialing";

      await sendOwnerAlertEmail({
        subject: "ShopWorks: " + (company.name || "a shop") + " subscribed",
        lines: [
          (company.name || "A shop") + " has just subscribed through Stripe.",
          "",
          planId && intervalId
            ? "Plan: " + priceLabel(planId, intervalId) + " - " +
              (planById(planId)?.label || "")
            : "Plan: (could not read it from the subscription)",
          session.metadata?.onboarding === "yes"
            ? "They also bought the $350 onboarding."
            : "",
          trialing && sub.trial_end
            ? "They still had trial left, so the first charge is on " +
              new Date(sub.trial_end * 1000).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              }) + "."
            : "The first payment has gone through.",
          "",
          "You do not need to do anything - they are switched on already.",
        ],
      });
      return;
    }

    // ------------------------------------------------------------------
    // The subscription changed: created, plan switched in the portal, trial
    // ended, cancelled at period end, whatever it was. One handler, because
    // the answer is always "write down what it says now".
    // ------------------------------------------------------------------
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscription(admin, sub);
      return;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const { company } = await syncSubscription(admin, sub);
      if (!company) return;

      await sendOwnerAlertEmail({
        subject:
          "ShopWorks: " + (company.name || "a shop") + "'s subscription ended",
        lines: [
          (company.name || "A shop") + "'s subscription has ended in Stripe.",
          "",
          "They are now on the locked-out screen. Nothing of theirs has been " +
            "deleted - if they come back and subscribe again, everything is " +
            "exactly where they left it.",
        ],
      });
      return;
    }

    // ------------------------------------------------------------------
    // A payment went through.
    //
    // This is also where a shop is marked as having EVER paid, which is what
    // decides whether a future failed card gets a grace period or not.
    // ------------------------------------------------------------------
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = idOf(invoice.customer);

      const company = await findCompany(admin, { customerId });
      if (!company) return;

      const update: Record<string, unknown> = {
        grace_ends_at: null,
        past_due_notified_at: null,
        locked_notified_at: null,
      };

      if (!company.first_paid_at) {
        update.first_paid_at = new Date().toISOString();
      }

      const { error } = await admin
        .from("companies")
        .update(update)
        .eq("id", company.id);

      if (error) {
        throw new Error("Could not clear the grace period: " + error.message);
      }
      return;
    }

    // ------------------------------------------------------------------
    // A card failed.
    //
    // Stripe will keep retrying for about two weeks. What we do is start the
    // seven-day clock - once, on the first failure - and tell you, once.
    // The app keeps working the whole time; the shop's admin sees a red
    // banner with the date it will pause, and nobody else at that shop sees
    // anything at all.
    // ------------------------------------------------------------------
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = idOf(invoice.customer);

      const company = await findCompany(admin, { customerId });
      if (!company) return;

      // ⚠️ Only a shop that has paid us before gets grace. A free trial that
      // ends on a card that will not go through has had its free period
      // already. Leaving grace_ends_at null is what locks them out.
      const deservesGrace = !!company.first_paid_at;

      const update: Record<string, unknown> = {
        subscription_status: "past_due",
      };

      if (deservesGrace && !company.grace_ends_at) {
        update.grace_ends_at = new Date(
          Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000
        ).toISOString();
      }

      const { error } = await admin
        .from("companies")
        .update(update)
        .eq("id", company.id);

      if (error) {
        throw new Error("Could not record the failed payment: " + error.message);
      }

      // Tell you once per lapse, not once per Stripe retry. The condition on
      // past_due_notified_at is what makes the third retry silent.
      const { data: claimed } = await admin
        .from("companies")
        .update({ past_due_notified_at: new Date().toISOString() })
        .eq("id", company.id)
        .is("past_due_notified_at", null)
        .select("id");

      if (!claimed || claimed.length === 0) {
        return;
      }

      const graceUntil = (update.grace_ends_at as string) || company.grace_ends_at;

      await sendOwnerAlertEmail({
        subject:
          "ShopWorks: " + (company.name || "a shop") + "'s payment failed",
        lines: [
          "A payment from " + (company.name || "a shop") + " did not go through.",
          "",
          deservesGrace
            ? "They have paid before, so the app keeps working for them until " +
              (graceUntil
                ? new Date(graceUntil).toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })
                : "seven days from now") +
              ". Their admin is seeing a banner with that date and a button " +
              "to fix the card."
            : "They have never completed a payment, so this was the end of " +
              "their free trial. They are locked out now.",
          "",
          "Stripe carries on retrying the card by itself. If one of those " +
            "goes through, everything clears and you will not hear from me " +
            "again about it.",
          "",
          "You are getting this once for this lapse.",
        ],
      });
      return;
    }

    default:
      // Everything else is noise we asked for by accident. Recorded in
      // stripe_events, ignored here.
      return;
  }
}

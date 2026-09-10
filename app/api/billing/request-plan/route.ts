// ---------------------------------------------------------------------------
// "This is the plan we want."
//
// What this does NOT do is switch a shop back on. There is no checkout yet, so
// this records the choice and tells the ShopWorks owner, and a person takes
// the payment. Nothing reachable from a browser can move a shop from locked to
// active - that is deliberate, and it is enforced in the database as well as
// here: the columns that hold the subscription are not writable by a signed-in
// user at all, only by this function and by the Supabase dashboard.
//
// When Stripe lands, this route is where the redirect to checkout goes, and
// the page in front of it does not have to change.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { sendOwnerAlertEmail, appBaseUrl } from "@/app/lib/email";
import { planById, planSummary } from "@/app/lib/plans";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const plan = String(body?.plan ?? "").trim();

    if (!planById(plan)) {
      return NextResponse.json(
        { error: "That is not a plan we offer." },
        { status: 400 }
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

    // The function works out which shop from the signed-in session and refuses
    // anybody who is not that shop's admin. It can only ever write the two
    // plan columns.
    const { data, error } = await supabase.rpc("request_plan", {
      p_plan: plan,
    });

    if (error) {
      return NextResponse.json(
        { error: error.message.replace(/^ShopWorks:\s*/, "") },
        { status: 400 }
      );
    }

    const rows = (data || []) as unknown as {
      shop_id: string;
      shop_name: string;
      plan: string;
    }[];
    const shopName = rows[0]?.shop_name || "(unknown shop)";

    await sendOwnerAlertEmail({
      subject: "ShopWorks: " + shopName + " wants to subscribe",
      lines: [
        shopName + " has chosen a plan and is waiting to be switched back on.",
        "",
        "Plan: " + planSummary(plan),
        "Chosen by: " + (user.email || user.id),
        "",
        "They are locked out until you set their shop to active. The line to " +
          "run is at the bottom of plan-request.sql - it also clears the alert " +
          "stamp so you hear about it if they ever lapse again.",
        "",
        appBaseUrl(req.headers.get("origin")),
      ],
    });

    return NextResponse.json({ success: true, plan });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

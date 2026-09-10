// ---------------------------------------------------------------------------
// "Start a new shop", for somebody who is already signed in.
//
// This is Sean's path. He has a customer portal login at another shop, and he
// wants his own. There is no new account to create and nothing to confirm -
// his email address was proved a long time ago - so this is much simpler than
// the signup form.
//
// All the real work is one database function, create_shop_for_current_user.
// It works out who is calling from the signed-in session rather than from
// anything this route hands it, so there is no way to create a shop in
// somebody else's name even if this route were wrong. It also refuses a second
// free trial for the same person.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { sendOwnerAlertEmail, appBaseUrl } from "@/app/lib/email";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const shopName = String(body?.shopName ?? "").trim();

    if (shopName.length < 2 || shopName.length > 100) {
      return NextResponse.json(
        { error: "Please enter a shop name." },
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

    const { data, error } = await supabase.rpc("create_shop_for_current_user", {
      p_shop_name: shopName,
    });

    if (error) {
      // The function's own messages are written to be read by a person, so
      // pass them straight through.
      return NextResponse.json(
        { error: error.message.replace(/^ShopWorks:\s*/, "") },
        { status: 400 }
      );
    }

    await sendOwnerAlertEmail({
      subject: "ShopWorks: new shop started - " + shopName,
      lines: [
        "An existing ShopWorks login just started their own shop.",
        "",
        "Shop: " + shopName,
        "Started by: " + (user.email || user.id),
        "",
        "They were already a member somewhere else, so this did not go through " +
          "the signup form and there was no email to confirm.",
        "",
        appBaseUrl(req.headers.get("origin")),
      ],
    });

    return NextResponse.json({ success: true, companyId: data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

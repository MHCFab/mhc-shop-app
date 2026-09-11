// ---------------------------------------------------------------------------
// "Is this shop paid up, and what do we show if it isn't?"
//
// Every area of the app - admin, floor, portal - asks this once in its layout
// before it renders anything. The answer comes from my_shop_access() in the
// database rather than from a query here, for one specific reason: a customer
// portal login is not allowed to read the companies table at all under the
// ordinary rules, so a query here would come back empty for them and every
// customer would look locked out.
//
// THE RULE THIS FILE LIVES BY: if we cannot get a clear answer, we let people
// in. A shop that is locked out by mistake is a shop that cannot run its work
// on a Tuesday morning. A shop that gets a few extra free days because the
// database hiccuped costs nothing. So every failure path here returns null,
// and null means "carry on".
//
// ⚠️ THE FOUR STATES, and who sees what:
//   ok      nothing shown. The shop is paid up, or it is MHC.
//   trial   the trial banner, admin only.
//   grace   a card has failed and Stripe is retrying. The app WORKS NORMALLY.
//           The admin sees a red banner with the date it will pause. The crew
//           and the shop's customers see nothing at all.
//   locked  the locked screen. Admin sees the plan picker; everybody else
//           sees a neutral "not available".
//
// grace is the one that is easy to get wrong. It is not a mild version of
// locked - it is a mild version of ok. Anything in the app that asks "can this
// person work?" must treat grace as yes.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendOwnerAlertEmail } from "./email";

export type ShopAccessState = "ok" | "trial" | "grace" | "locked";

export type ShopAccess = {
  companyId: string;
  shopName: string;
  role: string;
  state: ShopAccessState;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  /** Days until the trial ends, or until grace runs out. Null otherwise. */
  daysLeft: number | null;
  /** When a past_due shop will actually pause. Null unless state is grace. */
  graceEndsAt: string | null;
};

type AccessRow = {
  company_id: string;
  shop_name: string;
  role: string;
  state: string;
  subscription_status: string;
  trial_ends_at: string | null;
  days_left: number | null;
  grace_ends_at: string | null;
};

type LockAlertRow = {
  should_send: boolean;
  shop_id: string;
  shop_name: string;
  subscription_status: string;
  trial_ends_at: string | null;
};

/**
 * What state is the signed-in person's current shop in?
 *
 * Returns null when we could not tell - no session, no profile, the function
 * is not there yet because the SQL has not been run, or the database did not
 * answer. Callers treat null as "let them in".
 */
export async function getShopAccess(
  supabase: SupabaseClient
): Promise<ShopAccess | null> {
  try {
    const { data, error } = await supabase.rpc("my_shop_access");
    if (error) {
      return null;
    }

    // Supabase types a set-returning function as an array. Cast through
    // unknown, which is what keeps the TypeScript build happy on this repo.
    const rows = (data || []) as unknown as AccessRow[];
    if (rows.length === 0) {
      return null;
    }

    const r = rows[0];

    // ⚠️ Anything we do not recognise becomes "ok", not "locked". If a future
    // version of the database starts returning a state this build has never
    // heard of, the shop keeps working. That is the same fail-open rule as
    // the rest of this file.
    const state: ShopAccessState =
      r.state === "locked" ? "locked"
      : r.state === "trial" ? "trial"
      : r.state === "grace" ? "grace"
      : "ok";

    return {
      companyId: r.company_id,
      shopName: r.shop_name || "",
      role: r.role || "",
      state,
      subscriptionStatus: r.subscription_status || "",
      trialEndsAt: r.trial_ends_at,
      daysLeft: r.days_left == null ? null : Number(r.days_left),
      graceEndsAt: r.grace_ends_at ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Tell the ShopWorks owner - once - that a shop has hit the wall.
 *
 * The database decides whether this call is the one that sends. Two people at
 * the same shop refreshing at the same second cannot both be told they are
 * first, because the stamp and the answer happen in one statement.
 *
 * ⚠️ A shop in its grace window has NOT hit the wall, and the database knows
 * that: claim_shop_lock_alert() will not stamp a past_due shop whose
 * grace_ends_at is still ahead. You hear about the failed card from the Stripe
 * webhook instead, which is a different email saying a different thing.
 *
 * Never throws, and never blocks the page: the worst case is that the email
 * does not go and the shop is still correctly locked.
 */
export async function alertOwnerIfNewlyLocked(
  supabase: SupabaseClient
): Promise<void> {
  try {
    const { data, error } = await supabase.rpc("claim_shop_lock_alert");
    if (error) {
      return;
    }

    const rows = (data || []) as unknown as LockAlertRow[];
    if (rows.length === 0 || !rows[0].should_send) {
      return;
    }

    const row = rows[0];
    const reason =
      row.subscription_status === "trialing"
        ? "Their 14-day trial ran out"
        : row.subscription_status === "past_due"
        ? "Their card kept failing and the grace period has run out"
        : "Their subscription is " + row.subscription_status;

    await sendOwnerAlertEmail({
      subject: "ShopWorks: " + (row.shop_name || "a shop") + " is locked out",
      lines: [
        (row.shop_name || "A shop") + " has just hit the locked-out screen.",
        reason + ".",
        row.trial_ends_at ? "Trial ended: " + row.trial_ends_at : "",
        "",
        "Nothing of theirs has been deleted. If they subscribe through the " +
          "billing page, Stripe switches them back on by itself and you do " +
          "not have to do anything.",
        "",
        "You are getting this once, the first time somebody there hit the wall.",
      ],
    });
  } catch {
    // An email that did not send is not a reason to break their page.
  }
}

/**
 * The one call a layout makes. Gets the state and, if the shop is locked,
 * makes sure the owner has been told.
 */
export async function checkShopAccess(
  supabase: SupabaseClient
): Promise<ShopAccess | null> {
  const access = await getShopAccess(supabase);
  if (access?.state === "locked") {
    await alertOwnerIfNewlyLocked(supabase);
  }
  return access;
}

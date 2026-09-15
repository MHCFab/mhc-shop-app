// ---------------------------------------------------------------------------
// Look, don't guess.
//
//   node scripts/stripe-check.mjs             # the LIVE account
//   node scripts/stripe-check.mjs --sandbox   # the sandbox
//
// Read-only. Changes nothing, ever. It prints what is actually in the Stripe
// account so a question like "why is the Update subscription button still
// there" gets answered with evidence instead of another theory.
//
// Reads STRIPE_SECRET_KEY from .env.local, same as stripe-setup.mjs - or
// STRIPE_SANDBOX_SECRET_KEY with --sandbox, since STRIPE_SECRET_KEY has been
// the LIVE key since 14 September and the sandbox is otherwise unreachable
// without swapping keys about.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";

const plansPath = path.join(process.cwd(), "app", "lib", "plans.ts");
if (!fs.existsSync(plansPath)) {
  console.error(
    "\nThis is not the ShopWorks folder.\n\n" +
      "  Running in: " + process.cwd() + "\n\n" +
      "  cd " + path.join("C:", "Users", "erikp", "Desktop", "ShopWorks", "mhc-shop-app") + "\n"
  );
  process.exit(1);
}

const ENV_NAME = process.argv.includes("--sandbox")
  ? "STRIPE_SANDBOX_SECRET_KEY"
  : "STRIPE_SECRET_KEY";

function keyFromEnvFile(name) {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return "";
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

const key = (process.env[ENV_NAME] || keyFromEnvFile(ENV_NAME) || "").trim();
if (!key.startsWith("sk_")) {
  console.error("\nNo " + ENV_NAME + " in .env.local.\n");
  process.exit(1);
}

const stripe = new Stripe(key);

function yesno(v) {
  return v === true ? "YES" : v === false ? "no" : "(unset)";
}

async function main() {
  const acct = await stripe.accounts.retrieve();
  console.log("");
  console.log("ACCOUNT : " + (acct.settings?.dashboard?.display_name || "(unnamed)"));
  console.log("id      : " + acct.id);
  console.log("");

  // -------------------------------------------------------------------
  // Every billing portal configuration on the account.
  // -------------------------------------------------------------------
  const list = await stripe.billingPortal.configurations.list({ limit: 100 });

  console.log("BILLING PORTAL CONFIGURATIONS (" + list.data.length + ")");
  console.log("");

  for (const c of list.data) {
    const su = c.features?.subscription_update;
    const mine = c.metadata?.shopworks === "portal";

    console.log("  " + c.id + (mine ? "   <-- ours (metadata.shopworks=portal)" : ""));
    console.log("    is_default            : " + yesno(c.is_default));
    console.log("    active                : " + yesno(c.active));
    console.log("    CAN CHANGE PLAN       : " + yesno(su?.enabled));
    if (su?.enabled) {
      console.log("    allowed updates       : " + JSON.stringify(su.default_allowed_updates || []));
      console.log("    proration_behavior    : " + (su.proration_behavior || "(unset)"));
      console.log("    billing_cycle_anchor  : " + (su.billing_cycle_anchor || "(unset)"));
      console.log("    schedule_at_period_end: " +
        JSON.stringify(su.schedule_at_period_end?.conditions || []));
    }
    console.log("    can cancel            : " + yesno(c.features?.subscription_cancel?.enabled));
    console.log("    can update card       : " + yesno(c.features?.payment_method_update?.enabled));
    console.log("");
  }

  // -------------------------------------------------------------------
  // Which one would the app actually use? Same logic as
  // resolvePortalConfigurationId() in app/lib/stripe.ts.
  // -------------------------------------------------------------------
  const pinned = (process.env.STRIPE_PORTAL_CONFIGURATION_ID || "").trim();
  const mine = list.data.find((c) => c.metadata?.shopworks === "portal" && c.active);
  const chosen = pinned || (mine ? mine.id : null);

  console.log("WHAT THE APP WOULD USE");
  console.log("  STRIPE_PORTAL_CONFIGURATION_ID : " + (pinned || "(not set)"));
  console.log("  found ours, and active         : " + (mine ? mine.id : "NO - would fall back"));
  console.log("  so the portal session uses     : " + (chosen || "THE ACCOUNT DEFAULT"));
  console.log("");

  if (!chosen) {
    console.log("  ⚠️  Falling back to the account default means none of the rules");
    console.log("      we configured apply. That is the bug to chase.");
    console.log("");
  }
}

main().catch((e) => {
  console.error("\n  Stopped: " + (e?.message || e) + "\n");
  process.exit(1);
});

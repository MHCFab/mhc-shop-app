// ---------------------------------------------------------------------------
// Set up (or bring up to date) everything ShopWorks needs inside Stripe.
//
//   node scripts/stripe-setup.mjs --key sk_test_...          # see what it would do
//   node scripts/stripe-setup.mjs --key sk_test_... --apply  # actually do it
//
// Run it once against your TEST key and once against your LIVE key. The two
// accounts end up with the same product names, the same lookup keys and the
// same portal rules, which is what lets the app code be identical in both.
//
// ⚠️ IT IS SAFE TO RUN AGAIN. Nothing is deleted and nothing is duplicated: a
// price that already exists with the right amount is left alone, and a price
// whose amount has CHANGED gets a new Stripe price with the lookup key moved
// onto it. That is not us being clever - Stripe prices cannot be edited, and
// moving the lookup key is exactly how you are meant to change a price without
// disturbing anybody already subscribed to the old one.
//
// ⚠️ THE PRICES ARE NOT TYPED IN HERE. They are read out of app/lib/plans.ts,
// which is the single source of truth, so this script and the billing page can
// never quietly disagree. If that file is edited into a shape this cannot
// read, the script stops rather than guessing.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const liveConfirmed = argv.includes("--live");

// ⚠️ --sandbox reads a DIFFERENT line out of .env.local. Since 14 September
// STRIPE_SECRET_KEY is the LIVE key, so there is no way to reach the sandbox
// through the normal path any more without swapping keys about - which is how
// the wrong key ends up deployed. This reads STRIPE_SANDBOX_SECRET_KEY
// instead, the same line scripts/stripe-preview.mjs uses, and then REFUSES
// anything that is not a test key. Nothing to paste on a command line.
const sandbox = argv.includes("--sandbox");

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

// ---------------------------------------------------------------------------
// ⚠️ AM I EVEN IN THE RIGHT FOLDER? ASKED FIRST, ON PURPOSE.
//
// Everything below reads a file relative to where this was run from - the
// plans, and the key in .env.local. Run from the wrong folder, every one of
// those comes back empty, and the error you get is about whichever one is
// checked first rather than about the actual problem. So the actual problem
// gets checked first.
// ---------------------------------------------------------------------------
const plansPath = path.join(process.cwd(), "app", "lib", "plans.ts");

if (!fs.existsSync(plansPath)) {
  console.error(
    "\nThis is not the ShopWorks folder.\n\n" +
      "  Running in : " + process.cwd() + "\n" +
      "  Looking for: " + plansPath + "\n\n" +
      "  Move to the folder that has app/ and package.json in it, then run\n" +
      "  the script again. In Cursor's terminal that is usually:\n\n" +
      "      cd " + path.join("C:", "Users", "erikp", "Desktop", "ShopWorks", "mhc-shop-app") + "\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Where the key comes from.
//
// ⚠️ PASTING A SECRET KEY ON A COMMAND LINE IS THE FIDDLIEST STEP IN THIS
// WHOLE JOB, so it is not required. If --key is not given, this reads the key
// out of .env.local - the same file the app itself uses, which has to be
// filled in anyway. Nothing to paste twice, nothing to truncate, and no key
// left sitting in a shell history or a screenshot.
//
//   node scripts/stripe-setup.mjs --sandbox           # see what it would do
//   node scripts/stripe-setup.mjs --sandbox --apply   # do it, to the sandbox
//   node scripts/stripe-setup.mjs --apply --live      # do it, for real
// ---------------------------------------------------------------------------
function keyFromEnvFile(name) {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return "";

  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;

    // Strip surrounding quotes if somebody added them.
    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
  }
  return "";
}

// --sandbox looks at STRIPE_SANDBOX_SECRET_KEY; everything else at
// STRIPE_SECRET_KEY, which is the live key on this machine.
const ENV_NAME = sandbox ? "STRIPE_SANDBOX_SECRET_KEY" : "STRIPE_SECRET_KEY";

const keySource = argValue("--key")
  ? "--key"
  : process.env[ENV_NAME]
  ? ENV_NAME + " in the environment"
  : ENV_NAME + " in .env.local";

const key = (
  argValue("--key") ||
  process.env[ENV_NAME] ||
  keyFromEnvFile(ENV_NAME) ||
  ""
).trim();

if (!key) {
  const envPath = path.join(process.cwd(), ".env.local");
  const envExists = fs.existsSync(envPath);

  console.error(
    "\nNo Stripe secret key found.\n\n" +
      "  Looked in   : " + envPath + "\n" +
      "  That file   : " + (envExists ? "exists" : "IS NOT THERE") + "\n" +
      (envExists
        ? "  But it has no line starting STRIPE_SECRET_KEY=\n"
        : "") +
      "\n" +
      "  Add this to .env.local, on its own line, no quotes, no spaces around\n" +
      "  the = sign, and SAVE the file:\n\n" +
      "      STRIPE_SECRET_KEY=sk_test_...\n\n" +
      "  Then run:  node scripts/stripe-setup.mjs\n\n" +
      "  Get the key from Stripe: Developers -> API keys. Use the COPY BUTTON\n" +
      "  next to the secret key, not by selecting the text - the text on screen\n" +
      "  is partly hidden and selecting it gives a key that will not work.\n"
  );
  process.exit(1);
}

// ⚠️ Catch the masked-copy mistake HERE, with a useful sentence, rather than
// letting Stripe answer "Invalid API Key provided" and leaving somebody to
// guess why. A real key is letters, digits and underscores only.
const junk = key.match(/[^A-Za-z0-9_]/);
if (junk) {
  console.error(
    "\nThat key has a '" + junk[0] + "' in it, so it is not a real key.\n\n" +
      "  That usually means the masked version was copied - the dashboard\n" +
      "  shows the middle of the key as dots or asterisks. Use the COPY BUTTON\n" +
      "  next to the key rather than selecting the text.\n"
  );
  process.exit(1);
}

if (!key.startsWith("sk_")) {
  console.error(
    "\nThat is not a secret key - it does not start with sk_.\n\n" +
      "  Read from: " + keySource + "\n" +
      "  Starts with: " + key.slice(0, 8) + "\n\n" +
      "  pk_ is the publishable key, which cannot do any of this.\n" +
      "  rk_ is a restricted key; this script needs the full secret key.\n"
  );
  process.exit(1);
}

// A genuine Stripe secret key is around 100 characters. Much shorter almost
// always means a truncated copy.
if (key.length < 40) {
  console.error(
    "\nThat key is only " + key.length + " characters, which is too short to be\n" +
      "  a real Stripe secret key - it looks truncated. Use the COPY BUTTON\n" +
      "  next to the key in the dashboard rather than selecting the text.\n"
  );
  process.exit(1);
}

const live = key.startsWith("sk_live_");

// ⚠️ --sandbox MEANS SANDBOX. If STRIPE_SANDBOX_SECRET_KEY has somehow been
// filled in with a live key, stop here rather than quietly applying sandbox
// intentions to the live account.
if (sandbox && !key.startsWith("sk_test_")) {
  console.error(
    "\n  ⚠️  REFUSING TO RUN. --sandbox was given but that is not a test key.\n\n" +
      "  Read from  : " + keySource + "\n" +
      "  Starts with: " + key.slice(0, 8) + "\n\n" +
      "  A sandbox key starts sk_test_. Check the line in .env.local.\n"
  );
  process.exit(1);
}

const stripe = new Stripe(key);

const plansSource = fs.readFileSync(plansPath, "utf8");

// ---------------------------------------------------------------------------
// What kind of thing is ShopWorks, for tax purposes?
//
// Stripe's classification for cloud software, not downloaded, sold to a
// business rather than a consumer. Stripe Tax is NOT switched on - Erik chose
// to handle tax himself rather than pay 3.5% for Stripe to be merchant of
// record (2026-09-11) - so this does nothing today. It is set now because
// classifying a product at the moment it is created is free, and going back
// to classify live products later, with subscriptions already running on
// them, is the kind of job that gets put off.
// ---------------------------------------------------------------------------
const SAAS_TAX_CODE = "txcd_10103001"; // SaaS - business use

const INTERVAL_SHAPE = {
  monthly: { interval: "month", interval_count: 1 },
  quarterly: { interval: "month", interval_count: 3 },
  semiannual: { interval: "month", interval_count: 6 },
  annual: { interval: "year", interval_count: 1 },
};

function parsePlans(src) {
  const out = [];
  // Each plan block: id, label, then a prices object with the four intervals.
  const re =
    /id:\s*"(band_[a-z0-9_]+)"[\s\S]*?label:\s*"([^"]+)"[\s\S]*?prices:\s*\{\s*monthly:\s*(\d+),\s*quarterly:\s*(\d+),\s*semiannual:\s*(\d+),\s*annual:\s*(\d+)\s*\}/g;

  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({
      id: m[1],
      label: m[2],
      prices: {
        monthly: Number(m[3]),
        quarterly: Number(m[4]),
        semiannual: Number(m[5]),
        annual: Number(m[6]),
      },
    });
  }
  return out;
}

function parseOnboarding(src) {
  const lookup = src.match(/lookupKey:\s*"([^"]+)"/);
  const price = src.match(/lookupKey:\s*"[^"]+",\s*price:\s*(\d+)/);
  const label = src.match(/lookupKey:\s*"[^"]+",\s*price:\s*\d+,\s*label:\s*"([^"]+)"/);
  if (!lookup || !price) return null;
  return {
    lookupKey: lookup[1],
    price: Number(price[1]),
    label: label ? label[1] : "Onboarding",
  };
}

const plans = parsePlans(plansSource);
const onboarding = parseOnboarding(plansSource);

// ⚠️ Stop loudly rather than half-creating a price list. A wrong number here
// becomes a wrong charge on somebody's card.
if (plans.length !== 3) {
  console.error(
    "\nRead " + plans.length + " plans out of app/lib/plans.ts, expected 3.\n" +
      "The file has probably been reformatted. Fix the script's parser rather " +
      "than typing the prices in by hand - one source of truth is the point.\n"
  );
  process.exit(1);
}

for (const p of plans) {
  for (const [k, v] of Object.entries(p.prices)) {
    if (!Number.isInteger(v) || v <= 0) {
      console.error("\nBad price for " + p.id + " " + k + ": " + v + "\n");
      process.exit(1);
    }
  }
}

if (!onboarding || !Number.isInteger(onboarding.price) || onboarding.price <= 0) {
  console.error("\nCould not read the onboarding price out of app/lib/plans.ts.\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log("");
console.log("ShopWorks -> Stripe");
console.log("  account mode : " + (live ? "LIVE - this is real money" : "TEST"));
console.log("  action       : " + (apply ? "APPLYING CHANGES" : "dry run (add --apply to do it)"));
console.log("  key read from: " + keySource);
console.log("");

// ⚠️ WHICH ACCOUNT IS THIS? Printed every time, before anything happens.
// Erik has a second, LIVE Stripe account taking real card payments for the
// mhcfab.com store. Nothing here should ever run against it. Read the name
// below before you type --apply.
try {
  const acct = await stripe.accounts.retrieve();
  const name =
    acct.settings?.dashboard?.display_name ||
    acct.business_profile?.name ||
    "(unnamed)";
  console.log("  ACCOUNT      : " + name);
  console.log("  account id   : " + acct.id);
  if (acct.email) console.log("  account email: " + acct.email);
  console.log("");
} catch (e) {
  console.log("  ACCOUNT      : (could not read)");
  console.log("  why          : " + (e?.message || e));
  console.log("");
}

// ⚠️ A live-mode change needs saying out loud twice. This is the guard against
// a mis-pasted key putting ShopWorks products into the wrong account.
if (live && apply && !liveConfirmed) {
  console.error(
    "  Refusing to change a LIVE Stripe account without --live.\n\n" +
      "  Check the account name printed above is the ShopWorks one and NOT\n" +
      "  the mhcfab.com store, then run again with --live on the end.\n"
  );
  process.exit(1);
}

if (live && apply) {
  console.log("  ⚠️  APPLYING TO A LIVE ACCOUNT.");
  console.log("");
}

// Show what was read out of app/lib/plans.ts, so a bad parse is visible
// before anything is created rather than after.
console.log("  read from app/lib/plans.ts:");
for (const p of plans) {
  console.log(
    "    " + p.id.padEnd(13) +
    Object.entries(p.prices)
      .map(([k, v]) => k + " $" + v)
      .join("   ")
  );
}
console.log("    " + "onboarding".padEnd(13) + "one time $" + onboarding.price);
console.log("");

const planned = [];

function say(action, what) {
  planned.push(action + "  " + what);
  console.log("  " + action.padEnd(8) + what);
}

// ---------------------------------------------------------------------------
// Products. Found by metadata rather than by name, so renaming one on the
// billing page does not create a second product in Stripe.
// ---------------------------------------------------------------------------
async function ensureProduct(marker, name, description, taxCode) {
  const existing = await stripe.products.search({
    query: 'metadata["shopworks"]:"' + marker + '"',
    limit: 1,
  });

  if (existing.data[0]) {
    say("keep", "product " + name);
    return existing.data[0];
  }

  if (!apply) {
    say("create", "product " + name);
    return { id: "(not created - dry run)" };
  }

  const product = await stripe.products.create({
    name,
    description,
    metadata: { shopworks: marker },
    ...(taxCode ? { tax_code: taxCode } : {}),
  });
  say("create", "product " + name + "  " + product.id);
  return product;
}

// ---------------------------------------------------------------------------
// Prices. The lookup key is the name the app uses; the price id is Stripe's.
// ---------------------------------------------------------------------------
async function ensurePrice({ lookupKey, productId, dollars, recurring, nickname }) {
  const found = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });

  const current = found.data[0];
  const wanted = dollars * 100;

  if (current && current.unit_amount === wanted) {
    const sameShape = recurring
      ? current.recurring &&
        current.recurring.interval === recurring.interval &&
        current.recurring.interval_count === recurring.interval_count
      : !current.recurring;

    if (sameShape) {
      say("keep", lookupKey + "  $" + dollars);
      return current;
    }
  }

  if (!apply) {
    say(current ? "replace" : "create", lookupKey + "  $" + dollars);
    return null;
  }

  // ⚠️ transfer_lookup_key moves the name off the old price onto the new one.
  // The old price stays alive and anybody already subscribed to it keeps
  // paying what they agreed to - which is what you want when you raise prices.
  const price = await stripe.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: wanted,
    nickname,
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    ...(recurring ? { recurring } : {}),
  });

  say(current ? "replace" : "create", lookupKey + "  $" + dollars + "  " + price.id);
  return price;
}

// ---------------------------------------------------------------------------
// The billing portal rules.
//
// ⚠️ THIS IS WHERE ERIK'S "PRORATE UPGRADES, NEVER REFUND DOWNGRADES" LIVES.
//
//   proration_behavior: always_invoice
//       An upgrade happens now and is billed now: what they already paid for
//       the rest of the period is credited against the new price and they pay
//       the difference on the spot. ⚠️ NOT create_prorations - that is what
//       billed two years at once on 11 September. The measured numbers for
//       both are in the block further down; read them before touching this.
//
//   billing_cycle_anchor: unchanged
//       A shop keeps its billing date. Moving to yearly on the 30th when the
//       date is the 15th buys a short first year, priced pro rata, and the
//       renewal stays on the 15th.
//
//   schedule_at_period_end.conditions:
//       [shortening_interval, decreasing_item_amount]
//       Anything that goes DOWN - yearly back to monthly, 16-50 back to 1-15 -
//       waits for the end of the period they paid for. They ride out what they
//       bought, nothing is invoiced on the day, and no money goes back.
//       ⚠️ decreasing_item_amount is new and needs watching: if it turns out
//       to catch monthly -> yearly too, it has to come out. The block further
//       down says how to tell.
//
//   subscription_cancel: at_period_end, proration_behavior none
//       They keep what they paid for and get nothing back. No refunds.
//
// ⚠️ IT ONLY EVER TOUCHES A CONFIGURATION IT CREATED ITSELF, marked with
// metadata.shopworks = "portal". An earlier version fell back to updating the
// account's DEFAULT configuration if it could not find its own - which would
// have quietly rewritten the portal rules of whatever else that account does.
// On an account that is already taking real payments that is somebody else's
// customers' cancel and refund behaviour. Never again: if ours is not there,
// we make a new one and leave the default alone.
// ---------------------------------------------------------------------------
async function ensurePortalConfiguration(productIds) {
  const features = {
    customer_update: {
      enabled: true,
      allowed_updates: ["email", "address", "name", "phone", "tax_id"],
    },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      proration_behavior: "none",
      cancellation_reason: {
        enabled: true,
        options: [
          "too_expensive",
          "missing_features",
          "switched_service",
          "unused",
          "too_complex",
          "low_quality",
          "customer_service",
          "other",
        ],
      },
    },
    // ⚠️⚠️ SWITCHED BACK ON 2026-09-15, AND THE NUMBERS BELOW ARE MEASURED,
    // NOT REASONED. Read them before changing anything here.
    //
    // WHAT WENT WRONG ON 11 SEPTEMBER. A shop on $149 monthly, one day in,
    // chose yearly in the portal and was offered $2,831.01 - two years at
    // once. The setting at fault was proration_behavior: create_prorations.
    //
    // create_prorations does NOT mean "work out the proration". It means
    // "work it out and HOLD it until the next invoice". Change the interval
    // and the next invoice is a year away and already contains the next
    // year's charge - so the credit, the new period AND the period after it
    // all land on one bill:
    //
    //     -$149.00   15 Sep 26 - 15 Oct 26   unused time, 1-15 monthly
    //   $1,490.00    15 Sep 26 - 15 Sep 27   remaining time, 1-15 yearly
    //   $1,490.00    15 Sep 27 - 15 Sep 28   the next year as well
    //   ---------
    //   $2,831.00    dated 15 Sep 2027
    //
    // always_invoice bills the proration NOW instead, so the third line
    // never exists. Same shop, same day, same everything else:
    //
    //     -$149.00   15 Sep 26 - 15 Oct 26   unused time, 1-15 monthly
    //   $1,490.00    15 Sep 26 - 15 Sep 27   remaining time, 1-15 yearly
    //   ---------
    //   $1,341.00    dated 15 Sep 2026        <- what Erik asked for
    //
    // ⚠️ billing_cycle_anchor: "unchanged" WAS NOT THE PROBLEM and IS being
    // honoured - the old note here was wrong. A shop 15 days into its month
    // that moves to yearly keeps the 15th as its billing date: Stripe charges
    // $1,428.77 for 30 Sep 26 to 15 Sep 27 (a short first year, priced pro
    // rata), less the $74.50 unused, so $1,354.27 today and the next bill on
    // 15 Sep 2027. Leave it alone. Setting it to "now" moves everybody's
    // billing date to whenever they happened to click.
    //
    // Every number above came out of scripts/stripe-preview.mjs against the
    // sandbox on 2026-09-15, and the $2,831.00 line is the real bug
    // reproduced to the penny - which is what says the rest can be believed.
    // Run that script again before changing any of this.
    //
    // ⚠️ THE TWO schedule_at_period_end CONDITIONS ARE WHAT KEEP MONEY FROM
    // GOING BACKWARDS. Without them, always_invoice bills a DOWNGRADE as a
    // negative invoice - measured at -$100.00 for 16-50 back down to 1-15,
    // and -$1,341.00 for yearly back down to monthly. Stripe would not refund
    // a card over it, but it is still value handed back, and Erik's rule is
    // that a shop rides out what it already paid for.
    //
    //   shortening_interval    yearly -> monthly, quarterly -> monthly, and
    //                          anything else that shortens the billing period
    //   decreasing_item_amount 16-50 -> 1-15 and any other drop to a cheaper
    //                          price at the same interval
    //
    // Both wait for the end of the period they paid for. Nothing is invoiced
    // on the day, their login cap does not tighten under people who are using
    // it, and there is no credit balance to explain.
    //
    // ⚠️⚠️ decreasing_item_amount IS THE ONE TO WATCH, and the sandbox
    // click-through is what proves it. An older note in this file claimed
    // Stripe counts monthly -> yearly as "decreasing" because our yearly is
    // two months free, which would push the most valuable upgrade a shop can
    // make to the end of its period instead of taking the money now. Stripe
    // documents the condition as the new price's UNIT AMOUNT being lower, and
    // $1,490 is not lower than $149 - but that is reading, not evidence, and
    // reading is exactly what cost $1,400 last time. In the sandbox portal,
    // pick yearly on a monthly shop: if the page offers roughly $1,341 today
    // it is right; if it says the change is scheduled for a later date, take
    // decreasing_item_amount out and accept a credit balance on band
    // downgrades instead.
    //
    // ⚠️ always_invoice charges the card THE MOMENT they confirm. A card that
    // fails leaves them on the new plan with an unpaid invoice, which becomes
    // past_due and runs into the 7-day grace like any other failed payment.
    // That is the right outcome, but it is worth knowing it is the path.
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price", "promotion_code"],

      // ⚠️ NOT create_prorations. That is the $2,831 bug. See above.
      proration_behavior: "always_invoice",

      // ⚠️ NOT "now". Leave a shop's billing date where it is.
      billing_cycle_anchor: "unchanged",

      // A shop still inside its free trial that picks a different plan stays
      // on trial rather than being charged on the spot.
      trial_update_behavior: "continue_trial",

      schedule_at_period_end: {
        conditions: [
          { type: "shortening_interval" },
          { type: "decreasing_item_amount" },
        ],
      },

      products: productIds,
    },
  };

  const business_profile = {
    headline: "ShopWorks — shop management for metal fabricators",
    privacy_policy_url: "https://shopworks.app/privacy",
    terms_of_service_url: "https://shopworks.app/terms",
  };

  const configs = await stripe.billingPortal.configurations.list({ limit: 100 });
  // ⚠️ OURS ONLY. No fallback to the account default - see the note above.
  const target = configs.data.find((c) => c.metadata?.shopworks === "portal");

  if (!apply) {
    say(target ? "update" : "create", "billing portal configuration");
    return target ? target.id : null;
  }

  if (target) {
    const updated = await stripe.billingPortal.configurations.update(target.id, {
      features,
      business_profile,
      default_return_url: "https://shopworks.app/billing",
      metadata: { shopworks: "portal" },
    });
    say("update", "billing portal configuration  " + updated.id);
    return updated.id;
  }

  const created = await stripe.billingPortal.configurations.create({
    features,
    business_profile,
    default_return_url: "https://shopworks.app/billing",
    metadata: { shopworks: "portal" },
  });
  say("create", "billing portal configuration  " + created.id);
  return created.id;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
async function main() {
  const productIds = [];

  for (const plan of plans) {
    const product = await ensureProduct(
      plan.id,
      "ShopWorks — " + plan.label,
      "The whole of ShopWorks. No modules, no feature tiers. " +
        plan.label +
        ". Customer portal logins are unlimited and free.",
      SAAS_TAX_CODE
    );

    const prices = [];

    for (const [intervalId, shape] of Object.entries(INTERVAL_SHAPE)) {
      const price = await ensurePrice({
        lookupKey: "shopworks_" + plan.id + "_" + intervalId,
        productId: product.id,
        dollars: plan.prices[intervalId],
        recurring: shape,
        nickname: plan.label + " — " + intervalId,
      });
      if (price) prices.push(price.id);
    }

    if (apply && prices.length) {
      productIds.push({ product: product.id, prices });
    }
  }

  // ⚠️ NO TAX CODE ON THE ONBOARDING PRODUCT, DELIBERATELY. It is a service
  // somebody performs by hand, not software, so the SaaS code would be wrong
  // and there is no point guessing at a services code nobody has checked. If
  // Stripe Tax is ever switched on, classify this one with an accountant.
  const onboardingProduct = await ensureProduct(
    "onboarding",
    "ShopWorks — " + onboarding.label,
    "One-time setup: your material, products and bills of material loaded from spreadsheets."
  );

  await ensurePrice({
    lookupKey: onboarding.lookupKey,
    productId: onboardingProduct.id,
    dollars: onboarding.price,
    recurring: null,
    nickname: "Onboarding (one time)",
  });

  // Stripe allows at most 10 products in the portal's switchable list. Three
  // band products, so the cap is not close - but it is sliced anyway, because
  // a fourth band one day should not turn into a Stripe error nobody expects.
  //
  // ⚠️ THIS LIST IS ONLY FILLED ON --apply (see the loop above). A dry run
  // shows the portal configuration with no switchable products; that is the
  // dry run being honest, not the list being lost.
  await ensurePortalConfiguration(productIds.slice(0, 10));

  console.log("");
  if (!apply) {
    console.log("  Nothing was changed. Run it again with --apply to do the above.");
  } else {
    console.log("  Done.");
    console.log("");
    console.log("  Next: Developers -> Webhooks -> add an endpoint");
    console.log("    URL     https://shopworks.app/api/stripe/webhook");
    console.log("    events  checkout.session.completed");
    console.log("            customer.subscription.created");
    console.log("            customer.subscription.updated");
    console.log("            customer.subscription.deleted");
    console.log("            invoice.paid");
    console.log("            invoice.payment_failed");
    console.log("  Then copy its signing secret into STRIPE_WEBHOOK_SECRET.");
    console.log("");
    console.log("  And: Settings -> Billing -> Revenue recovery -> set the retry");
    console.log("  schedule so a failed card is retried within the 7-day grace.");
    console.log("");
    console.log("  The app finds the portal configuration above by name, so there");
    console.log("  is nothing to copy across. It never uses the account default.");
  }
  console.log("");
}

main().catch((e) => {
  console.error("\n  Stopped: " + (e?.message || e) + "\n");
  process.exit(1);
});

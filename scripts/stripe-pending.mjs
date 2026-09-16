// ---------------------------------------------------------------------------
// What does Stripe say is going to happen to each subscription NEXT?
//
//   node scripts/stripe-pending.mjs             # the LIVE account
//   node scripts/stripe-pending.mjs --sandbox   # the sandbox
//
// Read-only. Changes nothing, ever.
//
// ⚠️ WHY IT EXISTS. Our portal holds a downgrade - a smaller band, or yearly
// back to monthly - until the end of the period already paid for. Stripe does
// that by parking the change in a SUBSCRIPTION SCHEDULE and leaving the
// subscription alone, so nothing tells ShopWorks about it. /billing now asks
// Stripe directly (pendingPlanChange in app/lib/stripe.ts). This script proves
// that the thing it asks for is really where we think it is, on real data,
// rather than where the documentation says it should be.
//
// It prints the raw shape AND the verdict the app would reach, side by side.
// If the raw phases show a change and the verdict says "nothing pending", the
// app is wrong and this is where you find out.
//
// ⚠️⚠️ STRIPE'S LIST ENDPOINTS HIDE ANYTHING ON A TEST CLOCK.
// The SDK says it plainly on the subscription list call: "The response will
// not include subscriptions with test clocks if this and the customer
// parameter is not set." EVERY sandbox shop we build sits on a test clock, so
// the first version of this script listed subscriptions the obvious way, found
// nothing, and reported a tidy "0 with a scheduled change" while the downgrade
// sat in Stripe the whole time. A false all-clear is worse than no script at
// all. So it now walks the test clocks by hand and says how many it walked -
// if that number is wrong, you can see it is wrong.
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
const testMode = key.startsWith("sk_test_");

const priceCache = new Map();

async function describePrice(ref) {
  const id = typeof ref === "string" ? ref : ref && ref.id ? ref.id : null;
  if (!id) return { id: null, label: "(no price)", lookupKey: null };
  if (priceCache.has(id)) return priceCache.get(id);

  let out;
  try {
    const price = await stripe.prices.retrieve(id);
    const dollars = ((price.unit_amount || 0) / 100).toLocaleString("en-US");
    out = {
      id,
      lookupKey: price.lookup_key || null,
      label:
        (price.lookup_key || id) +
        "  $" + dollars +
        (price.recurring ? " / " + price.recurring.interval : ""),
    };
  } catch (e) {
    out = { id, lookupKey: null, label: id + "  (could not read: " + e.message + ")" };
  }

  priceCache.set(id, out);
  return out;
}

function stamp(seconds) {
  if (typeof seconds !== "number") return "(none)";
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function customerOf(obj) {
  if (!obj || !obj.customer) return null;
  return typeof obj.customer === "string" ? obj.customer : obj.customer.id || null;
}

// ---------------------------------------------------------------------------
// Every subscription on the account, INCLUDING the ones on test clocks.
// ---------------------------------------------------------------------------
async function allSubscriptions() {
  const byId = new Map();

  const plain = await stripe.subscriptions.list({
    status: "all",
    limit: 100,
    expand: ["data.schedule"],
  });
  for (const sub of plain.data) byId.set(sub.id, sub);

  const clocks = [];
  if (testMode) {
    const list = await stripe.testHelpers.testClocks.list({ limit: 100 });
    clocks.push(...list.data);

    for (const clock of clocks) {
      const onClock = await stripe.subscriptions.list({
        status: "all",
        limit: 100,
        test_clock: clock.id,
        expand: ["data.schedule"],
      });
      for (const sub of onClock.data) byId.set(sub.id, sub);
    }
  }

  return { subs: [...byId.values()], clocks, plainCount: plain.data.length };
}

// ---------------------------------------------------------------------------
// Every schedule, asked for from the other direction - per customer, because
// a bare list hides the test-clock ones just like subscriptions.
// ---------------------------------------------------------------------------
async function allSchedules(customerIds) {
  const byId = new Map();

  const plain = await stripe.subscriptionSchedules.list({ limit: 100 });
  for (const sch of plain.data) byId.set(sch.id, sch);

  for (const customer of customerIds) {
    const mine = await stripe.subscriptionSchedules.list({ customer, limit: 100 });
    for (const sch of mine.data) byId.set(sch.id, sch);
  }

  return [...byId.values()];
}

async function main() {
  const acct = await stripe.accounts.retrieve();
  console.log("");
  console.log("ACCOUNT : " + (acct.settings?.dashboard?.display_name || "(unnamed)"));
  console.log("id      : " + acct.id);
  console.log("mode    : " + (testMode ? "TEST / sandbox" : "LIVE"));

  const { subs, clocks, plainCount } = await allSubscriptions();

  console.log(
    "clocks  : " + (testMode ? clocks.length + " test clock(s) walked" : "(live - none)")
  );
  console.log(
    "subs    : " + subs.length + " found (" + plainCount + " not on a clock, " +
      (subs.length - plainCount) + " only visible by walking the clocks)"
  );
  console.log("");

  if (subs.length === 0) {
    console.log("No subscriptions on this account at all.\n");
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  let pendingCount = 0;

  for (const sub of subs) {
    const current = await describePrice(sub.items?.data?.[0]?.price || null);

    console.log("-".repeat(70));
    console.log("SUBSCRIPTION : " + sub.id);
    console.log("  customer   : " + customerOf(sub));
    console.log("  status     : " + sub.status);
    console.log("  on now     : " + current.label);
    console.log("  period ends: " + stamp(sub.items?.data?.[0]?.current_period_end));
    console.log("  cancel at period end : " + (sub.cancel_at_period_end === true ? "YES" : "no"));

    const schedule = sub.schedule;

    if (!schedule || typeof schedule === "string") {
      console.log("  schedule   : none");
      console.log("  VERDICT    : nothing pending - /billing shows the plan above");
      console.log("");
      continue;
    }

    console.log("  schedule   : " + schedule.id + "   status=" + schedule.status);

    for (const [i, phase] of (schedule.phases || []).entries()) {
      const p = await describePrice(phase.items?.[0]?.price || null);
      const future = phase.start_date > nowSeconds;
      console.log(
        "    phase " + i + "  " + stamp(phase.start_date) + " -> " + stamp(phase.end_date) +
          "  " + p.label + (future ? "   <-- in the future" : "")
      );
    }

    // ------------------------------------------------------------------
    // The same six rules as pendingPlanChange() in app/lib/stripe.ts. If you
    // change one there, change it here, or this stops being evidence.
    // ------------------------------------------------------------------
    let verdict = "nothing pending - /billing shows the plan above";

    if (schedule.status !== "active" && schedule.status !== "not_started") {
      verdict = "schedule is " + schedule.status + " - history, not a plan. Nothing shown.";
    } else {
      const upcoming = (schedule.phases || [])
        .filter((phase) => phase.start_date > nowSeconds)
        .sort((a, b) => a.start_date - b.start_date)[0];

      if (!upcoming) {
        verdict = "a schedule, but no phase in the future. Nothing shown.";
      } else {
        const next = await describePrice(upcoming.items?.[0]?.price || null);

        if (!next.id) {
          verdict = "⚠️ upcoming phase has no price. Nothing shown.";
        } else if (next.id === current.id) {
          verdict = "upcoming phase is the SAME price - nothing is changing. Nothing shown.";
        } else if (!next.lookupKey) {
          verdict =
            "⚠️ upcoming price has NO LOOKUP KEY (" + next.id + "), so the app " +
            "cannot name it and shows nothing. THIS IS A HOLE - the customer " +
            "still sees nothing in ShopWorks.";
        } else {
          pendingCount += 1;
          verdict =
            "/billing will say: changing to " + next.lookupKey +
            " on " + stamp(upcoming.start_date);
        }
      }
    }

    console.log("  VERDICT    : " + verdict);
    console.log("");
  }

  console.log("-".repeat(70));
  console.log(
    subs.length + " subscription(s) read, " + pendingCount +
      " with a scheduled change ShopWorks will now show."
  );
  console.log("");

  // ------------------------------------------------------------------
  // ⚠️ THE SECOND OPINION.
  //
  // Everything above trusts one belief: that a change the portal schedules
  // ends up hanging off subscription.schedule, where the app looks for it.
  // If that belief is wrong, every subscription above reads "schedule: none"
  // and the run looks like a clean pass when it is really a blind spot.
  //
  // So ask the other way round as well. A live schedule that did NOT turn up
  // above means the app is looking in the wrong place, and this says so.
  // ------------------------------------------------------------------
  const seen = new Set(
    subs
      .map((sub) => (sub.schedule && typeof sub.schedule !== "string" ? sub.schedule.id : null))
      .filter(Boolean)
  );

  const customerIds = new Set(subs.map(customerOf).filter(Boolean));
  const schedules = await allSchedules(customerIds);
  const live = schedules.filter(
    (sch) => sch.status === "active" || sch.status === "not_started"
  );

  console.log("SUBSCRIPTION SCHEDULES: " + schedules.length + " found, " + live.length + " live");

  let missed = 0;
  for (const sch of live) {
    const subId = typeof sch.subscription === "string" ? sch.subscription : sch.subscription?.id;
    const found = seen.has(sch.id);
    if (!found) missed += 1;
    console.log(
      "  " + sch.id + "  status=" + sch.status + "  subscription=" + (subId || "(none)") +
        (found ? "" : "   <-- ⚠️ NOT REACHED through subscription.schedule")
    );
  }

  console.log("");
  if (missed > 0) {
    console.log(
      "⚠️ " + missed + " live schedule(s) the app would NEVER see. pendingPlanChange() " +
        "in app/lib/stripe.ts looks at subscription.schedule and that is not where " +
        "these are. The feature is wrong - do not deploy it."
    );
  } else if (live.length > 0) {
    console.log(
      "Every live schedule was reachable through subscription.schedule, which is " +
        "where the app looks. The belief the feature rests on holds on real data."
    );
  } else if (!testMode) {
    // ⚠️ On the LIVE account, nothing pending is the RIGHT answer, not a
    // failed test. Telling Erik to go and schedule a downgrade here would be
    // telling him to go and do it to a real customer.
    console.log(
      "No schedules on the live account - nothing is pending for anybody. " +
        "That is the answer you want here. To TEST the feature, run this " +
        "with --sandbox."
    );
  } else {
    console.log(
      "No live schedules found, so nothing here proves or disproves anything. " +
        "Schedule a downgrade in the sandbox portal first - and check the " +
        "clock count above is not zero when it should not be."
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error("\n" + (e && e.message ? e.message : e) + "\n");
  process.exit(1);
});

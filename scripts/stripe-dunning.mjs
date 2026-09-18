// ---------------------------------------------------------------------------
// WHAT DOES STRIPE ACTUALLY DO WHEN A CARD FAILS?
//
//   node scripts/stripe-dunning.mjs            build it and leave it standing
//   node scripts/stripe-dunning.mjs --clean    delete a clock when you are done
//
// ⚠️ WHY THIS EXISTS. The seven-day grace period, the red banner and the
// lock-out at day seven were written from Stripe's documentation and have
// never once been exercised. Documentation is not evidence - that lesson cost
// $1,400 on the proration bug in September. This script produces evidence.
//
// WHAT IT DOES, in the SANDBOX only:
//   1. Builds a shop on a Stripe test clock and pays its first invoice with a
//      good card, so it is a shop that HAS paid us (that is the thing that
//      earns a grace period - see first_paid_at).
//   2. Swaps the card for one that attaches fine and then declines on charge
//      (4000 0000 0000 0341, which the API calls tok_chargeCustomerFail).
//   3. Winds the clock to the renewal, watches the payment fail, and then
//      follows Stripe's own retry schedule - advancing to each
//      next_payment_attempt it reports - until Stripe gives up.
//   4. Writes down exactly what happened and when, and saves the event
//      payloads to scripts/dunning-events.json so the webhook handler can be
//      tested against the real thing rather than against a guess.
//
// IT CHANGES NOTHING IN SHOPWORKS. Nothing here reaches the database or the
// deployed app - the app is on the LIVE key and would reject these events'
// signatures anyway. Replaying them into the handler is the next step and it
// is a separate script.
//
// ⚠️ IT REFUSES A LIVE KEY, FULL STOP. It creates customers and subscriptions,
// which have no business existing in the live account. There is no override.
//
// ⚠️ NEVER LIST. Stripe's list endpoints hide objects that sit on a test
// clock, so a script that lists subscriptions finds nothing here and reports a
// tidy all-clear. Everything below retrieves by id.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";

const argv = process.argv.slice(2);
const clean = argv.includes("--clean");

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Right folder?
// ---------------------------------------------------------------------------
const plansPath = path.join(process.cwd(), "app", "lib", "plans.ts");
if (!fs.existsSync(plansPath)) {
  console.error(
    "\nThis is not the ShopWorks folder.\n\n" +
      "  Running in : " + process.cwd() + "\n" +
      "  Looking for: " + plansPath + "\n\n" +
      "      cd " +
      path.join("C:", "Users", "erikp", "Desktop", "ShopWorks", "mhc-shop-app") +
      "\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The key. THE SANDBOX ONE, on its own line, so this can never pick up the
// live key and so nothing has to be swapped back and forth in .env.local.
// ---------------------------------------------------------------------------
function fromEnvFile(name) {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return "";
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return "";
}

const key = (
  process.env.STRIPE_SANDBOX_SECRET_KEY ||
  fromEnvFile("STRIPE_SANDBOX_SECRET_KEY") ||
  ""
).trim();

if (!key) {
  console.error(
    "\nNo STRIPE_SANDBOX_SECRET_KEY.\n\n" +
      "  Add a line to .env.local:\n\n" +
      "      STRIPE_SANDBOX_SECRET_KEY=sk_test_...\n"
  );
  process.exit(1);
}

if (!key.startsWith("sk_test_")) {
  console.error(
    "\n⚠️  THAT IS NOT A SANDBOX KEY.\n\n" +
      "  This script creates customers and subscriptions. It will not run\n" +
      "  against a live account, and there is no flag to make it.\n"
  );
  process.exit(1);
}

const stripe = new Stripe(key, { typescript: true });

// ---------------------------------------------------------------------------
// Output goes to the screen and to a file, so the whole run can be read back
// afterwards rather than remembered.
// ---------------------------------------------------------------------------
const logLines = [];
function out(s) {
  console.log(s);
  logLines.push(s);
}
function saveLog() {
  fs.writeFileSync(
    path.join(process.cwd(), "scripts", "stripe-dunning-output.txt"),
    logLines.join("\n") + "\n",
    "utf8"
  );
}

const DAY = 24 * 60 * 60;

function stamp(seconds) {
  if (!seconds) return "(none)";
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function money(cents, currency) {
  if (cents == null) return "-";
  return "$" + (cents / 100).toFixed(2) + (currency && currency !== "usd" ? " " + currency : "");
}

// ---------------------------------------------------------------------------
// Advancing a clock is not instant: Stripe replays everything that would have
// happened in between. Wait for Ready before believing anything you read.
// ---------------------------------------------------------------------------
async function advanceTo(clockId, to) {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === "ready") return c;
    if (c.status === "internal_failure") {
      throw new Error("test clock " + clockId + " failed to advance (Stripe's side)");
    }
  }
  throw new Error("test clock " + clockId + " did not finish advancing after 3 minutes");
}

// ---------------------------------------------------------------------------
// --clean: tear down a clock and everything on it.
// ---------------------------------------------------------------------------
if (clean) {
  const id = argValue("--clean");
  if (!id) {
    console.error(
      "\n  node scripts/stripe-dunning.mjs --clean clock_XXXX\n\n" +
        "  The clock id is printed at the end of a run and saved in\n" +
        "  scripts/dunning-events.json.\n"
    );
    process.exit(1);
  }
  const acct = await stripe.accounts.retrieve();
  console.log("\n  account: " + acct.id + "  " + (acct.settings?.dashboard?.display_name || ""));
  await stripe.testHelpers.testClocks.del(id);
  console.log("  deleted test clock " + id + " and everything on it.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ⚠️ SAY WHICH ACCOUNT, OUT LOUD, BEFORE DOING ANYTHING.
// "my Stripe account" turned out to be the live mhcfab.com store once already.
// ---------------------------------------------------------------------------
const account = await stripe.accounts.retrieve();

out("");
out("===========================================================================");
out("  FAILED CARD -> GRACE -> LOCK: what Stripe really does");
out("===========================================================================");
out("  account      : " + account.id + "   " +
    (account.settings?.dashboard?.display_name || "(no display name)"));
out("  mode         : SANDBOX (sk_test_)");
out("  started      : " + new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC");
out("");

// ---------------------------------------------------------------------------
// The price. By lookup key, exactly as the app resolves it - so this tests the
// same price a real shop would be put on.
// ---------------------------------------------------------------------------
const LOOKUP = "shopworks_band_1_15_monthly";

const prices = await stripe.prices.list({
  lookup_keys: [LOOKUP],
  active: true,
  limit: 1,
});
const price = prices.data[0];

if (!price) {
  out("");
  out("  ⚠️  No active price with lookup key " + LOOKUP + " in this account.");
  out("      Run: node scripts/stripe-setup.mjs --sandbox --apply");
  saveLog();
  process.exit(1);
}

out("  price        : " + price.id + "   " + LOOKUP + "   " +
    money(price.unit_amount, price.currency) + " / month");

// ---------------------------------------------------------------------------
// 1. A shop that has paid us once.
// ---------------------------------------------------------------------------
const startedAt = Math.floor(Date.now() / 1000);

const clock = await stripe.testHelpers.testClocks.create({
  frozen_time: startedAt,
  name: "shopworks dunning " + new Date(startedAt * 1000).toISOString().slice(0, 10),
});

out("  test clock   : " + clock.id + "   frozen at " + stamp(startedAt));

const customer = await stripe.customers.create({
  name: "dunning test shop",
  email: "dunning+" + startedAt + "@example.com",
  test_clock: clock.id,
});

const goodPm = await stripe.paymentMethods.create({
  type: "card",
  card: { token: "tok_visa" },
});
await stripe.paymentMethods.attach(goodPm.id, { customer: customer.id });
await stripe.customers.update(customer.id, {
  invoice_settings: { default_payment_method: goodPm.id },
});

// No trial: this shop is meant to have paid a real invoice, because that is
// what earns the seven-day grace period.
const created = await stripe.subscriptions.create({
  customer: customer.id,
  items: [{ price: price.id, quantity: 1 }],
  billing_mode: { type: "flexible" },
  default_payment_method: goodPm.id,
  payment_behavior: "error_if_incomplete",
  metadata: { plan_id: "band_1_15", billing_interval: "monthly" },
});

const firstInvoice = created.latest_invoice
  ? await stripe.invoices.retrieve(
      typeof created.latest_invoice === "string"
        ? created.latest_invoice
        : created.latest_invoice.id
    )
  : null;

out("  customer     : " + customer.id);
out("  subscription : " + created.id + "   status " + created.status);
out("  first invoice: " + (firstInvoice ? firstInvoice.id + "   " + firstInvoice.status +
    "   " + money(firstInvoice.amount_paid, firstInvoice.currency) : "(none)"));

if (!firstInvoice || firstInvoice.status !== "paid") {
  out("");
  out("  ⚠️  The first invoice did not pay. Everything below assumes a shop");
  out("      that HAS paid once, so stopping here rather than testing the");
  out("      wrong thing.");
  saveLog();
  process.exit(1);
}

// The renewal date, read off the subscription ITEM - since API 2025-03-31
// current_period_end is not on the subscription any more, and reading the old
// place silently gets undefined.
const item = created.items.data[0];
const renewsAt =
  item?.current_period_end ||
  // Older API shape, kept only as a fallback: reading this alone is the trap
  // that silently returns undefined on 2025-03-31 and later.
  created.current_period_end ||
  null;

if (!renewsAt) {
  out("");
  out("  \u26a0\ufe0f  Could not read the renewal date off the subscription ITEM or the");
  out("      subscription. Stopping rather than winding the clock blind.");
  saveLog();
  process.exit(1);
}

out("  renews       : " + stamp(renewsAt));
out("");

// ---------------------------------------------------------------------------
// 2. Swap in the card that declines on charge.
// ---------------------------------------------------------------------------
const badPm = await stripe.paymentMethods.create({
  type: "card",
  card: { token: "tok_chargeCustomerFail" },
});
await stripe.paymentMethods.attach(badPm.id, { customer: customer.id });
await stripe.customers.update(customer.id, {
  invoice_settings: { default_payment_method: badPm.id },
});
await stripe.subscriptions.update(created.id, { default_payment_method: badPm.id });

out("  card swapped : " + badPm.id + "   (4000 0000 0000 0341 - attaches, then declines)");
out("");

// ---------------------------------------------------------------------------
// 3. Wind the clock to the renewal and follow Stripe's own retry schedule.
// ---------------------------------------------------------------------------
const timeline = [];

async function snapshot(label, clockNow) {
  const sub = await stripe.subscriptions.retrieve(created.id);
  const invId =
    typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id;
  const inv = invId ? await stripe.invoices.retrieve(invId) : null;

  const row = {
    label,
    clockTime: clockNow,
    clockTimeReadable: stamp(clockNow),
    subscriptionStatus: sub.status,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    invoiceId: inv?.id || null,
    invoiceStatus: inv?.status || null,
    invoiceAttempts: inv?.attempt_count ?? null,
    amountDue: inv?.amount_due ?? null,
    nextPaymentAttempt: inv?.next_payment_attempt || null,
  };
  timeline.push(row);

  out(
    "  " + stamp(clockNow).padEnd(21) +
    " sub " + String(sub.status).padEnd(9) +
    " invoice " + String(inv?.status || "-").padEnd(9) +
    " attempts " + String(inv?.attempt_count ?? "-").padEnd(3) +
    " next try " + (inv?.next_payment_attempt ? stamp(inv.next_payment_attempt) : "(none)")
  );

  return { sub, inv };
}

out("  ---------------------------------------------------------------------");
out("  WINDING THE CLOCK");
out("  ---------------------------------------------------------------------");

let now = await advanceTo(clock.id, renewsAt + 3600);
let state = await snapshot("renewal attempted", now.frozen_time);

// Follow next_payment_attempt wherever it leads, rather than assuming what the
// retry schedule is. If the account's schedule changes, this still tells the
// truth.
let steps = 0;
while (
  steps < 12 &&
  state.sub.status !== "canceled" &&
  state.sub.status !== "unpaid" &&
  state.inv &&
  state.inv.next_payment_attempt
) {
  steps += 1;
  now = await advanceTo(clock.id, state.inv.next_payment_attempt + 3600);
  state = await snapshot("retry " + steps, now.frozen_time);
}

// If Stripe has stopped retrying but has not yet ended the subscription, push
// on a few days so the terminal state is actually observed rather than assumed.
if (state.sub.status !== "canceled" && state.sub.status !== "unpaid") {
  now = await advanceTo(clock.id, now.frozen_time + 7 * DAY);
  state = await snapshot("a week later", now.frozen_time);
}

out("");

// ---------------------------------------------------------------------------
// 4. What did it do, in one paragraph.
// ---------------------------------------------------------------------------
const firstFail = timeline.find((r) => r.invoiceStatus === "open" || r.subscriptionStatus === "past_due");
const ended = timeline[timeline.length - 1];
const daysToEnd = firstFail ? Math.round((ended.clockTime - firstFail.clockTime) / DAY) : null;

out("  ---------------------------------------------------------------------");
out("  WHAT STRIPE DID");
out("  ---------------------------------------------------------------------");
out("  first failed payment : " + (firstFail ? firstFail.clockTimeReadable : "(never failed?)"));
out("  retries observed     : " + steps);
out("  ended as             : subscription " + ended.subscriptionStatus +
    ", invoice " + (ended.invoiceStatus || "-"));
out("  days from first fail : " + (daysToEnd == null ? "-" : daysToEnd));
out("");
out("  ⚠️ READ THIS AGAINST OUR OWN RULE. ShopWorks does NOT wait for Stripe to");
out("     give up. my_shop_access() locks the shop the moment grace_ends_at is");
out("     in the past - seven days after the FIRST failure. Stripe's retries");
out("     carry on after that, and if one of them goes through the shop comes");
out("     back on by itself. The two clocks are independent and that is fine;");
out("     what matters is that the first failure is what starts ours.");
out("");

// ---------------------------------------------------------------------------
// The event payloads, for replaying into the webhook handler.
//
// ⚠️ events.list is a LIST endpoint and may not show anything that lives on a
// test clock. So: try it, say plainly whether it worked, and fall back to
// wrapping the objects retrieved by id in an event envelope. The objects are
// Stripe's own either way - only the envelope would be ours.
// ---------------------------------------------------------------------------
const WANTED = [
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
];

let events = [];
let source = "events.list";

try {
  const listed = await stripe.events.list({ limit: 100, types: WANTED });
  events = listed.data.filter((e) => {
    const o = e.data?.object || {};
    return (
      o.id === created.id ||
      o.customer === customer.id ||
      o.subscription === created.id
    );
  });
} catch {
  events = [];
}

if (!events.length) {
  source = "reconstructed";
  const sub = await stripe.subscriptions.retrieve(created.id);
  const inv = state.inv ? await stripe.invoices.retrieve(state.inv.id) : null;
  const envelope = (type, object) => ({
    id: "evt_local_" + type.replace(/[^a-z]/g, "") + "_" + Math.random().toString(36).slice(2, 10),
    object: "event",
    type,
    created: ended.clockTime,
    livemode: false,
    data: { object },
    reconstructed: true,
  });
  if (inv) events.push(envelope("invoice.payment_failed", inv));
  events.push(envelope("customer.subscription.updated", sub));
}

const outPath = path.join(process.cwd(), "scripts", "dunning-events.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      account: account.id,
      generatedAt: new Date().toISOString(),
      testClock: clock.id,
      customer: customer.id,
      subscription: created.id,
      priceLookupKey: LOOKUP,
      eventSource: source,
      timeline,
      events,
    },
    null,
    2
  ),
  "utf8"
);

out("  ---------------------------------------------------------------------");
out("  SAVED");
out("  ---------------------------------------------------------------------");
out("  scripts/dunning-events.json   " + events.length + " events, source: " + source);
if (source === "reconstructed") {
  out("  ⚠️  events.list returned nothing for these objects - which is exactly");
  out("      the test-clock blind spot. The objects in the file were retrieved");
  out("      by id and are Stripe's own; only the event envelope is ours.");
}
out("  scripts/stripe-dunning-output.txt");
out("");
out("  ⚠️ STILL STANDING IN THE SANDBOX, on purpose - the next step replays");
out("     these events into the handler, and the handler retrieves the");
out("     subscription from Stripe, so it has to still exist.");
out("");
out("     customer     : " + customer.id);
out("     subscription : " + created.id);
out("     test clock   : " + clock.id);
out("");
out("     When you are done:");
out("       node scripts/stripe-dunning.mjs --clean " + clock.id);
out("");

saveLog();

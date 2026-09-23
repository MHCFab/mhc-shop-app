// ---------------------------------------------------------------------------
// REPLAY THE REAL FAILED-CARD EVENTS INTO THE WEBHOOK HANDLER.
//
//   node scripts/stripe-replay.mjs --capture
//   node scripts/stripe-replay.mjs --company <uuid> --yes
//
// ⚠️ WHAT THIS IS FOR. scripts/stripe-dunning.mjs proved what Stripe does
// when a card fails: past_due, four retries, subscription cancelled seven days
// after the first failure. It proved nothing about OUR side. This takes those
// same events - Stripe's own payloads, not a guess at them - and posts them,
// correctly signed, at a copy of ShopWorks running on this machine.
//
// WHAT IT PROVES. That invoice.payment_failed sets past_due and
// grace_ends_at = seven days out, that it only does so for a shop with
// first_paid_at, and that the cancellation forgets the subscription id. It
// reads the shop's row from the database before and after and prints what
// actually moved - documentation is not evidence, and neither is a 200.
//
// ⚠️ IT WILL ONLY POST TO LOCALHOST. There is no flag to aim it at
// shopworks.app. Firing invented events at the live site would write real
// state for a real shop.
//
// BEFORE RUNNING, in another terminal:
//
//     set STRIPE_USE_SANDBOX=1
//     npm run dev
//
// That makes the local server read STRIPE_SANDBOX_SECRET_KEY instead of the
// live key, so when the handler retrieves the subscription it finds the
// sandbox one these events are about. Nothing in .env.local changes.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";

const argv = process.argv.slice(2);
const yes = argv.includes("--yes");
const capture = argv.includes("--capture");
const freshIds = argv.includes("--fresh-ids");

function argValue(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : fallback;
}

const url = argValue("--url", "http://localhost:3000/api/stripe/webhook");
const companyId = argValue("--company");

// ⚠️ --skip invoice.paid EXISTS FOR ONE REASON, and it is a lesson.
//
// To test that a shop which has NEVER paid gets no grace period, its
// first_paid_at is set to null and the events are replayed. But the run starts
// with invoice.paid, and invoice.paid STAMPS first_paid_at - correctly, that
// is how a shop earns it. So the column was refilled seconds before the rule
// that reads it was reached, and the test passed while proving nothing.
//
// Leaving an event out is not doctoring the evidence: each event is still
// Stripe's own and is still handled by the real handler. It is choosing which
// history the shop had, which is the whole point of testing a second case.
const skip = (argValue("--skip", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// ⚠️ LOCALHOST ONLY. Checked before anything else happens.
// ---------------------------------------------------------------------------
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();

if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(
    "\n⚠️  This posts made-up-but-real-looking Stripe events. It only ever\n" +
      "    posts them to a server on this machine.\n\n" +
      "    Refused: " + url + "\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Right folder, and the values out of .env.local.
// ---------------------------------------------------------------------------
const plansPath = path.join(process.cwd(), "app", "lib", "plans.ts");
if (!fs.existsSync(plansPath)) {
  console.error("\nThis is not the ShopWorks folder. Running in: " + process.cwd() + "\n");
  process.exit(1);
}

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return "";
}

const sandboxKey = (process.env.STRIPE_SANDBOX_SECRET_KEY || fromEnvFile("STRIPE_SANDBOX_SECRET_KEY")).trim();
const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || fromEnvFile("STRIPE_WEBHOOK_SECRET")).trim();
const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || fromEnvFile("NEXT_PUBLIC_SUPABASE_URL")).trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || fromEnvFile("SUPABASE_SERVICE_ROLE_KEY")).trim();

if (!webhookSecret) {
  console.error("\nNo STRIPE_WEBHOOK_SECRET in .env.local - nothing to sign with.\n");
  process.exit(1);
}
if (!sandboxKey.startsWith("sk_test_")) {
  console.error("\nSTRIPE_SANDBOX_SECRET_KEY is missing or is not a test key.\n");
  process.exit(1);
}

const stripe = new Stripe(sandboxKey, { typescript: true });
const eventsPath = path.join(process.cwd(), "scripts", "dunning-events.json");

if (!fs.existsSync(eventsPath)) {
  console.error("\nscripts/dunning-events.json is missing. Run stripe-dunning.mjs first.\n");
  process.exit(1);
}

const saved = JSON.parse(fs.readFileSync(eventsPath, "utf8"));

// ---------------------------------------------------------------------------
// --capture: go back to Stripe and take the events again.
//
// ⚠️ WHY THIS EXISTS. The first capture ran seconds after the last clock
// advance and came back missing the last retry and the cancellation - the two
// events the lock-out actually turns on. Events settle; the objects do not
// move. Run this once before replaying and the file holds the whole story.
// ---------------------------------------------------------------------------
if (capture) {
  const acct = await stripe.accounts.retrieve();
  console.log("\n  account   : " + acct.id + "   " + (acct.settings?.dashboard?.display_name || ""));
  console.log("  customer  : " + saved.customer);

  const wanted = [
    "invoice.paid",
    "invoice.payment_failed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ];

  const found = [];
  for await (const e of stripe.events.list({ limit: 100, types: wanted })) {
    const o = e.data?.object || {};
    if (
      o.id === saved.subscription ||
      o.customer === saved.customer ||
      o.subscription === saved.subscription
    ) {
      found.push(e);
    }
    if (found.length >= 100) break;
  }

  found.sort((a, b) => a.created - b.created);

  saved.events = found;
  saved.recapturedAt = new Date().toISOString();
  fs.writeFileSync(eventsPath, JSON.stringify(saved, null, 2), "utf8");

  console.log("  captured  : " + found.length + " events\n");
  for (const e of found) {
    const o = e.data.object;
    console.log(
      "    " + new Date(e.created * 1000).toISOString().slice(0, 16).replace("T", " ") +
      "  " + e.type.padEnd(32) +
      (o.object === "invoice"
        ? "invoice " + o.status + ", attempt " + o.attempt_count
        : "subscription " + o.status)
    );
  }

  const sub = await stripe.subscriptions.retrieve(saved.subscription).catch(() => null);
  console.log("\n  subscription now: " + (sub ? sub.status : "(gone)"));
  console.log("\n  Now replay:  node scripts/stripe-replay.mjs --company <uuid> --yes\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Reading the shop's row straight from the database, before and after.
// "Change, apply, read it back from the system itself."
// ---------------------------------------------------------------------------
const WATCH = [
  "name",
  "subscription_status",
  "stripe_customer_id",
  "stripe_subscription_id",
  "plan_id",
  "billing_interval",
  "trial_ends_at",
  "grace_ends_at",
  "first_paid_at",
  "past_due_notified_at",
  "locked_notified_at",
  "cancel_at_period_end",
  "current_period_end",
];

async function readCompany(id) {
  if (!supabaseUrl || !serviceKey) return null;
  const res = await fetch(
    supabaseUrl + "/rest/v1/companies?id=eq." + id + "&select=" + WATCH.join(","),
    { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } }
  );
  if (!res.ok) {
    console.log("  (could not read the shop's row: " + res.status + " " + (await res.text()) + ")");
    return null;
  }
  const rows = await res.json();
  return rows[0] || null;
}

if (!companyId) {
  console.error(
    "\n  Which shop is this aimed at?\n\n" +
      "    node scripts/stripe-replay.mjs --company <uuid> --yes\n\n" +
      "  That shop's stripe_customer_id must already be " + saved.customer + ".\n"
  );
  process.exit(1);
}

const before = await readCompany(companyId);

console.log("");
console.log("===========================================================================");
console.log("  REPLAYING " + saved.events.length + " EVENTS INTO " + url);
console.log("===========================================================================");
console.log("  shop        : " + (before ? before.name : "(row not readable)") + "   " + companyId);
console.log("  its customer: " + (before ? before.stripe_customer_id : "?"));
console.log("  events about: " + saved.customer);
console.log("");

if (before && before.stripe_customer_id !== saved.customer) {
  console.error(
    "  ⚠️  THAT SHOP IS NOT POINTED AT THESE EVENTS' CUSTOMER.\n\n" +
      "      The handler finds a shop BY stripe_customer_id, so this replay\n" +
      "      would land on nothing - or worse, on whichever shop does carry\n" +
      "      that id. Point the junk shop at " + saved.customer + " first.\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ⚠️ IS THIS A REAL SHOP?
//
// The customer-id check above only proves the row is pointed at these events.
// It would happily have let this run against MHC Fab, which would have set the
// live shop past_due and then canceled and locked everybody out of the app
// they work in. A shop people actually use has logins attached; a throwaway
// row created for this test has none. That is the difference worth checking.
// ---------------------------------------------------------------------------
async function loginCount(id) {
  if (!supabaseUrl || !serviceKey) return null;
  const res = await fetch(
    supabaseUrl + "/rest/v1/memberships?company_id=eq." + id + "&select=user_id",
    { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } }
  );
  if (!res.ok) return null;
  return (await res.json()).length;
}

const logins = await loginCount(companyId);

if (logins === null) {
  console.error(
    "  \u26a0\ufe0f  Could not check whether that shop has logins attached.\n\n" +
      "      Refusing rather than guessing. These events set a shop past_due\n" +
      "      and then cancelled, and on a shop somebody works in that is a\n" +
      "      lock-out.\n"
  );
  process.exit(1);
}

if (logins > 0) {
  console.error(
    "  \u26a0\ufe0f  THAT SHOP HAS " + logins + " LOGIN(S) ATTACHED. It is somebody's\n" +
      "      real shop, not a throwaway.\n\n" +
      "      Replaying these events would set it past_due and then cancelled,\n" +
      "      which locks those people out of the app. Refusing.\n"
  );
  process.exit(1);
}

console.log("  logins      : 0 - a throwaway row, safe to write to");
console.log("");

if (!yes) {
  console.log("  Nothing sent. Add --yes once the shop above is the one you mean.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ⚠️ THE HANDLER CLAIMS EACH EVENT ID ONCE, on purpose, so a repeated
// payment_failed cannot restart the grace clock. That means replaying the same
// file twice does nothing the second time and looks like a broken handler.
// --fresh-ids rewrites only the envelope id so it processes again; the object
// inside is untouched and is still Stripe's own.
// ---------------------------------------------------------------------------
const events = [...saved.events]
  .sort((a, b) => a.created - b.created)
  .filter((e) => !skip.includes(e.type));

if (skip.length) {
  console.log("  skipping    : " + skip.join(", ") +
    "   (" + (saved.events.length - events.length) + " event(s) left out)");
  console.log("");
}

// ⚠️ READ THE ROW AFTER EVERY EVENT, NOT JUST AT THE END.
//
// The cancellation clears grace_ends_at - correctly, because a cancelled shop
// is locked outright and has no clock left to run. But that means a
// before-and-after of the whole run shows grace_ends_at as null and proves
// NOTHING about the seven days, which is the single thing this test exists to
// check. The grace window only exists between the first failure and the
// cancellation, so it has to be read while it is there.
let last = before;

console.log("  " + "sent".padEnd(22) + "type".padEnd(34) + "reply");
console.log("  " + "-".repeat(70));

for (const original of events) {
  const event = freshIds
    ? { ...original, id: original.id + "_replay" + Date.now().toString(36) }
    : original;

  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
  });

  let reply = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    });
    const text = (await res.text()).slice(0, 60).replace(/\s+/g, " ");
    reply = res.status + " " + text;
  } catch (e) {
    reply = "FAILED " + (e instanceof Error ? e.message : String(e));
  }

  console.log(
    "  " +
      new Date(event.created * 1000).toISOString().slice(0, 16).replace("T", " ").padEnd(22) +
      event.type.padEnd(34) +
      reply
  );

  const now = await readCompany(companyId);
  if (last && now) {
    for (const col of WATCH) {
      if (String(last[col]) !== String(now[col])) {
        console.log("      " + col.padEnd(24) + String(last[col]) + "  ->  " + String(now[col]));
      }
    }
  }

  // ⚠️ SAY WHAT THE TWO COLUMNS ARE, EVERY TIME, CHANGED OR NOT.
  // When the thing being tested is that a column does NOT move - a shop with
  // no first_paid_at must never be given a grace period - "no line was
  // printed" is not evidence. Printing the value on every event turns the
  // absence of a change into something you can actually read.
  if (now) {
    console.log(
      "      = status " + String(now.subscription_status).padEnd(10) +
      " grace " + String(now.grace_ends_at)
    );
  }

  last = now;
}

// ---------------------------------------------------------------------------
// What actually moved.
// ---------------------------------------------------------------------------
const after = await readCompany(companyId);

console.log("");
console.log("  ---------------------------------------------------------------------");
console.log("  WHAT MOVED ON THE SHOP'S ROW");
console.log("  ---------------------------------------------------------------------");

if (!before || !after) {
  console.log("  Could not read the row on both sides, so nothing is proven here.");
} else {
  let changed = 0;
  for (const col of WATCH) {
    const a = before[col];
    const b = after[col];
    if (String(a) !== String(b)) {
      changed += 1;
      console.log("  " + col.padEnd(24) + String(a) + "   ->   " + String(b));
    }
  }
  if (!changed) {
    console.log("  NOTHING CHANGED. Either the events were all claimed already");
    console.log("  (try --fresh-ids), or the handler did not find this shop.");
  }
  console.log("");
  console.log("  ⚠️ grace_ends_at is expected to be NULL down here if the");
  console.log("     cancellation was replayed - a cancelled shop has no clock");
  console.log("     left to run. The seven days are proven in the per-event");
  console.log("     lines above, on whichever event first found the shop");
  console.log("     past_due - and only if first_paid_at was set. Which of");
  console.log("     the two events gets there first depends on Stripe's");
  console.log("     delivery order, which is why the rule is written in both.");
}
console.log("");

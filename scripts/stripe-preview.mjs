// ---------------------------------------------------------------------------
// What would Stripe ACTUALLY charge if somebody changed their plan?
//
//   node scripts/stripe-preview.mjs
//
// ⚠️ WHY THIS EXISTS. On 11 September the billing portal offered a shop on
// $149 monthly the yearly plan for $2,831.01 - two years at once. Three
// settings had been chosen by reading Stripe's documentation, and the first
// real test found a $1,400 overcharge. Documentation is not evidence about
// money. This script produces the evidence.
//
// WHAT IT DOES. In the SANDBOX only, it builds throwaway shops on a Stripe
// test clock, then asks Stripe - for every plan change a customer could make,
// at the start of a period and again halfway through, under every combination
// of the two settings that are in question - "what would you bill for this?"
// Stripe answers with the exact invoice. Nothing is charged and no real
// customer is touched: the invoice preview API changes nothing, and the test
// clock and everything on it is deleted at the end.
//
// It prints a table you can read, and writes the whole thing to
// stripe-preview-output.txt in this folder so it can be sent on in one piece.
//
// ⚠️ IT REFUSES A LIVE KEY, FULL STOP. There is no --live escape hatch like
// stripe-setup.mjs has, because unlike that script this one CREATES customers
// and subscriptions. Those have no business existing in the live account.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const keep = argv.includes("--keep"); // leave the test clock behind to poke at
const commit = argv.includes("--commit"); // also DO one change for real, in the sandbox
const portalOnly = argv.includes("--portal"); // build one shop and hand back a portal link

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Right folder? Asked first, for the same reason stripe-setup.mjs asks first.
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
// The key.
//
// ⚠️ NOT STRIPE_SECRET_KEY. That one is the LIVE key now - .env.local and
// Vercel both point at the live account since 14 September. This script wants
// the SANDBOX key and looks for its own separate line:
//
//     STRIPE_SANDBOX_SECRET_KEY=sk_test_...
//
// Keeping it under a different name means running this can never accidentally
// pick up the live key, and means you do not have to swap .env.local back and
// forth (which is how the wrong key ends up deployed).
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
    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
  }
  return "";
}

const keySource = argValue("--key")
  ? "--key on the command line"
  : process.env.STRIPE_SANDBOX_SECRET_KEY
  ? "STRIPE_SANDBOX_SECRET_KEY in the environment"
  : "STRIPE_SANDBOX_SECRET_KEY in .env.local";

const key = (
  argValue("--key") ||
  process.env.STRIPE_SANDBOX_SECRET_KEY ||
  fromEnvFile("STRIPE_SANDBOX_SECRET_KEY") ||
  ""
).trim();

if (!key) {
  console.error(
    "\nNo sandbox key found.\n\n" +
      "  Add this line to .env.local, on its own line, no quotes, no spaces\n" +
      "  around the = sign, and SAVE the file (Ctrl+S):\n\n" +
      "      STRIPE_SANDBOX_SECRET_KEY=sk_test_...\n\n" +
      "  Get it from the Stripe dashboard while you are in the SANDBOX\n" +
      "  (Shopworks sandbox, top-left switcher): Developers -> API keys ->\n" +
      "  Secret key. Use the COPY BUTTON. Selecting the text on screen copies\n" +
      "  the hidden middle and gives a key that will not work.\n\n" +
      "  ⚠️ Leave STRIPE_SECRET_KEY alone. That is the live key and the app\n" +
      "  needs it where it is.\n"
  );
  process.exit(1);
}

const junk = key.match(/[^A-Za-z0-9_]/);
if (junk) {
  console.error(
    "\nThat key has a '" + junk[0] + "' in it, so it is not a real key.\n\n" +
      "  That is the masked-copy mistake - use the COPY BUTTON next to the\n" +
      "  key rather than selecting the text.\n"
  );
  process.exit(1);
}

// ⚠️⚠️ THE GUARD THAT MATTERS. This script creates customers and
// subscriptions. On the live account those would be real records attached to
// real money, and there is no reason ever to want them there.
if (!key.startsWith("sk_test_")) {
  console.error(
    "\n  ⚠️  REFUSING TO RUN. That is not a sandbox key.\n\n" +
      "  Read from  : " + keySource + "\n" +
      "  Starts with: " + key.slice(0, 8) + "\n\n" +
      "  This script CREATES customers and subscriptions, so it only ever\n" +
      "  runs against a sandbox key (sk_test_...). There is deliberately no\n" +
      "  way to override this.\n"
  );
  process.exit(1);
}

if (key.length < 40) {
  console.error(
    "\nThat key is only " + key.length + " characters, which is too short to\n" +
      "  be a real Stripe secret key - it looks truncated.\n"
  );
  process.exit(1);
}

const stripe = new Stripe(key);

// ---------------------------------------------------------------------------
// The plans, read out of app/lib/plans.ts - same parser as stripe-setup.mjs,
// same reason. The prices are never typed in twice.
// ---------------------------------------------------------------------------
const plansSource = fs.readFileSync(plansPath, "utf8");

function parsePlans(src) {
  const out = [];
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

const plans = parsePlans(plansSource);
if (plans.length !== 3) {
  console.error(
    "\nRead " + plans.length + " plans out of app/lib/plans.ts, expected 3.\n" +
      "The file has probably been reformatted. Fix the parser rather than\n" +
      "typing prices in by hand.\n"
  );
  process.exit(1);
}

const planById = Object.fromEntries(plans.map((p) => [p.id, p]));
const lookupKey = (plan, interval) => "shopworks_" + plan + "_" + interval;
const priceOf = (plan, interval) => planById[plan].prices[interval];

const INTERVAL_LABEL = {
  monthly: "monthly",
  quarterly: "quarterly",
  semiannual: "6-monthly",
  annual: "yearly",
};

// Roughly how long each interval is, in days. Only used to describe a scenario
// in words and to work out a rough expectation - the real numbers all come
// back from Stripe.
const INTERVAL_DAYS = {
  monthly: 30,
  quarterly: 91,
  semiannual: 182,
  annual: 365,
};

// ---------------------------------------------------------------------------
// Everything gets written to a file as well as the screen, because the whole
// point is to send these numbers to somebody else.
// ---------------------------------------------------------------------------
const transcript = [];
function out(line = "") {
  const text = String(line);
  transcript.push(text);
  console.log(text);
}

function money(cents) {
  if (typeof cents !== "number") return "-";
  const sign = cents < 0 ? "-" : "";
  const v = Math.abs(cents) / 100;
  return (
    sign +
    "$" +
    v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function day(unixSeconds) {
  if (typeof unixSeconds !== "number") return "-";
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The scenarios.
//
// Every plan change a real customer could make from the portal, described the
// way Erik would describe it rather than in Stripe's words. `from` is what
// they are on, `to` is what they click.
// ---------------------------------------------------------------------------
const SCENARIOS = [
  {
    key: "monthly-to-yearly",
    from: ["band_1_15", "monthly"],
    to: ["band_1_15", "annual"],
    note: "THE ONE THAT BROKE. Upgrade: same band, pay for a year up front.",
  },
  {
    key: "monthly-to-quarterly",
    from: ["band_1_15", "monthly"],
    to: ["band_1_15", "quarterly"],
    note: "Upgrade: same band, pay three months up front.",
  },
  {
    key: "band-up-same-interval",
    from: ["band_1_15", "monthly"],
    to: ["band_16_50", "monthly"],
    note: "Upgrade: more logins, still monthly. The shop hired people.",
  },
  {
    key: "band-down-same-interval",
    from: ["band_16_50", "monthly"],
    to: ["band_1_15", "monthly"],
    note:
      "DOWNGRADE. Must not hand money back - a credit against future " +
      "invoices is fine, a refund is not.",
  },
  {
    key: "yearly-to-monthly",
    from: ["band_1_15", "annual"],
    to: ["band_1_15", "monthly"],
    note:
      "DOWNGRADE onto a shorter interval. The portal's shortening_interval " +
      "rule should push this to the end of the period, so the honest answer " +
      "here is 'nothing today'.",
  },
  {
    key: "quarterly-to-yearly",
    from: ["band_1_15", "quarterly"],
    to: ["band_1_15", "annual"],
    note: "Upgrade: three months up front, moving to a year up front.",
  },
];

// The two settings under suspicion, in every combination.
const PRORATION_BEHAVIOURS = ["create_prorations", "always_invoice", "none"];
const ANCHORS = ["unchanged", "now"];

// What is configured in the portal right now (switched off, but this is the
// combination that produced the $2,831.01). Marked in the output so the
// reproduction is visible rather than assumed.
const WHAT_BROKE = { proration_behavior: "create_prorations", billing_cycle_anchor: "unchanged" };

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
// ⚠️ STRIPE ALLOWS ONLY THREE CUSTOMERS PER TEST CLOCK, and this needs four
// starting plans. So the shops are spread over several clocks, all frozen at
// the same moment and all advanced together - which behaves identically to one
// clock and keeps room to spare under the limit.
const clockIds = [];
const CUSTOMERS_PER_CLOCK = 2;

async function main() {
  const acct = await stripe.accounts.retrieve();
  out("");
  out("ShopWorks - what would a plan change actually cost?");
  out("");
  out("  ACCOUNT      : " + (acct.settings?.dashboard?.display_name || "(unnamed)"));
  out("  account id   : " + acct.id);
  out("  mode         : SANDBOX (sk_test_)");
  out("  key read from: " + keySource);
  out("  run at       : " + new Date().toISOString());
  out("");
  out("  Nothing here is charged. The invoice preview API answers the");
  out("  question without creating anything, and the throwaway shops this");
  out("  builds are deleted at the end.");
  out("");

  // -------------------------------------------------------------------
  // Price ids, by lookup key. An unknown lookup key means stripe-setup.mjs
  // has not been run against this account, and every number below would be
  // meaningless - so stop rather than guess.
  // -------------------------------------------------------------------
  const needed = new Set();
  for (const s of SCENARIOS) {
    needed.add(lookupKey(s.from[0], s.from[1]));
    needed.add(lookupKey(s.to[0], s.to[1]));
  }

  const priceIds = {};
  for (const lk of needed) {
    const found = await stripe.prices.list({ lookup_keys: [lk], active: true, limit: 1 });
    if (!found.data[0]) {
      out("");
      out("  ⚠️  No active price with the lookup key " + lk + " in this account.");
      out("      Run:  node scripts/stripe-setup.mjs --apply");
      out("      against the SANDBOX key first, then run this again.");
      out("");
      process.exit(1);
    }
    priceIds[lk] = found.data[0].id;
  }
  out("  prices found : " + Object.keys(priceIds).length + " of " + needed.size);
  out("");

  // -------------------------------------------------------------------
  // --portal: skip the previews and hand back a link into the SANDBOX
  // billing portal.
  //
  // ⚠️ WHY THIS EXISTS. The app's own "Manage billing" button cannot be used
  // to test any of this: .env.local and Vercel both hold the LIVE key since
  // 14 September, so that button opens the LIVE portal. Swapping the keys
  // over to test is how the wrong key ends up deployed. This builds one
  // throwaway shop with a real subscription and asks Stripe for a portal
  // session against it directly, so the page you click through is the sandbox
  // portal with the sandbox configuration and nothing has to be swapped.
  //
  // ⚠️ IT LEAVES ITS TEST CLOCK BEHIND on purpose - deleting it would take the
  // customer with it while you are still looking at the page. The clock id is
  // printed; delete it in the sandbox dashboard when you are done.
  // -------------------------------------------------------------------
  if (portalOnly) {
    await portalLink(priceIds);
    return;
  }

  // -------------------------------------------------------------------
  // Test clocks, so "halfway through the period" is a real thing Stripe
  // agrees with rather than a date we made up.
  // -------------------------------------------------------------------
  const startedAt = Math.floor(Date.now() / 1000) - 60;

  // -------------------------------------------------------------------
  // One throwaway shop per starting plan, each with a working card, each
  // actually subscribed and paid - so the prorations below are computed
  // against a real paid-up period rather than a trial.
  //
  // billing_mode flexible, because that is what Checkout creates, and the
  // open question includes whether flexible behaves differently.
  // -------------------------------------------------------------------
  const startingPlans = [];
  for (const s of SCENARIOS) {
    const id = s.from.join("/");
    if (!startingPlans.some((p) => p.id === id)) {
      startingPlans.push({ id, plan: s.from[0], interval: s.from[1] });
    }
  }

  const subs = {};
  for (const [index, sp] of startingPlans.entries()) {
    // A new clock every couple of shops, for the three-customer limit.
    if (index % CUSTOMERS_PER_CLOCK === 0) {
      const clock = await stripe.testHelpers.testClocks.create({
        frozen_time: startedAt,
        name: "shopworks proration preview " + (clockIds.length + 1),
      });
      clockIds.push(clock.id);
      out("  test clock   : " + clock.id + "   frozen at " + day(startedAt));
    }
    const clockId = clockIds[clockIds.length - 1];

    const customer = await stripe.customers.create({
      name: "preview " + sp.id,
      email: "preview+" + sp.plan + "." + sp.interval + "@example.com",
      test_clock: clockId,
    });

    const pm = await stripe.paymentMethods.create({
      type: "card",
      card: { token: "tok_visa" },
    });
    await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    });

    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceIds[lookupKey(sp.plan, sp.interval)], quantity: 1 }],
      billing_mode: { type: "flexible" },
      default_payment_method: pm.id,
      payment_behavior: "error_if_incomplete",
    });

    subs[sp.id] = sub;
    out(
      "  subscribed   : " +
        planById[sp.plan].label +
        ", " +
        INTERVAL_LABEL[sp.interval] +
        " $" +
        priceOf(sp.plan, sp.interval) +
        "   " +
        sub.id +
        "  (" +
        sub.status +
        ")"
    );
  }
  out("");

  // -------------------------------------------------------------------
  // Two moments: the day they subscribed, and partway through. A customer
  // who upgrades the same afternoon and one who upgrades two weeks in are
  // different amounts of money, and the bug showed up on day one.
  // -------------------------------------------------------------------
  const results = [];

  await runPhase("Day 1 of the period - they subscribed and changed their mind", subs, priceIds, results);

  const advanceTo = startedAt + 15 * 24 * 60 * 60;
  out("");
  out("  advancing the test clock to " + day(advanceTo) + " (15 days in)...");
  await advanceClock(advanceTo);

  const refreshed = {};
  for (const [id, sub] of Object.entries(subs)) {
    refreshed[id] = await stripe.subscriptions.retrieve(sub.id);
  }

  await runPhase("15 days into the period", refreshed, priceIds, results);

  // -------------------------------------------------------------------
  // The scoreboard.
  // -------------------------------------------------------------------
  summarise(results);

  // -------------------------------------------------------------------
  // Optional: stop previewing and actually DO one, in the sandbox, so the
  // preview can be checked against what Stripe really does.
  // -------------------------------------------------------------------
  if (commit) await commitOne(refreshed, priceIds);
}

// ---------------------------------------------------------------------------
// Advancing a test clock is not instant - Stripe replays everything that would
// have happened in between, so this waits for it to say Ready.
// ---------------------------------------------------------------------------
async function advanceClock(to) {
  // Start them all moving first, then wait - they run in parallel on Stripe's
  // side, so waiting for each in turn would take as many times as long.
  for (const id of clockIds) {
    await stripe.testHelpers.testClocks.advance(id, { frozen_time: to });
  }

  const waiting = new Set(clockIds);
  for (let i = 0; i < 90 && waiting.size; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    for (const id of [...waiting]) {
      const c = await stripe.testHelpers.testClocks.retrieve(id);
      if (c.status === "ready") waiting.delete(id);
      else if (c.status === "internal_failure") {
        throw new Error("test clock " + id + " failed to advance (Stripe's side)");
      }
    }
  }
  if (waiting.size) {
    throw new Error("a test clock did not finish advancing after 3 minutes");
  }
}

// ---------------------------------------------------------------------------
// One phase = every scenario, every combination of the two settings.
// ---------------------------------------------------------------------------
async function runPhase(phaseLabel, subs, priceIds, results) {
  // ⚠️ Clock time, NOT the real clock. Every clock here is frozen at the same
  // moment, so the first one speaks for all of them.
  const c = await stripe.testHelpers.testClocks.retrieve(clockIds[0]);
  const now = c.frozen_time;

  out("");
  out("===========================================================================");
  out("  " + phaseLabel.toUpperCase());
  out("  (Stripe's clock says " + day(now) + ")");
  out("===========================================================================");

  for (const scenario of SCENARIOS) {
    const sub = subs[scenario.from.join("/")];
    const item = sub.items.data[0];

    // ⚠️ Stripe MOVED the period off the subscription and onto the ITEM in the
    // 2025-03-31 API version. Reading it from the old place gets undefined,
    // and undefined here would make every number below nonsense - so read the
    // item first and only fall back.
    const periodEnd = item.current_period_end ?? sub.current_period_end;
    const periodStart = item.current_period_start ?? sub.current_period_start;

    if (typeof periodEnd !== "number" || typeof periodStart !== "number") {
      out("");
      out("  ⚠️ Could not read the billing period off " + sub.id + ". Skipping.");
      continue;
    }

    const oldPrice = priceOf(scenario.from[0], scenario.from[1]);
    const newPrice = priceOf(scenario.to[0], scenario.to[1]);

    // What SHOULD happen, in Erik's words: credit the unused part of what
    // they paid, charge the new price, take the difference today.
    const totalDays = Math.max(1, (periodEnd - periodStart) / 86400);
    const leftDays = Math.max(0, (periodEnd - now) / 86400);
    const credit = (oldPrice * leftDays) / totalDays;
    const target = newPrice - credit;

    out("");
    out("---------------------------------------------------------------------------");
    out(
      "  " +
        planById[scenario.from[0]].label +
        " " +
        INTERVAL_LABEL[scenario.from[1]] +
        " $" +
        oldPrice +
        "   ->   " +
        planById[scenario.to[0]].label +
        " " +
        INTERVAL_LABEL[scenario.to[1]] +
        " $" +
        newPrice
    );
    out("  " + scenario.note);
    out(
      "  Paid-for period " +
        day(periodStart) +
        " to " +
        day(periodEnd) +
        ", " +
        leftDays.toFixed(1) +
        " of " +
        totalDays.toFixed(0) +
        " days unused."
    );
    out(
      "  What Erik asked for: credit about " +
        money(Math.round(credit * 100)) +
        ", charge $" +
        newPrice +
        ", so about " +
        money(Math.round(target * 100)) +
        " today."
    );
    out("");
    out(
      "    proration_behavior   anchor      Stripe would invoice   dated        lines"
    );

    for (const proration_behavior of PRORATION_BEHAVIOURS) {
      for (const billing_cycle_anchor of ANCHORS) {
        // ⚠️ proration_date is only ALLOWED in some of these combinations.
        // Stripe refuses it outright when the anchor moves to now, and when
        // there is no proration to date. Sending it anyway turns a real answer
        // into "REFUSED", which reads like Stripe rejecting the SETTINGS when
        // it is only rejecting the extra field. Learned the hard way on the
        // first run - four of the six combinations came back empty.
        const details = {
          items: [
            {
              id: item.id,
              price: priceIds[lookupKey(scenario.to[0], scenario.to[1])],
              quantity: 1,
            },
          ],
          proration_behavior,
          billing_cycle_anchor,
        };
        if (billing_cycle_anchor === "unchanged" && proration_behavior !== "none") {
          details.proration_date = now;
        }

        let preview = null;
        let error = null;
        try {
          preview = await stripe.invoices.createPreview({
            customer: sub.customer,
            subscription: sub.id,
            subscription_details: details,
          });
        } catch (e) {
          error = e?.message || String(e);
        }

        const isCurrent =
          proration_behavior === WHAT_BROKE.proration_behavior &&
          billing_cycle_anchor === WHAT_BROKE.billing_cycle_anchor;

        const row = {
          phase: phaseLabel,
          scenario: scenario.key,
          proration_behavior,
          billing_cycle_anchor,
          target: Math.round(target * 100),
          total: preview ? preview.total : null,
          error,
        };
        results.push(row);

        out(
          "    " +
            proration_behavior.padEnd(21) +
            billing_cycle_anchor.padEnd(12) +
            (error ? "REFUSED" : money(preview.total)).padStart(14) +
            "   " +
            (error ? "-" : day(preview.period_end || preview.created)).padStart(10) +
            "   " +
            (error ? "" : String(preview.lines?.data?.length ?? 0)).padStart(5) +
            (isCurrent ? "   <-- the combination that produced $2,831.01" : "")
        );

        if (error) {
          out("        Stripe refused it: " + error);
          continue;
        }

        // The line items. This is the bit that actually explains a number,
        // and it is why a screenshot of a total is never enough.
        for (const l of preview.lines?.data || []) {
          const p = l.period;
          out(
            "        " +
              money(l.amount).padStart(12) +
              "   " +
              (p ? day(p.start) + " to " + day(p.end) : "").padEnd(25) +
              (l.description || "")
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Which combination, if any, does what Erik asked for everywhere?
//
// ⚠️ This is a reading of the numbers, not a decision. The numbers above it
// are the evidence; if this disagrees with them, believe them.
// ---------------------------------------------------------------------------
function summarise(results) {
  out("");
  out("===========================================================================");
  out("  SCOREBOARD");
  out("===========================================================================");
  out("");
  out("  An upgrade passes when Stripe's number is within $2 of 'new price");
  out("  minus the unused credit'. A downgrade passes when nothing is handed");
  out("  back - the total is not negative.");
  out("");

  const combos = [];
  for (const pb of PRORATION_BEHAVIOURS) {
    for (const a of ANCHORS) combos.push({ pb, a });
  }

  for (const combo of combos) {
    const rows = results.filter(
      (r) => r.proration_behavior === combo.pb && r.billing_cycle_anchor === combo.a
    );
    const bad = [];
    for (const r of rows) {
      if (r.error) {
        bad.push(r.scenario + " (refused)");
        continue;
      }
      const isDowngrade =
        r.scenario === "band-down-same-interval" || r.scenario === "yearly-to-monthly";
      if (isDowngrade) {
        if (r.total < 0) bad.push(r.scenario + " (" + money(r.total) + " back)");
      } else if (Math.abs(r.total - r.target) > 200) {
        bad.push(r.scenario + " (" + money(r.total) + " vs " + money(r.target) + ")");
      }
    }
    out(
      "  " +
        combo.pb.padEnd(21) +
        combo.a.padEnd(12) +
        (bad.length === 0 ? "MATCHES WHAT WAS ASKED FOR" : bad.length + " off: " + bad.join(", "))
    );
  }

  out("");
  out("  ⚠️ A combination passing here is not permission to switch plan");
  out("     changes back on. It is permission to try it in the SANDBOX portal");
  out("     and check the page against these numbers.");
  out("");
}

// ---------------------------------------------------------------------------
// --commit: stop previewing, actually change one subscription in the sandbox,
// and print what Stripe really billed.
//
// ⚠️ A preview says what Stripe WOULD do through the API. The portal is a
// different caller. This closes half the gap; the other half only closes when
// somebody clicks the button in the sandbox portal and reads the page.
// ---------------------------------------------------------------------------
async function commitOne(subs, priceIds) {
  const pb = argValue("--proration") || "create_prorations";
  const anchor = argValue("--anchor") || "now";
  const scenario = SCENARIOS[0]; // monthly -> yearly, the one that broke

  out("");
  out("===========================================================================");
  out("  DOING IT FOR REAL (sandbox) - " + pb + " / " + anchor);
  out("===========================================================================");

  const sub = subs[scenario.from.join("/")];
  const item = sub.items.data[0];

  const updated = await stripe.subscriptions.update(sub.id, {
    items: [
      { id: item.id, price: priceIds[lookupKey(scenario.to[0], scenario.to[1])], quantity: 1 },
    ],
    proration_behavior: pb,
    billing_cycle_anchor: anchor,
  });

  out("");
  out("  subscription " + updated.id + " is now " + updated.status);
  out("  next period ends " + day(updated.items.data[0].current_period_end));
  out("");

  const invoices = await stripe.invoices.list({ customer: sub.customer, limit: 10 });
  out("  invoices on this customer, newest first:");
  for (const inv of invoices.data) {
    out(
      "    " +
        day(inv.created) +
        "   " +
        money(inv.total).padStart(12) +
        "   " +
        inv.status +
        "   " +
        (inv.billing_reason || "")
    );
    for (const l of inv.lines?.data || []) {
      out("        " + money(l.amount).padStart(12) + "   " + (l.description || ""));
    }
  }
  out("");
}

// ---------------------------------------------------------------------------
// One throwaway shop, subscribed and paid, plus a link into the sandbox
// billing portal for it. This is the step the preview API cannot do: the
// schedule_at_period_end conditions are evaluated by the PORTAL, not by the
// subscription API, so the only way to find out what they catch is to click.
// ---------------------------------------------------------------------------
async function portalLink(priceIds) {
  const plan = argValue("--plan") || "band_1_15";
  const interval = argValue("--interval") || "monthly";

  if (!planById[plan] || !INTERVAL_LABEL[interval]) {
    throw new Error(
      "unknown --plan or --interval. Plans: " +
        Object.keys(planById).join(", ") +
        ". Intervals: " +
        Object.keys(INTERVAL_LABEL).join(", ")
    );
  }

  // ⚠️ OUR configuration, found the same way app/lib/stripe.ts finds it. If we
  // let Stripe pick the account default, the page would be testing rules
  // nobody wrote and the whole exercise would be worthless.
  const configs = await stripe.billingPortal.configurations.list({ limit: 100 });
  const mine = configs.data.find((c) => c.metadata?.shopworks === "portal" && c.active);
  if (!mine) {
    throw new Error(
      "no active portal configuration marked metadata.shopworks=portal in this " +
        "account. Run: node scripts/stripe-setup.mjs --apply"
    );
  }

  const su = mine.features?.subscription_update;
  out("  portal config: " + mine.id);
  out("  can change plan: " + (su?.enabled ? "YES" : "NO"));
  if (su?.enabled) {
    out("  proration_behavior   : " + (su.proration_behavior || "(unset)"));
    out("  billing_cycle_anchor : " + (su.billing_cycle_anchor || "(unset)"));
    out(
      "  scheduled at period end when: " +
        JSON.stringify((su.schedule_at_period_end?.conditions || []).map((c) => c.type))
    );
  } else {
    out("");
    out("  ⚠️ Plan changes are switched OFF in this configuration, so the page");
    out("     will not offer one. Run stripe-setup.mjs --apply first.");
  }
  out("");

  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000) - 60,
    name: "shopworks portal click-through",
  });
  clockIds.push(clock.id);

  const customer = await stripe.customers.create({
    name: "portal test shop",
    email: "portal-test@example.com",
    test_clock: clock.id,
  });

  const pm = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_visa" },
  });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceIds[lookupKey(plan, interval)], quantity: 1 }],
    billing_mode: { type: "flexible" },
    default_payment_method: pm.id,
    payment_behavior: "error_if_incomplete",
  });

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.id,
    configuration: mine.id,
    return_url: "https://www.shopworks.app/billing",
  });

  out("  a throwaway shop on " + planById[plan].label + ", " + INTERVAL_LABEL[interval] +
      " $" + priceOf(plan, interval) + "  (" + sub.status + ")");
  out("");
  out("  OPEN THIS, then click Update subscription:");
  out("");
  out("      " + session.url);
  out("");
  out("  WHAT TO READ ON THE PAGE, in order:");
  out("    1. Pick YEARLY. It should offer roughly $" +
      (priceOf(plan, "annual") - priceOf(plan, interval)).toLocaleString("en-US") +
      " due today and take effect now.");
  out("       ⚠️ If it says the change is SCHEDULED for a later date instead,");
  out("       decreasing_item_amount is catching the upgrade - say so and stop.");
  out("    2. Go back and pick a BIGGER BAND, same interval. Expect the");
  out("       difference, prorated, due today.");
  out("    3. Go back and pick a SMALLER BAND. Expect 'scheduled' and $0 today.");
  out("    4. Go back and pick MONTHLY from yearly. Expect the same.");
  out("");
  out("  ⚠️ Nothing here is real money, but DO NOT confirm step 1 and then");
  out("     judge steps 2-4 - each one changes what the next one is offered.");
  out("     Read the confirmation page, then back out, for all four.");
  out("");
  out("  ⚠️ The test clock is LEFT BEHIND so the shop stays alive while you");
  out("     click: " + clock.id);
  out("     Delete it in the sandbox dashboard when you are finished.");
  out("");
}

// ---------------------------------------------------------------------------
// Always clean up, and always say where the transcript went.
// ---------------------------------------------------------------------------
async function cleanup() {
  if (!clockIds.length) return;
  if (keep || portalOnly) {
    out("  test clocks LEFT BEHIND at your request: " + clockIds.join(", "));
    out("  Delete them in the Stripe sandbox dashboard when you are done.");
    return;
  }
  for (const id of clockIds) {
    try {
      await stripe.testHelpers.testClocks.del(id);
      out("  cleaned up: test clock " + id + " and everything on it is deleted.");
    } catch (e) {
      out("  ⚠️ could not delete the test clock " + id + ": " + (e?.message || e));
      out("     Delete it by hand in the Stripe sandbox dashboard.");
    }
  }
}

function writeTranscript() {
  const file = path.join(process.cwd(), "stripe-preview-output.txt");
  try {
    fs.writeFileSync(file, transcript.join("\n") + "\n", "utf8");
    console.log("");
    console.log("  Everything above is also saved in:");
    console.log("      " + file);
    console.log("");
  } catch (e) {
    console.log("  (could not write the transcript file: " + (e?.message || e) + ")");
  }
}

main()
  .then(async () => {
    out("");
    await cleanup();
    writeTranscript();
  })
  .catch(async (e) => {
    out("");
    out("  Stopped: " + (e?.message || e));
    await cleanup();
    writeTranscript();
    process.exit(1);
  });

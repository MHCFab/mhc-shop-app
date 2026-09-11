// ---------------------------------------------------------------------------
// The plans, in one place.
//
// These numbers appear on the billing page, in the email you get when somebody
// subscribes, and in Stripe. Keeping them here means they can only disagree
// with each other if somebody edits this file.
//
// ⚠️ THIS FILE AND STRIPE HAVE TO AGREE. The link between them is the LOOKUP
// KEY - a short name like "shopworks_band_1_15_annual" that you attach to a
// price in Stripe. The app never hard-codes a Stripe price id; it asks Stripe
// "which price has this lookup key?" That means:
//   * no twelve price ids in environment variables to get wrong;
//   * test mode and live mode use the same names, so nothing has to change
//     when you switch over;
//   * if you ever change a price you make a NEW price in Stripe and move the
//     lookup key onto it, which is what Stripe expects you to do anyway
//     (prices are immutable, and existing subscriptions keep the old one).
//
// scripts/stripe-setup.mjs creates every product and price below with the
// right lookup key. Run it once against test, once against live.
//
// The `id` values are what the database stores and what the check constraints
// on companies.plan_id and companies.billing_interval allow. Changing one
// means a schema change, so they are named after what they MEASURE rather
// than after a marketing tier that might get renamed.
// ---------------------------------------------------------------------------

export type PlanId = "band_1_15" | "band_16_50" | "band_51_150";
export type IntervalId = "monthly" | "quarterly" | "semiannual" | "annual";

// ---------------------------------------------------------------------------
// How often they pay.
//
// The prepay discounts are 5% quarterly, 10% semi-annual, and annual is
// exactly two months free. "Two months free" is worth saying that way round
// on a page: it is the same 16.7% but people can picture it.
// ---------------------------------------------------------------------------
export type Interval = {
  id: IntervalId;
  label: string;
  /** "per month", "every 3 months" - how the price is described next to it. */
  cadence: string;
  months: number;
  /** Empty for monthly. Shown as a small tag on the interval toggle. */
  saving: string;
};

export const INTERVALS: Interval[] = [
  { id: "monthly", label: "Monthly", cadence: "per month", months: 1, saving: "" },
  { id: "quarterly", label: "Quarterly", cadence: "every 3 months", months: 3, saving: "Save 5%" },
  { id: "semiannual", label: "6 months", cadence: "every 6 months", months: 6, saving: "Save 10%" },
  { id: "annual", label: "Yearly", cadence: "per year", months: 12, saving: "2 months free" },
];

export type Plan = {
  id: PlanId;
  label: string;
  /** Inclusive. Used to work out which band a shop's login count needs. */
  minLogins: number;
  maxLogins: number;
  blurb: string;
  /** Whole dollars. Never cents - Stripe gets these multiplied by 100. */
  prices: Record<IntervalId, number>;
};

export const PLANS: Plan[] = [
  {
    id: "band_1_15",
    label: "1 to 15 shop logins",
    minLogins: 1,
    maxLogins: 15,
    blurb: "Most shops start here.",
    prices: { monthly: 149, quarterly: 425, semiannual: 805, annual: 1490 },
  },
  {
    id: "band_16_50",
    label: "16 to 50 shop logins",
    minLogins: 16,
    maxLogins: 50,
    blurb: "",
    prices: { monthly: 249, quarterly: 710, semiannual: 1345, annual: 2490 },
  },
  {
    id: "band_51_150",
    label: "51 to 150 shop logins",
    minLogins: 51,
    maxLogins: 150,
    blurb: "",
    prices: { monthly: 399, quarterly: 1137, semiannual: 2155, annual: 3990 },
  },
];

/** The optional setup we sell alongside a subscription. Charged once. */
export const ONBOARDING = {
  lookupKey: "shopworks_onboarding",
  price: 350,
  label: "Onboarding",
  blurb:
    "We load your material, your products and your bills of material from " +
    "spreadsheets you fill in, so you start with your own shop in it rather " +
    "than an empty one. Optional, charged once.",
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function planById(id: string | null | undefined): Plan | null {
  if (!id) return null;
  return PLANS.find((p) => p.id === id) || null;
}

export function intervalById(id: string | null | undefined): Interval | null {
  if (!id) return null;
  return INTERVALS.find((i) => i.id === id) || null;
}

/** The name that ties a plan+interval here to a price in Stripe. */
export function lookupKey(plan: PlanId, interval: IntervalId): string {
  return "shopworks_" + plan + "_" + interval;
}

export function priceFor(plan: PlanId, interval: IntervalId): number {
  const p = planById(plan);
  return p ? p.prices[interval] : 0;
}

/**
 * What this works out to per month. Shown underneath the headline price on
 * anything other than monthly, because "$1,490 per year" means nothing to
 * somebody comparing it with a competitor's monthly number.
 */
export function perMonth(plan: PlanId, interval: IntervalId): number {
  const iv = intervalById(interval);
  if (!iv) return 0;
  return priceFor(plan, interval) / iv.months;
}

/** Dollars saved over the same period paid monthly. Zero for monthly. */
export function savingVsMonthly(plan: PlanId, interval: IntervalId): number {
  const iv = intervalById(interval);
  if (!iv) return 0;
  return priceFor(plan, "monthly") * iv.months - priceFor(plan, interval);
}

/** The smallest band that fits this many shop logins. Null if nothing does. */
export function planForLoginCount(count: number): Plan | null {
  return PLANS.find((p) => count <= p.maxLogins) || null;
}

/** "$149/mo", "$1,490/yr" - short, for a button or a table cell. */
export function priceLabel(plan: PlanId, interval: IntervalId): string {
  const amount = priceFor(plan, interval);
  const suffix =
    interval === "monthly" ? "/mo"
    : interval === "quarterly" ? "/qtr"
    : interval === "semiannual" ? "/6mo"
    : "/yr";
  return "$" + amount.toLocaleString("en-US") + suffix;
}

// ---------------------------------------------------------------------------
// The 48-hour trial rule.
//
// ⚠️ STRIPE REFUSES A TRIAL END LESS THAN 48 HOURS AWAY. So a shop part-way
// through its free trial keeps its remaining days only if it has more than two
// left; below that it starts paying at checkout instead. Both the billing page
// (which has to SAY which one is about to happen) and the checkout route
// (which has to DO it) ask this, so it lives here and they cannot drift apart.
//
// It is a plain function rather than something worked out inside a component,
// because reading the clock while React is rendering is not allowed - and the
// answer belongs next to the plans anyway.
// ---------------------------------------------------------------------------
export const STRIPE_MIN_TRIAL_MS = 48 * 60 * 60 * 1000;

export function trialCanCarryOver(
  trialEndsAt: string | null | undefined
): boolean {
  if (!trialEndsAt) return false;
  const ends = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(ends)) return false;
  return ends > Date.now() + STRIPE_MIN_TRIAL_MS;
}

/** What a plan is called in an email to a human. */
export function planSummary(
  id: string | null | undefined,
  interval?: string | null
): string {
  const plan = planById(id);
  if (!plan) return "(unknown plan)";
  const iv = intervalById(interval) || intervalById("monthly")!;
  return (
    priceLabel(plan.id, iv.id) + " (" + iv.label.toLowerCase() + ") - " + plan.label
  );
}

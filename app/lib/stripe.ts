// ---------------------------------------------------------------------------
// Talking to Stripe.
//
// ⚠️ THE CLIENT IS BUILT ON FIRST USE, NOT WHEN THIS FILE LOADS.
// If it were built at import time, a missing or mistyped STRIPE_SECRET_KEY
// would throw while Next was loading the module - and because Next shares
// modules across routes, that can take down pages that have nothing to do with
// billing. The app went dark for exactly this shape of reason once already
// (see the note on middleware's Supabase dependency). So: nothing happens here
// until something actually asks to talk to Stripe, and the only pages that ask
// are the billing ones.
//
// ⚠️ NO apiVersion IS PASSED, ON PURPOSE. The stripe package sends the API
// version it was built and type-checked against. Pinning a different one by
// hand is how you get code that compiles and then gets back a shape it does
// not expect. Upgrading the package is the way to move API version.
// ---------------------------------------------------------------------------

import Stripe from "stripe";

let client: Stripe | null = null;

/** Is Stripe set up on this deployment at all? */
export function stripeConfigured(): boolean {
  return !!(process.env.STRIPE_SECRET_KEY || "").trim();
}

/**
 * The Stripe client. Throws a plain-English error if the key is missing, which
 * the routes turn into "billing is not switched on yet" rather than a 500.
 */
export function getStripe(): Stripe {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) {
    throw new Error(
      "Stripe is not set up on this deployment: STRIPE_SECRET_KEY is missing."
    );
  }
  if (!client) {
    client = new Stripe(key, { typescript: true });
  }
  return client;
}

/** True when the key in use is a test-mode key. Shown on the billing page. */
export function isTestMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY || "").trim().startsWith("sk_test_");
}

// ---------------------------------------------------------------------------
// Lookup key -> price id.
//
// The app knows prices by lookup key (see app/lib/plans.ts). Stripe knows them
// by id. This turns one into the other and remembers the answer for the life
// of the server process, because a price id never changes once a lookup key
// points at it, and doing this on every checkout would be a wasted round trip.
//
// ⚠️ An unknown lookup key is a REAL error and must not be swallowed: it means
// scripts/stripe-setup.mjs has not been run against this Stripe account, and
// silently checking somebody out on the wrong price would be far worse than
// showing them a message.
// ---------------------------------------------------------------------------
const priceIdCache = new Map<string, string>();

export async function resolvePriceId(key: string): Promise<string> {
  const cached = priceIdCache.get(key);
  if (cached) return cached;

  const stripe = getStripe();
  const found = await stripe.prices.list({
    lookup_keys: [key],
    active: true,
    limit: 1,
  });

  const price = found.data[0];
  if (!price) {
    throw new Error(
      'No active Stripe price with the lookup key "' +
        key +
        '". Run scripts/stripe-setup.mjs against this Stripe account.'
    );
  }

  priceIdCache.set(key, price.id);
  return price.id;
}

/** Resolve several at once, in parallel. */
export async function resolvePriceIds(keys: string[]): Promise<string[]> {
  return Promise.all(keys.map(resolvePriceId));
}

// ---------------------------------------------------------------------------
// Which billing portal configuration are we allowed to use?
//
// ⚠️ THE ANSWER IS "OURS", AND NEVER "WHATEVER THE ACCOUNT DEFAULTS TO".
// The portal configuration is where the rules Erik chose actually live -
// upgrades prorate now, downgrades and interval shortenings wait for the end
// of the paid period, cancellation is at period end with no refund. A Stripe
// account can hold several configurations and will silently use its default
// if you do not name one. scripts/stripe-setup.mjs creates ours and marks it
// metadata.shopworks = "portal"; this finds it by that mark.
//
// Looked up once per server process. A configuration id does not change.
// STRIPE_PORTAL_CONFIGURATION_ID overrides it if it is ever set by hand.
// ---------------------------------------------------------------------------
let portalConfigurationId: string | null | undefined;

export async function resolvePortalConfigurationId(): Promise<string | null> {
  if (portalConfigurationId !== undefined) return portalConfigurationId;

  const pinned = (process.env.STRIPE_PORTAL_CONFIGURATION_ID || "").trim();
  if (pinned) {
    portalConfigurationId = pinned;
    return pinned;
  }

  try {
    const list = await getStripe().billingPortal.configurations.list({
      limit: 100,
    });
    const mine = list.data.find(
      (c) => c.metadata?.shopworks === "portal" && c.active
    );
    portalConfigurationId = mine ? mine.id : null;
  } catch {
    // Not worth failing the whole "Manage billing" click over. Stripe falls
    // back to the account default, which on a ShopWorks-only account is the
    // right shape anyway - it is only the wrong thing on a shared account.
    portalConfigurationId = null;
  }

  return portalConfigurationId;
}

// ---------------------------------------------------------------------------
// When does this subscription's paid-up period end?
//
// ⚠️ Stripe MOVED this. It used to live on the subscription itself; since the
// 2025-03-31 API version it lives on each subscription ITEM, because one
// subscription can now hold items on different billing intervals. Reading
// subscription.current_period_end on a current API version gets you undefined,
// and undefined here means the billing page shows no renewal date and nobody
// notices for a month. This reads the item and falls back to the old place.
// ---------------------------------------------------------------------------
export function periodEndOf(sub: Stripe.Subscription): number | null {
  const item = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number })
    | undefined;

  const fromItem = item?.current_period_end;
  if (typeof fromItem === "number") return fromItem;

  const legacy = (sub as unknown as { current_period_end?: number })
    .current_period_end;
  return typeof legacy === "number" ? legacy : null;
}

/** Unix seconds -> an ISO string Postgres will take, or null. */
export function toIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

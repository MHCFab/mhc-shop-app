// ---------------------------------------------------------------------------
// The plans, in one place.
//
// These prices appear on the billing page, in the email you get when somebody
// picks one, and eventually in Stripe. Keeping them here means they can only
// disagree with each other if somebody edits this file.
//
// The `id` values are what the database stores and what the check constraint
// on companies.requested_plan allows. Changing one means a schema change, so
// they are named after what they MEASURE (login count) rather than after a
// marketing tier that might get renamed.
// ---------------------------------------------------------------------------

export type PlanId = "band_1_15" | "band_16_50" | "band_51_150";

export type Plan = {
  id: PlanId;
  label: string;
  monthly: number;
  blurb: string;
};

export const PLANS: Plan[] = [
  {
    id: "band_1_15",
    label: "1 to 15 shop logins",
    monthly: 149,
    blurb: "Most shops start here.",
  },
  {
    id: "band_16_50",
    label: "16 to 50 shop logins",
    monthly: 249,
    blurb: "",
  },
  {
    id: "band_51_150",
    label: "51 to 150 shop logins",
    monthly: 399,
    blurb: "",
  },
];

export function planById(id: string | null | undefined): Plan | null {
  if (!id) return null;
  return PLANS.find((p) => p.id === id) || null;
}

/** What a plan is called in an email to a human. */
export function planSummary(id: string | null | undefined): string {
  const plan = planById(id);
  if (!plan) return "(unknown plan)";
  return "$" + plan.monthly + "/mo - " + plan.label;
}

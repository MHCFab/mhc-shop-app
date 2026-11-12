// ---------------------------------------------------------------------------
// The three onboarding spreadsheets - ONBOARDING-FILES-V1.
//
// A shop that ticks the $350 onboarding box at checkout gets these: on the
// billing page the moment it comes back from Stripe, and by email from the
// webhook. They fill them in on their own computer and send them back to
// support, and Erik loads them as review-first SQL.
//
// The files themselves live in public/onboarding/ and are rebuilt from the
// script that made them, not edited by hand in Excel, so the column headers
// stay in step with what the import SQL expects.
//
// They are blank templates, so they are deliberately public: the link in the
// email has to work for someone who is not signed in yet. middleware.ts lets
// /onboarding/ through without a login for that reason.
// ---------------------------------------------------------------------------

export type OnboardingFile = {
  file: string;
  title: string;
  what: string;
};

export const ONBOARDING_FILES: OnboardingFile[] = [
  {
    file: "ShopWorks-Onboarding-1-Material-and-Parts.xlsx",
    title: "1. Raw material and purchased parts",
    what: "What is on your rack and your shelf. Fill this one in first.",
  },
  {
    file: "ShopWorks-Onboarding-2-Products.xlsx",
    title: "2. Products",
    what: "The things you build over and over, and the steps to build them.",
  },
  {
    file: "ShopWorks-Onboarding-3-Bills-of-Material.xlsx",
    title: "3. Bills of material",
    what: "What goes into one unit of each product, plus an optional cut list.",
  },
];

/** Where the filled-in files go back to. Same address the Terms promise. */
export const ONBOARDING_RETURN_EMAIL = "support@mhcfab.com";

/** A path on this site, for links inside the app. */
export function onboardingPath(f: OnboardingFile): string {
  return "/onboarding/" + f.file;
}

/**
 * A full address, for email. The webhook has no browser origin to go on, so
 * this falls back to the live site rather than to Vercel's per-deployment
 * address, which can be private.
 */
export function onboardingUrl(f: OnboardingFile): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.shopworks.app")
    .trim()
    .replace(/\/+$/, "");
  return base + onboardingPath(f);
}

// ---------------------------------------------------------------------------
// This page moved to /billing.
//
// It had to leave /admin: the admin layout replaces everything with the
// locked-out screen when a trial ends, so a billing page underneath it would
// lock itself away at exactly the moment somebody needs it to get unlocked.
//
// Kept as a redirect rather than deleted, so any bookmark or link still works.
// ---------------------------------------------------------------------------

import { redirect } from "next/navigation";

export default async function AdminBillingRedirect() {
  redirect("/billing");
}

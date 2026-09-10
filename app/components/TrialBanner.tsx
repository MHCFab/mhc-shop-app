// ---------------------------------------------------------------------------
// The strip along the top of the admin area during a free trial.
//
// It only ever shows for the shop's admin, and only while the shop is actually
// on a trial. MHC Fab is a paid shop, so nobody at MHC will ever see this.
//
// It gets louder as the trial runs down - grey for the first week, amber in
// the last five days, red on the last two - because "3 days left" buried in a
// grey bar is how people lose their data access by surprise.
// ---------------------------------------------------------------------------

import Link from "next/link";

export default function TrialBanner({
  daysLeft,
}: {
  daysLeft: number | null;
}) {
  if (daysLeft == null) {
    return null;
  }

  const urgent = daysLeft <= 2;
  const soon = daysLeft <= 5;

  const tone = urgent
    ? "bg-red-50 border-red-200 text-red-800"
    : soon
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : "bg-gray-50 border-gray-200 text-gray-700";

  const dayWord = daysLeft === 1 ? "day" : "days";

  return (
    <div className={"border-b px-4 py-2 text-sm " + tone}>
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <span>
          {daysLeft === 0
            ? "Your free trial ends today."
            : "Free trial: " + daysLeft + " " + dayWord + " left."}{" "}
          <span className="opacity-80">
            Everything is switched on — no card needed yet.
          </span>
        </span>
        <Link
          href="/billing"
          className="font-medium underline hover:no-underline"
        >
          Trial and setup
        </Link>
      </div>
    </div>
  );
}

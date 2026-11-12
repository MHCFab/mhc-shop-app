// ---------------------------------------------------------------------------
// Shown on /billing when a shop comes back from Stripe having bought the
// onboarding. The same three links are emailed by the webhook, so closing
// this page does not lose them.
// ---------------------------------------------------------------------------

import {
  ONBOARDING_FILES,
  ONBOARDING_RETURN_EMAIL,
  onboardingPath,
} from "../lib/onboarding-files";

export default function OnboardingDownloads() {
  return (
    <div className="mb-8 rounded-lg border border-blue-200 bg-blue-50 p-6">
      <p className="mb-1 text-sm font-medium text-blue-900">Your onboarding spreadsheets</p>
      <p className="mb-4 text-blue-900">
        Fill these in on your own computer, then email all three to{" "}
        <a href={"mailto:" + ONBOARDING_RETURN_EMAIL} className="underline">
          {ONBOARDING_RETURN_EMAIL}
        </a>{" "}
        with your shop name in the subject. We load them and let you know when your
        shop is ready to check. We have emailed you these links as well.
      </p>
      <ul className="space-y-3">
        {ONBOARDING_FILES.map((f) => (
          <li key={f.file}>
            <a
              href={onboardingPath(f)}
              download
              className="font-medium text-blue-700 underline hover:text-blue-900"
            >
              {f.title}
            </a>
            <span className="block text-sm text-blue-900/80">{f.what}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

"use client";

// ---------------------------------------------------------------------------
// What somebody sees when their shop's trial has run out.
//
// Two versions, and the difference is deliberate:
//
//   isOwner = true   the person who signed the shop up. They get the real
//                    detail and what to do about it.
//   isOwner = false  everybody else at that shop - the crew AND the shop's own
//                    customers. They get a plain "not available right now" and
//                    NOTHING about money. A fabricator's customer should never
//                    find out from us that their supplier has a billing
//                    problem, and a welder should hear it from his boss.
//
// The two look almost identical on purpose, so nobody can tell from a
// screenshot which one they were shown.
// ---------------------------------------------------------------------------

import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "../lib/supabase";

export default function ShopLockedScreen({
  isOwner,
  shopName,
  supportEmail = "support@mhcfab.com",
}: {
  isOwner: boolean;
  shopName?: string;
  supportEmail?: string;
}) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm max-w-lg w-full p-8">
        {isOwner ? (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              Your ShopWorks trial has ended
            </h1>
            <p className="text-gray-600 mb-4">
              {shopName ? shopName + "'s" : "Your shop's"} free trial is over, so
              the app is paused. Nothing has been deleted — every job, every
              material record and every hour logged is exactly where you left
              it, and it all comes straight back the moment the subscription
              starts.
            </p>
            <p className="text-gray-600 mb-6">
              Pick the plan that fits your shop and we&apos;ll switch it back
              on. It takes a minute and there is no card form to fight with.
            </p>
            <Link
              href="/billing"
              className="inline-block w-full text-center bg-blue-600 text-white py-2.5 rounded-md font-medium hover:bg-blue-700 transition-colors mb-6"
            >
              Choose your plan
            </Link>
            <div className="bg-gray-50 border border-gray-200 rounded-md p-4 mb-6">
              <p className="text-sm text-gray-600">
                Your crew and your customers can&apos;t get in either right now.
                They&apos;re just being told the shop isn&apos;t available —
                they aren&apos;t shown anything about billing.
              </p>
              <p className="text-sm text-gray-600 mt-2">
                Rather talk to somebody? Email{" "}
                <a
                  href={"mailto:" + supportEmail}
                  className="text-blue-600 hover:underline"
                >
                  {supportEmail}
                </a>
                .
              </p>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              Not available right now
            </h1>
            <p className="text-gray-600 mb-6">
              This shop&apos;s ShopWorks account isn&apos;t active at the
              moment, so there&apos;s nothing to show you. Nothing is lost, and
              it will be back as soon as the shop sorts it out. Please check
              with them directly.
            </p>
          </>
        )}

        <button
          onClick={signOut}
          className="text-sm text-gray-600 hover:text-gray-900 font-medium"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

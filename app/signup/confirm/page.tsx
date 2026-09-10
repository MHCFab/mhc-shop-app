// ---------------------------------------------------------------------------
// Where the link in the confirmation email lands.
//
// This is a server component purely so the token can be read from the URL on
// the server and handed down as a prop. Reading it in the browser instead
// would need a Suspense wrapper to survive the build, and this is simpler.
// ---------------------------------------------------------------------------

import Link from "next/link";
import ConfirmForm from "./ConfirmForm";

export default async function SignupConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  const token = params?.token || "";

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            That link is incomplete
          </h1>
          <p className="text-gray-600 mb-6">
            Open the link from your email again, or start over and we&apos;ll
            send a fresh one.
          </p>
          <Link href="/signup" className="text-sm text-blue-600 hover:underline">
            Start again
          </Link>
        </div>
      </div>
    );
  }

  return <ConfirmForm token={token} />;
}

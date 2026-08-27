import Link from "next/link";

/**
 * Shared shell for the Terms of Service and Privacy Policy pages.
 *
 * These pages are deliberately public and deliberately independent of
 * Supabase - they must load for someone who has no account at all, and they
 * must keep loading if Supabase is having a bad day. See middleware.ts, where
 * /terms and /privacy are listed as no-auth paths.
 */
export default function LegalPage({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-baseline justify-between gap-4">
          <Link href="/login" className="text-xl font-bold text-gray-900">
            ShopWorks
          </Link>
          <nav className="text-sm text-gray-600 space-x-4">
            <Link href="/terms" className="hover:text-blue-600 hover:underline">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-blue-600 hover:underline">
              Privacy
            </Link>
            <Link href="/login" className="hover:text-blue-600 hover:underline">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-bold text-gray-900 mb-1">{title}</h1>
        <p className="text-sm text-gray-500 mb-8">
          Effective date: {effectiveDate}
        </p>

        <div className="legal-body space-y-6 text-gray-700 leading-relaxed">
          {children}
        </div>
      </main>

      <footer className="max-w-3xl mx-auto px-6 pb-12 pt-4 text-sm text-gray-500 border-t border-gray-200 mt-8">
        <p>
          ShopWorks is operated by [LEGAL ENTITY NAME]. Questions about this
          document can go to{" "}
          <a
            href="mailto:[CONTACT EMAIL]"
            className="text-blue-600 hover:underline"
          >
            [CONTACT EMAIL]
          </a>
          .
        </p>
      </footer>
    </div>
  );
}

/** A numbered section heading plus its body. */
export function Section({
  n,
  heading,
  children,
}: {
  n: number;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-900 pt-2">
        {n}. {heading}
      </h2>
      {children}
    </section>
  );
}

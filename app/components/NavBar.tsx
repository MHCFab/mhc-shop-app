"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import { createClient } from "../lib/supabase";

type Profile = {
  email: string;
  full_name: string | null;
  role: string;
};

type Company = {
  name: string;
} | null;

export default function NavBar({
  profile,
  company,
}: {
  profile: Profile;
  company: Company;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  if (pathname === "/login") return null;

  const isAdmin = profile.role === "admin";

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const adminLinks = [
    { href: "/admin", label: "Dashboard" },
    { href: "/admin/jobs", label: "Jobs" },
    { href: "/admin/customers", label: "Customers" },
    { href: "/admin/suppliers", label: "Suppliers" },
    { href: "/admin/raw-materials", label: "Raw Materials" },
    { href: "/admin/inventory/raw-materials", label: "Raw Material Inventory" },
    { href: "/admin/purchased-parts", label: "Purchased Parts" },
    { href: "/admin/inventory/purchased-parts", label: "Parts Inventory" },
    { href: "/admin/product-templates", label: "Product Templates" },
  ];

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex flex-col leading-tight">
              <span className="text-xl font-bold text-gray-900">ShopWorks</span>
              {company && (
                <span className="text-xs text-gray-500">{company.name}</span>
              )}
            </Link>

            {isAdmin && (
              <div className="hidden md:flex items-center gap-1">
                {adminLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      pathname === link.href
                        ? "bg-blue-100 text-blue-700"
                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                    }`}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col items-end text-sm">
              <span className="text-gray-900 font-medium">
                {profile.full_name || profile.email}
              </span>
              <span className="text-gray-500 text-xs capitalize">
                {profile.role}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="px-3 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
            >
              Sign out
            </button>
            {isAdmin && (
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="md:hidden p-2 text-gray-600 hover:text-gray-900"
                aria-label="Open menu"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>

        {isAdmin && menuOpen && (
          <div className="md:hidden pb-3 space-y-1">
            {adminLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={`block px-3 py-2 rounded-md text-base font-medium ${
                  pathname === link.href
                    ? "bg-blue-100 text-blue-700"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
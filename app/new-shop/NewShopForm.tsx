"use client";

import { useState } from "react";
import Link from "next/link";

export default function NewShopForm({ name }: { name: string }) {
  const [shopName, setShopName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/shops/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopName }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      // A full page load, not a client navigation: which area of the app a
      // person lands in is decided by the middleware from their profile, and
      // that profile has just changed.
      window.location.assign("/admin");
    } catch {
      setError("Could not reach ShopWorks. Please check your connection and try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Start your own shop</h1>
        <p className="text-gray-600 mb-6">
          {name ? name + ", you" : "You"} already have a ShopWorks login, so
          there is nothing to set up. Name your shop and you are in, on a 14-day
          free trial with no card.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="shopName" className="block text-sm font-medium text-gray-700 mb-1">
              Shop name
            </label>
            <input
              id="shopName"
              type="text"
              required
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Creating..." : "Create my shop"}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-gray-200 text-sm text-gray-600">
          <p className="mb-2">
            Everything you can already reach stays exactly as it is. Once your
            shop exists, a switcher appears at the top of the page for moving
            between them.
          </p>
          <Link href="/" className="text-blue-600 hover:underline">
            Never mind, take me back
          </Link>
        </div>
      </div>
    </div>
  );
}

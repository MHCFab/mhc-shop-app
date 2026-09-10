"use client";

// ---------------------------------------------------------------------------
// Pick a password, and the shop comes into existence.
//
// When the route below answers, the shop, the login and the trial all exist,
// so this signs them straight in with the password they just typed rather than
// bouncing them to the sign-in page to type it a second time.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../lib/supabase";

const MIN_PASSWORD = 8;

export default function ConfirmForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD) {
      setError("Please choose a password of at least " + MIN_PASSWORD + " characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those two passwords are not the same.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/signup/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      // The account exists now. Sign in with what they just typed.
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: data.email,
        password,
      });

      if (signInError) {
        // The shop is real either way, so send them to sign in by hand rather
        // than implying it failed.
        router.push("/login");
        return;
      }

      router.push("/admin");
      router.refresh();
    } catch {
      setError("Could not reach ShopWorks. Please check your connection and try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Pick a password</h1>
        <p className="text-gray-600 mb-6">
          Last step. Your 14-day trial starts as soon as you do this.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              At least {MIN_PASSWORD} characters.
            </p>
          </div>

          <div>
            <label htmlFor="confirm" className="block text-sm font-medium text-gray-700 mb-1">
              Password again
            </label>
            <input
              id="confirm"
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
            {loading ? "Setting up your shop..." : "Create my shop"}
          </button>
        </form>

        <p className="mt-6 text-sm text-gray-600 text-center">
          <Link href="/signup" className="text-blue-600 hover:underline">
            Start again
          </Link>
        </p>
      </div>
    </div>
  );
}

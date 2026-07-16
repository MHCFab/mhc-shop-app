"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../lib/supabase";

export default function AcceptInvitePage() {
  const supabase = createClient();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function establishSession() {
      const url = new URL(window.location.href);
      const hasInviteToken =
        !!url.searchParams.get("token_hash") ||
        !!url.searchParams.get("code") ||
        window.location.hash.includes("access_token");

      // 1. Existing session already? A fresh invite link in the URL always
      // wins over a stored session — otherwise a leftover login (possibly a
      // since-deleted user) hijacks the invite and setting the password
      // fails with "User from sub claim in JWT does not exist".
      const { data: { session: existing } } = await supabase.auth.getSession();
      if (existing) {
        if (!hasInviteToken) {
          // No invite token in the URL: trust the stored session only if its
          // user still exists on the server.
          const { data: { user: liveUser }, error: liveError } = await supabase.auth.getUser();
          if (liveUser && !liveError) {
            if (!cancelled) { setReady(true); setChecking(false); }
            return;
          }
        }
        // Stale, or outranked by the invite link — clear it and continue.
        await supabase.auth.signOut({ scope: "local" });
      }

      // 2. token_hash flow (our custom invite template)
      const token_hash = url.searchParams.get("token_hash");
      const type = url.searchParams.get("type");
      if (token_hash && type) {
        const { error } = await supabase.auth.verifyOtp({
          token_hash,
          type: type as "invite" | "recovery" | "email" | "signup",
        });
        if (!cancelled) {
          if (error) {
            setError("This invite link is invalid or has expired. Ask your admin to resend it.");
            setChecking(false);
          } else {
            setReady(true);
            setChecking(false);
          }
        }
        return;
      }

      // 3. code flow (PKCE)
      const code = url.searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!cancelled) {
          if (error) {
            setError("This invite link could not be verified. Ask your admin to resend it.");
            setChecking(false);
          } else {
            setReady(true);
            setChecking(false);
          }
        }
        return;
      }

      // 4. hash-token flow
      const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
      const hashParams = new URLSearchParams(hash);
      const access_token = hashParams.get("access_token");
      const refresh_token = hashParams.get("refresh_token");
      if (access_token && refresh_token) {
        const { error } = await supabase.auth.setSession({ access_token, refresh_token });
        if (!cancelled) {
          if (error) {
            setError("This invite link could not be verified. Ask your admin to resend it.");
            setChecking(false);
          } else {
            setReady(true);
            setChecking(false);
          }
        }
        return;
      }

      // 5. Nothing usable
      if (!cancelled) {
        setError("This invite link is invalid or has expired. Ask your admin to resend it.");
        setChecking(false);
      }
    }

    establishSession();
    return () => { cancelled = true; };
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      const friendly = error.message.toLowerCase().includes("sub claim")
        ? "This sign-in session is no longer valid. Close this window, open the newest invite email, and click its link again — or ask for a fresh invite."
        : error.message;
      setError(friendly);
      setSaving(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email) {
      const acceptedAt = new Date().toISOString();
      const email = user.email.toLowerCase();
      // Mark the matching invitation accepted (one of these will match
      // depending on whether this was an employee or customer invite;
      // the other is a harmless no-op).
      await supabase
        .from("employee_invitations")
        .update({ status: "accepted", accepted_at: acceptedAt })
        .eq("email", email)
        .eq("status", "pending");
      await supabase
        .from("customer_invitations")
        .update({ status: "accepted", accepted_at: acceptedAt })
        .eq("email", email)
        .eq("status", "pending");
    }

    setSaving(false);
    // The home page routes everyone to the right place for their role
    // (admin -> /admin, employee -> /floor, customer -> /portal).
    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm max-w-md w-full p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Set your password</h1>
        <p className="text-gray-600 mb-6">Welcome! Create a password to finish setting up your account.</p>

        {checking && <p className="text-gray-600">Verifying your invite...</p>}

        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

        {ready && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : "Set password and continue"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

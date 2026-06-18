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
      // 1. If a session already exists, we're good.
      const { data: { session: existing } } = await supabase.auth.getSession();
      if (existing) {
        if (!cancelled) { setReady(true); setChecking(false); }
        return;
      }

      // 2. Handle the PKCE/code flow: ?code=...
      const url = new URL(window.location.href);
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

      // 3. Handle the hash-token flow: #access_token=...&refresh_token=...&type=invite
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

      // 4. Nothing usable in the URL. Give Supabase's detectSessionInUrl a brief moment, then re-check.
      setTimeout(async () => {
        const { data: { session: s2 } } = await supabase.auth.getSession();
        if (!cancelled) {
          if (s2) {
            setReady(true);
          } else {
            setError("This invite link is invalid or has expired. Ask your admin to resend it.");
          }
          setChecking(false);
        }
      }, 1500);
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
      setError(error.message);
      setSaving(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email) {
      await supabase
        .from("employee_invitations")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("email", user.email.toLowerCase())
        .eq("status", "pending");
    }

    setSaving(false);
    router.push("/floor");
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
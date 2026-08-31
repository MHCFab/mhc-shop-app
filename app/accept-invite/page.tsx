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
  const [problems, setProblems] = useState<string[] | null>(null);
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

  // Flip this person's invitation row to "accepted" and REPORT BACK whether it
  // actually happened. This used to be two fire-and-forget updates whose
  // results were thrown away, which hid a broken invite flow for over a month:
  // a missing row-level-security policy makes an update touch zero rows and
  // still return no error, so silence proved nothing.
  //
  // expectInvitation = true means somebody arriving on this page should have a
  // pending invitation waiting; finding none is itself worth reporting.
  async function recordInvitationAccepted(expectInvitation: boolean): Promise<string[]> {
    const found: string[] = [];

    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) {
      return ["Could not read the signed-in account, so no invitation was marked accepted."];
    }

    const email = user.email.toLowerCase();
    const acceptedAt = new Date().toISOString();
    let sawPending = false;

    for (const table of ["employee_invitations", "customer_invitations"] as const) {
      const { data: pendingRows, error: readError } = await supabase
        .from(table)
        .select("id")
        .eq("email", email)
        .eq("status", "pending");
      if (readError) {
        found.push(table + " could not be read: " + readError.message);
        continue;
      }
      if (!pendingRows || pendingRows.length === 0) continue;
      sawPending = true;

      const { data: updatedRows, error: writeError } = await supabase
        .from(table)
        .update({ status: "accepted", accepted_at: acceptedAt })
        .eq("email", email)
        .eq("status", "pending")
        .select("id");
      if (writeError) {
        found.push(table + " could not be updated: " + writeError.message);
        continue;
      }
      if (!updatedRows || updatedRows.length === 0) {
        found.push(table + " returned no error but changed no rows - a permission rule is blocking the update.");
      }
    }

    if (expectInvitation && !sawPending && found.length === 0) {
      found.push("No pending invitation was found for " + email + ", so nothing was marked accepted.");
    }

    return found;
  }

  // The home page routes everyone to the right place for their role
  // (admin -> /admin, employee -> /floor, customer -> /portal).
  function goToApp() {
    router.push("/");
    router.refresh();
  }

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

    const bookkeeping = await recordInvitationAccepted(true);
    setSaving(false);

    if (bookkeeping.length > 0) {
      console.error("[ShopWorks] invitation was not marked accepted:", bookkeeping);
      setProblems(bookkeeping);
      return;
    }

    goToApp();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm max-w-md w-full p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Set your password</h1>
        <p className="text-gray-600 mb-6">Welcome! Create a password to finish setting up your account.</p>

        {checking && <p className="text-gray-600">Verifying your invite...</p>}

        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

        {problems && (
          <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 mb-4">
            <p className="font-medium">Your password is saved and you&apos;re signed in.</p>
            <p className="mt-1">
              One bookkeeping step didn&apos;t finish, so your shop admin may still see you as
              &quot;Awaiting password&quot;. Please mention it to them &mdash; nothing else about your
              account is affected.
            </p>
            <ul className="mt-2 list-disc list-inside text-xs text-amber-800">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            <button
              type="button"
              onClick={goToApp}
              className="mt-3 bg-amber-600 text-white px-4 py-2 rounded-md font-medium hover:bg-amber-700 transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {ready && !problems && (
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

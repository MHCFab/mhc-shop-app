"use client";

import { useState } from "react";
import { createClient } from "../lib/supabase";

// One line of my_memberships(), the database function that answers "which
// shops does this person belong to?". It is a function rather than a plain
// query because the ordinary rules hide the NAME of any shop other than the
// one you are currently in.
export type Membership = {
  membership_id: string;
  company_id: string;
  company_name: string;
  role: string;
  status: string;
  is_current: boolean;
};

function roleWord(role: string) {
  if (role === "admin") return "an admin";
  if (role === "customer") return "a customer";
  return "an employee";
}

export default function ShopSwitcher({ memberships }: { memberships: Membership[] }) {
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = memberships.filter((m) => m.status === "active");
  const pending = memberships.filter((m) => m.status === "pending");
  const current = active.find((m) => m.is_current);
  const others = active.filter((m) => !m.is_current);

  // One shop, nobody asking: show nothing at all. That is everybody today, so
  // this strip is invisible until somebody actually belongs to two shops.
  if (active.length < 2 && pending.length === 0) return null;

  async function switchTo(companyId: string) {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("switch_active_shop", {
      p_company_id: companyId,
    });
    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }
    // Which part of the app you belong in is worked out on the server from your
    // profile, so a full page load is the only honest way to move shops. Going
    // to the root lets it send you to the right home for your role there.
    window.location.assign("/");
  }

  async function respond(membershipId: string, accept: boolean) {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc(
      accept ? "accept_membership" : "decline_membership",
      { p_membership_id: membershipId }
    );
    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }
    // Reload rather than navigate: accepting can move which shop you are in,
    // and the server needs to work that out again either way.
    window.location.reload();
  }

  return (
    <div className="border-b border-gray-200">
      {pending.map((m) => (
        <div key={m.membership_id} className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-5xl mx-auto px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-amber-900">
              {m.company_name} would like to add you as {roleWord(m.role)} on ShopWorks.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => respond(m.membership_id, true)}
                disabled={busy}
                className="bg-amber-600 text-white px-3 py-1 rounded text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
              >
                Accept
              </button>
              <button
                onClick={() => respond(m.membership_id, false)}
                disabled={busy}
                className="text-sm text-amber-900 underline hover:no-underline disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      ))}

      {others.length > 0 && (
        <div className="bg-gray-50">
          <div className="max-w-5xl mx-auto px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-gray-700">
              You are working in <span className="font-medium">{current?.company_name || "this shop"}</span>.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {others.map((m) => (
                <button
                  key={m.company_id}
                  onClick={() => switchTo(m.company_id)}
                  disabled={busy}
                  className="border border-gray-300 bg-white px-3 py-1 rounded text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  Switch to {m.company_name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border-b border-red-200">
          <div className="max-w-5xl mx-auto px-4 py-2">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}

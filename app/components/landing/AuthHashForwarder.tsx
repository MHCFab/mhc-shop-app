"use client";

// ---------------------------------------------------------------------------
// Safety net for login links that land on the home page.
//
// Every invite and password-reset email names its own page (/accept-invite,
// /reset-password). But if Supabase ever refuses that address it falls back
// to the bare site URL - which used to be a redirect to /login and is now the
// landing page. Without this, someone clicking an invite would be left looking
// at the marketing page with their login token sitting unused in the address
// bar. This hands the token on to the page that knows what to do with it.
// Renders nothing; does nothing for an ordinary visitor.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

export default function AuthHashForwarder() {
  useEffect(() => {
    const { hash, search } = window.location;

    const fromHash = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : "");
    if (fromHash.get("access_token")) {
      const target =
        fromHash.get("type") === "recovery" ? "/reset-password" : "/accept-invite";
      window.location.replace(target + hash);
      return;
    }

    const fromQuery = new URLSearchParams(search);
    if (fromQuery.get("token_hash")) {
      const target =
        fromQuery.get("type") === "recovery" ? "/reset-password" : "/accept-invite";
      window.location.replace(target + search);
    }
  }, []);

  return null;
}

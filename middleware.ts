import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------
// Every request to the app passes through this file, and this file talks to
// Supabase. An unguarded Supabase call here will hang when Supabase is slow or
// down, until Vercel gives up and returns a 504 - for EVERY page, including the
// login page, leaving no way into the app at all. That is what took the app
// down on 2026-08-27. The guards below make a Supabase problem degrade the app
// instead of blacking it out.

// How long to wait on any single Supabase call before giving up on it.
const SUPABASE_TIMEOUT_MS = 2000;

// Paths that don't require a logged-in user.
const PUBLIC_PATHS = ["/login", "/accept-invite", "/reset-password", "/auth"];

// Paths that don't need Supabase in the middleware at all. These pages run
// their own token-based flows, so we skip the auth round-trip entirely and they
// keep loading even when Supabase is unreachable.
const NO_AUTH_PATHS = ["/accept-invite", "/reset-password", "/auth"];

// Resolves to the promise's value, or to null if it rejects or takes too long.
// This is what guarantees the middleware always moves on instead of hanging.
function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const done = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    Promise.resolve(promise).then(
      (value) => done(value),
      () => done(null)
    );
  });
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Token-based flows: serve them without touching Supabase.
  if (NO_AUTH_PATHS.some((p) => path.startsWith(p))) {
    return NextResponse.next({ request });
  }

  // Public paths that don't require auth
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Abort any Supabase HTTP call that takes too long, so a stalled
      // connection can never hold this request open.
      global: {
        fetch: (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1]
        ) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
          return fetch(input, { ...init, signal: controller.signal }).finally(() =>
            clearTimeout(timer)
          );
        },
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Who is this? If Supabase doesn't answer in time, treat them as logged out
  // rather than stalling the request.
  const userResult = await withTimeout(supabase.auth.getUser(), SUPABASE_TIMEOUT_MS);
  const user = userResult?.data?.user ?? null;

  // Not logged in and trying to access a protected page -> login
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Logged in: enforce role-based area access
  if (user) {
    // Look up role
    const profileResult = await withTimeout(
      supabase.from("profiles").select("role").eq("id", user.id).single(),
      SUPABASE_TIMEOUT_MS
    );

    // Role lookup didn't come back, so we don't know where this person belongs.
    // Let them through rather than guessing - guessing "employee" would bounce
    // admins out of /admin during a Supabase blip. Row-level security still
    // controls what data they can actually see.
    if (profileResult === null) {
      return supabaseResponse;
    }

    const role = profileResult.data?.role || "employee";
    const home = role === "admin" ? "/admin" : role === "customer" ? "/portal" : "/floor";

    // Logged-in user on /login -> send to their home
    if (path === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = home;
      return NextResponse.redirect(url);
    }

    // Customers can only use the portal (public paths like accept-invite
    // and reset-password stay reachable so those flows keep working)
    if (role === "customer" && !isPublic && !path.startsWith("/portal")) {
      const url = request.nextUrl.clone();
      url.pathname = "/portal";
      return NextResponse.redirect(url);
    }

    // Only customers can use the portal
    if (role !== "customer" && path.startsWith("/portal")) {
      const url = request.nextUrl.clone();
      url.pathname = home;
      return NextResponse.redirect(url);
    }

    // Employees cannot access /admin
    if (role !== "admin" && path.startsWith("/admin")) {
      const url = request.nextUrl.clone();
      url.pathname = home;
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

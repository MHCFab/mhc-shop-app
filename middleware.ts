import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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

  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Public paths that don't require auth
  const publicPaths = ["/login", "/accept-invite", "/reset-password", "/auth"];
  const isPublic = publicPaths.some((p) => path.startsWith(p));

  // Not logged in and trying to access a protected page -> login
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Logged in: enforce role-based area access
  if (user) {
    // Look up role
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const role = profile?.role || "employee";

    // Logged-in user on /login -> send to their home
    if (path === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = role === "admin" ? "/admin" : "/floor";
      return NextResponse.redirect(url);
    }

    // Employees cannot access /admin
    if (role !== "admin" && path.startsWith("/admin")) {
      const url = request.nextUrl.clone();
      url.pathname = "/floor";
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
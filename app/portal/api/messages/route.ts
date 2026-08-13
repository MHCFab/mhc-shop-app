import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Portal messaging actions. Like the orders route, every write happens here with
// the service role key after verifying the caller is an active customer login
// acting on their OWN job. Customer logins can READ their job messages through
// RLS, but have no insert/update rights of their own.
//
//   action: "send"      -> post a message from the customer on one of their jobs
//   action: "mark_read" -> mark this job's staff messages as read by the customer

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action as string;

    if (!["send", "mark_read"].includes(action)) {
      return bad("Unknown action.");
    }

    // ---- Who is calling? (normal cookie-based client) ----
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll() {
            // no-op in route handler
          },
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return bad("Not signed in.", 401);

    const { data: profile } = await supabase
      .from("profiles")
      .select("role, is_active, company_id, customer_id")
      .eq("id", user.id)
      .single();

    if (!profile || profile.role !== "customer" || !profile.customer_id) {
      return bad("Only customer portal accounts can use this.", 403);
    }
    if (!profile.is_active) {
      return bad("This portal account is disabled.", 403);
    }

    const companyId = profile.company_id as string;
    const customerId = profile.customer_id as string;

    // ---- Service role client for the actual writes ----
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // ---- The job must belong to this customer ----
    const jobId = body.jobId;
    if (!jobId || typeof jobId !== "string") return bad("Missing job.");

    const { data: job } = await admin
      .from("jobs")
      .select("id, customer_id, company_id")
      .eq("id", jobId)
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .single();

    if (!job) return bad("Order not found.", 404);

    // ================= SEND =================
    if (action === "send") {
      const raw = typeof body.body === "string" ? body.body.trim() : "";
      if (!raw) return bad("Message can't be empty.");
      if (raw.length > 4000) return bad("Message is too long (4000 characters max).");

      const { data: inserted, error: insError } = await admin
        .from("job_messages")
        .insert({
          company_id: companyId,
          job_id: job.id,
          customer_id: customerId,
          sender_side: "customer",
          sender_id: user.id,
          body: raw,
          read_by_customer: true, // the sender has obviously "read" their own message
          read_by_staff: false,
        })
        .select("id, created_at")
        .single();

      if (insError) return bad("Could not send the message: " + insError.message, 500);
      return NextResponse.json({ success: true, id: inserted?.id, created_at: inserted?.created_at });
    }

    // ================= MARK READ =================
    // Customer opened the thread: mark the shop's messages on this job as read.
    if (action === "mark_read") {
      const { error: updError } = await admin
        .from("job_messages")
        .update({ read_by_customer: true })
        .eq("job_id", job.id)
        .eq("customer_id", customerId)
        .eq("sender_side", "staff")
        .eq("read_by_customer", false);

      if (updError) return bad(updError.message, 500);
      return NextResponse.json({ success: true });
    }

    return bad("Unknown action.");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

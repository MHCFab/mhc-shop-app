import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Portal order actions. All writes happen here with the service role key,
// after verifying the caller is an active customer login acting on their
// own records — customer logins have NO insert/update rights of their own.
//
//   action: "create"  -> new job with status 'pending' + one line item
//   action: "update"  -> edit qty / PO / date / notes while still 'pending'
//   action: "cancel"  -> 'pending' or 'ordered' job -> status 'cancelled'

const OPEN_STATUSES = ["pending", "ordered", "ready", "in_progress"];

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action as string;

    if (!["create", "update", "cancel"].includes(action)) {
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

    // ---- Shared field validation ----
    function cleanText(value: unknown, maxLen: number): string | null {
      if (typeof value !== "string") return null;
      const t = value.trim();
      if (!t) return null;
      return t.slice(0, maxLen);
    }
    function cleanQuantity(value: unknown): number | null {
      const q = typeof value === "string" ? parseInt(value, 10) : Number(value);
      if (!Number.isInteger(q) || q < 1 || q > 1000000) return null;
      return q;
    }
    function cleanDueDate(value: unknown): string | null {
      if (typeof value !== "string" || !value.trim()) return null;
      const t = value.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
      if (isNaN(new Date(t + "T00:00:00").getTime())) return null;
      return t;
    }

    // ================= CREATE =================
    if (action === "create") {
      const quantity = cleanQuantity(body.quantity);
      if (quantity === null) return bad("Quantity must be a whole number of at least 1.");
      const customerPo = cleanText(body.customerPo, 100);
      const notes = cleanText(body.notes, 2000);
      const dueDate = cleanDueDate(body.dueDate);
      const productTemplateId = body.productTemplateId;
      if (!productTemplateId || typeof productTemplateId !== "string") {
        return bad("Please pick a product.");
      }

      // The product must be this customer's own active product (not a sub-assembly)
      const { data: template } = await admin
        .from("product_templates")
        .select("id, name")
        .eq("id", productTemplateId)
        .eq("company_id", companyId)
        .eq("customer_id", customerId)
        .eq("is_active", true)
        .eq("is_sub_assembly", false)
        .single();

      if (!template) return bad("That product isn't available to order.");

      // Job number is simply the product name. Duplicate names are allowed —
      // the DB unique rule on (company_id, job_number) was dropped 2026-07-16;
      // jobs are tracked by id everywhere in the app.
      const jobNumber = (template.name as string).trim().slice(0, 80);

      // New orders go to the bottom of this customer's board
      const { data: openJobs } = await admin
        .from("jobs")
        .select("board_order")
        .eq("company_id", companyId)
        .eq("customer_id", customerId)
        .in("status", OPEN_STATUSES);
      const maxBoardOrder = (openJobs || []).reduce(
        (max, j) => Math.max(max, Number((j as { board_order: number | null }).board_order ?? 0)),
        -1
      );

      const { data: job, error: jobError } = await admin
        .from("jobs")
        .insert({
          company_id: companyId,
          customer_id: customerId,
          job_number: jobNumber,
          customer_po: customerPo,
          status: "pending",
          due_date: dueDate,
          notes: notes,
          board_order: maxBoardOrder + 1,
          is_build_order: false,
          build_template_id: null,
          build_quantity: null,
        })
        .select()
        .single();

      if (jobError || !job) {
        return bad(jobError?.message || "Could not create the order.", 500);
      }

      const { error: lineError } = await admin.from("job_line_items").insert({
        company_id: companyId,
        job_id: job.id,
        product_template_id: template.id,
        quantity: quantity,
        notes: null,
        sort_order: 0,
        name: null,
        unit_price: null,
      });

      if (lineError) {
        // Don't leave a half-created order behind
        await admin.from("jobs").delete().eq("id", job.id);
        return bad("Could not create the order: " + lineError.message, 500);
      }

      return NextResponse.json({ success: true, jobId: job.id, jobNumber });
    }

    // ---- update/cancel both need the job, verified as this customer's ----
    const jobId = body.jobId;
    if (!jobId || typeof jobId !== "string") return bad("Missing job.");

    const { data: job } = await admin
      .from("jobs")
      .select("id, status, customer_id, company_id")
      .eq("id", jobId)
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .single();

    if (!job) return bad("Order not found.", 404);

    // ================= UPDATE (pending only) =================
    if (action === "update") {
      if (job.status !== "pending") {
        return bad("This order has already been approved — it can't be edited online anymore.");
      }
      const quantity = cleanQuantity(body.quantity);
      if (quantity === null) return bad("Quantity must be a whole number of at least 1.");
      const customerPo = cleanText(body.customerPo, 100);
      const notes = cleanText(body.notes, 2000);
      const dueDate = cleanDueDate(body.dueDate);

      // Guarded update: only while still pending
      const { data: updated, error: updError } = await admin
        .from("jobs")
        .update({ customer_po: customerPo, due_date: dueDate, notes: notes })
        .eq("id", job.id)
        .eq("status", "pending")
        .select("id");

      if (updError) return bad(updError.message, 500);
      if (!updated || updated.length === 0) {
        return bad("This order was just approved — it can't be edited online anymore.");
      }

      const { error: lineError } = await admin
        .from("job_line_items")
        .update({ quantity: quantity })
        .eq("job_id", job.id);

      if (lineError) return bad("Order saved, but the quantity update failed: " + lineError.message, 500);

      return NextResponse.json({ success: true });
    }

    // ================= CANCEL (pending or ordered) =================
    if (action === "cancel") {
      if (job.status !== "pending" && job.status !== "ordered") {
        return bad("This job has been released to the shop and can't be cancelled online. Give us a call instead.");
      }

      const { data: cancelled, error: cancelError } = await admin
        .from("jobs")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancelled_by: user.id,
        })
        .eq("id", job.id)
        .in("status", ["pending", "ordered"])
        .select("id");

      if (cancelError) return bad(cancelError.message, 500);
      if (!cancelled || cancelled.length === 0) {
        return bad("This job's status just changed and it can't be cancelled online anymore.");
      }

      // Free up any inventory reservations it may have had (safe if none)
      await admin.from("inventory_allocations").delete().eq("job_id", job.id);

      return NextResponse.json({ success: true });
    }

    return bad("Unknown action.");
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

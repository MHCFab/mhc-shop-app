// ---------------------------------------------------------------------------
// The only place ShopWorks sends its own email from.
//
// Supabase sends the account emails - invite, password reset, email change -
// through the custom SMTP settings in its dashboard. This file is for the
// emails the APP has to send itself, which is anything Supabase will not send
// for us. The first of those is the cross-shop membership request: Supabase
// flatly refuses to "invite" an address that already has a login, so if we did
// not send that one ourselves nobody would ever hear about it.
//
// It talks to Resend over plain HTTPS rather than through their npm package,
// on purpose: no new dependency, nothing to keep up to date, and nothing new
// that can break the build.
//
// Nothing in here ever throws. Email is a courtesy on top of an action that
// has already succeeded in the database - if the mail fails, the membership
// request still stands and the person still sees it when they next sign in.
// Callers get { ok: false, error } and decide whether to mention it.
// ---------------------------------------------------------------------------

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Escape anything that came from a person before it goes into HTML.
 * Shop names and full names are typed by users, so they are not safe markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send one email through Resend.
 *
 * Returns instead of throwing. If RESEND_API_KEY is not set - which is the
 * case on any environment where email has not been configured yet - this
 * reports that plainly rather than pretending to have sent something.
 */
export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey) {
    return { ok: false, error: "Email is not configured (RESEND_API_KEY is missing)." };
  }
  if (!from) {
    return { ok: false, error: "Email is not configured (EMAIL_FROM is missing)." };
  }

  const body: Record<string, unknown> = {
    from,
    to: [params.to],
    subject: params.subject,
    html: params.html,
    text: params.text,
  };

  const replyTo = process.env.EMAIL_REPLY_TO;
  if (replyTo) {
    body.reply_to = replyTo;
  }

  try {
    // Never let a slow mail provider hold a request handler open. Ten seconds
    // is generous for a single API call; past that we give up and the caller
    // carries on without the email.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    let res: Response;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Resend returns a JSON error body; fall back to the status if it is not
      // JSON, which happens on a gateway error.
      let detail = "HTTP " + res.status;
      try {
        const parsed = (await res.json()) as { message?: string; name?: string };
        if (parsed?.message) {
          detail = parsed.message;
        } else if (parsed?.name) {
          detail = parsed.name;
        }
      } catch {
        // leave detail as the status
      }
      return { ok: false, error: detail };
    }

    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return { ok: false, error: message };
  }
}

/**
 * Work out the address to put in a link back into the app.
 *
 * Same order the invite routes already use for their redirect: the origin the
 * request actually came from, then the configured site URL, then whatever
 * Vercel says this deployment is. Trailing slashes stripped so we never build
 * a double slash.
 */
export function appBaseUrl(requestOrigin: string | null): string {
  const envUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "");
  const base = (requestOrigin || envUrl || "").trim();
  return base.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// The cross-shop membership request.
//
// This goes to somebody who ALREADY has a ShopWorks login at another shop. It
// is a request, not a change: nothing about their account has moved, and it
// grants nothing until they accept. The wording has to make that obvious, or
// it reads like their account was taken over.
// ---------------------------------------------------------------------------
export async function sendMembershipRequestEmail(params: {
  to: string;
  shopName: string;
  inviterName: string | null;
  role: "employee" | "customer";
  appUrl: string;
}): Promise<SendResult> {
  const shop = params.shopName || "A shop on ShopWorks";
  const asWhat =
    params.role === "customer"
      ? "to their customer portal"
      : "to their shop as an employee";

  const who = params.inviterName
    ? params.inviterName + " at " + shop
    : shop;

  const subject = shop + " would like to add you on ShopWorks";

  const signIn = params.appUrl || "https://shopworks.app";

  const text =
    who +
    " has asked to add you " +
    asWhat +
    " on ShopWorks.\n\n" +
    "Nothing about your existing account has changed, and nothing will unless you accept. " +
    "Sign in at " +
    signIn +
    " and you will see the request at the top of the page, with Accept and Decline.\n\n" +
    "If you were not expecting this, you can decline it and nothing happens.\n";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;">' +
    "<p>" +
    escapeHtml(who) +
    " has asked to add you " +
    escapeHtml(asWhat) +
    " on ShopWorks.</p>" +
    "<p>Nothing about your existing account has changed, and nothing will unless you accept.</p>" +
    '<p><a href="' +
    escapeHtml(signIn) +
    '" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Sign in to review the request</a></p>' +
    "<p>You will see it at the top of the page, with Accept and Decline.</p>" +
    '<p style="color:#666;font-size:13px;">If you were not expecting this, you can decline it and nothing happens.</p>' +
    "</div>";

  return sendEmail({ to: params.to, subject, html, text });
}

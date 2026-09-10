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

// ---------------------------------------------------------------------------
// Signup: "confirm your email address".
//
// This is the ONLY thing standing between the form and a real shop record. At
// the moment we send it, nothing exists but one row in shop_signups - no shop,
// no login, and no password anywhere. The link is the whole account.
// ---------------------------------------------------------------------------
export async function sendSignupConfirmationEmail(params: {
  to: string;
  shopName: string;
  fullName: string;
  confirmUrl: string;
}): Promise<SendResult> {
  const subject = "Confirm your email to finish setting up ShopWorks";

  const greeting = params.fullName ? "Hi " + params.fullName + "," : "Hi,";

  const text =
    greeting +
    "\n\nYou started setting up " +
    params.shopName +
    " on ShopWorks. Open the link below to pick a password and get into your shop:\n\n" +
    params.confirmUrl +
    "\n\nThe link works once and expires in 24 hours.\n\n" +
    "Your 14-day free trial starts when you finish, not now, so there is no rush " +
    "and there is no card to enter.\n\n" +
    "If you did not start this, ignore this email - nothing has been created.\n";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;">' +
    "<p>" +
    escapeHtml(greeting) +
    "</p>" +
    "<p>You started setting up <strong>" +
    escapeHtml(params.shopName) +
    "</strong> on ShopWorks. Use the button below to pick a password and get into your shop.</p>" +
    '<p><a href="' +
    escapeHtml(params.confirmUrl) +
    '" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Set my password</a></p>' +
    "<p>The link works once and expires in 24 hours.</p>" +
    "<p>Your 14-day free trial starts when you finish, not now — so there is no rush, and there is no card to enter.</p>" +
    '<p style="color:#666;font-size:13px;">If you did not start this, ignore this email. Nothing has been created.</p>' +
    "</div>";

  return sendEmail({ to: params.to, subject, html, text });
}

// ---------------------------------------------------------------------------
// Signup, when that address ALREADY has a ShopWorks login.
//
// The signup form deliberately gives the same answer either way - "check your
// email" - so that nobody can use it to find out whether an address has an
// account here. This is the email that goes instead, and it is genuinely
// useful: somebody with a customer portal login at one shop who wants their
// own shop is exactly the case this points the right way.
// ---------------------------------------------------------------------------
export async function sendSignupExistingAccountEmail(params: {
  to: string;
  shopName: string;
  appUrl: string;
}): Promise<SendResult> {
  const subject = "You already have a ShopWorks login";
  const signIn = params.appUrl || "https://shopworks.app";

  const text =
    "Somebody - probably you - just tried to start a new ShopWorks shop called " +
    params.shopName +
    " using this email address.\n\n" +
    "This address already has a ShopWorks login, so we did not create anything new. " +
    "Sign in at " +
    signIn +
    " with your existing password.\n\n" +
    "Once you are in, you can start your own shop from Admin, then Trial and setup. " +
    "Your existing access stays exactly as it is, and you can switch between them.\n\n" +
    "If you have forgotten your password, use the reset link on the sign-in page.\n\n" +
    "If this was not you, you can ignore it - nothing has changed.\n";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;">' +
    "<p>Somebody — probably you — just tried to start a new ShopWorks shop called <strong>" +
    escapeHtml(params.shopName) +
    "</strong> using this email address.</p>" +
    "<p>This address already has a ShopWorks login, so nothing new was created.</p>" +
    '<p><a href="' +
    escapeHtml(signIn) +
    '" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Sign in</a></p>' +
    "<p>Once you are in, you can start your own shop from Admin &rarr; Trial and setup. Your existing access stays exactly as it is, and you can switch between them.</p>" +
    '<p style="color:#666;font-size:13px;">Forgotten your password? Use the reset link on the sign-in page. If this was not you, ignore this email — nothing has changed.</p>' +
    "</div>";

  return sendEmail({ to: params.to, subject, html, text });
}

// ---------------------------------------------------------------------------
// The email that comes to YOU, not to a customer.
//
// Goes to OWNER_ALERT_EMAIL. That is an environment variable rather than a
// hardcoded address on purpose - support@mhcfab.com is what the legal pages
// promise to customers, and this is operational mail for whoever is running
// ShopWorks. Keeping them separate means changing one does not change the
// other.
//
// If the variable is not set, this quietly does nothing. It is never worth
// failing a customer's page over an internal notification.
// ---------------------------------------------------------------------------
export async function sendOwnerAlertEmail(params: {
  subject: string;
  lines: string[];
}): Promise<SendResult> {
  const to = process.env.OWNER_ALERT_EMAIL;
  if (!to) {
    return { ok: false, error: "OWNER_ALERT_EMAIL is not set." };
  }

  const body = params.lines.filter((l) => l !== undefined && l !== null);

  const text = body.join("\n") + "\n";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;">' +
    body
      .map((l) => (l === "" ? "<br />" : "<p>" + escapeHtml(l) + "</p>"))
      .join("") +
    "</div>";

  return sendEmail({ to, subject: params.subject, html, text });
}

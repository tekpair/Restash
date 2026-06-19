// supabase/functions/send-email/index.ts
//
// Sends Restash transactional emails via Resend.
//
//   Deploy:  supabase functions deploy send-email
//   Secrets: supabase secrets set RESEND_API_KEY=re_xxx EMAIL_FN_SECRET=your-shared-secret APP_URL=https://getrestash.gg
//
// SECURITY: call this server-side only (from a Supabase Database Webhook on claim status
// changes, or from your own backend). Pass the shared secret in the "x-restash-secret"
// header. NEVER expose RESEND_API_KEY or EMAIL_FN_SECRET to the browser.
//
// This embeds the same email shell as /emails/restash-email-preview.html — keep them in sync.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FN_SECRET = Deno.env.get("EMAIL_FN_SECRET") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://getrestash.gg";
const FROM = "Restash <noreply@getrestash.gg>";          // must be a domain you've verified in Resend
const LOGO = `${APP_URL}/email-logo.png`;                 // hosted PNG (SVGs don't render in many clients)

// ---- Email shell (transparent background, dark-mode aware, purple brand) ----
function shell(preheader: string, inner: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="color-scheme" content="light dark"/><meta name="supported-color-schemes" content="light dark"/>
<style>
@media (prefers-color-scheme: dark){.t-ink{color:#e8e8f2!important}.t-muted{color:#a9a9c2!important}.hairline td{border-color:#34345a!important}}
@media only screen and (max-width:600px){.container{width:100%!important}.px{padding-left:22px!important;padding-right:22px!important}}
a{text-decoration:none}
</style></head>
<body style="margin:0;padding:0;background:transparent;width:100%;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:transparent;"><tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td class="px" style="padding:0 8px 28px;"><img src="${LOGO}" alt="Restash" width="150" style="display:block;width:150px;height:auto;border:0;outline:none;"/></td></tr>
<tr><td class="px" style="padding:0 8px;">${inner}</td></tr>
<tr><td class="px" style="padding:28px 8px 0;"><table role="presentation" class="hairline" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #e6e5f1;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
<tr><td class="px" style="padding:18px 8px 0;">
<p class="t-muted" style="margin:0 0 6px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#6a6d8c;">Restash &middot; Cohoes, NY &middot; <a href="mailto:hello@getrestash.gg" style="color:#5b3fd6;">hello@getrestash.gg</a></p>
<p class="t-muted" style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#9a9ab4;">You're receiving this because you have a claim with Restash. Estimates and offers are not guaranteed until accepted. PlayStation, Xbox, Nintendo, and all game titles are trademarks of their respective owners; Restash is not affiliated with them.</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

const h1 = (t: string) =>
  `<h1 class="t-ink" style="margin:0 0 14px;font-family:'Bricolage Grotesque',Georgia,serif;font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:#5b3fd6;">${t}</h1>`;
const p = (t: string) =>
  `<p class="t-ink" style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1b1d3a;">${t}</p>`;
const muted = (t: string) =>
  `<p class="t-muted" style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#6a6d8c;">${t}</p>`;
const amount = (t: string) =>
  `<p style="margin:18px 0 4px;font-family:'Bricolage Grotesque',Georgia,serif;font-size:46px;line-height:1;font-weight:700;letter-spacing:-0.02em;color:#5b3fd6;">${t}</p>`;
const button = (label: string, href: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#5b3fd6" style="border-radius:12px;"><a href="${href}" style="display:inline-block;padding:14px 28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;border-radius:12px;">${label}</a></td></tr></table>`;

interface EmailData {
  ref?: string;
  name?: string;
  items?: string;
  amount?: string;
  method?: string; // "PayPal" | "Check"
}

// Add more cases here as you wire up the rest of the lifecycle
// (accepted + label, received, declined/returned, password reset, etc.).
function buildEmail(type: string, d: EmailData): { subject: string; html: string } | null {
  const name = d.name ?? "there";
  const url = `${APP_URL}/`;
  switch (type) {
    case "claim_received":
      return {
        subject: `We got your Restash claim ${d.ref ?? ""}`.trim(),
        html: shell(
          "We received your claim — we'll review it shortly.",
          h1("Claim received") +
            p(`Hi ${name}, thanks — we've received claim <strong>${d.ref}</strong> and we're reviewing it now. We typically respond within <strong>2&ndash;3 business days</strong> with a decision.`) +
            p("If we accept it, we'll email you a prepaid shipping label so you can send your games in.") +
            button("View your claim", url),
        ),
      };
    case "offer_made":
      return {
        subject: `Your Restash offer for claim ${d.ref ?? ""}`.trim(),
        html: shell(
          "You've got an offer — review and accept to get paid.",
          h1("You've got an offer") +
            p(`Hi ${name}, we reviewed the games in claim <strong>${d.ref}</strong> and made you an offer:`) +
            amount(d.amount ?? "$0") +
            (d.items ? muted(`for ${d.items}`) : "") +
            p(`Review it in your account. Accept to get paid by ${d.method ?? "PayPal"}, or decline and we'll send your games back to you free.`) +
            button("Review your offer", url),
        ),
      };
    case "payment_sent":
      return {
        subject: "Your Restash payment is on the way",
        html: shell(
          "Your payment has been authorized.",
          h1("Payment on the way") +
            p(`Hi ${name}, you accepted the offer on claim <strong>${d.ref}</strong> — your payment of <strong>${d.amount}</strong> by ${d.method} has been authorized.`) +
            muted(d.method === "Check" ? "Checks typically arrive within 3&ndash;5 business days." : "PayPal transfers typically arrive within 1&ndash;3 business days.") +
            p("Thanks for selling with Restash.") +
            button("View your claim", url),
        ),
      };
    default:
      return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // shared-secret gate — this function is server-to-server only
  if (!FN_SECRET || req.headers.get("x-restash-secret") !== FN_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { to?: string; type?: string; data?: EmailData };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const { to, type, data = {} } = body;
  if (!to || !type) return new Response("Missing 'to' or 'type'", { status: 400 });

  const email = buildEmail(type, data);
  if (!email) return new Response(`Unknown email type: ${type}`, { status: 400 });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject: email.subject, html: email.html }),
  });

  if (!res.ok) {
    const err = await res.text();
    return new Response(JSON.stringify({ ok: false, error: err }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const out = await res.json();
  return new Response(JSON.stringify({ ok: true, id: out.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

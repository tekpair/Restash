# Restash email setup (Resend + Supabase)

Transactional emails are sent by a Supabase Edge Function
(`supabase/functions/send-email/index.ts`) that calls the Resend API. The
Resend key stays server-side — it is never exposed to the browser.

Preview the design any time by opening `emails/restash-email-preview.html`.

> **Good news on the domain:** the site has no custom domain, but email
> verification is **independent of where the site is hosted** — it only needs
> control of the domain's DNS. You own **getrestash.gg** (you already run mail
> on it), so you can verify it in Resend and send **real customer email** from
> `noreply@getrestash.gg` while the site stays on `github.io`.

### Addresses
- **hello@getrestash.gg** — general inquiries. Used as the site's Contact link.
- **noreply@getrestash.gg** — automated transactional sends (the `From`).
- **support@getrestash.gg** — deeper support. Set as the `Reply-To`, so when a
  customer replies to an automated email it lands in a monitored inbox.

## 1. Host the email logo
Emails load the logo from `${APP_URL}/email-logo.png`. `email-logo.png` is
in the repo root, so with the default `APP_URL`
(`https://tekpair.github.io/Restash`) it just works. If you move the site,
set `APP_URL` (step 3) to match.

## 2. Verify getrestash.gg in Resend (required for real sends)
1. Create a Resend account → **Add domain** → `getrestash.gg`.
2. Add the DNS records Resend gives you (SPF / DKIM, and DMARC if offered) at
   your registrar — alongside your existing mail records; they don't conflict.
3. Wait for Resend to show the domain **Verified**. Now `noreply@getrestash.gg`
   can send to anyone. (Before it's verified, override `EMAIL_FROM` with
   `onboarding@resend.dev`, which only delivers to your own account email.)

## 3. Set the secrets in Supabase
```bash
supabase secrets set \
  RESEND_API_KEY=re_your_key_here \
  EMAIL_FN_SECRET=pick-a-long-random-string \
  EMAIL_FROM="Restash <noreply@getrestash.gg>" \
  EMAIL_REPLY_TO=support@getrestash.gg \
  APP_URL=https://tekpair.github.io/Restash
```
- `RESEND_API_KEY` — from the Resend dashboard.
- `EMAIL_FN_SECRET` — any long random string; gates the function so it
  can't be used as an open relay.
- `EMAIL_FROM` — a verified sender (defaults to Resend's test sender).
- `APP_URL` — your live base URL (used for the logo and button links).

## 4. Deploy the function
```bash
supabase functions deploy send-email
```

## 5. Call it (server-side only)
```bash
curl -X POST "https://<project-ref>.functions.supabase.co/send-email" \
  -H "x-restash-secret: <your EMAIL_FN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{ "to":"customer@example.com", "type":"offer_made",
        "data":{ "name":"Maya","ref":"RS-7K2Q9P","amount":"$27","items":"Mario Kart 8 Deluxe","method":"PayPal" } }'
```
Built-in `type` values: `claim_received`, `claim_accepted`, `games_received`,
`offer_made`, `payment_sent`, `claim_declined`, `games_returned`.

## 6. Trigger automatically (recommended)
Don't call this from the browser. Fire it from a **Supabase Database
Webhook** on the `claims` table so emails track real claim state. Example:
when `status` changes to `offer`, POST `type: "offer_made"` with the
`x-restash-secret` header; when it changes to `accepted`, send
`claim_accepted`; and so on. That keeps the secret server-side.

## Notes on the design
- Transparent background so it sits on the client's light/dark surface.
- Brand purple for the logo, headings, amount, and button.
- Body text adapts to dark mode via `prefers-color-scheme` (honored by
  Apple Mail; Gmail does its own adjustment but stays legible).
- The logo is a hosted **PNG**, not SVG, because many clients don't render
  inline SVG.

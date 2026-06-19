# Restash email setup (Resend + Supabase)

Transactional emails are sent by a Supabase Edge Function
(`supabase/functions/send-email/index.ts`) that calls the Resend API. The
Resend key stays server-side — it is never exposed to the browser.

Preview the design any time by opening `emails/restash-email-preview.html`.

> **Status:** you launched without a custom domain, so email is in **test
> mode** — Resend will only send from its test sender (`onboarding@resend.dev`)
> and only to your own Resend account email. Wire it up now; real customer
> sends start the moment you verify a domain (step 2).

## 1. Host the email logo
Emails load the logo from `${APP_URL}/email-logo.png`. `email-logo.png` is
in the repo root, so with the default `APP_URL`
(`https://tekpair.github.io/Restash`) it just works. If you move the site,
set `APP_URL` (step 3) to match.

## 2. Verify your sending domain in Resend (required for real sends)
1. Create a Resend account. Until you add a domain you can only send from
   `onboarding@resend.dev` to your own account email.
2. **Add a domain** you control and add the DNS records Resend gives you
   (SPF / DKIM) at your registrar. (You can verify a domain for email even
   if the website itself stays on `github.io`.)
3. Wait for Resend to show the domain **Verified**, then set `EMAIL_FROM`
   to an address on it (step 3), e.g. `Restash <noreply@yourdomain.com>`.

## 3. Set the secrets in Supabase
```bash
supabase secrets set \
  RESEND_API_KEY=re_your_key_here \
  EMAIL_FN_SECRET=pick-a-long-random-string \
  EMAIL_FROM="Restash <noreply@yourdomain.com>" \
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

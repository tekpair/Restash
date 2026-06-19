# Restash email setup (Resend + Supabase)

Transactional emails are sent by a Supabase Edge Function (`supabase/functions/send-email/index.ts`)
that calls the Resend API. The Resend key stays server-side — it is never exposed to the browser.

Preview the design any time by opening `emails/restash-email-preview.html` in a browser.

## 1. Host the email logo
The emails load the logo from `https://getrestash.gg/email-logo.png`.
`email-logo.png` is already in the repo root, so once the site is live on the domain it just works.
If your live URL is different (e.g. a `github.io` sub-path), set `APP_URL` in step 3 to match.

## 2. Verify your sending domain in Resend
1. Create a Resend account and add the domain `getrestash.gg`.
2. Add the DNS records Resend gives you (SPF / DKIM) at your registrar.
3. Wait for Resend to show the domain as **Verified**.
   Until then you can only send from Resend's test address, not `noreply@getrestash.gg`.

## 3. Set the secrets in Supabase
```bash
supabase secrets set \
  RESEND_API_KEY=re_your_key_here \
  EMAIL_FN_SECRET=pick-a-long-random-string \
  APP_URL=https://getrestash.gg
```
- `RESEND_API_KEY` — from the Resend dashboard.
- `EMAIL_FN_SECRET` — any long random string; it gates the function so it can't be used as an open relay.
- `APP_URL` — your live base URL (used for the logo and the button links).

## 4. Deploy the function
```bash
supabase functions deploy send-email
```

## 5. Call it (server-side only)
Send a POST with the secret header and a `type` + `data`:
```bash
curl -X POST "https://<project-ref>.functions.supabase.co/send-email" \
  -H "x-restash-secret: <your EMAIL_FN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "customer@example.com",
    "type": "offer_made",
    "data": { "name": "Alex", "ref": "RS-7K2Q9P", "amount": "$27", "items": "Mario Kart 8 Deluxe", "method": "PayPal" }
  }'
```

Built-in `type` values: `claim_received`, `offer_made`, `payment_sent`.
Add more cases in `buildEmail()` as you wire up the rest of the lifecycle
(accepted + shipping label, games received, declined/returned, password reset).

## 6. Trigger automatically (recommended)
Don't call this from the browser. Instead fire it from a **Supabase Database Webhook**
on the `claims` table: when `status` changes to `offer`, call the function with `type: "offer_made"`,
and so on. That keeps the secret server-side and emails in sync with real claim state.

## Notes on the design
- No background on the content, so it sits cleanly on the mail client's light or dark surface.
- Brand purple is used for the logo, headings, amount, and button — it reads on both light and dark.
- Body text swaps to a light tone in dark mode via a `prefers-color-scheme` media query. This is
  honored by Apple Mail and similar clients; Gmail does its own color adjustment and won't read the
  media query, but the purple accents keep it legible there too.
- The logo is a hosted **PNG**, not an SVG, because many clients don't render inline SVG.

# Restash

A recommerce platform for buying physical video games back from sellers. Customers submit games, get an estimate, ship them in, and get paid by PayPal or check. This repo holds two front-end surfaces:

- **`index.html`** — the customer app. Buyback flow: platform → title → edition → condition → cart → claim → track status → accept or decline offers. The account area is a left-nav layout — **Home · Profile · Claims · Refer · Bulk Seller · Controls**. **Home** is a dashboard landing (active/paid claim counts, referral bonus, an offer-to-review nudge, recent claims, quick actions). Each claim has a **two-way message thread** with Restash, and there's a **referral program** (give/get a bonus on your next accepted offer — no withdrawable wallet).
- **`console.html`** — the internal staff console. Review claims, claim/assign ownership, inspect, make offers (with a fair-price guardrail), **message customers on a claim**, record payouts, manage customer accounts, **review the Bulk Seller queue**, leave notes/flags, and view the team/department directory.
- **`help.html`** — public Help Center (how it works + FAQ, with FAQ rich-results data). `how-it-works.html` redirects here.

Contact: **hello@getrestash.gg** · Governing law: **New York (Cohoes, Albany County)**

Live URL (GitHub Pages): **https://tekpair.github.io/Restash/** — staff console at **https://tekpair.github.io/Restash/console.html**

---

## Current status: Supabase-backed, launching without a custom domain

The two surfaces are static HTML/CSS/vanilla-JS, served on GitHub Pages and
wired to **Supabase** for real auth, database, and server-side logic. **→ See
[`SUPABASE-SETUP.md`](SUPABASE-SETUP.md) to take it live.**

What's real now:
- **Supabase Auth** — customer signup/login/reset; the console is gated by a
  `staff` role + Row-Level Security (reachable URL, but no data/actions
  without a staff account).
- **Postgres + RLS** — customers see only their own claims; staff see all.
- **Server-side pricing + offer guardrail** — estimates/line values are
  computed from the catalog in the DB (client numbers ignored); staff offers
  are forced into the fair band by the database.
- **Shared claim state machine** with the customer-gated offer step.

What's deferred (by choice, for this first launch):
- **Payouts are manual** — the app records them; staff send the actual
  PayPal/check and mark it paid. (No PayPal Payouts API yet.)
- **Email is wired but in test mode** until a sending domain is verified
  (see [`EMAIL-SETUP.md`](EMAIL-SETUP.md)).
- **Catalog pricing is placeholder** — replace before taking real claims.
- **Legal copy is a template** — have an attorney review before launch.

### Stack
- **GitHub Pages** — static hosting for both surfaces (no build step).
- **Supabase** — Postgres + Auth + Row-Level Security + Edge Functions.
- **Resend** — transactional email (via a Supabase Edge Function).
- Front-end talks to Supabase with the public **anon key** (`config.js`);
  all privileged logic lives in SECURITY DEFINER functions / Edge Functions.

### 1. Authentication & access control — DONE
- Fake logins replaced with **Supabase Auth** (`js/api.js`).
- Customers: email/password (+ password reset).
- Staff: `profiles.role = 'staff'`, enforced with **RLS** and checked both on
  console sign-in and in every staff RPC.
- **Console exposure:** the console HTML is reachable by URL on GitHub Pages,
  but RLS makes it inert without a staff session — no data loads and no action
  succeeds. `noindex` keeps it out of search. (If you later want stronger
  isolation, move `console.html` to a separate access-restricted host.)

### 2. Database (replace the seeded arrays)
The prototype `state.*` arrays show the intended shape. Model at least:
- **profiles** — name, email, phone, **mailing address** (for checks), created_at.
- **claims** — `ref` (RS-XXXXXX), customer, estimate low/high, payout method, **mailing address**, status, offer amount, **customer response** (accepted/declined), **assignee**, **flagged**, **notes[]**, status history, timestamps.
- **claim_items** — title, platform, edition, condition, qty, line value.
- **team_members** — name, role, **group/department**, email, focus areas.
- (later) inventory, a payouts ledger.

### 3. Claim lifecycle (one shared state machine)
Status flow:

```
submitted → reviewing → accepted → received → offer → paid | declined | returned
```

- This is the single source of truth shared by both surfaces through Supabase.
- **The customer-gated offer step is real and must stay:** after staff send an offer, the claim is locked until the customer **accepts or declines** in their account. The customer's choice flips the status the console reads. (In the prototype the console *simulates* this response; in production it comes from the customer app via the shared DB.)
- Each claim gets a unique `RS-XXXXXX` reference.

### 4. Offer guardrail (enforce server-side)
- Staff offers must fall within a fair band of the customer estimate. The prototype uses roughly **70%–110% of the estimate midpoint** and blocks anything outside it.
- Enforce this in the API/DB, not just the client.
- **Re-check / tune the band with real pricing data** — some legitimate condition markdowns may fall below 70%. The number is a starting point, not a final rule.

### 5. Address handling (already designed correctly)
- Collect the **mailing address on the customer side** — only when **Check** is chosen, and on the account profile. Store it in Supabase.
- The console **reads** it (the "Send to" field) so staff can mail the check.
- Do **not** collect addresses inside the console or over email.

### 6. Payments
- **PayPal:** integrate the **PayPal Payouts API** to send payments for accepted offers.
- **Check:** manual mail process; track status + mailed/tracking info.
- Pay only when the payee name matches the account name (existing policy).
- **Do NOT build a withdrawable account balance / wallet.** Holding customer funds they can withdraw likely makes Restash a **money transmitter** — triggering state Money Transmitter Licenses (incl. NY/NYDFS), FinCEN MSB registration, fund safeguarding, and unclaimed-property law. Keep the simple **pay-per-accepted-offer** model. If this is ever reconsidered, talk to a fintech/payments attorney first.

### 7. Email (Resend)
Transactional sends to wire up: claim received, accepted + shipping label, games received, offer made, payment authorized, declined/return + tracking, password reset, account changes.

### 8. Shipping labels
Integrate a carrier/label API (e.g. EasyPost or Shippo) to generate a prepaid label when a claim is accepted, and tracking for returns.

### 9. Catalog & pricing
- The buyback dollar values in the customer app are **placeholders** (see the comment in `index.html`: "Catalog (placeholder buyback values...)"). Replace with real values, e.g. a PriceCharting feed × your buyback rate.
- Move the catalog (platforms, titles, editions, condition multipliers) into the database so it's editable without code changes.

### 10. Secrets & security
- All API keys (Supabase service-role key, PayPal, Resend, label API) live in **server-side env vars only** — never in client code.
- Use RLS so customers see only their own claims and staff see the full queue.

### 11. Legal (review before launch)
- The Terms of Service, Privacy Policy, and in-app policy copy are **draft templates**. Have an **attorney review** them before going live — especially: authenticity/ownership certification ("under penalty of perjury"), suspected-stolen-property handling, name-matched payouts, IP/device-data collection, NY governing law, and the trademark disclaimers.

### 12. Brand assets (trademark / copyright)
- The prototype intentionally uses **generic icons** — not console-maker logos (PlayStation/Xbox/Nintendo) or game box art, which are trademarked/copyrighted.
- Only use official platform logos if you have the rights. Keep the "not affiliated / trademarks of their respective owners" disclaimers.

---

## Bulk Seller program (beta)

A separate lane for high-volume sellers, gated by **hard requirements** and
**approved by the Restash team**. Sellers apply from their account
(**Bulk Seller** tab); staff review the queue in the console (**Bulk Sellers**
tab) and approve / decline / suspend / close — each with an inline reason the
seller sees. Rules live in one place (`RestashAPI.BULK` in `js/api.js`) and are
shown identically on both surfaces:

- **To apply:** ≥ 50 lifetime paid claims, ≥ 60 days on Restash, an account in
  **good standing** (no counterfeit / repeated-mismatch flags), a government ID,
  and the signed Bulk Seller agreement.
- **Once active:** ≥ 50 **games shipped/month** (or **suspended**), ≥ 15 games
  per shipment, **PayPal-only** payouts, and no counterfeits / ownership issues
  / repeated mismatches (**immediate closure**). A closed seller may reapply
  after 3 months. Active sellers can also **close their own membership** from
  the Bulk Seller tab (warned about the 3-month lockout and forfeiting active
  bulk lot claims).
- **Lane lock:** an active Bulk Seller can **not** use the standard one-by-one
  flow — they're routed to the bulk lane. (Closed/suspended sellers keep using
  Restash normally.)

**The bulk submission lane:** an active seller submits **one manifest** for the
whole lot → the claim is **auto-accepted and a prepaid label is emailed** (no
review gate) → it **skips traditional per-item inspection** and is inspected on
arrival (priority intake) → staff send **one bulk offer for everything**, which
the seller accepts/declines through the normal customer-gated step. Bulk Sellers
also get a **24/7 direct line** (`RestashAPI.BULK_LINE`). Bulk claims reuse the
shared claim state machine (`accepted → received → offer → paid | returned`)
with a `bulk` flag, a free-form `manifest`, and `est_count` instead of items —
so the offer fair-band (which prices items) doesn't apply to a bulk lot.

The program is wired end-to-end in **demo mode** (sign in as `riley.park@email.com`
to see an active seller submit a manifest; `admin@getrestash.gg` in the console
to make the bulk offer). The production schema + RPCs are scaffolded in
`supabase/migrations/0013_bulk_seller.sql` (eligibility checked server-side,
decisions staff-only, customers can't self-set their status).

---

## Site roadmap (making it fully fledged)

Built so far (beyond the core buyback loop + console):
- **Help Center** (`help.html`) consolidating how-it-works + an expanded FAQ.
- **Two-way claim messaging** — a thread per claim on both the customer app and
  the console (`claim_messages`; demo-seeded on `RS-2W8E4F`).
- **Home dashboard** — the default account landing with activity stats, an
  offer-to-review nudge, recent claims, and quick actions.
- **Referral program** (`RestashAPI.REFERRAL`) — a give/get bonus **applied to
  the next accepted offer** (deliberately *not* a withdrawable balance, to avoid
  money-transmitter exposure). Demo-seeded for `maya.chen@email.com`. Includes an
  **optional referral-code field on the create-account form** that pre-fills from
  a `?ref=CODE` link and credits the referrer (`applyReferralCode`).
- **Live phone formatting** on all `tel` inputs, e.g. `(518) 555-0123`.
- **Google address autocomplete** is wired for the checkout (Check) and profile
  address fields — it activates once `GOOGLE_MAPS_API_KEY` is set in `config.js`.
  Suggestions are **restricted to the U.S.** (`country: ['us']`).
- **Continental-U.S.-only addresses** — checkout (Check payout) and profile saves
  reject AK, HI, and the U.S. territories (`nonContinentalRegion`), with a
  helper note on the address fields. (Autocomplete is country-level, so the
  continental filter is enforced by this submit-time check.)
- **Notifications + email/SMS preferences** — an **Alerts** account tab with an
  in-app notification list and per-category email/SMS toggles
  (`RestashAPI.NOTIF_CATS`, `getNotifications` / `updateNotifPrefs` /
  `markNotificationsRead`). Notifications are generated server-side on offers,
  payments, acceptance, and tracking updates. Demo-seeded for
  `maya.chen@email.com`. An unread dot shows on the nav tab.
- **Tracking on claims** — carrier + tracking number on accepted / in-inspection
  / returned claims, with a deep link to the carrier (`RestashAPI.CARRIERS`,
  `setTracking`). Customers see a **Shipping** card; staff get an inline setter
  on the claim detail. Demo-seeded on `RS-8M4X2A` (USPS) and `RS-BLK3X9` (UPS).
- **Bulk CSV upload** — Bulk Sellers can upload a `.csv` manifest (with a
  downloadable template) on the bulk-submit screen; it parses `title, platform,
  condition, qty, notes` columns to fill the manifest text and game count.
- **Bulk-seller priority band** — the console claims dashboard pulls active Bulk
  Seller lots into a dedicated gold "Priority" section (plus a Priority filter
  chip), so the priority intake/inspection we promise them is visible at a glance
  (`priorityClaims`, `PRIORITY_ACTIVE`).
- **Marketing landing page** — a dedicated front door (`views.landing`) shown to
  logged-out visitors: hero, value props, how-it-works, why-Restash, and CTAs
  into the buyback flow. It's the default boot view when signed out.
- **Staff Inventory** — a console tab showing games **on hand** (received +
  offer-out lots) with units and estimated value, plus an **Incoming** list
  (accepted/in-transit). The **Payouts** tab remains the running payment ledger.

Next up (greenlit, not yet built), roughly in order:
1. **Saved/again selling** — let returning sellers re-submit common titles fast.
2. **Seller profile polish** — avatars, payout defaults, saved addresses.
3. **Admin analytics** — simple volume/throughput charts in the console.

(Reviews / social proof was considered and **skipped** for now.)

Later / parked: production hardening is unchanged — see the numbered list above
(PayPal Payouts API, shipping-label API, real catalog pricing, verified email
domain, attorney review of the legal copy). The notification/tracking demo
methods are wired to RPC stubs (`get_notifications`, `update_notif_prefs`,
`mark_notifications_read`, `set_tracking`) that still need their SQL functions +
tables (`notifications`, `notif_prefs`, claim `carrier` / `tracking_number`
columns) for the Supabase backend.

## Do not regress

These are correct in the prototype and must carry into production:

- The **customer-gated offer step** (lock pay/return until the customer responds).
- The **fair-offer band** on staff offers.
- **Address collected on the customer side** (Check only), read by the console.
- **No withdrawable balance/wallet** (money-transmission risk).
- **Generic icons only** — no maker logos or box art.
- **Name-matched payouts.**

---

## File map / key seed data to replace

- **`index.html`** — customer app. Seed to replace: `state.user`, `state.claims`, and the catalog object (placeholder prices, marked in a comment).
- **`admin.html`** — staff console. Seed to replace: `state.claims`, `state.accounts`, `state.team`, and `DEPTS` (the planned department list shown on the Team tab).

---

## Deploying this prototype to GitHub Pages

1. Put `index.html`, `console.html`, and this `README.md` in the repo root on the `main` branch. (A `.nojekyll` file is included so GitHub Pages serves the files as-is, without Jekyll processing.)
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save.**
3. Wait ~1 minute. The site is at `https://tekpair.github.io/Restash/`; the console at `…/console.html`.
4. **Asset/link paths are relative** so the project subpath (`/Restash/`) works. SEO/social tags (canonical, Open Graph, sitemap, robots) point at `https://tekpair.github.io/Restash/` — the current live URL.
5. Custom domain (getrestash.gg) later: **Settings → Pages → Custom domain**, enter the domain, then add the DNS records GitHub shows you at your registrar (apex A-records + a `www` CNAME). Follow GitHub's current Pages custom-domain docs for the exact values, then enable **Enforce HTTPS**. When you do, update the SEO/social URLs (canonical, `og:url`, `og:image`, `sitemap.xml`, `robots.txt`) back to the custom domain — relative asset paths will keep working as-is.

Reminder: this hosts the console publicly. Fine for a demo with fake data; move it behind real auth before launch (see section 1).

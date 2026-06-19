# Restash

A recommerce platform for buying physical video games back from sellers. Customers submit games, get an estimate, ship them in, and get paid by PayPal or check. This repo holds two front-end surfaces:

- **`index.html`** — the customer app (the public site at getrestash.gg). Buyback flow: platform → title → edition → condition → cart → claim → track status → accept or decline offers, plus account/profile.
- **`admin.html`** — the internal staff console. Review claims, claim/assign ownership, inspect, make offers (with a fair-price guardrail), process payouts, manage customer accounts, leave notes/flags, and view the team/department directory.

Domain: **getrestash.gg** · Contact: **hello@getrestash.gg** · Governing law: **New York (Cohoes, Albany County)**

Live URL (GitHub Pages): _add after enabling Pages_

---

## Current status: front-end prototype (NOT production)

Both files are **single-file, front-end-only HTML/CSS/vanilla-JS prototypes** that run entirely in the browser with **in-memory seeded data**. There is:

- no backend, no database (all data lives in JS `state.*` objects and resets on refresh),
- no real authentication (both logins accept any credentials),
- no real payments, email, or shipping labels.

Treat the visuals, flows, copy, status machine, and policies as **the design spec**. Everything in the launch checklist below is what must be built or replaced to go live.

To preview: open either file in a browser. No build step.

---

## Production launch — what to build / change

### Planned stack
- **Next.js** (App Router) — replaces the static HTML. One app serves the public customer site; a separate protected area serves the console.
- **Supabase** — Postgres + Auth + Row-Level Security (RLS) + Storage.
- **Resend** — transactional email.

### 1. Authentication & access control
- Replace the fake logins (both files accept anything) with **Supabase Auth**.
- Customers: email/password or magic link.
- Staff: a separate **role** (e.g. `role = 'staff'`) enforced with **RLS** and a server-side check.
- **The console must not be publicly reachable.** As shipped on GitHub Pages it is open to anyone with the URL (it only holds fake data, which is fine for a demo). For launch, gate it behind real auth + role and host it on a protected deployment — **not public GitHub Pages**.

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

1. Put `index.html`, `admin.html`, and this `README.md` in the repo root on the `main` branch.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save.**
3. Wait ~1 minute. The site is at `https://<username>.github.io/<repo>/`; the console at `…/admin.html`.
4. Custom domain (getrestash.gg): **Settings → Pages → Custom domain**, enter the domain, then add the DNS records GitHub shows you at your registrar (apex A-records + a `www` CNAME). Follow GitHub's current Pages custom-domain docs for the exact values, then enable **Enforce HTTPS**.

Reminder: this hosts the console publicly. Fine for a demo with fake data; move it behind real auth before launch (see section 1).

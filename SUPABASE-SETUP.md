# Restash — Supabase setup (go-live guide)

The site is a static front-end (GitHub Pages) backed by **Supabase** for
auth, database, Row-Level Security, and server-side logic. Follow these
steps once to take it live.

> You will need: a Supabase account (free tier is fine). ~20 minutes.

---

## 1. Create the project
1. Go to https://supabase.com → **New project**. Pick a name, a strong
   database password, and a region near your customers.
2. Wait for it to finish provisioning.

## 2. Create the database schema
Run the four migration files in **`supabase/migrations/`**, in order.

**Option A — SQL Editor (no tooling):** open the Supabase dashboard →
**SQL Editor** → paste the contents of each file and run them in order:
1. `0001_init.sql`
2. `0002_security.sql`
3. `0003_rpcs.sql`
4. `0004_seed.sql`

**Option B — Supabase CLI:**
```bash
supabase link --project-ref <your-project-ref>
supabase db push          # applies everything in supabase/migrations
```

This creates the tables, Row-Level Security, the lifecycle functions, and
seeds the catalog + the founder directory.

## 3. Connect the front-end
Supabase dashboard → **Project Settings → API**. Copy:
- **Project URL**
- the **anon / publishable** key (the public one — safe in the browser)

Paste them into **`config.js`** in the repo root:
```js
window.RESTASH_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGci...'   // the anon/publishable key
};
```
Commit and push. (The anon key is meant to be public; Row-Level Security
controls what it can do. **Never** put the service-role/secret key here.)

## 4. Point auth at the live site
Supabase dashboard → **Authentication → URL Configuration**:
- **Site URL:** `https://tekpair.github.io/Restash/`
- **Redirect URLs — add:**
  - `https://tekpair.github.io/Restash/index.html`
  - `https://tekpair.github.io/Restash/console.html`

These make email-confirmation and password-reset links return to the app.

**Email confirmation** is ON by default. Two choices:
- **Keep it on** (recommended for a real launch): new customers must
  click a confirmation link before they can sign in. The signup screen
  already tells them to check their email.
- **Turn it off** for a smoother first run: **Authentication → Providers →
  Email → "Confirm email" off**. New accounts can use the site immediately.

## 5. Create your staff (console) login
The console is reachable by URL but **useless without a staff account** —
RLS blocks all data and every action unless your profile's `role` is
`staff`. To grant it:

1. Create the user: **Authentication → Users → Add user** (set an email +
   password), or have them sign up through the customer site first.
2. Promote them: **SQL Editor** →
   ```sql
   update profiles set role = 'staff' where email = 'you@yourdomain.com';
   ```
3. Sign in at `https://tekpair.github.io/Restash/console.html`.

Repeat for each staff member. (Customers never get `staff`; the database
blocks them from changing their own role.)

## 6. Replace the placeholder pricing
The seeded catalog uses **placeholder** buyback values. Update them before
taking real claims — edit `editions.base` (and add titles/editions) in the
**Table Editor** or via SQL, e.g.:
```sql
update editions set base = 24 where title_id = 'mk8d' and edition_key = 'std';
```
The customer estimate, the fair-offer band, and every line value are
computed **server-side** from these numbers, so they must be real.

## 7. (Optional now) Transactional email
Customer emails need a **verified sending domain** in Resend. You chose to
launch without one, so email stays in test mode for now. When you're
ready, see **`EMAIL-SETUP.md`** — verify a domain, set the function
secrets, deploy `send-email`, and wire the database webhooks.

---

## What's enforced server-side (don't rely on the browser)
- **Pricing** — estimates and line values are recomputed from the catalog
  on submit; the client's numbers are ignored.
- **Offer guardrail** — staff offers must be 70%–110% of the estimate
  midpoint; the database rejects anything outside it.
- **Access** — customers see only their own claims/profile; staff see
  everything. The console's data and actions require a `staff` role.
- **Customer-gated offers** — an offer locks until the customer accepts or
  declines in their own account; staff then record the manual payout.

## Still required before a true public launch
- **Attorney review** of the Terms and Privacy Policy (they're templates).
- **Real payout process** — v1 records payouts; staff send the actual
  PayPal/check out-of-band and mark them paid. (PayPal Payouts API and
  shipping-label APIs can be added later behind their credentials.)
- **Replace placeholder pricing** (step 6) and review the catalog.

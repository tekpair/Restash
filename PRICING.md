# Restash — pricing & offers

## How an offer is calculated
Every game has a **market value** (the price of a Complete/CIB copy). Our buy
offer is a strict, deterministic function of it — computed in the database
(`compute_offer`, migration `0007`) and mirrored in the browser for live
estimates (`RestashAPI.computeOffer`). The two always agree.

```
per-game market value = edition market value (Complete) × condition multiplier
                        (Sealed 1.4 · Complete 1.0 · Loose 0.6)

offer = ( Σ  market_value × target_margin )  −  shipping  −  payment processing fee
```

**Target margin is tiered by each game's market value** — shipping eats most of
the profit on cheap games, so we offer a smaller %; high-value/retro games allow
a more competitive %:

| Per-game market value | Target margin |
|---|---|
| under $20 (low value) | **35%** (range 30–40%) |
| $20 – $50 | **45%** |
| $50+ (high value / retro) | **57%** (range 50–65%) |

Then we subtract estimated **shipping** ($4.50/claim) and the **payment
processing fee** (2.9% + $0.30).

## Minimum-submission rule
To stop a single $4 game that costs $4.50 to ship, a claim must clear **either**
bar to submit:
- estimated offer **≥ $25**, **or**
- **≥ 3 games**.

Enforced server-side in `submit_claim` and in the customer cart (the *Continue*
button is disabled until one bar is met).

## Tuning — all knobs live in `pricing_config`
One row, editable in the Supabase Table Editor (no code change):

| column | default | meaning |
|---|---|---|
| `margin_low` / `margin_mid` / `margin_high` | 0.35 / 0.45 / 0.57 | target margin per tier |
| `tier_mid_min` / `tier_high_min` | 20 / 50 | tier thresholds ($) |
| `ship_cost` | 4.50 | estimated shipping per claim |
| `fee_pct` / `fee_flat` | 0.029 / 0.30 | payment processing fee |
| `min_quote` / `min_games` | 25 / 3 | minimum-submission rule |

The staff offer guardrail allows **±15%** around the algorithm's suggestion, so
staff have judgment room while payouts stay consistent.

## Live market values from PriceCharting (optional, needs a subscription)
`editions.base` is the Complete market value. It ships with placeholders; refresh
it from a pricing API:

1. **Get a PriceCharting API token** (paid). (Mavin or another source can be
   swapped in — only `supabase/functions/price-sync` changes; the algorithm
   doesn't.)
2. **Map products:** set each row's `editions.pricecharting_id` to the product
   id at PriceCharting (Table Editor or SQL).
3. **Set secrets & deploy:**
   ```bash
   supabase secrets set PRICECHARTING_TOKEN=xxxxx PRICE_SYNC_SECRET=long-random \
     SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
   supabase functions deploy price-sync
   ```
4. **Run it** (server-side only) — manually or on a schedule (e.g. a daily
   Supabase cron). It pulls each edition's CIB price and updates `base` +
   `market_updated_at`:
   ```bash
   curl -X POST "https://<ref>.functions.supabase.co/price-sync" \
     -H "x-restash-secret: <PRICE_SYNC_SECRET>"
   ```

Offers recompute automatically from the refreshed market values — no app
changes needed.

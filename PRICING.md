# Restash — pricing & offers

## How an offer is calculated
Every game has a **market value** (the price of a Complete/CIB copy). Our buy
offer is a strict, deterministic function of it — computed in the database
(`compute_offer`, migration `0007`) and mirrored in the browser for live
estimates (`RestashAPI.computeOffer`). The two always agree.

```
per-game market value = the real market price for that exact condition
                        (PriceCharting loose-price / cib-price / new-price).
                        Before a price sync runs, it falls back to the Complete
                        value × a condition multiplier (Sealed 1.4 · Complete 1.0
                        · Loose 0.6).

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

## Live market values from PriceCharting
The [PriceCharting Prices API](https://www.pricecharting.com/api-documentation)
returns three prices per game — `loose-price`, `cib-price`, `new-price` (in
pennies) — which map exactly to our **Loose / Complete / Sealed** conditions.
`price-sync` pulls all three into `editions` (`loose_market`, `base` = CIB,
`new_market`), so offers use the real market spread, not a flat multiplier.

1. **Get your PriceCharting API token** (your account → API). (Mavin or another
   source can be swapped in — only `supabase/functions/price-sync` changes; the
   algorithm doesn't.)
2. **Set secrets & deploy:**
   ```bash
   supabase secrets set PRICECHARTING_TOKEN=xxxxx PRICE_SYNC_SECRET=long-random \
     SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
   supabase functions deploy price-sync
   ```
3. **Run it** (server-side only) — manually or on a schedule (e.g. a daily
   Supabase cron):
   ```bash
   curl -X POST "https://<ref>.functions.supabase.co/price-sync" \
     -H "x-restash-secret: <PRICE_SYNC_SECRET>"
   ```

Each edition is matched **by name + console automatically** (PriceCharting `q`
search) and the matched product id is saved back to `editions.pricecharting_id`,
so later runs are exact. For full control of a specific edition (e.g. a GOTY or
reprint), set its `pricecharting_id` yourself in the Table Editor. Offers
recompute automatically from the refreshed values — no app changes needed.

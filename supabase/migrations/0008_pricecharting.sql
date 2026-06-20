-- Restash — hooks for a live pricing feed (PriceCharting / Mavin).
-- editions.base holds the Complete (CIB) MARKET value used by the offer
-- algorithm (0007). These columns let a sync job refresh that value from a
-- pricing API and record when it last ran. See supabase/functions/price-sync
-- and PRICING.md.

alter table editions
  add column if not exists pricecharting_id  text,        -- product id at the pricing source
  add column if not exists market_updated_at timestamptz;  -- last successful price refresh

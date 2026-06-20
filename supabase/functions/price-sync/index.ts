// supabase/functions/price-sync/index.ts
//
// Refreshes editions' market value (editions.base = Complete/CIB price) from a
// pricing API (PriceCharting by default). The offer algorithm (compute_offer)
// then derives buy offers from these market values.
//
//   Deploy:  supabase functions deploy price-sync
//   Secrets: supabase secrets set PRICECHARTING_TOKEN=xxxxx PRICE_SYNC_SECRET=long-random \
//            SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...   (see PRICING.md)
//
// Call it server-side only (a scheduled cron, or manually). Pass the shared
// secret in the "x-restash-secret" header. NEVER expose the service-role key or
// the PriceCharting token to the browser.
//
// Each edition needs a `pricecharting_id` (the product id at PriceCharting).
// PriceCharting returns prices in PENNIES; "cib-price" maps to a Complete copy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PC_TOKEN = Deno.env.get("PRICECHARTING_TOKEN") ?? "";
const SYNC_SECRET = Deno.env.get("PRICE_SYNC_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function pcLookup(id: string): Promise<number | null> {
  // https://www.pricecharting.com/api/product?t=TOKEN&id=PRODUCT_ID
  const res = await fetch(`https://www.pricecharting.com/api/product?t=${PC_TOKEN}&id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const data = await res.json();
  // "cib-price" is in pennies (Complete-in-box). Fall back to loose if missing.
  const cents = data["cib-price"] ?? data["loose-price"];
  if (typeof cents !== "number" || cents <= 0) return null;
  return Math.round(cents / 100); // dollars (whole), used as the Complete market value
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SYNC_SECRET || req.headers.get("x-restash-secret") !== SYNC_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!PC_TOKEN || !SUPABASE_URL || !SERVICE_KEY) {
    return new Response("Missing PRICECHARTING_TOKEN / SUPABASE_URL / SERVICE_ROLE_KEY", { status: 500 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: editions, error } = await db
    .from("editions")
    .select("id, name, pricecharting_id")
    .not("pricecharting_id", "is", null);
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 502 });

  let updated = 0;
  const failures: string[] = [];
  for (const e of editions ?? []) {
    try {
      const market = await pcLookup(e.pricecharting_id as string);
      if (market == null) { failures.push(e.id as string); continue; }
      const { error: upErr } = await db
        .from("editions")
        .update({ base: market, market_updated_at: new Date().toISOString() })
        .eq("id", e.id);
      if (upErr) { failures.push(e.id as string); continue; }
      updated++;
    } catch (_) {
      failures.push(e.id as string);
    }
  }

  return new Response(JSON.stringify({ ok: true, updated, failed: failures.length, failures }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

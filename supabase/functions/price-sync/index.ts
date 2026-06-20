// supabase/functions/price-sync/index.ts
//
// Refreshes per-condition MARKET values from the PriceCharting Prices API.
// PriceCharting returns three prices that map exactly to our conditions:
//   loose-price -> Loose, cib-price -> Complete (editions.base), new-price -> Sealed.
// The offer algorithm (compute_offer / edition_market) derives buy offers from them.
//
//   Deploy:  supabase functions deploy price-sync
//   Secrets: supabase secrets set PRICECHARTING_TOKEN=xxxxx PRICE_SYNC_SECRET=long-random \
//            SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...   (see PRICING.md)
//
// Call server-side only (cron or manual). Pass the shared secret in the
// "x-restash-secret" header. NEVER expose the service-role key or the token.
//
// Each edition is matched by its `pricecharting_id` if set; otherwise by name +
// console ("q" search), and the matched id is saved back so future runs are exact.
// PriceCharting prices are in PENNIES.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PC_TOKEN = Deno.env.get("PRICECHARTING_TOKEN") ?? "";
const SYNC_SECRET = Deno.env.get("PRICE_SYNC_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PC_BASE = "https://www.pricecharting.com/api/product";

const dollars = (cents: unknown): number | null =>
  typeof cents === "number" && cents > 0 ? Math.round((cents / 100) * 100) / 100 : null;

interface PcResult { id?: string; loose: number | null; cib: number | null; sealed: number | null; }

async function pcFetch(params: Record<string, string>): Promise<PcResult | null> {
  const qs = new URLSearchParams({ t: PC_TOKEN, ...params }).toString();
  const res = await fetch(`${PC_BASE}?${qs}`, { headers: { "Accept": "application/json" } });
  if (!res.ok) return null;
  const d = await res.json();
  if (d && d.status && d.status !== "success") return null;
  const cib = dollars(d["cib-price"]);
  const loose = dollars(d["loose-price"]);
  const sealed = dollars(d["new-price"]);
  if (cib == null && loose == null && sealed == null) return null;
  return { id: d["id"] != null ? String(d["id"]) : undefined, loose, cib, sealed };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SYNC_SECRET || req.headers.get("x-restash-secret") !== SYNC_SECRET) return new Response("Unauthorized", { status: 401 });
  if (!PC_TOKEN || !SUPABASE_URL || !SERVICE_KEY) return new Response("Missing PRICECHARTING_TOKEN / SUPABASE_URL / SERVICE_ROLE_KEY", { status: 500 });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  // editions joined to their title + platform (for the name search fallback)
  const { data: editions, error } = await db
    .from("editions")
    .select("id, name, pricecharting_id, titles(name, platforms(name))");
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 502 });

  let updated = 0;
  const failures: string[] = [];
  for (const e of (editions ?? []) as any[]) {
    try {
      let r: PcResult | null = null;
      if (e.pricecharting_id) {
        r = await pcFetch({ id: String(e.pricecharting_id) });
      } else {
        const title = e.titles?.name ?? "";
        const consoleName = e.titles?.platforms?.name ?? "";
        const edName = /standard/i.test(e.name) ? "" : (" " + e.name);
        r = await pcFetch({ q: `${title}${edName} ${consoleName}`.trim() });
      }
      if (!r || (r.cib == null && r.loose == null && r.sealed == null)) { failures.push(e.id); continue; }

      const patch: Record<string, unknown> = { market_updated_at: new Date().toISOString() };
      if (r.cib != null) patch.base = Math.round(r.cib);        // Complete value (int)
      if (r.loose != null) patch.loose_market = r.loose;
      if (r.sealed != null) patch.new_market = r.sealed;
      if (r.id && !e.pricecharting_id) patch.pricecharting_id = r.id; // remember the match

      const { error: upErr } = await db.from("editions").update(patch).eq("id", e.id);
      if (upErr) { failures.push(e.id); continue; }
      updated++;
    } catch (_) {
      failures.push(e.id);
    }
  }

  return new Response(JSON.stringify({ ok: true, updated, failed: failures.length, failures }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});

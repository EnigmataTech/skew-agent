import { fetchSpot, fetchDailyCloses, latestSpot, realizedVol, rebuildMispricings } from "../packages/edge/src/index";
import { db } from "@rfb2/shared";

// Refresh price feed.
console.log("[edges] fetching spot + 60d daily closes…");
await fetchSpot();
await fetchDailyCloses("BTC", 60);
await fetchDailyCloses("ETH", 60);

const spots = { BTC: latestSpot("BTC"), ETH: latestSpot("ETH") };
const sigmas = { BTC: realizedVol("BTC"), ETH: realizedVol("ETH") };
console.log("Spot:", spots, "  Realized vol (annualized):", sigmas);

// Drop stale rows from earlier runs before this rebuild — we keep only the
// latest snapshot per market anyway. This avoids confusion from missing
// settlement on pre-D4 rows.
db().exec(`DELETE FROM mispricings`);

console.log("\n[edges] rebuilding mispricings…");
const r = rebuildMispricings();
console.log(`  evaluated=${r.evaluated}  written=${r.written}  skipped(settlement)=${(r as any).skippedSettlement ?? 0}`);

// Filters: settlement-aware (Kalshi back in via barrier and EOD-digital pricers)
//  - require >= 2d maturity (spot-latency below this dominates the edge)
//  - liquidity OR volume threshold
//  - stay away from boundaries where digital pricing is flaky
const filt = `
  (liquidity > 1000 OR volume_24h > 1000)
  AND expiry_unix - captured_at BETWEEN (2 * 86400) AND (180 * 86400)
  AND model_p BETWEEN 0.05 AND 0.95
  AND market_p BETWEEN 0.05 AND 0.95
`;

const longs = db().query(`
  -- Dedupe: pick the highest-volume row per canonical bet within a venue.
  WITH ranked AS (
    SELECT m.venue, mp.asset, mp.op, mp.strike, mp.strike_upper, mp.expiry_unix, mp.settlement,
           mp.market_p, mp.model_p, mp.edge,
           mp.liquidity, mp.volume_24h, m.question,
           ROW_NUMBER() OVER (
             PARTITION BY m.venue, mp.asset, mp.op, ROUND(mp.strike,0),
                          COALESCE(ROUND(mp.strike_upper,0),0),
                          ROUND(mp.expiry_unix/3600.0,0)
             ORDER BY COALESCE(mp.volume_24h,0) DESC, COALESCE(mp.liquidity,0) DESC
           ) AS rn
    FROM mispricings mp JOIN markets m ON m.id = mp.market_id
    WHERE ${filt}
  )
  SELECT venue, asset, op, strike, strike_upper, expiry_unix, settlement,
         ROUND(market_p,3) AS market_p, ROUND(model_p,3) AS model_p,
         ROUND(edge,3) AS edge, ROUND(liquidity,0) AS liq, ROUND(volume_24h,0) AS v24,
         question
  FROM ranked
  WHERE rn = 1
  ORDER BY edge DESC LIMIT 10
`).all() as any[];

const shorts = db().query(`
  -- Dedupe: pick the highest-volume row per canonical bet within a venue.
  WITH ranked AS (
    SELECT m.venue, mp.asset, mp.op, mp.strike, mp.strike_upper, mp.expiry_unix, mp.settlement,
           mp.market_p, mp.model_p, mp.edge,
           mp.liquidity, mp.volume_24h, m.question,
           ROW_NUMBER() OVER (
             PARTITION BY m.venue, mp.asset, mp.op, ROUND(mp.strike,0),
                          COALESCE(ROUND(mp.strike_upper,0),0),
                          ROUND(mp.expiry_unix/3600.0,0)
             ORDER BY COALESCE(mp.volume_24h,0) DESC, COALESCE(mp.liquidity,0) DESC
           ) AS rn
    FROM mispricings mp JOIN markets m ON m.id = mp.market_id
    WHERE ${filt}
  )
  SELECT venue, asset, op, strike, strike_upper, expiry_unix, settlement,
         ROUND(market_p,3) AS market_p, ROUND(model_p,3) AS model_p,
         ROUND(edge,3) AS edge, ROUND(liquidity,0) AS liq, ROUND(volume_24h,0) AS v24,
         question
  FROM ranked
  WHERE rn = 1
  ORDER BY edge ASC LIMIT 10
`).all() as any[];

function strikeStr(r: any): string {
  if (r.op === "range" && r.strike_upper) return `$${Math.round(r.strike).toLocaleString()}-${Math.round(r.strike_upper).toLocaleString()}`;
  return `$${r.strike.toLocaleString()}`;
}
function fmt(r: any) {
  const dte = ((r.expiry_unix - Math.floor(Date.now() / 1000)) / 86400).toFixed(1) + "d";
  const dir = r.edge > 0 ? "BUY YES " : "SELL YES";
  const sett = (r.settlement || "?").replace("eod-digital", "EOD").replace("barrier-max", "MAX").replace("barrier-min", "MIN");
  return `  ${dir} ${r.venue.padEnd(10)} ${sett.padEnd(3)} ${r.asset} ${r.op.padEnd(5)} ${strikeStr(r).padStart(17)} in ${dte.padStart(6)}  mkt=${(r.market_p*100).toFixed(1).padStart(4)}%  model=${(r.model_p*100).toFixed(1).padStart(4)}%  edge=${(r.edge*100>=0?"+":"")}${(r.edge*100).toFixed(1)}pp  v24=$${(r.v24||0).toLocaleString()}`;
}

console.log("\n=== top 10 BUY-YES edges (model > market) ===");
longs.forEach(r => console.log(fmt(r)));
console.log("\n=== top 10 SELL-YES edges (market > model) ===");
shorts.forEach(r => console.log(fmt(r)));

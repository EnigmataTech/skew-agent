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

console.log("\n[edges] rebuilding mispricings…");
const r = rebuildMispricings();
console.log(`  evaluated=${r.evaluated}  written=${r.written}`);

// Filters:
//  - Polymarket only for now — questions are consistently EOD digital
//    ("above $X on date Y"). Kalshi has mixed settlement types
//    (touch barriers, intraday, daily, yearly) that need per-series tagging
//    before they're safe to price with the European digital model.
//    Kalshi support → D4.
//  - require >= 2d maturity (spot-latency below this dominates the edge)
//  - liquidity OR volume threshold
//  - stay away from the boundaries where digital pricing is flaky
const filt = `
  m.venue = 'polymarket'
  AND (liquidity > 1000 OR volume_24h > 5000)
  AND expiry_unix - captured_at BETWEEN (2 * 86400) AND (90 * 86400)
  AND model_p BETWEEN 0.05 AND 0.95
  AND market_p BETWEEN 0.05 AND 0.95
`;

const longs = db().query(`
  SELECT m.venue, mp.asset, mp.op, mp.strike, mp.expiry_unix,
         ROUND(mp.market_p,3) AS market_p, ROUND(mp.model_p,3) AS model_p,
         ROUND(mp.edge,3) AS edge, ROUND(mp.liquidity,0) AS liq, ROUND(mp.volume_24h,0) AS v24,
         m.question
  FROM mispricings mp
  JOIN markets m ON m.id = mp.market_id
  WHERE ${filt}
  ORDER BY mp.edge DESC LIMIT 10
`).all() as any[];

const shorts = db().query(`
  SELECT m.venue, mp.asset, mp.op, mp.strike, mp.expiry_unix,
         ROUND(mp.market_p,3) AS market_p, ROUND(mp.model_p,3) AS model_p,
         ROUND(mp.edge,3) AS edge, ROUND(mp.liquidity,0) AS liq, ROUND(mp.volume_24h,0) AS v24,
         m.question
  FROM mispricings mp
  JOIN markets m ON m.id = mp.market_id
  WHERE ${filt}
  ORDER BY mp.edge ASC LIMIT 10
`).all() as any[];

function fmt(r: any) {
  const dte = ((r.expiry_unix - Math.floor(Date.now() / 1000)) / 86400).toFixed(1) + "d";
  const dir = r.edge > 0 ? "BUY YES" : "SELL YES";
  return `  ${dir}  ${r.venue.padEnd(10)} ${r.asset} ${r.op} $${r.strike.toLocaleString().padStart(8)} in ${dte.padStart(6)}  mkt=${(r.market_p*100).toFixed(1).padStart(4)}%  model=${(r.model_p*100).toFixed(1).padStart(4)}%  edge=${(r.edge*100>=0?"+":"")}${(r.edge*100).toFixed(1)}pp  v24=$${r.v24||0}`;
}

console.log("\n=== top 10 BUY-YES edges (model > market) ===");
longs.forEach(r => console.log(fmt(r)));
console.log("\n=== top 10 SELL-YES edges (market > model) ===");
shorts.forEach(r => console.log(fmt(r)));

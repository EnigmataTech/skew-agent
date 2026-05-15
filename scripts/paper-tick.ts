// One-shot: refresh edges, book new paper trades from top edges, resolve
// any that expired. Print summary.
import { fetchSpot, fetchDailyCloses, rebuildMispricings } from "../packages/edge/src/index";
import { bookTradesFromTopEdges, resolveExpiredTrades, paperSummary } from "../packages/agent/src/index";
import { db } from "@rfb2/shared";

console.log("[tick] refreshing spot + closes…");
await fetchSpot();
await fetchDailyCloses("BTC", 7);
await fetchDailyCloses("ETH", 7);

console.log("[tick] rebuilding mispricings…");
db().exec(`DELETE FROM mispricings`);
const r = rebuildMispricings();
console.log(`  evaluated=${r.evaluated} written=${r.written}`);

console.log("[tick] resolving expired trades…");
const res = resolveExpiredTrades();
console.log(`  resolved=${res.resolved} voided=${res.voided}`);

console.log("[tick] booking new top-edge trades…");
const bk = bookTradesFromTopEdges({ edgeThreshold: 0.05, sizeUsdc: 100, maxOpen: 20 });
console.log(`  booked=${bk.booked} examined=${bk.examined ?? 0} pre-open=${bk.openCount}`);

const s = paperSummary();
console.log("\n=== paper-trade summary ===");
console.log(`  OPEN:     ${(s.open as any).n} positions  notional=$${(s.open as any).notional}`);
console.log(`  SETTLED:  ${(s.settled as any).n} positions  wins=${(s.settled as any).wins}  pnl=$${(s.settled as any).pnl ?? 0}`);
if ((s.byKind as any[]).length) {
  console.log("  By settlement type:");
  for (const r of s.byKind as any[]) {
    console.log(`    ${r.settlement.padEnd(12)} n=${r.n}  wins=${r.wins}  pnl=$${r.pnl}`);
  }
}

console.log("\n=== currently-open positions (top 10 by edge) ===");
const open = db().query(`
  SELECT side, asset, op, strike, strike_upper, expiry_unix, settlement,
         ROUND(entry_market_p,3) AS mkt, ROUND(entry_model_p,3) AS model,
         ROUND(entry_edge,3) AS edge, entered_at
  FROM paper_trades WHERE status='open' ORDER BY ABS(entry_edge) DESC LIMIT 10
`).all() as any[];
for (const t of open) {
  const dte = ((t.expiry_unix - Math.floor(Date.now()/1000))/86400).toFixed(1);
  const k = t.strike_upper ? `$${Math.round(t.strike).toLocaleString()}-${Math.round(t.strike_upper).toLocaleString()}` : `$${t.strike.toLocaleString()}`;
  console.log(`  ${t.side.toUpperCase().padEnd(3)} ${t.settlement.padEnd(11)} ${t.asset} ${t.op.padEnd(5)} ${k.padStart(17)} in ${dte.padStart(5)}d  mkt=${(t.mkt*100).toFixed(1)}%  model=${(t.model*100).toFixed(1)}%  edge=${(t.edge*100>=0?"+":"")}${(t.edge*100).toFixed(1)}pp`);
}

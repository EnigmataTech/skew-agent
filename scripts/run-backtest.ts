// Pull 365d of BTC + ETH history then run the walk-forward calibration.
import { fetchDailyCloses, runCalibration } from "../packages/edge/src/index";
import { db } from "@rfb2/shared";

console.log("[backtest] fetching 365d daily closes…");
await fetchDailyCloses("BTC", 365);
await fetchDailyCloses("ETH", 365);

const btcN = db().query<{ n: number }, []>("SELECT COUNT(*) n FROM daily_closes WHERE asset='BTC'").get()!.n;
const ethN = db().query<{ n: number }, []>("SELECT COUNT(*) n FROM daily_closes WHERE asset='ETH'").get()!.n;
console.log(`  BTC: ${btcN} closes  ETH: ${ethN} closes`);

for (const asset of ["BTC", "ETH"] as const) {
  console.log(`\n=== ${asset} calibration ===`);
  const r = runCalibration(asset);
  console.log(`  history=${r.historyDays}d`);
  for (const [kind, stats] of Object.entries(r.perKind)) {
    const s = stats as { n: number; brier: number; buckets: { lo: number; hi: number; n: number; yes: number; rate: number; avgPred: number }[] };
    console.log(`\n  --- ${kind}  (n=${s.n}, brier=${s.brier.toFixed(4)}) ---`);
    console.log(`    bucket    n     yes   actual  predicted  reliability`);
    for (const b of s.buckets) {
      if (b.n === 0) continue;
      const diff = b.rate - b.avgPred;
      const flag = Math.abs(diff) > 0.10 ? "⚠" : Math.abs(diff) > 0.05 ? "·" : " ";
      console.log(`    [${b.lo.toFixed(2)},${b.hi.toFixed(2)})  ${String(b.n).padStart(4)}  ${String(b.yes).padStart(4)}  ${(b.rate*100).toFixed(1).padStart(5)}%  ${(b.avgPred*100).toFixed(1).padStart(5)}%   ${(diff>=0?"+":"")}${(diff*100).toFixed(1)}pp ${flag}`);
    }
  }
}

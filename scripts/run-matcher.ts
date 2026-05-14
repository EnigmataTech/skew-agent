import { rebuildMatches } from "../packages/edge/src/match";
import { db } from "@rfb2/shared";

const stats = rebuildMatches();
console.log("Matcher stats:", stats);

const sample = db().query(`
  SELECT
    p.question AS poly_q,
    k.question AS kalshi_q,
    sp.implied_prob AS poly_p,
    sk.implied_prob AS kalshi_p,
    ABS(sp.implied_prob - sk.implied_prob) AS spread,
    cvm.rationale
  FROM cross_venue_matches cvm
  JOIN markets p ON p.id = cvm.poly_market_id
  JOIN markets k ON k.id = cvm.kalshi_market_id
  JOIN snapshots sp ON sp.market_id = p.id AND sp.outcome='yes'
  JOIN snapshots sk ON sk.market_id = k.id AND sk.outcome='yes'
  WHERE sp.captured_at = (SELECT MAX(captured_at) FROM snapshots WHERE market_id = p.id)
    AND sk.captured_at = (SELECT MAX(captured_at) FROM snapshots WHERE market_id = k.id)
  ORDER BY spread DESC
  LIMIT 15
`).all();

console.log("\n=== top 15 cross-venue disagreements ===");
for (const r of sample as any[]) {
  console.log(
    `  ${r.rationale.padEnd(40)}  Poly ${(r.poly_p * 100).toFixed(1).padStart(5)}%  Kalshi ${(r.kalshi_p * 100).toFixed(1).padStart(5)}%  Δ ${(r.spread * 100).toFixed(1)}pp`,
  );
}

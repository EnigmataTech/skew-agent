// One-shot to populate the new settlement column on rows ingested before D4.
import { db } from "@rfb2/shared";
import { kalshiSettlement } from "@rfb2/edge";

const conn = db();
const rows = conn.query<{ id: string; venue: string; venue_id: string }, []>(
  `SELECT id, venue, venue_id FROM markets WHERE settlement IS NULL`
).all();

const upd = conn.prepare(`UPDATE markets SET settlement = ? WHERE id = ?`);
let n = 0;
const tx = conn.transaction(() => {
  for (const r of rows) {
    const s = r.venue === "polymarket" ? "eod-digital" : kalshiSettlement(r.venue_id);
    upd.run(s, r.id);
    n++;
  }
});
tx();

console.log(`backfilled ${n} rows`);
const dist = conn.query(`
  SELECT venue, settlement, COUNT(*) n
  FROM markets WHERE category IN ('btc-price','eth-price')
  GROUP BY venue, settlement ORDER BY n DESC
`).all();
console.table(dist);

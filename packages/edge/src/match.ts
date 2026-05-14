import { db, now } from "@rfb2/shared";
import { parsePolymarket, parseKalshi, type CanonicalStrike } from "./parse";

// Tolerances for considering two markets "the same bet".
const STRIKE_REL_TOL = 0.002;       // 0.2% (e.g. $80k ± $160)
const STRIKE_ABS_TOL_USD = 100;     // absolute $100 fallback for tight strikes
const EXPIRY_TOL_S = 24 * 3600;     // ±24h on expiry

function strikesMatch(a: number, b: number): boolean {
  const rel = Math.abs(a - b) / Math.max(a, b);
  return rel <= STRIKE_REL_TOL || Math.abs(a - b) <= STRIKE_ABS_TOL_USD;
}

function expiryMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= EXPIRY_TOL_S;
}

function canonMatch(a: CanonicalStrike, b: CanonicalStrike): number {
  if (a.asset !== b.asset) return 0;
  if (a.op !== b.op) return 0;
  if (!expiryMatch(a.expiryUnix, b.expiryUnix)) return 0;
  if (a.op === "range") {
    if (!b.strikeUpper || !a.strikeUpper) return 0;
    return strikesMatch(a.strike, b.strike) && strikesMatch(a.strikeUpper, b.strikeUpper) ? 1 : 0;
  }
  return strikesMatch(a.strike, b.strike) ? 1 : 0;
}

export function rebuildMatches() {
  const conn = db();
  const ts = now();

  type Row = { id: string; venue: string; question: string; closes_at: number | null; raw_json: string };
  const polys = conn.query<Row, []>(`
    SELECT id, venue, question, closes_at, raw_json
    FROM markets WHERE venue='polymarket' AND category IN ('btc-price','eth-price') AND resolved=0
  `).all();
  const kals = conn.query<Row, []>(`
    SELECT id, venue, question, closes_at, raw_json
    FROM markets WHERE venue='kalshi' AND category IN ('btc-price','eth-price') AND resolved=0
  `).all();

  // Parse both into canonical strikes (skip ones we can't parse).
  const polyParsed = polys
    .map(r => ({ row: r, c: parsePolymarket(r.question, r.closes_at) }))
    .filter((x): x is { row: Row; c: CanonicalStrike } => x.c !== null);
  const kalParsed = kals
    .map(r => ({ row: r, c: parseKalshi(JSON.parse(r.raw_json)) }))
    .filter((x): x is { row: Row; c: CanonicalStrike } => x.c !== null);

  // Bucket Kalshi by (asset, op, expiryDay) for O(P + K) instead of O(P*K).
  const bucket = new Map<string, typeof kalParsed>();
  const keyOf = (c: CanonicalStrike, dayOffset: number) =>
    `${c.asset}|${c.op}|${Math.floor((c.expiryUnix + dayOffset) / 86400)}`;
  for (const k of kalParsed) {
    const key = keyOf(k.c, 0);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key)!.push(k);
  }

  const insert = conn.prepare(`
    INSERT OR REPLACE INTO cross_venue_matches
      (poly_market_id, kalshi_market_id, confidence, judged_at, rationale)
    VALUES (?, ?, ?, ?, ?)
  `);

  let matches = 0;
  const tx = conn.transaction(() => {
    for (const p of polyParsed) {
      // check same day and ±1 day buckets for expiry tolerance
      for (const off of [-86400, 0, 86400]) {
        const candidates = bucket.get(keyOf(p.c, off));
        if (!candidates) continue;
        for (const k of candidates) {
          const score = canonMatch(p.c, k.c);
          if (score > 0) {
            insert.run(
              p.row.id,
              k.row.id,
              score,
              ts,
              `${p.c.asset} ${p.c.op} $${p.c.strike} @${new Date(p.c.expiryUnix * 1000).toISOString().slice(0, 10)}`,
            );
            matches++;
          }
        }
      }
    }
  });
  tx();

  return {
    polyParsed: polyParsed.length, polyTotal: polys.length,
    kalParsed: kalParsed.length, kalTotal: kals.length,
    matches,
  };
}

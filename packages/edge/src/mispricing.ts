import { db, now } from "@rfb2/shared";
import { parsePolymarket, parseKalshi, type CanonicalStrike } from "./parse";
import { latestSpot, realizedVol } from "./spot";
import { modelProb } from "./model";

function ensureTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS mispricings (
      market_id     TEXT NOT NULL,
      captured_at   INTEGER NOT NULL,
      asset         TEXT NOT NULL,
      op            TEXT NOT NULL,
      strike        REAL NOT NULL,
      strike_upper  REAL,
      expiry_unix   INTEGER NOT NULL,
      spot          REAL NOT NULL,
      sigma         REAL NOT NULL,
      model_p       REAL NOT NULL,
      market_p      REAL NOT NULL,
      edge          REAL NOT NULL,         -- model_p - market_p
      liquidity     REAL,
      volume_24h    REAL,
      PRIMARY KEY (market_id, captured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_mispricings_edge ON mispricings(captured_at DESC, edge);
  `);
}

export interface ScoredMispricing {
  marketId: string;
  asset: "BTC" | "ETH";
  edge: number;
  modelP: number;
  marketP: number;
  liquidity: number | null;
  volume24h: number | null;
  c: CanonicalStrike;
}

export function rebuildMispricings(): { evaluated: number; written: number; spots: Record<string, number>; sigmas: Record<string, number> } {
  ensureTable();
  const conn = db();
  const ts = now();

  const spots = { BTC: latestSpot("BTC"), ETH: latestSpot("ETH") };
  const sigmas = { BTC: realizedVol("BTC"), ETH: realizedVol("ETH") };
  if (!spots.BTC || !spots.ETH || !sigmas.BTC || !sigmas.ETH) {
    throw new Error("missing spot or vol; run feedSpotAndVol() first");
  }

  // Pull latest snapshot per market for tracked categories.
  type Row = { id: string; venue: string; question: string; closes_at: number | null; raw_json: string; market_p: number; volume_24h: number | null; liquidity: number | null };
  const rows = conn.query<Row, []>(`
    SELECT m.id, m.venue, m.question, m.closes_at, m.raw_json,
           s.implied_prob AS market_p, s.volume_24h, s.liquidity
    FROM markets m
    JOIN snapshots s ON s.market_id = m.id AND s.outcome = 'yes'
    WHERE m.category IN ('btc-price','eth-price')
      AND m.resolved = 0
      AND s.captured_at = (SELECT MAX(captured_at) FROM snapshots WHERE market_id = m.id)
  `).all();

  const insert = conn.prepare(`
    INSERT OR REPLACE INTO mispricings
      (market_id, captured_at, asset, op, strike, strike_upper, expiry_unix,
       spot, sigma, model_p, market_p, edge, liquidity, volume_24h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let evaluated = 0, written = 0;
  const tx = conn.transaction(() => {
    for (const r of rows) {
      const c = r.venue === "polymarket"
        ? parsePolymarket(r.question, r.closes_at)
        : parseKalshi(JSON.parse(r.raw_json));
      if (!c) continue;
      evaluated++;
      if (c.expiryUnix <= ts) continue;
      const spot = spots[c.asset]!;
      const sigma = sigmas[c.asset]!;
      const modelP = modelProb(c, { spot, sigmaAnnual: sigma, nowUnix: ts });
      const edge = modelP - r.market_p;
      insert.run(
        r.id, ts, c.asset, c.op, c.strike, c.strikeUpper ?? null, c.expiryUnix,
        spot, sigma, modelP, r.market_p, edge,
        r.liquidity, r.volume_24h,
      );
      written++;
    }
  });
  tx();
  return { evaluated, written, spots: spots as any, sigmas: sigmas as any };
}

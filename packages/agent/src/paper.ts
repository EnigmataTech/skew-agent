// Paper-trading ledger. Books synthetic trades from the top corrected
// edges, marks them to market, and resolves them at expiry against the
// realized spot.
//
// Each booked trade represents a $100-notional bet at the market's
// quoted yes-side price. PnL convention (per $1 notional):
//   side='yes':  if resolved yes → +(1 - entry_market_p), else -entry_market_p
//   side='no':   if resolved no  → +entry_market_p,       else -(1 - entry_market_p)
// (Ignores Polymarket/Kalshi fees; this is signal-quality evaluation,
// not execution simulation.)
import { db, now } from "@rfb2/shared";
import { latestSpot } from "@rfb2/edge";

export interface BookOptions {
  edgeThreshold: number;    // |edge| min to consider, e.g. 0.04
  sizeUsdc: number;         // notional per trade
  maxOpen: number;          // cap concurrent open positions
  minLiquidity: number;
  minVolume24h: number;
  minDte: number;           // seconds
  maxDte: number;
}

const DEFAULTS: BookOptions = {
  edgeThreshold: 0.04,
  sizeUsdc: 100,
  maxOpen: 20,
  minLiquidity: 1000,
  minVolume24h: 1000,
  minDte: 2 * 86400,
  maxDte: 60 * 86400,
};

function ensureTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      trade_id      TEXT PRIMARY KEY,
      market_id     TEXT NOT NULL,
      asset         TEXT NOT NULL,
      side          TEXT NOT NULL,    -- 'yes' | 'no'
      op            TEXT NOT NULL,
      strike        REAL NOT NULL,
      strike_upper  REAL,
      expiry_unix   INTEGER NOT NULL,
      settlement    TEXT NOT NULL,
      entered_at    INTEGER NOT NULL,
      entry_market_p REAL NOT NULL,
      entry_model_p  REAL NOT NULL,
      entry_edge    REAL NOT NULL,
      size_usdc     REAL NOT NULL,
      status        TEXT NOT NULL,    -- 'open' | 'resolved' | 'voided'
      resolved_at   INTEGER,
      resolved_outcome TEXT,           -- 'yes' | 'no' | 'void'
      pnl_usdc      REAL,
      settle_spot   REAL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_status ON paper_trades(status, expiry_unix);
  `);
}

export function bookTradesFromTopEdges(opts: Partial<BookOptions> = {}) {
  ensureTable();
  const o = { ...DEFAULTS, ...opts };
  const conn = db();
  const ts = now();

  const openCount = conn.query<{ n: number }, []>(
    `SELECT COUNT(*) n FROM paper_trades WHERE status='open'`
  ).get()!.n;
  const room = o.maxOpen - openCount;
  if (room <= 0) return { booked: 0, openCount };

  // Latest mispricings only; skip markets already booked.
  const candidates = conn.query<any, any[]>(`
    WITH latest AS (
      SELECT * FROM mispricings WHERE captured_at = (SELECT MAX(captured_at) FROM mispricings)
    )
    SELECT mp.*, m.venue
    FROM latest mp
    JOIN markets m ON m.id = mp.market_id
    WHERE ABS(mp.edge) >= ?
      AND (COALESCE(mp.liquidity,0) >= ? OR COALESCE(mp.volume_24h,0) >= ?)
      AND (mp.expiry_unix - mp.captured_at) BETWEEN ? AND ?
      AND mp.market_p BETWEEN 0.05 AND 0.95
      AND mp.model_p  BETWEEN 0.02 AND 0.98
      AND NOT EXISTS (SELECT 1 FROM paper_trades pt WHERE pt.market_id = mp.market_id AND pt.status = 'open')
    ORDER BY ABS(mp.edge) DESC
  `).all(o.edgeThreshold, o.minLiquidity, o.minVolume24h, o.minDte, o.maxDte) as any[];

  const ins = conn.prepare(`
    INSERT INTO paper_trades
      (trade_id, market_id, asset, side, op, strike, strike_upper, expiry_unix,
       settlement, entered_at, entry_market_p, entry_model_p, entry_edge,
       size_usdc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `);

  // Avoid booking multiple positions on the same canonical bet.
  const seenCanonical = new Set<string>();
  let booked = 0;
  const tx = conn.transaction(() => {
    for (const c of candidates) {
      if (booked >= room) break;
      const canonKey = `${c.asset}|${c.op}|${Math.round(c.strike)}|${Math.round(c.strike_upper ?? 0)}|${Math.floor(c.expiry_unix / 3600)}`;
      if (seenCanonical.has(canonKey)) continue;
      seenCanonical.add(canonKey);

      const side: "yes" | "no" = c.edge >= 0 ? "yes" : "no";
      const tradeId = `pt-${ts}-${booked}-${c.market_id}`;
      ins.run(
        tradeId, c.market_id, c.asset, side, c.op, c.strike, c.strike_upper, c.expiry_unix,
        c.settlement, ts, c.market_p, c.model_p, c.edge, o.sizeUsdc,
      );
      booked++;
    }
  });
  tx();
  return { booked, openCount, examined: candidates.length };
}

// Look up the actual spot at (or near) expiry. We use the daily close on
// that UTC day from our prices history if available, falling back to the
// most recent spot snapshot.
function spotAtExpiry(asset: "BTC" | "ETH", expiryUnix: number): number | null {
  const day = new Date(expiryUnix * 1000).toISOString().slice(0, 10);
  const dc = db().query<{ close_usd: number }, [string, string]>(
    `SELECT close_usd FROM daily_closes WHERE asset=? AND day=? LIMIT 1`
  ).get(asset, day);
  if (dc) return dc.close_usd;
  return latestSpot(asset);
}

function settlesYes(
  spotAtT: number,
  op: "gte" | "lte" | "range",
  strike: number,
  strikeUpper: number | null,
): boolean {
  if (op === "gte")   return spotAtT >= strike;
  if (op === "lte")   return spotAtT <= strike;
  /* range */         return strikeUpper != null && spotAtT >= strike && spotAtT < strikeUpper;
}

function pnlFor(side: "yes" | "no", entryP: number, outcomeYes: boolean, size: number): number {
  // Cost basis: buying YES costs entryP, buying NO costs (1-entryP). Payout is $1 if your side wins.
  if (side === "yes") return outcomeYes ? size * (1 - entryP) : -size * entryP;
  return outcomeYes ? -size * (1 - entryP) : size * entryP;
}

export function resolveExpiredTrades() {
  ensureTable();
  const conn = db();
  const ts = now();
  const open = conn.query<any, [number]>(
    `SELECT * FROM paper_trades WHERE status='open' AND expiry_unix <= ?`
  ).all(ts);

  const upd = conn.prepare(`
    UPDATE paper_trades SET
      status = ?, resolved_at = ?, resolved_outcome = ?, pnl_usdc = ?, settle_spot = ?
    WHERE trade_id = ?
  `);

  let resolved = 0, voided = 0;
  const tx = conn.transaction(() => {
    for (const t of open) {
      const spot = spotAtExpiry(t.asset, t.expiry_unix);
      if (spot == null) { upd.run("voided", ts, "void", 0, null, t.trade_id); voided++; continue; }
      const yes = settlesYes(spot, t.op, t.strike, t.strike_upper);
      const pnl = pnlFor(t.side, t.entry_market_p, yes, t.size_usdc);
      upd.run("resolved", ts, yes ? "yes" : "no", pnl, spot, t.trade_id);
      resolved++;
    }
  });
  tx();
  return { resolved, voided };
}

export function paperSummary() {
  ensureTable();
  const conn = db();
  const open = conn.query<any, []>(`SELECT COUNT(*) n, COALESCE(SUM(size_usdc),0) notional FROM paper_trades WHERE status='open'`).get();
  const settled = conn.query<any, []>(`
    SELECT COUNT(*) n,
           SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END) wins,
           SUM(pnl_usdc) pnl,
           SUM(size_usdc) notional
    FROM paper_trades WHERE status='resolved'
  `).get();
  const byKind = conn.query(`
    SELECT settlement, COUNT(*) n,
           SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END) wins,
           ROUND(SUM(pnl_usdc),2) pnl
    FROM paper_trades WHERE status='resolved' GROUP BY settlement
  `).all();
  return { open, settled, byKind };
}

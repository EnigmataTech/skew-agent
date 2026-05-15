// Persists per-asset per-bet-kind reliability data from the backtest and
// applies linear-interpolation corrections to live model predictions.
//
// The raw log-normal model is biased differently across assets and
// settlement types (see D5 backtest). We learned ETH EOD is calibrated,
// BTC EOD under-predicts the mid-range, and barriers systematically
// over-predict touches. Rather than pretend the raw probability is the
// truth, we map it through the empirical reliability curve.
import { db } from "@rfb2/shared";

export type CalibKind = "eod-gte" | "eod-lte" | "max-gte" | "min-lte";

interface Bucket { lo: number; hi: number; n: number; rate: number; avgPred: number }

function ensureTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS calibration (
      asset       TEXT NOT NULL,
      kind        TEXT NOT NULL,
      bucket_lo   REAL NOT NULL,
      bucket_hi   REAL NOT NULL,
      n           INTEGER NOT NULL,
      avg_pred    REAL NOT NULL,
      actual_rate REAL NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (asset, kind, bucket_lo, bucket_hi)
    );
  `);
}

export function persistCalibration(
  asset: "BTC" | "ETH",
  perKind: Record<string, { n: number; buckets: Bucket[] }>,
) {
  ensureTable();
  const conn = db();
  const ts = Math.floor(Date.now() / 1000);
  const ins = conn.prepare(`
    INSERT OR REPLACE INTO calibration
      (asset, kind, bucket_lo, bucket_hi, n, avg_pred, actual_rate, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const del = conn.prepare(`DELETE FROM calibration WHERE asset=? AND kind=?`);
  const tx = conn.transaction(() => {
    for (const [kind, stats] of Object.entries(perKind)) {
      del.run(asset, kind);
      for (const b of stats.buckets) {
        if (b.n === 0) continue;
        ins.run(asset, kind, b.lo, b.hi, b.n, b.avgPred, b.rate, ts);
      }
    }
  });
  tx();
}

interface Point { avgPred: number; actual: number; n: number }
const cache = new Map<string, Point[]>();

function loadPoints(asset: "BTC" | "ETH", kind: CalibKind): Point[] {
  const key = `${asset}|${kind}`;
  const c = cache.get(key);
  if (c) return c;
  ensureTable();
  const rows = db().query<Point, [string, string]>(
    `SELECT avg_pred AS avgPred, actual_rate AS actual, n
     FROM calibration WHERE asset=? AND kind=? AND n >= 50
     ORDER BY avg_pred ASC`
  ).all(asset, kind);
  cache.set(key, rows);
  return rows;
}

export function clearCalibCache() { cache.clear(); }

// Map a raw model probability to the empirically-calibrated probability via
// piecewise-linear interpolation between bucket midpoints. Anchors at 0
// and 1 are appended so the interpolation has well-defined endpoints.
export function correctedProb(rawP: number, asset: "BTC" | "ETH", kind: CalibKind): number {
  const pts = loadPoints(asset, kind);
  if (pts.length === 0) return rawP; // no calibration data yet → pass through
  const knots = [{ avgPred: 0, actual: 0 }, ...pts, { avgPred: 1, actual: 1 }];
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1]!;
    const b = knots[i]!;
    if (rawP <= b.avgPred) {
      const t = (rawP - a.avgPred) / Math.max(1e-9, b.avgPred - a.avgPred);
      const y = a.actual + t * (b.actual - a.actual);
      return Math.max(0.001, Math.min(0.999, y));
    }
  }
  return rawP;
}

export function calibKindFor(op: "gte" | "lte" | "range", settlement: string): CalibKind | null {
  if (op === "gte" && settlement === "eod-digital")  return "eod-gte";
  if (op === "lte" && settlement === "eod-digital")  return "eod-lte";
  if (op === "gte" && settlement === "barrier-max")  return "max-gte";
  if (op === "lte" && settlement === "barrier-min")  return "min-lte";
  return null; // ranges and unknowns pass through raw
}

// Walk-forward calibration backtest for the log-normal pricer.
//
// Question: when our model says P(S_T >= K) = p, does that bet actually
// resolve YES at rate ~p over historical data? A model that's well-
// calibrated *is itself the edge story*: any systematic gap between
// market quotes and our predictions is real mispricing, not model error.
//
// Method: walk-forward. At each historical day t:
//   1. Estimate sigma from the trailing 30d of closes (same way live does)
//   2. For each forward horizon T in {2, 7, 14, 30}d and each strike
//      ratio r in {0.95, 0.98, 1.0, 1.02, 1.05}, generate a synthetic
//      market: strike = spot_t * r, expiry = t + T.
//   3. Compute model_p ex-ante (using only data <= t).
//   4. Observe actual outcome from history: for EOD-digital,
//      did spot_{t+T} cross the strike? For barrier-max,
//      did max(spot over [t, t+T]) cross? For barrier-min, did min cross?
//   5. Bucket by predicted p, count YES vs total per bucket.
import { db } from "@rfb2/shared";
import { probGte, probLte, probMaxGte, probMinLte } from "./model";

type Asset = "BTC" | "ETH";
type BetKind = "eod-gte" | "eod-lte" | "max-gte" | "min-lte";

interface Sample {
  predictedP: number;
  resolvedYes: 0 | 1;
}

const HORIZONS_DAYS = [2, 7, 14, 30];
const STRIKE_RATIOS = [0.90, 0.95, 0.98, 1.00, 1.02, 1.05, 1.10];
const VOL_WINDOW = 30;     // days
const MIN_HISTORY = 60;    // days before we'll start sampling
const BUCKETS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.01];

function loadCloses(asset: Asset): { day: string; close: number }[] {
  return db().query<{ day: string; close: number }, [string]>(
    `SELECT day, close_usd AS close FROM daily_closes WHERE asset=? ORDER BY day ASC`
  ).all(asset).map(r => ({ day: r.day, close: r.close }));
}

function realizedVolWindow(closes: number[], end: number, window: number): number | null {
  const start = end - window;
  if (start < 1) return null;
  const rets: number[] = [];
  for (let i = start; i < end; i++) {
    rets.push(Math.log(closes[i]! / closes[i - 1]!));
  }
  if (rets.length < window / 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365);
}

function bucketize(samples: Sample[]) {
  const out: { lo: number; hi: number; n: number; yes: number; rate: number; avgPred: number }[] = [];
  for (let i = 0; i < BUCKETS.length - 1; i++) {
    const lo = BUCKETS[i]!;
    const hi = BUCKETS[i + 1]!;
    const inB = samples.filter(s => s.predictedP >= lo && s.predictedP < hi);
    const yes = inB.reduce((a, s) => a + s.resolvedYes, 0);
    const avgPred = inB.length ? inB.reduce((a, s) => a + s.predictedP, 0) / inB.length : 0;
    out.push({ lo, hi, n: inB.length, yes, rate: inB.length ? yes / inB.length : 0, avgPred });
  }
  return out;
}

function brierScore(samples: Sample[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((a, s) => a + (s.predictedP - s.resolvedYes) ** 2, 0) / samples.length;
}

export function runCalibration(asset: Asset, kinds: BetKind[] = ["eod-gte", "eod-lte", "max-gte", "min-lte"]) {
  const series = loadCloses(asset);
  const closes = series.map(s => s.close);
  if (closes.length < MIN_HISTORY + Math.max(...HORIZONS_DAYS)) {
    throw new Error(`Not enough history for ${asset}: ${closes.length} closes`);
  }

  const samplesByKind = new Map<BetKind, Sample[]>(kinds.map(k => [k, []]));

  for (let t = MIN_HISTORY; t < closes.length; t++) {
    const sigma = realizedVolWindow(closes, t, VOL_WINDOW);
    if (!sigma || sigma <= 0) continue;
    const spot = closes[t]!;

    for (const T of HORIZONS_DAYS) {
      const tExpiry = t + T;
      if (tExpiry >= closes.length) continue;
      const yearsT = T / 365;

      // Path observations needed for barriers
      let pathMax = -Infinity, pathMin = Infinity;
      for (let i = t + 1; i <= tExpiry; i++) {
        if (closes[i]! > pathMax) pathMax = closes[i]!;
        if (closes[i]! < pathMin) pathMin = closes[i]!;
      }
      const closeAtT = closes[tExpiry]!;

      for (const ratio of STRIKE_RATIOS) {
        const strike = spot * ratio;

        if (kinds.includes("eod-gte")) {
          const p = probGte(spot, strike, sigma, yearsT);
          const yes = closeAtT >= strike ? 1 : 0;
          samplesByKind.get("eod-gte")!.push({ predictedP: p, resolvedYes: yes });
        }
        if (kinds.includes("eod-lte")) {
          const p = probLte(spot, strike, sigma, yearsT);
          const yes = closeAtT <= strike ? 1 : 0;
          samplesByKind.get("eod-lte")!.push({ predictedP: p, resolvedYes: yes });
        }
        if (kinds.includes("max-gte")) {
          const p = probMaxGte(spot, strike, sigma, yearsT);
          const yes = pathMax >= strike ? 1 : 0;
          samplesByKind.get("max-gte")!.push({ predictedP: p, resolvedYes: yes });
        }
        if (kinds.includes("min-lte")) {
          const p = probMinLte(spot, strike, sigma, yearsT);
          const yes = pathMin <= strike ? 1 : 0;
          samplesByKind.get("min-lte")!.push({ predictedP: p, resolvedYes: yes });
        }
      }
    }
  }

  return {
    asset,
    historyDays: closes.length,
    perKind: Object.fromEntries(
      [...samplesByKind].map(([k, s]) => [k, {
        n: s.length,
        brier: brierScore(s),
        buckets: bucketize(s),
      }])
    ),
  };
}

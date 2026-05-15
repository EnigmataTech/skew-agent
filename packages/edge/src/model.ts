// Closed-form binary-option pricing under log-normal dynamics.
// Risk-neutral drift r is approximated as 0 here — crypto perp funding is
// noisy and short-dated digital pricing is dominated by σ√t anyway.
import type { CanonicalStrike } from "./parse";

// Abramowitz & Stegun 26.2.17 approximation. Accurate to ~7.5e-8.
function erf(x: number): number {
  const sign = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export interface PriceInputs {
  spot: number;             // S_0
  sigmaAnnual: number;      // annualized vol
  nowUnix: number;
}

// Probability the spot ends >= strike at expiry.
export function probGte(spot: number, strike: number, sigmaAnnual: number, yearsToExpiry: number): number {
  if (yearsToExpiry <= 0) return spot >= strike ? 1 : 0;
  if (sigmaAnnual <= 0) return spot >= strike ? 1 : 0;
  const sqrtT = Math.sqrt(yearsToExpiry);
  const d2 = (Math.log(spot / strike) - 0.5 * sigmaAnnual ** 2 * yearsToExpiry) / (sigmaAnnual * sqrtT);
  return normCdf(d2);
}

export function probLte(spot: number, strike: number, sigmaAnnual: number, yearsToExpiry: number): number {
  return 1 - probGte(spot, strike, sigmaAnnual, yearsToExpiry);
}

export function probRange(spot: number, lo: number, hi: number, sigmaAnnual: number, yearsToExpiry: number): number {
  return probGte(spot, lo, sigmaAnnual, yearsToExpiry) - probGte(spot, hi, sigmaAnnual, yearsToExpiry);
}

// Reflection-principle barrier price under GBM with zero drift.
// P(max_{0≤t≤T} S_t ≥ K). Closed form (Reiner-Rubinstein, simplified to r=0):
//   if S_0 ≥ K: barrier already touched → 1
//   else: 2 * Φ(-d) where d = ln(K/S_0) / (σ√T) + 0.5σ√T  (using μ = 0)
// Derivation: P(τ_K ≤ T) = 2 * P(W_T ≥ b) for Brownian motion with drift adjustment.
export function probMaxGte(spot: number, strike: number, sigmaAnnual: number, yearsToExpiry: number): number {
  if (yearsToExpiry <= 0) return spot >= strike ? 1 : 0;
  if (sigmaAnnual <= 0) return spot >= strike ? 1 : 0;
  if (spot >= strike) return 1;
  const sqrtT = Math.sqrt(yearsToExpiry);
  const sigSqrtT = sigmaAnnual * sqrtT;
  // Under risk-neutral GBM with r=0: d = (ln(K/S_0) + 0.5σ²T) / (σ√T)
  const d = (Math.log(strike / spot) + 0.5 * sigmaAnnual ** 2 * yearsToExpiry) / sigSqrtT;
  return 2 * (1 - normCdf(d));
}

// P(min_{0≤t≤T} S_t ≤ K). Symmetric to max.
export function probMinLte(spot: number, strike: number, sigmaAnnual: number, yearsToExpiry: number): number {
  if (yearsToExpiry <= 0) return spot <= strike ? 1 : 0;
  if (sigmaAnnual <= 0) return spot <= strike ? 1 : 0;
  if (spot <= strike) return 1;
  const sqrtT = Math.sqrt(yearsToExpiry);
  const sigSqrtT = sigmaAnnual * sqrtT;
  const d = (Math.log(spot / strike) + 0.5 * sigmaAnnual ** 2 * yearsToExpiry) / sigSqrtT;
  return 2 * (1 - normCdf(d));
}

import type { SettlementType } from "./settlement";

export function modelProb(c: CanonicalStrike, inputs: PriceInputs, settlement: SettlementType = "eod-digital"): number {
  const yearsToExpiry = Math.max(0, (c.expiryUnix - inputs.nowUnix) / (365 * 24 * 3600));
  const { spot, sigmaAnnual } = inputs;

  if (settlement === "barrier-max") {
    // "Yes if price is ever ≥ K by T". We expect c.op === 'gte' or
    // sometimes 'lte' isn't meaningful for max barriers.
    if (c.op === "gte") return probMaxGte(spot, c.strike, sigmaAnnual, yearsToExpiry);
    return probGte(spot, c.strike, sigmaAnnual, yearsToExpiry);
  }
  if (settlement === "barrier-min") {
    if (c.op === "lte") return probMinLte(spot, c.strike, sigmaAnnual, yearsToExpiry);
    return probLte(spot, c.strike, sigmaAnnual, yearsToExpiry);
  }
  // eod-digital (default)
  switch (c.op) {
    case "gte": return probGte(spot, c.strike, sigmaAnnual, yearsToExpiry);
    case "lte": return probLte(spot, c.strike, sigmaAnnual, yearsToExpiry);
    case "range":
      if (c.strikeUpper === undefined) return 0;
      return probRange(spot, c.strike, c.strikeUpper, sigmaAnnual, yearsToExpiry);
  }
}

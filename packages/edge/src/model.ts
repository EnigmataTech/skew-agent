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

export function modelProb(c: CanonicalStrike, inputs: PriceInputs): number {
  const yearsToExpiry = Math.max(0, (c.expiryUnix - inputs.nowUnix) / (365 * 24 * 3600));
  switch (c.op) {
    case "gte": return probGte(inputs.spot, c.strike, inputs.sigmaAnnual, yearsToExpiry);
    case "lte": return probLte(inputs.spot, c.strike, inputs.sigmaAnnual, yearsToExpiry);
    case "range":
      if (c.strikeUpper === undefined) return 0;
      return probRange(inputs.spot, c.strike, c.strikeUpper, inputs.sigmaAnnual, yearsToExpiry);
  }
}

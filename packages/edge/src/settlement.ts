// Empirically-derived settlement-type classifier for Kalshi crypto series.
// Verified by sampling `rules_primary` from each series in our universe.
export type SettlementType =
  | "eod-digital"   // European binary: S_T vs K at fixed expiry. Our default model.
  | "barrier-max"   // 'price is ever above K by T' → reflection-principle pricer.
  | "barrier-min"   // 'price is ever below K by T' → reflection-principle pricer.
  | "intraday"      // <30min horizons; spot latency dominates — skip for now.
  | "comparison"    // asset-vs-asset performance — not price-vs-strike — skip.
  | "event"         // halving, satoshi-movement, etc. — not derivable from price.
  | "unknown";

// Map Kalshi series ticker prefix → settlement type.
const KALSHI_SERIES: Record<string, SettlementType> = {
  // EOD-digital: settle to BRTI average at fixed time
  KXBTC:    "eod-digital",   // "Bitcoin price range on May 14, 2026?" → 9 AM EDT close
  KXBTCD:   "eod-digital",   // "Bitcoin price on May 14, 2026?" → 9 AM EDT close
  KXETH:    "eod-digital",
  KXETHD:   "eod-digital",
  KXBTCY:   "eod-digital",   // yearly close at Jan 1
  KXETHY:   "eod-digital",

  // Intraday: 15-min interval markets — skip (spot latency dominates).
  KXBTC15M: "intraday",
  KXETH15M: "intraday",

  // Barrier-max: "if price is ever above K by T"
  KXBTCMAXMON: "barrier-max",
  KXBTCMAXY:   "barrier-max",
  KXETHMAXMON: "barrier-max",
  KXETHMAXY:   "barrier-max",
  KXBTCMAX100: "barrier-max",
  KXBTCMAX150: "barrier-max",
  KXBTC2026200: "barrier-max",
  KXBTC2026250: "barrier-max",

  // Barrier-min: "if price is ever below K by T"
  KXBTCMINMON: "barrier-min",
  KXBTCMINY:   "barrier-min",
  KXETHMINMON: "barrier-min",
  KXETHMINY:   "barrier-min",

  // Asset comparison — not a price-vs-strike bet
  KXBTCVSETH:   "comparison",
  KXBTCVSSOL:   "comparison",
  KXBTC75VS100: "comparison",

  // Non-price events
  KXBTCHALF:        "event",
  KXSATOSHIBTCYEAR: "event",
};

// Extract series prefix from a Kalshi market ticker (everything before first '-')
export function kalshiSeries(ticker: string): string {
  const i = ticker.indexOf("-");
  return i === -1 ? ticker : ticker.slice(0, i);
}

export function kalshiSettlement(ticker: string): SettlementType {
  return KALSHI_SERIES[kalshiSeries(ticker)] ?? "unknown";
}

// Polymarket binary markets are uniformly EOD-digital ("above $X on May 14")
// — they settle to UMA oracle reading the spot at the stated date.
export const POLYMARKET_SETTLEMENT: SettlementType = "eod-digital";

export { env } from "./env";
export { db, now } from "./db";

export type Venue = "polymarket" | "kalshi";

export interface MarketSnapshot {
  venue: Venue;
  marketId: string;
  question: string;
  category: string;
  outcome: "yes" | "no";
  impliedProb: number;
  bidProb: number | null;
  askProb: number | null;
  volume24h: number;
  liquidity: number;
  closesAt: number;
  capturedAt: number;
}

export interface Call {
  callId: string;
  venue: Venue;
  marketId: string;
  side: "yes" | "no";
  modelProb: number;
  marketProb: number;
  edgeBps: number;
  size: number;
  reasoning: string;
  publishedAt: number;
  attestationTx?: `0x${string}`;
}

export interface Resolution {
  callId: string;
  resolvedAs: "yes" | "no" | "void";
  resolvedAt: number;
  pnlBps: number;
}

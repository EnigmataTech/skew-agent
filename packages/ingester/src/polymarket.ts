import { db, now, env } from "@rfb2/shared";

const PAGE = 100;

interface PolyTag { slug: string; label: string }
interface PolyMarket {
  id: string;
  question: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  outcomes?: string;          // JSON-string array, e.g. '["Yes","No"]'
  outcomePrices?: string;     // JSON-string array, e.g. '["0.52","0.48"]'
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  spread?: number;
  volume24hr?: number;
  liquidityNum?: number;
  closed?: boolean;
  active?: boolean;
}
interface PolyEvent {
  id: string;
  title: string;
  tags?: PolyTag[];
  markets?: PolyMarket[];
  closed?: boolean;
  active?: boolean;
}

// Map title/question to one of our narrow categories. Null = crypto-tagged but
// out of scope for the model's initial focus (still stored, just flagged).
export function categorize(text: string): string | null {
  const t = text.toLowerCase();
  const isBtc = /\bbitcoin\b|\bbtc\b/.test(t);
  const isEth = /\bethereum\b|\beth\b/.test(t);
  const isPrice = /\bprice\b|\breach\b|\bhit\b|\babove\b|\bbelow\b|\$\s?\d|\bdip\b|\ball[- ]time high\b|\bath\b/.test(t);
  const isEtf = /\betf\b/.test(t) && /\b(flow|inflow|outflow|net|approval|approve|approved)\b/.test(t);
  if (isEtf) return "etf-flow";
  if (isBtc && isPrice) return "btc-price";
  if (isEth && isPrice) return "eth-price";
  return null;
}

function tryParseArr(s: string | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}

async function fetchPage(offset: number): Promise<PolyEvent[]> {
  const url = `${env.polymarket()}/events?active=true&closed=false&tag_slug=crypto&limit=${PAGE}&offset=${offset}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`polymarket ${res.status}: ${await res.text()}`);
  return res.json() as Promise<PolyEvent[]>;
}

export async function snapshotPolymarket() {
  const t0 = Date.now();
  const ts = now();
  const conn = db();

  const upsertMarket = conn.prepare(`
    INSERT INTO markets (id, venue, venue_id, question, category, closes_at, first_seen, last_seen, raw_json)
    VALUES (?, 'polymarket', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      question = excluded.question,
      category = excluded.category,
      closes_at = excluded.closes_at,
      last_seen = excluded.last_seen,
      raw_json = excluded.raw_json
  `);
  const insertSnap = conn.prepare(`
    INSERT OR REPLACE INTO snapshots
      (market_id, outcome, captured_at, implied_prob, bid_prob, ask_prob, volume_24h, liquidity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let offset = 0;
  let totalEvents = 0;
  let totalMarkets = 0;
  let inScope = 0;

  while (true) {
    const events = await fetchPage(offset);
    if (events.length === 0) break;
    totalEvents += events.length;

    const tx = conn.transaction(() => {
      for (const ev of events) {
        for (const mk of ev.markets ?? []) {
          if (mk.closed || mk.active === false) continue;
          totalMarkets++;

          const outcomes = tryParseArr(mk.outcomes);          // ["Yes","No"]
          const prices = tryParseArr(mk.outcomePrices).map(Number);
          if (outcomes.length !== prices.length || outcomes.length === 0) continue;

          const category = categorize(`${ev.title} ${mk.question}`);
          if (category) inScope++;

          const id = `polymarket:${mk.id}`;
          const closesAt = mk.endDate ? Math.floor(new Date(mk.endDate).getTime() / 1000) : null;
          upsertMarket.run(id, mk.id, mk.question, category, closesAt, ts, ts, JSON.stringify(mk));

          // For each outcome, write a snapshot row.
          for (let i = 0; i < outcomes.length; i++) {
            const outcome = outcomes[i]!.toLowerCase(); // "yes"/"no"
            const p = prices[i]!;
            if (!Number.isFinite(p)) continue;
            insertSnap.run(
              id,
              outcome,
              ts,
              p,
              outcome === "yes" ? (mk.bestBid ?? null) : null,
              outcome === "yes" ? (mk.bestAsk ?? null) : null,
              mk.volume24hr ?? null,
              mk.liquidityNum ?? null,
            );
          }
        }
      }
    });
    tx();

    if (events.length < PAGE) break;
    offset += PAGE;
  }

  const ms = Date.now() - t0;
  console.log(`[polymarket] ${totalEvents} events, ${totalMarkets} active markets, ${inScope} in-scope (btc/eth/etf), ${ms}ms`);
  return { totalEvents, totalMarkets, inScope, ms };
}

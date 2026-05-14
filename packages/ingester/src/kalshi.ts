import { db, now, env } from "@rfb2/shared";

const PAGE = 200;

interface KSeries { ticker: string; title: string; category?: string }
interface KMarket {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  floor_strike?: number;
  cap_strike?: number;
  strike_type?: string;
  status?: string;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  liquidity_dollars?: string;
  open_interest_fp?: string;
  volume_24h_fp?: string;
  volume_fp?: string;
}

function composeQuestion(mk: KMarket): string {
  const base = mk.title ?? mk.ticker;
  const sub = mk.yes_sub_title;
  const op =
    mk.strike_type === "greater_or_equal" ? "≥" :
    mk.strike_type === "less_or_equal"    ? "≤" :
    mk.strike_type === "greater"          ? ">" :
    mk.strike_type === "less"             ? "<" : null;
  const strike =
    mk.floor_strike !== undefined ? `$${mk.floor_strike.toLocaleString()}` :
    mk.cap_strike   !== undefined ? `$${mk.cap_strike.toLocaleString()}`  : null;
  const parts = [base];
  if (sub) parts.push(sub);
  else if (op && strike) parts.push(`${op} ${strike}`);
  return parts.join(" — ");
}

// Decide if a series is in our BTC/ETH/ETF-flow scope.
function seriesScope(s: KSeries): string | null {
  const tk = s.ticker.toUpperCase();
  const tt = (s.title ?? "").toLowerCase();
  const isBtc = /BTC|BITCOIN/.test(tk) || /bitcoin/.test(tt);
  const isEth = /ETH(?!E)|ETHEREUM/.test(tk) || /ethereum/.test(tt);
  const isEtfFlow = /ETF/.test(tk) && /(FLOW|INFLOW|OUTFLOW|NET)/.test(tk);
  if (isEtfFlow) return "etf-flow";
  // For price-style series we accept the whole series — most are price/range bets.
  if (isBtc) return "btc-price";
  if (isEth) return "eth-price";
  return null;
}

function numOrNull(s: string | undefined): number | null {
  if (s === undefined || s === null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function getCryptoSeries(): Promise<KSeries[]> {
  const url = `${env.kalshi()}/series?category=Crypto`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`kalshi /series ${res.status}: ${await res.text()}`);
  const j = await res.json() as { series?: KSeries[] };
  return j.series ?? [];
}

async function* marketsForSeries(ticker: string): AsyncGenerator<KMarket> {
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({
      series_ticker: ticker,
      status: "open",
      limit: String(PAGE),
    });
    if (cursor) params.set("cursor", cursor);
    const url = `${env.kalshi()}/markets?${params}`;

    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status !== 429) break;
      await Bun.sleep(500 * (attempt + 1));
    }
    if (!res || !res.ok) {
      console.warn(`[kalshi] ${ticker}: ${res?.status ?? "fetch-fail"}`);
      return;
    }
    const j = await res.json() as { markets?: KMarket[]; cursor?: string };
    for (const m of j.markets ?? []) yield m;
    if (!j.cursor || (j.markets?.length ?? 0) < PAGE) return;
    cursor = j.cursor;
  }
}

export async function snapshotKalshi() {
  const t0 = Date.now();
  const ts = now();
  const conn = db();

  const upsertMarket = conn.prepare(`
    INSERT INTO markets (id, venue, venue_id, question, category, closes_at, first_seen, last_seen, raw_json)
    VALUES (?, 'kalshi', ?, ?, ?, ?, ?, ?, ?)
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

  const series = await getCryptoSeries();
  const inScope = series.filter(s => seriesScope(s) !== null);
  console.log(`[kalshi] ${series.length} crypto series, ${inScope.length} in scope (btc/eth/etf)`);

  let totalMarkets = 0;
  // Throttled: 2 concurrent series at a time, with small inter-batch pause.
  const BATCH = 2;
  for (let i = 0; i < inScope.length; i += BATCH) {
    const batch = inScope.slice(i, i + BATCH);
    const all = await Promise.allSettled(batch.map(async s => {
      const collected: { market: KMarket; category: string }[] = [];
      for await (const m of marketsForSeries(s.ticker)) {
        collected.push({ market: m, category: seriesScope(s)! });
      }
      return collected;
    }));

    const tx = conn.transaction(() => {
      for (const r of all) {
        if (r.status !== "fulfilled") continue;
        for (const { market: mk, category } of r.value) {
          if (mk.status && mk.status !== "active" && mk.status !== "open" && mk.status !== "initialized") continue;
          totalMarkets++;

          const id = `kalshi:${mk.ticker}`;
          const closesAt = mk.close_time ? Math.floor(new Date(mk.close_time).getTime() / 1000) : null;
          const question = composeQuestion(mk);
          upsertMarket.run(id, mk.ticker, question, category, closesAt, ts, ts, JSON.stringify(mk));

          const yesBid = numOrNull(mk.yes_bid_dollars);
          const yesAsk = numOrNull(mk.yes_ask_dollars);
          const last   = numOrNull(mk.last_price_dollars);
          const liq    = numOrNull(mk.liquidity_dollars);
          const vol24  = numOrNull(mk.volume_24h_fp);

          // Implied prob: mid if we have both sides, else last.
          let yesProb: number | null = null;
          if (yesBid !== null && yesAsk !== null) yesProb = (yesBid + yesAsk) / 2;
          else if (last !== null) yesProb = last;

          if (yesProb !== null) {
            insertSnap.run(id, "yes", ts, yesProb, yesBid, yesAsk, vol24, liq);
            insertSnap.run(id, "no",  ts, 1 - yesProb,
              mk.no_bid_dollars ? numOrNull(mk.no_bid_dollars) : null,
              mk.no_ask_dollars ? numOrNull(mk.no_ask_dollars) : null,
              vol24, liq);
          }
        }
      }
    });
    tx();
    if (i + BATCH < inScope.length) await Bun.sleep(150);
  }

  const ms = Date.now() - t0;
  console.log(`[kalshi] ${totalMarkets} active markets ingested, ${ms}ms`);
  return { series: inScope.length, totalMarkets, ms };
}

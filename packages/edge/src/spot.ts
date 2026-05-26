import { db, now } from "@rfb2/shared";

// Add a tiny prices table on first use so the edge package can self-init.
function ensureTable() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS prices (
      asset       TEXT NOT NULL,           -- 'BTC' | 'ETH'
      captured_at INTEGER NOT NULL,
      source      TEXT NOT NULL,
      spot_usd    REAL NOT NULL,
      PRIMARY KEY (asset, captured_at, source)
    );
    CREATE INDEX IF NOT EXISTS idx_prices_asset_time ON prices(asset, captured_at DESC);

    CREATE TABLE IF NOT EXISTS daily_closes (
      asset      TEXT NOT NULL,
      day        TEXT NOT NULL,            -- YYYY-MM-DD UTC
      close_usd  REAL NOT NULL,
      PRIMARY KEY (asset, day)
    );
  `);
}

const COINS = { BTC: "bitcoin", ETH: "ethereum" } as const;

const SPOT_TTL_SECS = 5 * 60; // re-fetch at most once per 5 min

export async function fetchSpot(): Promise<Record<"BTC" | "ETH", number>> {
  ensureTable();
  // Return cached value if it's fresh enough.
  const age = db().query<{ age: number }, []>(
    `SELECT ? - MAX(captured_at) AS age FROM prices WHERE asset='BTC'`
  ).get()?.age ?? Infinity;
  if (age < SPOT_TTL_SECS) {
    return { BTC: latestSpot("BTC")!, ETH: latestSpot("ETH")! };
  }

  const ids = Object.values(COINS).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`coingecko spot ${res.status}: ${await res.text()}`);
  const j = await res.json() as Record<string, { usd: number }>;
  const out = {
    BTC: j[COINS.BTC]?.usd,
    ETH: j[COINS.ETH]?.usd,
  };
  if (!out.BTC || !out.ETH) throw new Error("coingecko returned missing price");

  const ts = now();
  const stmt = db().prepare(`INSERT OR REPLACE INTO prices (asset, captured_at, source, spot_usd) VALUES (?, ?, 'coingecko', ?)`);
  stmt.run("BTC", ts, out.BTC);
  stmt.run("ETH", ts, out.ETH);

  return out as Record<"BTC" | "ETH", number>;
}

const CLOSES_TTL_SECS = 60 * 60; // re-fetch at most once per hour

export async function fetchDailyCloses(asset: "BTC" | "ETH", days = 60): Promise<{ day: string; close: number }[]> {
  ensureTable();
  // Skip fetch if we already have enough recent rows.
  const count = db().query<{ n: number }, [string]>(
    `SELECT COUNT(*) n FROM daily_closes WHERE asset=?`
  ).get(asset)?.n ?? 0;
  const latestDay = db().query<{ day: string }, [string]>(
    `SELECT MAX(day) day FROM daily_closes WHERE asset=?`
  ).get(asset)?.day ?? "";
  const today = new Date().toISOString().slice(0, 10);
  if (count >= days && latestDay >= today) {
    return db().query<{ day: string; close_usd: number }, [string, number]>(
      `SELECT day, close_usd FROM daily_closes WHERE asset=? ORDER BY day DESC LIMIT ?`
    ).all(asset, days).map(r => ({ day: r.day, close: r.close_usd }));
  }

  const url = `https://api.coingecko.com/api/v3/coins/${COINS[asset]}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`coingecko market_chart ${res.status}: ${await res.text()}`);
  const j = await res.json() as { prices: [number, number][] };
  const out: { day: string; close: number }[] = [];
  for (const [ms, p] of j.prices) {
    const day = new Date(ms).toISOString().slice(0, 10);
    out.push({ day, close: p });
  }

  const stmt = db().prepare(`INSERT OR REPLACE INTO daily_closes (asset, day, close_usd) VALUES (?, ?, ?)`);
  for (const { day, close } of out) stmt.run(asset, day, close);
  return out;
}

export function latestSpot(asset: "BTC" | "ETH"): number | null {
  ensureTable();
  const r = db().query<{ spot_usd: number }, [string]>(
    `SELECT spot_usd FROM prices WHERE asset=? ORDER BY captured_at DESC LIMIT 1`
  ).get(asset);
  return r?.spot_usd ?? null;
}

// Annualized realized vol from log returns of recent daily closes.
export function realizedVol(asset: "BTC" | "ETH", windowDays = 30): number | null {
  ensureTable();
  const rows = db().query<{ close_usd: number }, [string, number]>(
    `SELECT close_usd FROM daily_closes WHERE asset=? ORDER BY day DESC LIMIT ?`
  ).all(asset, windowDays);
  if (rows.length < windowDays / 2) return null;
  const closes = rows.map(r => r.close_usd).reverse();
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const dailyStd = Math.sqrt(variance);
  return dailyStd * Math.sqrt(365); // annualized
}

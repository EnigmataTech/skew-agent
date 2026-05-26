import { Hono } from "hono";
import { cors } from "hono/cors";
import { db, now } from "@rfb2/shared";
import {
  fetchSpot,
  fetchDailyCloses,
  latestSpot,
  realizedVol,
  rebuildMispricings,
  runCalibration,
  persistCalibration,
  clearCalibCache,
} from "@rfb2/edge";
import {
  bookTradesFromTopEdges,
  resolveExpiredTrades,
  paperSummary,
} from "@rfb2/agent";
import { ensureRegistered, anchorTrade, settleTrade, getAgentState } from "@rfb2/onchain";
import { appendLog, getLog } from "./tick-log";

const app = new Hono();

// ─── CORS ─────────────────────────────────────────────────────────────
app.use("*", cors({ origin: "*", allowHeaders: ["*"], allowMethods: ["*"] }));

// ─── Agent identity (ERC-8004) — register once on startup ─────────────
ensureRegistered().then(s => {
  appendLog(`[onchain] agent id=${s.agentId} address=${s.address}`);
  appendLog(`  explorer: https://testnet.arcscan.app/address/${s.address}`);
}).catch(e => appendLog(`[onchain] registration error: ${e.message}`));

// ─── Health ────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  const agent = getAgentState();
  return c.json({ status: "healthy", ts: now(), agent });
});

// ─── Spot prices ───────────────────────────────────────────────────────
app.get("/spot", (c) => {
  try {
    const btc = latestSpot("BTC");
    const eth = latestSpot("ETH");
    return c.json({ BTC: btc, ETH: eth, ts: now() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Realized vol ──────────────────────────────────────────────────────
app.get("/vol", (c) => {
  try {
    const btc = realizedVol("BTC");
    const eth = realizedVol("ETH");
    return c.json({ BTC: btc, ETH: eth, ts: now() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Mispricings ───────────────────────────────────────────────────────
app.get("/mispricings", (c) => {
  try {
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const minEdge = Number(c.req.query("min_edge")) || 0;
    const conn = db();
    const rows = conn
      .query(
        `WITH latest AS (
          SELECT * FROM mispricings WHERE captured_at = (SELECT MAX(captured_at) FROM mispricings)
        )
        SELECT mp.*, m.venue, m.question
        FROM latest mp
        JOIN markets m ON m.id = mp.market_id
        WHERE ABS(mp.edge) >= ?
        ORDER BY ABS(mp.edge) DESC
        LIMIT ?`
      )
      .all(minEdge, limit) as any[];
    return c.json({ count: rows.length, mispricings: rows, ts: now() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Paper trades ──────────────────────────────────────────────────────
app.get("/trades", (c) => {
  try {
    const status = c.req.query("status") || "open";
    const conn = db();
    const rows = conn
      .query(
        `SELECT pt.*, m.venue, m.question
         FROM paper_trades pt
         JOIN markets m ON m.id = pt.market_id
         WHERE pt.status = ?
         ORDER BY ABS(pt.entry_edge) DESC`
      )
      .all(status) as any[];
    return c.json({ count: rows.length, trades: rows, ts: now() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Summary ───────────────────────────────────────────────────────────
app.get("/summary", (c) => {
  try {
    const s = paperSummary() as any;
    return c.json({ ...s, ts: now() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Calibration data ──────────────────────────────────────────────────
app.get("/calibration", (c) => {
  try {
    const conn = db();
    const rows = conn
      .query(
        `SELECT asset, kind, bucket_lo, bucket_hi, n, avg_pred, actual_rate
         FROM calibration
         ORDER BY asset, kind, bucket_lo`
      )
      .all() as any[];
    return c.json({ count: rows.length, buckets: rows, ts: now() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Agent log ─────────────────────────────────────────────────────────
app.get("/log", (c) => {
  const n = Math.min(Number(c.req.query("n")) || 200, 1000);
  return c.json({ lines: getLog(n), ts: now() });
});

// ─── Tick (run paper-trade cycle) ──────────────────────────────────────
app.post("/tick", async (c) => {
  try {
    appendLog("[tick] refreshing spot + closes…");
    await fetchSpot();
    await fetchDailyCloses("BTC", 7);
    await fetchDailyCloses("ETH", 7);

    appendLog("[tick] rebuilding mispricings…");
    db().exec(`DELETE FROM mispricings`);
    const r = rebuildMispricings();
    appendLog(`  evaluated=${r.evaluated} written=${r.written}`);

    appendLog("[tick] resolving expired trades…");
    const beforeResolve = now();
    const res = resolveExpiredTrades();
    appendLog(`  resolved=${res.resolved} voided=${res.voided}`);

    // Settle resolved trades on Arc (USDC transfer as on-chain proof)
    if (res.resolved > 0) {
      const justResolved = db()
        .query<any, any[]>(`SELECT * FROM paper_trades WHERE status='resolved' AND resolved_at >= ?`)
        .all(beforeResolve - 2);
      const agent = getAgentState();
      for (const t of justResolved) {
        settleTrade({
          tradeId: t.trade_id,
          asset: t.asset,
          side: t.side,
          pnlUsdc: t.pnl_usdc ?? 0,
          outcome: t.resolved_outcome as "yes" | "no" | "void",
          agentId: agent?.agentId ?? "0",
        });
      }
      appendLog(`[onchain] settling ${justResolved.length} trade(s) on Arc…`);
    }

    appendLog("[tick] booking new top-edge trades…");
    const bk = bookTradesFromTopEdges({ edgeThreshold: 0.05, sizeUsdc: 100, maxOpen: 20 });
    appendLog(`  booked=${bk.booked} pre-open=${bk.openCount}`);

    // Anchor each newly booked trade on Arc (ERC-8004 agent identity + on-chain memo)
    const agent = getAgentState();
    if (agent && bk.booked > 0) {
      const newTrades = db()
        .query<any, any[]>(`SELECT * FROM paper_trades WHERE entered_at >= ? AND status = 'open' ORDER BY entered_at DESC LIMIT ?`)
        .all(now() - 5, bk.booked);
      for (const t of newTrades) {
        anchorTrade({
          tradeId: t.trade_id,
          asset: t.asset,
          side: t.side,
          op: t.op,
          strike: t.strike,
          edge: t.entry_edge,
          modelP: t.entry_model_p,
          marketP: t.entry_market_p,
          agentId: agent.agentId,
        });
      }
      appendLog(`[onchain] anchoring ${newTrades.length} trade(s) on Arc…`);
    }

    const s = paperSummary() as any;
    appendLog(`  OPEN: ${(s.open as any).n} / SETTLED: ${(s.settled as any).n}  pnl=$${(s.settled as any).pnl ?? 0}`);

    return c.json({ ok: true, mispricings: r, resolved: res, booked: bk, summary: s });
  } catch (e: any) {
    appendLog(`[tick] ERROR: ${e.message}`);
    return c.json({ error: e.message }, 500);
  }
});

// ─── Backtest (run calibration) ────────────────────────────────────────
app.post("/backtest", async (c) => {
  try {
    appendLog("[backtest] fetching 365d daily closes…");
    await fetchDailyCloses("BTC", 365);
    await fetchDailyCloses("ETH", 365);
    const results: any[] = [];

    for (const asset of ["BTC", "ETH"] as const) {
      appendLog(`[backtest] ${asset}…`);
      const r = runCalibration(asset);
      persistCalibration(asset, r.perKind as any);
      clearCalibCache();
      results.push({ asset, historyDays: r.historyDays, perKind: r.perKind });
      appendLog(`  ${asset}: ${r.historyDays}d history, stored`);
    }

    return c.json({ ok: true, results, ts: now() });
  } catch (e: any) {
    appendLog(`[backtest] ERROR: ${e.message}`);
    return c.json({ error: e.message }, 500);
  }
});

// ─── Markets overview ──────────────────────────────────────────────────
app.get("/markets", (c) => {
  try {
    const conn = db();
    const rows = conn
      .query(
        `SELECT id, venue, venue_id, question, category, settlement,
                closes_at, resolved, resolved_as, last_seen
         FROM markets
         WHERE resolved = 0
         ORDER BY last_seen DESC
         LIMIT 100`
      )
      .all() as any[];
    return c.json({ count: rows.length, markets: rows, ts: now() });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Aggregated dashboard data ─────────────────────────────────────────
app.get("/dashboard", (c) => {
  try {
    const conn = db();

    // Latest spot + vol
    const btcSpot = latestSpot("BTC");
    const ethSpot = latestSpot("ETH");
    const btcVol = realizedVol("BTC");
    const ethVol = realizedVol("ETH");

    // Top mispricings
    const mispricings = conn
      .query(
        `WITH latest AS (
          SELECT * FROM mispricings WHERE captured_at = (SELECT MAX(captured_at) FROM mispricings)
        )
        SELECT mp.*, m.venue, m.question
        FROM latest mp
        JOIN markets m ON m.id = mp.market_id
        WHERE ABS(mp.edge) >= 0.02
        ORDER BY ABS(mp.edge) DESC
        LIMIT 25`
      )
      .all() as any[];

    // Open trades with mark-to-market unrealized P&L
    const openTrades = conn
      .query(
        `WITH latest_mp AS (
           SELECT market_id, market_p
           FROM mispricings
           WHERE captured_at = (SELECT MAX(captured_at) FROM mispricings)
         )
         SELECT pt.*, m.venue, m.question,
           mp.market_p AS curr_market_p,
           CASE pt.side
             WHEN 'yes' THEN pt.size_usdc * (COALESCE(mp.market_p, pt.entry_market_p) - pt.entry_market_p)
             WHEN 'no'  THEN pt.size_usdc * (pt.entry_market_p - COALESCE(mp.market_p, pt.entry_market_p))
           END AS unrealized_pnl
         FROM paper_trades pt
         JOIN markets m ON m.id = pt.market_id
         LEFT JOIN latest_mp mp ON mp.market_id = pt.market_id
         WHERE pt.status = 'open'
         ORDER BY ABS(pt.entry_edge) DESC`
      )
      .all() as any[];

    // Summary with unrealized P&L
    const summary = paperSummary() as any;
    const unrealizedTotal = (openTrades as any[]).reduce((s: number, t: any) => s + (t.unrealized_pnl ?? 0), 0);
    (summary as any).unrealized = { pnl: Math.round(unrealizedTotal * 100) / 100, n: openTrades.length };

    return c.json({
      spot: { BTC: btcSpot, ETH: ethSpot },
      vol: { BTC: btcVol, ETH: ethVol },
      mispricings: mispricings.slice(0, 25),
      openTrades,
      summary,
      ts: now(),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Listen ────────────────────────────────────────────────────────────
// ─── Agent identity endpoint ───────────────────────────────────────────
app.get("/agent", (c) => {
  const agent = getAgentState();
  if (!agent) return c.json({ registered: false, ts: now() });
  return c.json({
    registered: true,
    agentId: agent.agentId,
    address: agent.address,
    registrationTx: agent.registrationTx,
    explorerUrl: `https://testnet.arcscan.app/address/${agent.address}`,
    ts: now(),
  });
});

// ─── Auto-tick loop ────────────────────────────────────────────────────
const TICK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

async function runTick() {
  try {
    appendLog("[auto-tick] refreshing spot + closes…");
    await fetchSpot();
    await fetchDailyCloses("BTC", 7);
    await fetchDailyCloses("ETH", 7);

    appendLog("[auto-tick] rebuilding mispricings…");
    db().exec(`DELETE FROM mispricings`);
    const r = rebuildMispricings();
    appendLog(`  evaluated=${r.evaluated} written=${r.written}`);

    appendLog("[auto-tick] resolving expired trades…");
    const beforeResolve = now();
    const res = resolveExpiredTrades();
    appendLog(`  resolved=${res.resolved} voided=${res.voided}`);

    if (res.resolved > 0) {
      const justResolved = db()
        .query<any, any[]>(`SELECT * FROM paper_trades WHERE status='resolved' AND resolved_at >= ?`)
        .all(beforeResolve - 2);
      const agent = getAgentState();
      for (const t of justResolved) {
        settleTrade({
          tradeId: t.trade_id,
          asset: t.asset,
          side: t.side,
          pnlUsdc: t.pnl_usdc ?? 0,
          outcome: t.resolved_outcome as "yes" | "no" | "void",
          agentId: agent?.agentId ?? "0",
        });
      }
      if (justResolved.length > 0) appendLog(`[onchain] settling ${justResolved.length} trade(s) on Arc…`);
    }

    appendLog("[auto-tick] booking new top-edge trades…");
    const bk = bookTradesFromTopEdges({ edgeThreshold: 0.05, sizeUsdc: 100, maxOpen: 20 });
    appendLog(`  booked=${bk.booked} pre-open=${bk.openCount}`);

    const agent = getAgentState();
    if (agent && bk.booked > 0) {
      const newTrades = db()
        .query<any, any[]>(`SELECT * FROM paper_trades WHERE entered_at >= ? AND status = 'open' ORDER BY entered_at DESC LIMIT ?`)
        .all(now() - 5, bk.booked);
      for (const t of newTrades) {
        anchorTrade({
          tradeId: t.trade_id, asset: t.asset, side: t.side, op: t.op,
          strike: t.strike, edge: t.entry_edge, modelP: t.entry_model_p,
          marketP: t.entry_market_p, agentId: agent.agentId,
        });
      }
    }

    const s = paperSummary() as any;
    appendLog(`  OPEN: ${(s.open as any).n} / SETTLED: ${(s.settled as any).n}  pnl=$${(s.settled as any).pnl ?? 0}`);
  } catch (e: any) {
    appendLog(`[auto-tick] ERROR: ${e.message}`);
  }
}

// Initial tick after 10s, then every 5 min
setTimeout(() => {
  runTick();
  setInterval(runTick, TICK_INTERVAL_MS);
}, 10_000);

const PORT = Number(process.env.API_PORT) || 3200;

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`[api] rfb2-agent API server listening on http://0.0.0.0:${PORT}`);

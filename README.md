# Skew

**Agora Agents Hackathon — RFB 2 submission.**

An autonomous prediction-market mispricing agent that detects and paper-trades mispricings on Polymarket and Kalshi for BTC/ETH price markets, with onchain agent identity and USDC settlement anchored on Arc testnet.

---

## What it does

The agent applies a **log-normal options pricing model** to BTC and ETH price prediction markets. Most market participants price these naively; the agent finds edges where the market probability diverges from what realized volatility and time-to-expiry imply.

1. **Ingest** — snapshots Polymarket + Kalshi every 5 minutes into SQLite
2. **Price** — runs a log-normal model (Black-Scholes style) calibrated via walk-forward backtest against 365 days of daily closes
3. **Detect** — identifies mispricings where `|model_p − market_p| > 5pp`
4. **Trade** — books paper trades on top edges, tracks P&L with mark-to-market unrealized values
5. **Settle on Arc** — each trade decision is anchored on-chain; when a trade resolves, USDC is transferred on Arc testnet as settlement proof

---

## Architecture

```
packages/
  shared/     Types, env config, SQLite helpers
  ingester/   Polymarket + Kalshi market snapshotter → SQLite
  edge/       Log-normal pricing model, mispricing detector, calibration backtest
  agent/      Paper-trade ledger: book → resolve → P&L
  onchain/    Arc integration: ERC-8004 identity, trade anchoring, USDC settlement
  api/        Hono HTTP server (12 endpoints) — the agent's brain
  tui/        Textual Python terminal dashboard

data/         SQLite database (gitignored)
scripts/      One-shot utilities (rpc-ping, faucet check)
```

---

## Arc integration

This agent uses Arc testnet as its **settlement and accountability layer**:

| What | How |
|------|-----|
| **Agent identity** | ERC-8004 `register()` on startup — agent gets a unique on-chain ID |
| **Trade anchoring** | Every booked trade fires a self-send tx with trade metadata in calldata |
| **USDC settlement** | On trade resolution: WIN → USDC transfer to agent address; LOSS → USDC burned to `0xdEaD` |

The agent's Arc address and registration tx are exposed via `/agent` and visible on [testnet.arcscan.app](https://testnet.arcscan.app).

**Chain:** Arc Testnet (Chain ID `5042002`)
**USDC:** `0x3600000000000000000000000000000000000000` (6 dec ERC-20)
**ERC-8004 IdentityRegistry:** `0x8004A818BFB912233c491871b3d84c89A494BD9e`

---

## Pricing model

For a binary market "BTC ≥ $K at expiry T":

```
P(yes) = Φ( (ln(S/K) + (σ²/2)·τ) / (σ·√τ) )
```

Where:
- `S` = current BTC spot (CoinGecko)
- `K` = strike price
- `σ` = 30-day annualized realized volatility from daily closes
- `τ` = time to expiry in years
- `Φ` = standard normal CDF

Settlement type modifiers applied for Kalshi barrier markets (`max`, `min`, `barrier`).

Calibration: walk-forward backtest over 365d of daily closes produces per-bucket reliability scores (Brier score per probability decile).

---

## API

The Hono server runs on port `3200` by default.

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server status + agent registration state |
| `GET /agent` | ERC-8004 agent identity + Arc explorer link |
| `GET /dashboard` | Spot, vol, top mispricings, open trades, P&L summary |
| `GET /mispricings` | Latest detected mispricings (sorted by \|edge\|) |
| `GET /trades` | Paper trades by status |
| `GET /summary` | Realized + unrealized P&L summary |
| `GET /calibration` | Reliability buckets from last backtest |
| `GET /markets` | Active markets in DB |
| `GET /spot` | Latest BTC/ETH spot prices |
| `GET /vol` | Realized volatility |
| `GET /log` | Agent log ring buffer |
| `POST /tick` | Run one full cycle manually |
| `POST /backtest` | Run 365d calibration backtest |

Auto-tick runs every 5 minutes on server startup.

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- Python ≥ 3.11 + [uv](https://github.com/astral-sh/uv)
- [arc-canteen CLI](https://github.com/the-canteen-dev/ARC-cli) (for RPC key)

### 1. Install

```bash
arc-canteen login                  # one-time — issues your RPC key
git clone <this-repo>
cd rfb2-agent
cp .env.example .env               # fill in keys (see below)
bun install
```

### 2. Configure `.env`

```bash
# Arc RPC — get from arc-canteen
RPC=                               # arc-canteen rpc-url

# Agent wallet (testnet only — never use mainnet keys here)
AGENT_PRIVATE_KEY=                 # 0x-prefixed hex private key with testnet USDC
                                   # Faucet: https://faucet.circle.com (select Arc Testnet)

# Venues (public APIs, no key required for read)
POLYMARKET_API_BASE=https://gamma-api.polymarket.com
KALSHI_API_BASE=https://api.elections.kalshi.com/trade-api/v2
```

### 3. Seed the database

```bash
bun run ingest          # snapshot Polymarket + Kalshi markets → SQLite
```

### 4. Run

**Terminal 1 — API server:**
```bash
bun run api
```

**Terminal 2 — Terminal UI:**
```bash
bun run tui
```

The TUI auto-connects to `http://localhost:3200`. The API server auto-ticks every 5 minutes.

### First run

On first start the API server will:
1. Register the agent on Arc (ERC-8004) — takes ~5 seconds
2. Run an initial tick to build mispricings
3. Begin the 5-minute auto-tick loop

---

## TUI controls

| Key | Action |
|-----|--------|
| `1` | Dashboard tab |
| `2` | Calibration tab |
| `3` | Settings tab |
| `t` | Run tick manually |
| `b` | Run full backtest (365d) |
| `r` | Refresh all |
| `q` | Quit |

Click any row in the mispricings or trades table for full detail.

---

## Dev scripts

```bash
bun run typecheck       # TypeScript type check (all packages)
bun run ingest          # Run ingester once
bun run edge            # Run edge detector once
bun run agent           # Run agent loop once
bun run rpc:ping        # Sanity-check Arc RPC
```

---

## Chain facts (Arc Testnet)

| Field | Value |
|-------|-------|
| Chain ID | `5042002` |
| RPC | Via `arc-canteen rpc-url` |
| Explorer | https://testnet.arcscan.app |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000` (6 dec) |
| Faucet | https://faucet.circle.com |
| CCTP domain | `26` |

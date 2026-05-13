# rfb2-agent

Agora Agents Hackathon — RFB 2 submission. Prediction-market mispricing agent
specializing in crypto-native markets (BTC/ETH price, ETF flows, etc.) across
Polymarket + Kalshi, with onchain agent identity and pay-per-call signal
distribution settled in USDC on Arc.

## Architecture

```
packages/shared    Types, env, common utils
packages/ingester  Polymarket + Kalshi snapshotters → SQLite
packages/edge      LLM + base-rate probability model, mispricing detector
packages/agent     Observe→reason→publish→reconcile loop
packages/onchain   Arc + Circle: ERC-8004 identity, ERC-8183 jobs, x402, Agent Wallet
apps/dashboard     Public dashboard (calls, accuracy, subscribe) — D11
scripts/           One-shots (rpc-ping, faucet check, ...)
data/              Local SQLite + snapshot dumps (gitignored)
```

## Local arc-canteen context

Synced docs + samples live at `~/.arc-canteen/context/`:
- `circlefin-skills/use-arc.md` — chain config (USDC=gas, 18 dec native vs 6 dec ERC20)
- `docs/developers.circle.com/agent-stack.md` — Circle CLI + Agent Wallets + x402
- `docs/docs.arc.network/build/agentic-economy.md` — ERC-8004 + ERC-8183
- `samples/arc-escrow` — reference job lifecycle implementation
- `samples/arc-fintech` + `arc-multichain-wallet` — UI references

## Setup

```bash
arc-canteen login                  # one-time; writes RPC to ~/.arc-canteen/env
source ~/.arc-canteen/env          # exports $RPC for this shell
cp .env.example .env               # then fill in keys
bun install
bun run rpc:ping                   # sanity-check the chain
```

## 12-day plan

| Day | Goal |
|-----|------|
| D1  | CLI auth, context sync, scaffold, faucet, RPC sanity (DONE) |
| D2  | Polymarket + Kalshi ingester → 5-min snapshots → SQLite |
| D3-4| LLM+base-rate probability model; mispricing signal |
| D5  | Lean-style backtest harness on historical snapshots |
| D6  | Cross-venue arb scanner |
| D7-8| Agent loop: observe→reason→publish→reconcile |
| D9  | ERC-8004 agent registration; attest each call as reputation event |
| D10 | x402 pay-per-call endpoint + (optional) ERC-8183 subscription |
| D11 | Dashboard (Next.js) |
| D12 | Demo video, README, submit via arc-canteen |

## Chain facts (Arc testnet)

- Chain ID: `5042002` (hex `0x4cef52`)
- USDC (ERC-20, gas): `0x3600000000000000000000000000000000000000` (6 dec)
- Faucet: https://faucet.circle.com
- Explorer: https://testnet.arcscan.app
- CCTP domain: `26`
- ⚠️ Native gas uses 18 decimals, USDC-the-ERC-20 uses 6 — do not mix

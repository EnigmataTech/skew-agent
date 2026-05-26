import { parseAbiItem, toHex } from "viem";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { publicClient, walletClient, agentAccount } from "./client";

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

const REGISTER_ABI = [{
  name: "register",
  type: "function" as const,
  stateMutability: "nonpayable" as const,
  inputs: [{ name: "metadataURI", type: "string" }],
  outputs: [],
}];

export interface AgentState {
  agentId: string;
  registrationTx: string;
  address: string;
}

const STATE_PATH = "./data/agent-state.json";

function loadState(): AgentState | null {
  try {
    if (!existsSync(STATE_PATH)) return null;
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as AgentState;
  } catch {
    return null;
  }
}

function saveState(s: AgentState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

let _state: AgentState | null = null;

export async function ensureRegistered(): Promise<AgentState> {
  if (_state) return _state;
  const cached = loadState();
  if (cached) { _state = cached; return cached; }

  const account = agentAccount();
  const wc = walletClient();
  const pc = publicClient();

  const metadata = {
    name: "Skew",
    description: "Autonomous prediction-market mispricing agent. Detects log-normal mispricings on Polymarket + Kalshi for BTC/ETH price markets.",
    agent_type: "trading",
    capabilities: ["mispricing_detection", "log_normal_pricing", "cross_venue_calibration", "paper_trading"],
    version: "0.0.1",
    venue: "polymarket+kalshi",
  };
  const metadataURI = "data:application/json;base64," +
    Buffer.from(JSON.stringify(metadata)).toString("base64");

  console.log(`[onchain] registering agent identity for ${account.address}…`);
  const hash = await wc.writeContract({
    address: IDENTITY_REGISTRY,
    abi: REGISTER_ABI,
    functionName: "register",
    args: [metadataURI],
  });

  console.log(`[onchain] registration tx: ${hash} — waiting for receipt…`);
  const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 30_000 });

  const logs = await pc.getLogs({
    address: IDENTITY_REGISTRY,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
    args: { to: account.address },
    blockHash: receipt.blockHash,
  });

  if (logs.length === 0) throw new Error("No Transfer event found after registration");
  const tokenId = logs[logs.length - 1]?.args?.tokenId;
  if (tokenId == null) throw new Error("Transfer event missing tokenId");
  const agentId = tokenId.toString();

  const state: AgentState = { agentId, registrationTx: hash, address: account.address };
  saveState(state);
  _state = state;
  console.log(`[onchain] agent registered: id=${agentId} tx=https://testnet.arcscan.app/tx/${hash}`);
  return state;
}

export function getAgentState(): AgentState | null {
  if (_state) return _state;
  _state = loadState();
  return _state;
}

// Fire-and-forget: anchor a paper trade decision on-chain.
// Uses a self-send with JSON calldata so every booked trade has a verifiable tx hash.
export function anchorTrade(payload: {
  tradeId: string;
  asset: string;
  side: string;
  op: string;
  strike: number;
  edge: number;
  modelP: number;
  marketP: number;
  agentId: string;
}): void {
  const wc = walletClient();
  const pc = publicClient();
  const account = agentAccount();

  const calldata = toHex(JSON.stringify({ ...payload, ts: Math.floor(Date.now() / 1000) }));

  wc.sendTransaction({
    to: account.address,
    value: 0n,
    data: calldata,
  }).then(hash => {
    console.log(`[onchain] trade anchored: ${payload.tradeId} → https://testnet.arcscan.app/tx/${hash}`);
  }).catch(err => {
    console.error(`[onchain] anchor failed for ${payload.tradeId}:`, err.message);
  });
}

// Arc USDC contract (6 decimals ERC-20 interface)
const USDC = "0x3600000000000000000000000000000000000000" as const;
const USDC_ABI = [{
  name: "transfer",
  type: "function" as const,
  stateMutability: "nonpayable" as const,
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}];

// Settle a resolved paper trade on Arc: transfer USDC proportional to |P&L|.
// Capped at 0.10 USDC per settlement so the testnet wallet isn't drained.
// The settlement outcome (win/loss) is encoded in the recipient:
//   WIN  → transfer to agent address (collect profit)
//   LOSS → transfer to zero address  (burn / acknowledge loss)
export function settleTrade(payload: {
  tradeId: string;
  asset: string;
  side: string;
  pnlUsdc: number;
  outcome: "yes" | "no" | "void";
  agentId: string;
}): void {
  if (payload.outcome === "void") return; // nothing to settle

  const wc = walletClient();
  const account = agentAccount();

  const isWin = payload.pnlUsdc > 0;
  // Cap at 0.10 USDC (100_000 in 6-dec units); minimum 1 unit so tx is non-trivial
  const rawAmount = Math.round(Math.abs(payload.pnlUsdc) * 1_000_000);
  const amount = BigInt(Math.max(1, Math.min(rawAmount, 100_000)));

  // Wins go back to the agent (profit collected); losses go to the zero address (burned)
  const to: `0x${string}` = isWin
    ? account.address
    : "0x000000000000000000000000000000000000dEaD";

  const label = isWin ? `WIN +$${payload.pnlUsdc.toFixed(2)}` : `LOSS $${payload.pnlUsdc.toFixed(2)}`;

  wc.writeContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [to, amount],
  }).then(hash => {
    console.log(`[onchain] settlement ${label} ${payload.tradeId} → https://testnet.arcscan.app/tx/${hash}`);
  }).catch(err => {
    console.error(`[onchain] settle failed for ${payload.tradeId}:`, err.message);
  });
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Did you source ~/.arc-canteen/env and copy .env.example to .env?`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  rpc: () => required("RPC"),
  arcDirectRpc: () => optional("ARC_TESTNET_RPC_URL", "https://rpc.testnet.arc.network"),
  chainId: () => Number(optional("ARC_CHAIN_ID", "5042002")),
  usdc: () => optional("USDC_ADDRESS", "0x3600000000000000000000000000000000000000") as `0x${string}`,
  agentKey: () => optional("AGENT_PRIVATE_KEY"),
  anthropic: () => optional("ANTHROPIC_API_KEY"),
  dbPath: () => optional("DB_PATH", "./data/rfb2.sqlite"),
  polymarket: () => optional("POLYMARKET_API_BASE", "https://gamma-api.polymarket.com"),
  kalshi: () => optional("KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2"),
};

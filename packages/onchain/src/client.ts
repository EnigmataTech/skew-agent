import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { env } from "@rfb2/shared";

function rpcUrl(): string {
  // Prefer the canteen-proxied RPC ($RPC) if set; fall back to direct Arc RPC.
  return process.env.RPC || env.arcDirectRpc();
}

export function publicClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl()),
  });
}

export function agentAccount() {
  const key = env.agentKey();
  if (!key) throw new Error("AGENT_PRIVATE_KEY not set");
  return privateKeyToAccount(key as `0x${string}`);
}

export function walletClient() {
  return createWalletClient({
    account: agentAccount(),
    chain: arcTestnet,
    transport: http(rpcUrl()),
  });
}

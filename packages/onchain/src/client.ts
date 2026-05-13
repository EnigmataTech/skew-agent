import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { env } from "@rfb2/shared";

export function publicClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(env.rpc()),
  });
}

// Snapshotters for Polymarket + Kalshi.
// Filled in on D2. Skeleton only.
import { env } from "@rfb2/shared";

export async function main() {
  console.log("[ingester] polymarket base:", env.polymarket());
  console.log("[ingester] kalshi base:    ", env.kalshi());
  console.log("[ingester] TODO: implement snapshot loop (D2)");
}

if (import.meta.main) await main();

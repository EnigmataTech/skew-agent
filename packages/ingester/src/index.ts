import { snapshotPolymarket } from "./polymarket";
import { snapshotKalshi } from "./kalshi";

const INTERVAL_MS = 5 * 60 * 1000;

async function tick() {
  await Promise.allSettled([
    snapshotPolymarket().catch(e => console.error("[polymarket] error:", e)),
    snapshotKalshi().catch(e => console.error("[kalshi] error:", e)),
  ]);
}

if (import.meta.main) {
  const loop = process.argv.includes("--loop");
  await tick();
  if (loop) {
    setInterval(tick, INTERVAL_MS);
    console.log(`[ingester] looping every ${INTERVAL_MS / 1000}s — Ctrl-C to stop`);
  }
}

export { snapshotPolymarket };

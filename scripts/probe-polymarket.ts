// Probe Polymarket Gamma API to learn the actual response shape.
// Writes a sample to data/probes/polymarket-sample.json so we can build
// the snapshotter against real data instead of speculation.
import { mkdirSync, writeFileSync } from "node:fs";
import { env } from "@rfb2/shared";

const base = env.polymarket();
const outDir = `${import.meta.dir}/../data/probes`;
mkdirSync(outDir, { recursive: true });

async function probe(path: string, label: string) {
  const url = `${base}${path}`;
  console.log(`[probe] GET ${url}`);
  const t0 = Date.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const ms = Date.now() - t0;
  const body = await res.text();
  console.log(`  status=${res.status} ms=${ms} bytes=${body.length}`);
  const outPath = `${outDir}/${label}.json`;
  writeFileSync(outPath, body);
  console.log(`  -> ${outPath}`);
  try {
    const json = JSON.parse(body);
    const sample = Array.isArray(json) ? json.slice(0, 2) : json;
    console.log("  shape preview:", JSON.stringify(sample, null, 2).slice(0, 1200));
  } catch {
    console.log("  (non-JSON body)");
  }
  console.log("");
}

// Try a few likely endpoints. We'll see which respond and what they return.
await probe("/markets?active=true&closed=false&limit=5", "markets-active");
await probe("/markets?active=true&closed=false&limit=20&tag=crypto", "markets-crypto-tag");
await probe("/events?active=true&closed=false&limit=5", "events-active");

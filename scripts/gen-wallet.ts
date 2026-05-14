import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const envPath = `${import.meta.dir}/../.env`;
const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(`${import.meta.dir}/../.env.example`, "utf8");

if (/^AGENT_PRIVATE_KEY=0x[0-9a-fA-F]{64}/m.test(existing)) {
  const acct = privateKeyToAccount(existing.match(/^AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]+)/m)![1] as `0x${string}`);
  console.log("Wallet already exists in .env");
  console.log("Address:", acct.address);
  process.exit(0);
}

const pk = generatePrivateKey();
const acct = privateKeyToAccount(pk);
const updated = existing.replace(/^AGENT_PRIVATE_KEY=.*$/m, `AGENT_PRIVATE_KEY=${pk}`);
writeFileSync(envPath, updated, { mode: 0o600 });

console.log("✓ Generated new agent wallet");
console.log("  Address:    ", acct.address);
console.log("  Private key: stored in .env (chmod 600, gitignored)");
console.log("");
console.log("Next: fund this address at https://faucet.circle.com (pick Arc Testnet)");

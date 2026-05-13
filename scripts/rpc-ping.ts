import { publicClient } from "@rfb2/onchain";

const client = publicClient();
const [chainId, block, gas] = await Promise.all([
  client.getChainId(),
  client.getBlockNumber(),
  client.getGasPrice(),
]);
console.log({ chainId, block, gasWei: gas.toString() });

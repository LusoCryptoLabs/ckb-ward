// Run from a folder holding issuer.key and pool.key (testnet keys, never committed).
// Mints the playground's test token (xUDT, owner = the issuer's lock) straight into 4 pool cells
// under the pool's lock. Testnet only. Usage: node mint.mjs <whole tokens>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
const client = new ccc.ClientPublicTestnet();
const issuer = new ccc.SignerCkbPrivateKey(client, readFileSync("issuer.key", "utf8").trim());
const pool = new ccc.SignerCkbPrivateKey(client, readFileSync("pool.key", "utf8").trim());
const st = existsSync("mint.json") ? JSON.parse(readFileSync("mint.json", "utf8")) : {};
const ownerLock = (await issuer.getRecommendedAddressObj()).script;
const poolLock = (await pool.getRecommendedAddressObj()).script;
const x = await client.getKnownScript(ccc.KnownScript.XUdt);
const type = ccc.Script.from({ codeHash: x.codeHash, hashType: x.hashType, args: ownerLock.hash() });
const UNIT = 10n ** 8n, TOTAL = BigInt(process.argv[2] ?? "1000000") * UNIT, PARTS = 4n;
if (!st.tx) {
  const outputs = [], data = [];
  for (let i = 0n; i < PARTS; i++) { outputs.push({ lock: poolLock, type }); data.push(ccc.hexFrom(ccc.numLeToBytes(TOTAL / PARTS, 16))); }
  const tx = ccc.Transaction.from({ outputs, outputsData: data });
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
  await tx.completeInputsByCapacity(issuer);
  await tx.completeFeeBy(issuer, 1000);
  st.tx = await issuer.sendTransaction(tx);
  Object.assign(st, { type: { codeHash: type.codeHash, hashType: type.hashType, args: type.args }, poolLock: { codeHash: poolLock.codeHash, hashType: poolLock.hashType, args: poolLock.args }, total: TOTAL.toString(), decimals: 8 });
  writeFileSync("mint.json", JSON.stringify(st, null, 1));
}
await client.waitTransaction(st.tx, 0, 300000);
console.log(JSON.stringify(st, null, 1));
process.exit(0);

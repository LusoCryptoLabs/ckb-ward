// Total CKB in Nervos DAO deposits on testnet live at a snapshot block, for the playground's claim
// example. Deposits live now and made at or before the snapshot, plus deposits spent after it that
// were made at or before it.
const RPC = "https://testnet.ckb.dev/rpc";
const SNAP = BigInt(process.argv[2] ?? "23095100");
const DAO = { code_hash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e", hash_type: "type", args: "0x" };
let id = 0;
const rpc = async (method, params) => {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ++id, jsonrpc: "2.0", method, params }) })).json();
      if (r.error) throw new Error(JSON.stringify(r.error));
      return r.result;
    } catch (e) { if (i === 4) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
  }
};
const ZERO = "0x0000000000000000";
let total = 0n, cells = 0, cursor = null;
const tips = await rpc("get_tip_header", []);
const add = async (cap) => { total += cap; cells++; };
let pages = 0;
for (;;) {
  const r = await rpc("get_cells", [{ script: DAO, script_type: "type", filter: { output_data: ZERO, output_data_filter_mode: "exact" } }, "asc", "0x3e8", cursor]);
  for (const c of r.objects) { const b = BigInt(c.block_number); if (b <= SNAP) await add(BigInt(c.output.capacity)); }
  pages++; if (pages % 5 === 0) console.error('live pages', pages, 'cells', cells);
  if (r.objects.length < 1000) break;
  cursor = r.last_cursor;
}
const live = cells;
// Spent after the snapshot: inputs with the DAO type in (SNAP, tip].
cursor = null;
const seen = new Set();
for (;;) {
  const r = await rpc("get_transactions", [{ script: DAO, script_type: "type", filter: { block_range: ["0x" + (SNAP + 1n).toString(16), "0x" + (BigInt(tips.number) + 1n).toString(16)] } }, "asc", "0x3e8", cursor]);
  for (const o of r.objects) {
    if (o.io_type !== "input") continue;
    const tx = (await rpc("get_transaction", [o.tx_hash])).transaction;
    const prev = tx.inputs[Number(o.io_index)].previous_output;
    const k = prev.tx_hash + prev.index; if (seen.has(k)) continue; seen.add(k);
    const pt = await rpc("get_transaction", [prev.tx_hash]);
    const i = Number(prev.index);
    if (pt.transaction.outputs_data[i] !== ZERO) continue;
    const b = BigInt(pt.tx_status.block_number);
    if (b <= SNAP) await add(BigInt(pt.transaction.outputs[i].capacity));
  }
  if (r.objects.length < 1000) break;
  cursor = r.last_cursor;
}
console.log(JSON.stringify({ snapshot: String(SNAP), tip: BigInt(tips.number).toString(), liveCells: live, spentAfter: cells - live, totalShannons: total.toString(), totalCkb: Number(total / 100000000n) }));

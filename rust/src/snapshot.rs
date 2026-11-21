//! Whether the cells a proof ran with were live at a snapshot block (SPEC section 9, rule 5).
use ckb_types::{packed, prelude::*};
use serde_json::{json, Value};

use crate::chain::{num, tip_number, Rpc, RpcError};
use crate::util::{hex, hex_num};

/// One cell dep at the snapshot block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepAtSnapshot {
    pub out_point: packed::OutPoint,
    pub live: bool,
    /// Block that committed the cell, when its transaction is committed.
    pub created_at: Option<u64>,
    /// Block that spent it, when that is at or before the snapshot.
    pub spent_at: Option<u64>,
    pub reason: String,
}

/// Every cell dep at the snapshot block. `live` is true only when all of them were.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepsAtSnapshot {
    pub live: bool,
    pub deps: Vec<DepAtSnapshot>,
}

fn index_of(op: &packed::OutPoint) -> u32 {
    op.index().unpack()
}

/// Whether each out point (the `cell_deps` an accepted proof returned) was a live cell at block
/// `snapshot`: committed at or before it, and not spent at or before it. Reads the transaction that
/// made each cell, and when a cell is no longer live, the indexer for what spent it. `max_pages` of
/// 100 indexer entries are read before giving up (20 in the TypeScript package). Err when the
/// snapshot is past the tip or a read fails.
pub fn deps_live_at(rpc: &impl Rpc, cell_deps: &[packed::OutPoint], snapshot: u64, max_pages: usize) -> Result<DepsAtSnapshot, RpcError> {
    let tip = tip_number(rpc)?;
    if snapshot > tip {
        return Err(RpcError(format!("snapshot block {snapshot} is past the tip {tip}")));
    }
    crate::chain::indexer_reaches(rpc, snapshot)?;
    let mut deps = Vec::new();
    for op in cell_deps {
        let index = index_of(op) as usize;
        let tx_hash = hex(op.tx_hash().as_slice());
        let dep = |live, created_at, spent_at, reason: String| DepAtSnapshot { out_point: op.clone(), live, created_at, spent_at, reason };
        let tx = rpc.call("get_transaction", json!([tx_hash]))?;
        let status = tx["tx_status"]["status"].as_str().unwrap_or("unknown");
        if status != "committed" {
            deps.push(dep(false, None, None, format!("its transaction is {status}")));
            continue;
        }
        let created_at = num(&tx["tx_status"]["block_number"], "get_transaction block_number")?;
        let output = &tx["transaction"]["outputs"][index];
        if output.is_null() {
            deps.push(dep(false, Some(created_at), None, "its transaction has no such output".into()));
            continue;
        }
        if created_at > snapshot {
            deps.push(dep(false, Some(created_at), None, format!("created in block {created_at}, after the snapshot")));
            continue;
        }
        let now = rpc.call("get_live_cell", json!([{ "tx_hash": tx_hash, "index": hex_num(index as u64) }, false]))?;
        if now["status"].as_str() == Some("live") {
            deps.push(dep(true, Some(created_at), None, "live now, so live at the snapshot".into()));
            continue;
        }
        match spent_by(rpc, &tx_hash, index as u64, output, created_at, snapshot, max_pages)? {
            None => deps.push(dep(true, Some(created_at), None, "spent after the snapshot".into())),
            Some(spent_at) => {
                deps.push(dep(false, Some(created_at), Some(spent_at), format!("spent in block {spent_at}, at or before the snapshot")))
            }
        }
    }
    Ok(DepsAtSnapshot { live: deps.iter().all(|d| d.live), deps })
}

/// The block, at or before `to`, of the transaction that spent the cell; None when none did.
fn spent_by(rpc: &impl Rpc, tx_hash: &str, index: u64, output: &Value, from: u64, to: u64, max_pages: usize) -> Result<Option<u64>, RpcError> {
    let (script, script_type) = if output["type"].is_null() { (&output["lock"], "lock") } else { (&output["type"], "type") };
    let search_key = json!({ "script": script, "script_type": script_type, "script_search_mode": "exact", "filter": { "block_range": [hex_num(from), hex_num(to + 1)] } });
    let mut cursor: Option<Value> = None;
    for _ in 0..max_pages {
        let params = match &cursor {
            Some(c) => json!([search_key, "asc", "0x64", c]),
            None => json!([search_key, "asc", "0x64"]),
        };
        let r = rpc.call("get_transactions", params)?;
        let objects = r["objects"].as_array().cloned().unwrap_or_default();
        for o in &objects {
            if o["io_type"].as_str() != Some("input") {
                continue;
            }
            let spender = rpc.call("get_transaction", json!([o["tx_hash"]]))?;
            let i = num(&o["io_index"], "get_transactions io_index")? as usize;
            let prev = &spender["transaction"]["inputs"][i]["previous_output"];
            if prev["tx_hash"].as_str() == Some(tx_hash)
                && prev["index"].as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()) == Some(index)
            {
                return Ok(Some(num(&o["block_number"], "get_transactions block_number")?));
            }
        }
        if objects.len() < 100 {
            return Ok(None);
        }
        cursor = Some(r["last_cursor"].clone());
    }
    Err(RpcError(format!("could not find what spent {tx_hash}:{index} within {max_pages} pages")))
}

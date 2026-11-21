//! Nervos DAO deposits under a lock at a snapshot block, the weight a voting platform counts.
use std::collections::{HashMap, HashSet};

use ckb_jsonrpc_types as rpc;
use ckb_types::{packed, prelude::*};
use serde_json::json;

use crate::chain::{num, tip_number, Rpc, RpcError};
use crate::json::script_to_rpc_json;
use crate::util::{byte32, hex, hex_num};

/// The Nervos DAO type script's code hash (hash_type type), the same on mainnet and testnet.
pub const NERVOS_DAO_CODE_HASH: &str = "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e";
/// A deposit's data: 8 zero bytes. A withdrawing cell (phase 1) holds its deposit's block number.
pub const DAO_DEPOSIT_DATA: &str = "0x0000000000000000";

/// One cell with the Nervos DAO type under the lock, live at the snapshot block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaoCell {
    pub out_point: packed::OutPoint,
    /// Shannons.
    pub capacity: u64,
    /// Block that committed the cell.
    pub created_at: u64,
}

/// What the lock held in the Nervos DAO at the snapshot block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaoWeight {
    /// Shannons in Nervos DAO deposits under the lock, live at the snapshot block.
    pub weight: u128,
    pub deposits: Vec<DaoCell>,
    /// Live at the snapshot with the DAO type but in phase 1 of a withdrawal: not counted.
    pub withdrawing: Vec<DaoCell>,
}

fn key(tx_hash: &str, index: u64) -> String {
    format!("{tx_hash}:{index}")
}

/// The Nervos DAO deposits under exactly `lock` that were live at block `snapshot`. A cell in phase
/// 1 of a withdrawal is not counted (it comes back in `withdrawing`), and a lock whose args merely
/// start the same way weighs nothing. `max_pages` of 100 indexer entries are read before giving up
/// (50 in the TypeScript package). Err rather than a weight it could not read in full.
pub fn dao_weight_at(rpc: &impl Rpc, lock: &packed::Script, snapshot: u64, max_pages: usize) -> Result<DaoWeight, RpcError> {
    let tip = tip_number(rpc)?;
    if snapshot > tip {
        return Err(RpcError(format!("snapshot block {snapshot} is past the tip {tip}")));
    }
    let lock_hash = lock.calc_script_hash();
    let search_key = json!({
        "script": script_to_rpc_json(lock),
        "script_type": "lock",
        "script_search_mode": "exact",
        "filter": { "script": { "code_hash": NERVOS_DAO_CODE_HASH, "hash_type": "type", "args": "0x" }, "block_range": ["0x0", hex_num(snapshot + 1)] },
    });
    let mut txs: HashMap<String, serde_json::Value> = HashMap::new();
    let mut made: Vec<(String, DaoCell, String)> = Vec::new();
    let mut spent: HashSet<String> = HashSet::new();
    let mut cursor: Option<serde_json::Value> = None;
    let mut page = 0;
    loop {
        if page >= max_pages {
            return Err(RpcError(format!("the DAO history of {} did not end within {max_pages} pages", hex(lock_hash.as_slice()))));
        }
        page += 1;
        let params = match &cursor {
            Some(c) => json!([search_key, "asc", "0x64", c]),
            None => json!([search_key, "asc", "0x64"]),
        };
        let r = rpc.call("get_transactions", params)?;
        let objects = r["objects"].as_array().cloned().unwrap_or_default();
        for o in &objects {
            let h = o["tx_hash"].as_str().ok_or_else(|| RpcError("get_transactions: no tx_hash".into()))?.to_string();
            if !txs.contains_key(&h) {
                let t = rpc.call("get_transaction", json!([h]))?;
                txs.insert(h.clone(), t["transaction"].clone());
            }
            let t = &txs[&h];
            let i = num(&o["io_index"], "get_transactions io_index")?;
            if o["io_type"].as_str() == Some("input") {
                let prev = &t["inputs"][i as usize]["previous_output"];
                if let (Some(ph), Some(pi)) = (prev["tx_hash"].as_str(), prev["index"].as_str()) {
                    if let Ok(pi) = u64::from_str_radix(pi.trim_start_matches("0x"), 16) {
                        spent.insert(key(ph, pi));
                    }
                }
                continue;
            }
            let out = &t["outputs"][i as usize];
            let Some(data) = t["outputs_data"][i as usize].as_str() else { continue };
            if out.is_null() {
                continue;
            }
            let Ok(out_lock) = serde_json::from_value::<rpc::Script>(out["lock"].clone()) else { continue };
            if packed::Script::from(out_lock).calc_script_hash() != lock_hash {
                continue;
            }
            let ty = &out["type"];
            if ty.is_null()
                || ty["code_hash"].as_str() != Some(NERVOS_DAO_CODE_HASH)
                || ty["hash_type"].as_str() != Some("type")
                || ty["args"].as_str() != Some("0x")
            {
                continue;
            }
            let out_point = packed::OutPoint::new_builder().tx_hash(byte32(&h).map_err(RpcError)?).index(i as u32).build();
            let cell = DaoCell {
                out_point,
                capacity: num(&out["capacity"], "output capacity")?,
                created_at: num(&o["block_number"], "get_transactions block_number")?,
            };
            let k = key(&h, i);
            match made.iter_mut().find(|(mk, _, _)| *mk == k) {
                Some(slot) => *slot = (k, cell, data.to_string()),
                None => made.push((k, cell, data.to_string())),
            }
        }
        if objects.len() < 100 {
            break;
        }
        cursor = Some(r["last_cursor"].clone());
    }
    let (mut deposits, mut withdrawing) = (Vec::new(), Vec::new());
    for (k, cell, data) in made {
        if spent.contains(&k) {
            continue;
        }
        if data == DAO_DEPOSIT_DATA {
            deposits.push(cell);
        } else {
            withdrawing.push(cell);
        }
    }
    let weight = deposits.iter().map(|c| u128::from(c.capacity)).sum();
    Ok(DaoWeight { weight, deposits, withdrawing })
}

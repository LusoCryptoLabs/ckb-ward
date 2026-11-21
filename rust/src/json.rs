//! Scripts and transactions as JSON, in the two forms a backend meets: CCC's (camelCase, what a
//! browser using CCC sends, and what the vectors in `tests/vectors` use) and the node's JSON RPC
//! form (snake_case). Both read; the template is written in CCC's form for wallets.
use ckb_jsonrpc_types as rpc;
use ckb_types::packed;
use serde_json::{Map, Value};

use crate::template::{proof_input, proof_template, ProofOptions};

const NUMERIC: &[&str] = &["version", "capacity", "since", "index"];

fn camel_to_snake(k: &str) -> String {
    let mut s = String::with_capacity(k.len() + 4);
    for c in k.chars() {
        if c.is_ascii_uppercase() {
            s.push('_');
            s.push(c.to_ascii_lowercase());
        } else {
            s.push(c);
        }
    }
    s
}

fn snake_to_camel(k: &str) -> String {
    let mut s = String::with_capacity(k.len());
    let mut up = false;
    for c in k.chars() {
        if c == '_' {
            up = true;
        } else if up {
            s.push(c.to_ascii_uppercase());
            up = false;
        } else {
            s.push(c);
        }
    }
    s
}

/// Keys to snake_case, `depGroup` to `dep_group`, numbers given as JSON numbers to hex, and the
/// fields CCC adds that the RPC form does not have (an input's cell, a transaction's hash) dropped.
///
/// An object that holds the same key in both spellings (`outputsData` and `outputs_data`) is an
/// error: the two readers would each take a different one.
fn to_rpc_form(v: &Value) -> Result<Value, String> {
    match v {
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, val) in m {
                let key = camel_to_snake(k);
                if matches!(key.as_str(), "cell_output" | "output_data" | "hash") {
                    continue;
                }
                if k == "depType" && val.as_str() == Some("dep_group") {
                    return Err("depType is code or depGroup (dep_group is the JSON RPC spelling, under dep_type)".into());
                }
                let val = match (key.as_str(), val) {
                    ("dep_type", Value::String(s)) if s == "depGroup" => Value::String("dep_group".into()),
                    (k, Value::Number(n)) if NUMERIC.contains(&k) => match n.as_u64() {
                        Some(n) => Value::String(format!("{n:#x}")),
                        None => val.clone(),
                    },
                    _ => to_rpc_form(val)?,
                };
                if out.insert(key.clone(), val).is_some() {
                    return Err(format!("the key {key} is written twice (camelCase and snake_case)"));
                }
            }
            Ok(Value::Object(out))
        }
        Value::Array(a) => Ok(Value::Array(a.iter().map(to_rpc_form).collect::<Result<_, _>>()?)),
        other => Ok(other.clone()),
    }
}

fn to_ccc_form(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, val)| {
                    let val = match (k.as_str(), val) {
                        ("dep_type", Value::String(s)) if s == "dep_group" => Value::String("depGroup".into()),
                        (_, val) => to_ccc_form(val),
                    };
                    (snake_to_camel(&k), val)
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(to_ccc_form).collect()),
        other => other,
    }
}

/// A script from JSON in either form.
pub fn script_from_json(v: &Value) -> Result<packed::Script, String> {
    let s: rpc::Script = serde_json::from_value(to_rpc_form(v)?).map_err(|e| format!("script: {e}"))?;
    Ok(s.into())
}

/// A transaction from JSON in either form.
pub fn transaction_from_json(v: &Value) -> Result<packed::Transaction, String> {
    let t: rpc::Transaction = serde_json::from_value(to_rpc_form(v)?).map_err(|e| format!("transaction: {e}"))?;
    Ok(t.into())
}

/// A script in the JSON RPC form.
pub fn script_to_rpc_json(s: &packed::Script) -> Value {
    serde_json::to_value(rpc::Script::from(s.clone())).expect("script serializes")
}

/// A transaction in the JSON RPC form.
pub fn transaction_to_rpc_json(t: &packed::Transaction) -> Value {
    serde_json::to_value(rpc::Transaction::from(t.clone())).expect("transaction serializes")
}

/// A transaction in CCC's JSON form (camelCase).
pub fn transaction_to_ccc_json(t: &packed::Transaction) -> Value {
    to_ccc_form(transaction_to_rpc_json(t))
}

/// The proof template in CCC's JSON form, for a wallet: `ccc.Transaction.from(json)` gives the same
/// transaction as the TypeScript `proofTemplate`, with the input's cell (capacity u64::MAX, the
/// lock, no type, no data) carried, so a signer computes the sighash without the chain.
pub fn template_json(lock: &packed::Script, message: &str, opts: &ProofOptions) -> Value {
    let tx = proof_template(lock, message, opts);
    let mut v = transaction_to_ccc_json(&tx);
    let (cell, _) = proof_input(lock);
    let cell = to_ccc_form(serde_json::to_value(rpc::CellOutput::from(cell)).expect("cell serializes"));
    let input = &mut v["inputs"][0];
    let mut cell_output = Map::new();
    cell_output.insert("capacity".into(), cell["capacity"].clone());
    cell_output.insert("lock".into(), cell["lock"].clone());
    input["cellOutput"] = Value::Object(cell_output);
    input["outputData"] = Value::String("0x".into());
    v
}

/// The bytes of a script's `args`.
pub fn args_of(s: &packed::Script) -> Vec<u8> {
    s.args().raw_data().to_vec()
}

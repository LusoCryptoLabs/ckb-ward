//! Verifies proofs given as JSON on stdin, one verdict per line on stdout.
//!
//!   cargo run --example verify < proofs.json
//!
//! The input is one object or an array of them:
//!   { "rpc": "https://testnet.ckb.dev/rpc",
//!     "lock": {...}, "message": "...", "tx": {...},        CCC's JSON form or the RPC form
//!     "expect": { "message": "...", "domain": "...", "account": "...", "nonce": "...",
//!                 "chain": "0x...", "maxAgeSeconds": 600, "now": "2026-11-21T12:00:00Z" } }
//! `now` is optional (the system clock). Each line is {"ok":true,"cycles":"...","cellDeps":[...]} or
//! {"ok":false,"reason":"..."}, or {"error":"..."} when the check could not be completed.
use std::io::Read;
use std::time::{Duration, UNIX_EPOCH};

use ckb_types::{prelude::*, H256};
use ckb_ward::{parse_time, verify_json, Expect, RpcClient, Verdict, VerifyOptions};
use serde_json::{json, Value};

fn expect_of(e: &Value) -> Result<Expect, String> {
    let s = |k: &str| e[k].as_str().filter(|v| !v.is_empty()).map(str::to_string).ok_or(format!("expect.{k} is required"));
    let chain = s("chain")?;
    if chain.len() != 66 || !chain.starts_with("0x") || !chain.is_char_boundary(2) {
        return Err("expect.chain is required".into());
    }
    let bytes: Vec<u8> =
        (2..chain.len()).step_by(2).map(|i| u8::from_str_radix(&chain[i..i + 2], 16)).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let now = match e["now"].as_str() {
        Some(t) => {
            let ms = parse_time(t).ok_or("expect.now must be a valid Date")?;
            Some(if ms >= 0 { UNIX_EPOCH + Duration::from_millis(ms as u64) } else { UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs()) })
        }
        None => None,
    };
    let max_age = e["maxAgeSeconds"].as_f64().filter(|a| a.is_finite() && *a >= 0.0).ok_or("expect.maxAgeSeconds is required")?;
    // A window longer than any time span is no limit at all.
    let max_age = Duration::try_from_secs_f64(max_age).unwrap_or(Duration::MAX);
    Ok(Expect {
        message: s("message")?,
        domain: s("domain")?,
        account: s("account")?,
        nonce: s("nonce")?,
        chain: H256::from_slice(&bytes).map_err(|_| "expect.chain is not 32 bytes")?,
        max_age,
        now,
    })
}

fn one(case: &Value) -> Value {
    let expect = match expect_of(&case["expect"]) {
        Ok(e) => e,
        // A missing or bad expectation is a refusal, in the words verify() uses.
        Err(e) => return json!({ "ok": false, "reason": e }),
    };
    let rpc = RpcClient::new(case["rpc"].as_str().unwrap_or("https://testnet.ckb.dev/rpc"));
    let message = case["message"].as_str().unwrap_or("");
    match verify_json(&case["lock"], message, &case["tx"], &expect, &rpc, &VerifyOptions::default(), |_| true) {
        Ok(Verdict::Accepted(a)) => json!({
            "ok": true,
            "cycles": a.cycles.to_string(),
            "cellDeps": a.cell_deps.iter().map(|o| { let i: u32 = o.index().unpack(); format!("0x{}:{i}", o.tx_hash().as_slice().iter().map(|b| format!("{b:02x}")).collect::<String>()) }).collect::<Vec<_>>(),
        }),
        Ok(Verdict::Refused(r)) => json!({ "ok": false, "reason": r.reason }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let v: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            println!("{}", json!({ "error": format!("stdin is not JSON: {e}") }));
            std::process::exit(1);
        }
    };
    let cases = match v {
        Value::Array(a) => a,
        other => vec![other],
    };
    for c in &cases {
        println!("{}", one(c));
    }
}

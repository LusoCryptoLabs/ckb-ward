//! A small binding server on testnet: the backend side of a Ward proof, in about a hundred lines.
//!
//!   cargo run --example bind_server -- [port]          (default 8787)
//!
//!   POST /nonce  {"account": "...", "lock": {...}}     -> {"nonce", "message", "template"}
//!   POST /bind   {"nonce": "...", "tx": {...}}         -> {"ok": true, "account", "lockHash", "cellDeps"}
//!                                                         or {"ok": false, "reason"}
//!   GET  /bindings                                     -> the bindings made so far
//!
//! The wallet signs `template` as it would any transaction spending a cell under the lock (CCC:
//! `signer.signOnlyTransaction(await signer.prepareTransaction(ccc.Transaction.from(template)))`)
//! and the page posts the signed transaction back with the nonce. Each nonce is issued for one
//! account and one lock, is good for ten minutes, and is used once: the server marks it used before
//! the first chain read (the claim_nonce callback), so a replay costs no chain read and no lock run.
//! In memory only; a real platform keeps nonces and bindings in its database.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ckb_types::{prelude::*, H256};
use ckb_ward::{iso_time, json, message, verify_json, Expect, RpcClient, Verdict, VerifyOptions, TESTNET_GENESIS};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

const DOMAIN: &str = "bind.example";
const RPC: &str = "https://testnet.ckb.dev/rpc";
const MAX_AGE: Duration = Duration::from_secs(600);

struct Issued {
    account: String,
    lock: Value,
    message: String,
    used: bool,
}

fn chain() -> H256 {
    let h = TESTNET_GENESIS;
    H256::from_slice(&(2..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect::<Vec<_>>()).unwrap()
}

fn random_nonce() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn issue(issued: &Mutex<HashMap<String, Issued>>, body: &Value) -> Result<Value, String> {
    let account = body["account"].as_str().ok_or("account missing")?.to_string();
    let lock = json::script_from_json(&body["lock"])?;
    let nonce = random_nonce();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    let text = message(DOMAIN, &account, &lock, &chain(), &iso_time(now), &nonce).map_err(|e| e.to_string())?;
    let template = json::template_json(&lock, &text, &Default::default());
    issued.lock().unwrap().insert(nonce.clone(), Issued { account, lock: body["lock"].clone(), message: text.clone(), used: false });
    Ok(json!({ "nonce": nonce, "message": text, "template": template }))
}

fn bind(issued: &Mutex<HashMap<String, Issued>>, bindings: &Mutex<Vec<Value>>, rpc: &RpcClient, body: &Value) -> Result<Value, String> {
    let nonce = body["nonce"].as_str().ok_or("nonce missing")?.to_string();
    let (account, lock, text) = {
        let map = issued.lock().unwrap();
        let i = map.get(&nonce).ok_or("unknown nonce")?;
        (i.account.clone(), i.lock.clone(), i.message.clone())
    };
    let expect = Expect {
        message: text.clone(),
        domain: DOMAIN.into(),
        account: account.clone(),
        nonce: nonce.clone(),
        chain: chain(),
        max_age: MAX_AGE,
        now: None,
    };
    // Compare-and-set: the nonce is used from here on, whether the proof is then accepted or not.
    let claim = |_: &ckb_ward::MessageFields| {
        let mut map = issued.lock().unwrap();
        match map.get_mut(&nonce) {
            Some(i) if !i.used => {
                i.used = true;
                true
            }
            _ => false,
        }
    };
    let verdict = verify_json(&lock, &text, &body["tx"], &expect, rpc, &VerifyOptions::default(), claim).map_err(|e| e.to_string())?;
    Ok(match verdict {
        Verdict::Accepted(a) => {
            let lock_hash = a.fields.lock_hash.clone();
            let deps: Vec<String> = a
                .cell_deps
                .iter()
                .map(|o| {
                    let i: u32 = o.index().unpack();
                    format!("0x{}:{i}", o.tx_hash().as_slice().iter().map(|b| format!("{b:02x}")).collect::<String>())
                })
                .collect();
            let b = json!({ "account": account, "lockHash": lock_hash, "cellDeps": deps, "cycles": a.cycles.to_string() });
            bindings.lock().unwrap().push(b.clone());
            json!({ "ok": true, "account": b["account"], "lockHash": b["lockHash"], "cellDeps": b["cellDeps"], "cycles": b["cycles"] })
        }
        Verdict::Refused(r) => json!({ "ok": false, "reason": r.reason }),
    })
}

fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(8787);
    let server = Server::http(("127.0.0.1", port)).expect("listen");
    let rpc = RpcClient::new(RPC);
    let issued = Mutex::new(HashMap::new());
    let bindings = Mutex::new(Vec::new());
    println!("listening on http://127.0.0.1:{port}");
    for mut req in server.incoming_requests() {
        let mut text = String::new();
        let _ = req.as_reader().read_to_string(&mut text);
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let result = match (req.method(), req.url()) {
            (Method::Post, "/nonce") => issue(&issued, &body),
            (Method::Post, "/bind") => bind(&issued, &bindings, &rpc, &body),
            (Method::Get, "/bindings") => Ok(Value::Array(bindings.lock().unwrap().clone())),
            _ => Err("not found".into()),
        };
        let (status, out) = match result {
            Ok(v) => (200, v),
            Err(e) => (400, json!({ "error": e })),
        };
        let header = Header::from_bytes("content-type", "application/json").unwrap();
        let _ = req.respond(Response::from_string(out.to_string()).with_status_code(status).with_header(header));
    }
}

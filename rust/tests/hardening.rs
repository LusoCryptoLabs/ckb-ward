// The hardening of the Rust crate, each with its control: a time that does not exist, a message that
// names another lock, JSON with one key written twice, a deadline, a lagging indexer, and an answer
// larger than the cap.
mod common;

use std::cell::RefCell;
use std::time::Duration;

use ckb_types::{bytes::Bytes, core::ScriptHashType, packed, prelude::*};
use ckb_ward::{
    dao_weight_at, deps_live_at, json, message, parse_message, proof_template, read_proof, verify, Proof, Rpc, RpcClient, RpcError, VerifyOptions,
    MAX_RPC_RESPONSE_BYTES,
};
use common::*;
use serde_json::{json, Value};

fn secp() -> Vector {
    vectors().into_iter().find(|v| v.file == "secp256k1.json").unwrap()
}

#[test]
fn issued_at_must_be_a_time_that_exists() {
    let v = secp();
    let f = parse_message(&v.message).unwrap();
    let at = |t: &str| v.message.replace(&f.issued_at, t);
    for bad in [
        "2026-02-29T00:00:00Z",
        "2026-02-30T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T24:00:00.000Z",
        "1900-02-29T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-00-10T00:00:00Z",
        "2026-01-00T00:00:00Z",
        "2026-01-01T23:60:00Z",
        "2026-01-01T23:59:60Z",
    ] {
        assert_eq!(parse_message(&at(bad)).unwrap_err().0, "bad issued at", "{bad}");
    }
    for ok in ["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "2026-04-30T23:59:59Z", "2026-12-31T23:59:59.123456789Z", "0000-01-01T00:00:00Z"] {
        assert_eq!(parse_message(&at(ok)).unwrap().issued_at, ok, "control {ok}");
    }
}

#[test]
fn read_proof_refuses_a_message_that_shows_another_locks_hash() {
    let mk = |b: u8| {
        packed::Script::new_builder().code_hash([0x9b; 32].pack()).hash_type(ScriptHashType::Type).args(Bytes::from(vec![b; 20]).pack()).build()
    };
    let (a, b) = (mk(0x11), mk(0x22));
    let v = secp();
    let f = parse_message(&v.message).unwrap();
    let text_a = message(&f.domain, &f.account, &a, &h256(&f.chain), &f.issued_at, &f.nonce).unwrap();
    assert!(read_proof(&proof_template(&a, &text_a, &Default::default()), &a).is_some(), "control: the message and the lock agree");
    // The transaction is for lock b and carries a message that shows lock a's hash line.
    assert!(read_proof(&proof_template(&b, &text_a, &Default::default()), &b).is_none());
}

#[test]
fn one_key_written_in_both_spellings_is_refused() {
    let v = secp();
    // control: the CCC spelling alone reads
    json::transaction_from_json(&v.raw["tx"]).expect("control");
    let mut tx = v.raw["tx"].clone();
    tx["outputs_data"] = json!(["0x"]);
    let e = json::transaction_from_json(&tx).unwrap_err();
    assert!(e.contains("outputs_data is written twice"), "{e}");
    let mut tx = v.raw["tx"].clone();
    tx["inputs"][0]["previous_output"] = tx["inputs"][0]["previousOutput"].clone();
    assert!(json::transaction_from_json(&tx).unwrap_err().contains("is written twice"));
    // the value dep_group belongs to the RPC spelling of the key, not to CCC's
    let mut tx = v.raw["tx"].clone();
    tx["cellDeps"][0]["depType"] = json!("dep_group");
    assert!(json::transaction_from_json(&tx).unwrap_err().contains("depType is code or depGroup"));
    // and the RPC spelling alone reads
    json::transaction_from_json(&json::transaction_to_rpc_json(&v.tx)).expect("control: rpc form");
}

struct Scripted {
    indexer: u64,
    calls: RefCell<Vec<String>>,
}

impl Rpc for Scripted {
    fn call(&self, method: &str, _params: Value) -> Result<Value, RpcError> {
        self.calls.borrow_mut().push(method.into());
        Ok(match method {
            "get_tip_header" => json!({ "number": "0x64", "epoch": "0x3739" }),
            "get_indexer_tip" => json!({ "block_number": format!("{:#x}", self.indexer), "block_hash": "0x" }),
            "get_block_hash" => json!(ckb_ward::TESTNET_GENESIS),
            _ => Value::Null,
        })
    }
}

#[test]
fn the_indexer_must_have_reached_the_snapshot_block() {
    let lock = secp().lock;
    let op = packed::OutPoint::new_builder().tx_hash([0x11; 32].pack()).index(0u32).build();
    let lag = Scripted { indexer: 80, calls: RefCell::new(vec![]) };
    let e = dao_weight_at(&lag, &lock, 100, 50).unwrap_err();
    assert_eq!(e.0, "the indexer is at block 80, behind the snapshot block 100");
    assert!(deps_live_at(&lag, std::slice::from_ref(&op), 100, 20).unwrap_err().0.contains("behind the snapshot"));
    assert!(!lag.calls.borrow().iter().any(|c| c == "get_transactions"), "no search by script ran on a lagging indexer");
    // control: a caught up indexer lets the search start (the scripted node has no history: weight 0)
    let ok = Scripted { indexer: 100, calls: RefCell::new(vec![]) };
    assert_eq!(dao_weight_at(&ok, &lock, 100, 50).map(|w| w.weight), Ok(0));
    assert!(ok.calls.borrow().iter().any(|c| c == "get_transactions"));
}

#[test]
fn reads_stop_at_the_deadline() {
    let v = secp();
    let opts = |d: Duration| VerifyOptions { deadline: d, ..Default::default() };
    let go = |o: &VerifyOptions| {
        let node = Scripted { indexer: 100, calls: RefCell::new(vec![]) };
        let r = verify(&Proof { lock: v.lock.clone(), message: v.message.clone(), tx: v.tx.clone() }, &expect_for(&v.message), &node, o, |_| true);
        (r, node.calls.into_inner())
    };
    let (late, calls) = go(&opts(Duration::ZERO));
    let e = late.unwrap_err();
    assert!(e.to_string().contains("the time allowed for this verification has passed"), "{e}");
    assert!(calls.is_empty(), "no read was sent after the deadline: {calls:?}");
    // control: with time, the first read goes out (the scripted node has no cells, so the proof is refused later)
    let (ok, calls) = go(&opts(Duration::from_secs(60)));
    assert_eq!(calls.first().map(String::as_str), Some("get_block_hash"));
    assert!(ok.is_ok());
}

#[test]
fn an_answer_larger_than_the_cap_is_refused_a_smaller_one_is_read() {
    let serve = |bytes: usize| {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let body = format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"{}\"}}", "x".repeat(bytes));
                let _ = req.respond(tiny_http::Response::from_string(body));
            }
        });
        url
    };
    let big = serve(MAX_RPC_RESPONSE_BYTES as usize + 1);
    let e = RpcClient::new(big).call("get_tip_header", json!([])).unwrap_err();
    assert!(e.0.contains("larger than"), "{e}");
    let small = serve(1024 * 1024);
    let r = RpcClient::new(small).call("get_tip_header", json!([])).expect("control: 1 MB is read");
    assert_eq!(r.as_str().unwrap().len(), 1024 * 1024);
}

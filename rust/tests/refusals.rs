// Every refusal of verify(), each with the text the TypeScript verifier gives. The free checks run
// against a chain that panics when read; the chain checks against a scripted node.
mod common;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::Duration;

use ckb_types::{bytes::Bytes, core::ScriptHashType, packed, prelude::*, H256};
use ckb_ward::{json, message, verify, verify_json, Expect, Proof, Rpc, RpcError, Verdict, VerifyError, VerifyOptions, TESTNET_GENESIS};
use common::*;
use serde_json::{json, Value};

fn base() -> (Vector, Expect) {
    let v = vectors().into_iter().find(|v| v.file == "secp256k1.json").unwrap();
    let e = expect_for(&v.message);
    (v, e)
}

fn proof(v: &Vector) -> Proof {
    Proof { lock: v.lock.clone(), message: v.message.clone(), tx: v.tx.clone() }
}

fn refused_free(p: &Proof, e: &Expect, opts: &VerifyOptions) -> String {
    let claimed = Cell::new(false);
    let r = verify(p, e, &NoChain, opts, |_| {
        claimed.set(true);
        false
    })
    .unwrap();
    let reason = r.reason().expect("refused").to_string();
    // A free refusal comes before the nonce is claimed; past every free check, the claim refuses.
    assert_eq!(claimed.get(), reason == "nonce already used", "{reason}");
    reason
}

fn reason(p: &Proof, e: &Expect) -> String {
    refused_free(p, e, &VerifyOptions::default())
}

fn with_cell_deps(tx: &packed::Transaction, deps: Vec<packed::CellDep>) -> packed::Transaction {
    let raw = tx.raw().as_builder().cell_deps(deps.pack()).build();
    tx.clone().as_builder().raw(raw).build()
}

fn dep(tx_hash: u8, index: u32, group: bool) -> packed::CellDep {
    let op = packed::OutPoint::new_builder().tx_hash([tx_hash; 32].pack()).index(index).build();
    packed::CellDep::new_builder().out_point(op).dep_type(if group { 1u8 } else { 0u8 }).build()
}

#[test]
fn expect_fields_are_required() {
    let (v, e) = base();
    for (k, f) in [
        ("message", Expect { message: String::new(), ..e.clone() }),
        ("domain", Expect { domain: String::new(), ..e.clone() }),
        ("account", Expect { account: String::new(), ..e.clone() }),
        ("nonce", Expect { nonce: String::new(), ..e.clone() }),
    ] {
        assert_eq!(reason(&proof(&v), &f), format!("expect.{k} is required"));
    }
}

#[test]
fn malformed_proofs() {
    let (v, e) = base();
    assert_eq!(reason(&Proof { message: "hello".into(), ..proof(&v) }, &e), "malformed proof: expected 6 lines");
    let bad = verify_json(&v.raw["lock"], &v.message, &json!({ "version": "0x0" }), &e, &NoChain, &VerifyOptions::default(), |_| true).unwrap();
    assert!(bad.reason().unwrap().starts_with("malformed proof: transaction:"), "{bad:?}");
    let bad = verify_json(&json!({ "codeHash": "0x00" }), &v.message, &v.raw["tx"], &e, &NoChain, &VerifyOptions::default(), |_| true).unwrap();
    assert!(bad.reason().unwrap().starts_with("malformed proof: script:"), "{bad:?}");
    // The same proof as JSON reaches the nonce: both forms parse.
    let ok = verify_json(&v.raw["lock"], &v.message, &v.raw["tx"], &e, &NoChain, &VerifyOptions::default(), |_| false).unwrap();
    assert_eq!(ok.reason(), Some("nonce already used"));
    let rpc_form = json::transaction_to_rpc_json(&v.tx);
    let ok = verify_json(&json::script_to_rpc_json(&v.lock), &v.message, &rpc_form, &e, &NoChain, &VerifyOptions::default(), |_| false).unwrap();
    assert_eq!(ok.reason(), Some("nonce already used"));
}

#[test]
fn the_message_must_name_the_lock() {
    let (v, e) = base();
    let other = v.lock.clone().as_builder().args(Bytes::from(vec![7u8; 20]).pack()).build();
    assert_eq!(reason(&Proof { lock: other, ..proof(&v) }, &e), "message names another lock");
}

#[test]
fn omnilock_in_administrator_mode_is_refused() {
    let (_, e) = base();
    let omni = |flags: u8| {
        let mut args = vec![0u8; 21];
        args[0] = 0x00;
        args.push(flags);
        args.extend([0u8; 32]);
        packed::Script::new_builder()
            .code_hash(packed::Byte32::from_slice(&hexbytes("0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb")).unwrap())
            .hash_type(ScriptHashType::Type)
            .args(Bytes::from(args).pack())
            .build()
    };
    for (flags, admin) in [(1u8, true), (3, true), (0, false), (2, false)] {
        let lock = omni(flags);
        let f = ckb_ward::parse_message(&e.message).unwrap();
        let msg = message(&f.domain, &f.account, &lock, &h256(&f.chain), &f.issued_at, &f.nonce).unwrap();
        let tx =
            ckb_ward::proof_template(&lock, &msg, &Default::default()).as_builder().witnesses(vec![Bytes::from(vec![0u8; 85]).pack()].pack()).build();
        let r = reason(&Proof { lock, message: msg.clone(), tx }, &Expect { message: msg, ..e.clone() });
        if admin {
            assert_eq!(r, "omnilock in administrator mode: an administrator can sign for it");
        } else {
            // Control: without the flag the same lock passes every free check.
            assert_eq!(r, "nonce already used", "flags {flags}");
        }
    }
}

#[test]
fn the_message_must_be_the_one_issued() {
    let (v, e) = base();
    let p = proof(&v);
    assert_eq!(reason(&p, &Expect { message: format!("{}x", e.message), ..e.clone() }), "message is not the one issued");
    assert_eq!(reason(&p, &Expect { domain: "other.example".into(), ..e.clone() }), "message is for another domain");
    assert_eq!(reason(&p, &Expect { account: "user-43".into(), ..e.clone() }), "message is for another account");
    assert_eq!(reason(&p, &Expect { nonce: "other".into(), ..e.clone() }), "message has another nonce");
    assert_eq!(reason(&p, &Expect { chain: H256([1; 32]), ..e.clone() }), "message names another chain");
}

#[test]
fn the_message_must_be_recent() {
    let (v, e) = base();
    let p = proof(&v);
    let issued = e.now.unwrap() - Duration::from_secs(60);
    let at = |secs: i64| Expect {
        now: Some(if secs >= 0 { issued + Duration::from_secs(secs as u64) } else { issued - Duration::from_secs((-secs) as u64) }),
        ..e.clone()
    };
    assert_eq!(reason(&p, &at(600)), "nonce already used"); // exactly max_age: still accepted
    assert_eq!(reason(&p, &at(601)), "message expired");
    assert_eq!(reason(&p, &at(-60)), "nonce already used"); // the allowed clock skew
    assert_eq!(reason(&p, &at(-61)), "message issued in the future");
    let ms = Expect { now: Some(issued + Duration::from_millis(600_001)), ..e.clone() };
    assert_eq!(reason(&p, &ms), "message expired");
}

#[test]
fn shape_and_size_limits() {
    let (v, e) = base();
    let p = proof(&v);
    let w = v.tx.witnesses().get(0).unwrap();
    let two = v.tx.clone().as_builder().witnesses(vec![w.clone(), w.clone()].pack()).build();
    assert_eq!(reason(&Proof { tx: two, ..p.clone() }, &e), "exactly one witness expected");
    let none = v.tx.clone().as_builder().witnesses(Vec::<packed::Bytes>::new().pack()).build();
    assert_eq!(reason(&Proof { tx: none, ..p.clone() }, &e), "exactly one witness expected");

    let small = VerifyOptions { max_witness_bytes: w.raw_data().len() - 1, ..Default::default() };
    assert_eq!(refused_free(&p, &e, &small), "witness too large");
    let exact = VerifyOptions { max_witness_bytes: w.raw_data().len(), ..Default::default() };
    assert_eq!(refused_free(&p, &e, &exact), "nonce already used");

    // The transaction limit counts the bytes plus 4, as a block does.
    let size = v.tx.as_slice().len();
    let roomy = VerifyOptions { max_witness_bytes: 1 << 20, ..Default::default() };
    let grow = |n: usize| with_witness(&v.tx, vec![0u8; w.raw_data().len() + n]);
    let fits = grow(597_000 - 4 - size);
    assert_eq!(fits.as_slice().len() + 4, 597_000);
    assert_eq!(refused_free(&Proof { tx: fits, ..p.clone() }, &e, &roomy), "nonce already used");
    assert_eq!(refused_free(&Proof { tx: grow(597_000 - 3 - size), ..p.clone() }, &e, &roomy), "transaction too large");

    let listed: Vec<packed::CellDep> = v.tx.raw().cell_deps().into_iter().collect();
    let mut sixteen = listed.clone();
    sixteen.extend((0..16 - listed.len() as u8).map(|i| dep(0xa0 + i, 0, false)));
    assert_eq!(reason(&Proof { tx: with_cell_deps(&v.tx, sixteen.clone()), ..p.clone() }, &e), "nonce already used");
    let mut seventeen = sixteen;
    seventeen.push(dep(0xff, 0, false));
    assert_eq!(reason(&Proof { tx: with_cell_deps(&v.tx, seventeen), ..p.clone() }, &e), "too many cell deps");

    let headers = |n: u8| {
        let raw =
            v.tx.raw().as_builder().header_deps((0..n).map(|i| packed::Byte32::from_slice(&[i; 32]).unwrap()).collect::<Vec<_>>().pack()).build();
        v.tx.clone().as_builder().raw(raw).build()
    };
    assert_eq!(reason(&Proof { tx: headers(8), ..p.clone() }, &e), "nonce already used");
    assert_eq!(reason(&Proof { tx: headers(9), ..p.clone() }, &e), "too many header deps");

    let mut twice = listed.clone();
    twice.push(listed[0].clone());
    let r = reason(&Proof { tx: with_cell_deps(&v.tx, twice), ..p.clone() }, &e);
    assert!(r.starts_with("cell dep 0x") && r.ends_with(":0 is listed twice"), "{r}");
}

#[test]
fn only_the_template_is_accepted() {
    let (v, e) = base();
    let raw = v.tx.raw();
    let out = raw.outputs().get(0).unwrap();
    let cap: u64 = out.capacity().unpack();
    let changed = raw.clone().as_builder().outputs(vec![out.as_builder().capacity(cap + 1).build()].pack()).build();
    let tx = v.tx.clone().as_builder().raw(changed).build();
    assert_eq!(reason(&Proof { tx, ..proof(&v) }, &e), "not the proof template for this lock and message");
    // since and header deps are the prover's: changing them keeps the template.
    let input = raw.inputs().get(0).unwrap().as_builder().since(5u64).build();
    let tx = v.tx.clone().as_builder().raw(raw.as_builder().inputs(vec![input].pack()).build()).build();
    assert_eq!(reason(&Proof { tx, ..proof(&v) }, &e), "nonce already used");
}

#[test]
fn the_nonce_is_claimed_once_and_only_after_the_free_checks() {
    let (v, e) = base();
    let calls = Cell::new(0);
    let seen = RefCell::new(None);
    let r = verify(&proof(&v), &e, &NoChain, &VerifyOptions::default(), |f| {
        calls.set(calls.get() + 1);
        *seen.borrow_mut() = Some(f.clone());
        false
    })
    .unwrap();
    assert_eq!(r.reason(), Some("nonce already used"));
    assert_eq!(calls.get(), 1);
    assert_eq!(seen.into_inner().unwrap().nonce, e.nonce);
}

#[test]
fn a_chain_with_no_consensus_is_an_error() {
    let (v, e) = base();
    let f = ckb_ward::parse_message(&e.message).unwrap();
    let chain = H256([9; 32]);
    let msg = message(&f.domain, &f.account, &v.lock, &chain, &f.issued_at, &f.nonce).unwrap();
    let tx = ckb_ward::proof_template(&v.lock, &msg, &Default::default()).as_builder().witnesses(v.tx.witnesses()).build();
    let r = verify(
        &Proof { lock: v.lock.clone(), message: msg.clone(), tx },
        &Expect { message: msg, chain, ..e },
        &NoChain,
        &VerifyOptions::default(),
        |_| panic!("claimed"),
    );
    assert!(matches!(r, Err(VerifyError::NoConsensus(_))), "{r:?}");
}

/// A scripted node: the genesis it reports, the cells and headers it has, and every call made.
struct Node {
    genesis: String,
    cells: HashMap<String, Value>,
    headers: HashMap<String, Value>,
    calls: RefCell<Vec<String>>,
    fail: bool,
}

impl Node {
    fn new() -> Self {
        Node { genesis: TESTNET_GENESIS.into(), cells: HashMap::new(), headers: HashMap::new(), calls: RefCell::new(vec![]), fail: false }
    }
}

impl Rpc for Node {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.calls.borrow_mut().push(format!("{method} {params}"));
        if self.fail {
            return Err(RpcError(format!("{method}: connection refused")));
        }
        Ok(match method {
            "get_block_hash" => json!(self.genesis),
            "get_live_cell" => {
                let k = format!("{}:{}", params[0]["tx_hash"].as_str().unwrap(), params[0]["index"].as_str().unwrap());
                self.cells.get(&k).cloned().unwrap_or(json!({ "cell": null, "status": "unknown" }))
            }
            "get_header" => self.headers.get(params[0].as_str().unwrap()).cloned().unwrap_or(Value::Null),
            "get_tip_header" => json!({ "epoch": "0x7080291000049", "number": "0x1" }),
            m => panic!("unexpected {m}"),
        })
    }
}

fn live(data: &[u8]) -> Value {
    json!({ "status": "live", "cell": { "output": { "capacity": "0x0", "lock": { "code_hash": format!("0x{}", "00".repeat(32)), "hash_type": "data", "args": "0x" }, "type": null }, "data": { "content": format!("0x{}", data.iter().map(|b| format!("{b:02x}")).collect::<String>()), "hash": format!("0x{}", "00".repeat(32)) } } })
}

fn chain_reason(p: &Proof, e: &Expect, node: &Node) -> Result<Verdict, VerifyError> {
    verify(p, e, node, &VerifyOptions::default(), |_| true)
}

fn key(d: &packed::CellDep) -> String {
    let i: u32 = d.out_point().index().unpack();
    format!("0x{}:{:#x}", d.out_point().tx_hash().as_slice().iter().map(|b| format!("{b:02x}")).collect::<String>(), i)
}

#[test]
fn chain_refusals() {
    let (v, e) = base();
    let p = proof(&v);
    let listed: Vec<packed::CellDep> = v.tx.raw().cell_deps().into_iter().collect();

    let mut node = Node::new();
    node.genesis = ckb_ward::MAINNET_GENESIS.into();
    assert_eq!(chain_reason(&p, &e, &node).unwrap().reason(), Some("the node is on another chain"));

    let node = Node::new(); // has no cells
    let r = chain_reason(&p, &e, &node).unwrap();
    assert!(r.reason().unwrap().ends_with(":0 is not live (unknown)"), "{r:?}");

    let mut node = Node::new();
    node.cells.insert(key(&listed[0]), json!({ "cell": null, "status": "dead" }));
    assert!(chain_reason(&p, &e, &node).unwrap().reason().unwrap().ends_with(" is not live (dead)"));

    // The secp256k1 vector's dep is a dep group: data that is not a list of out points is refused.
    assert_eq!(u8::from(listed[0].dep_type()), 1);
    let mut node = Node::new();
    node.cells.insert(key(&listed[0]), live(&[1, 0, 0, 0, 9]));
    let r = chain_reason(&p, &e, &node).unwrap();
    assert!(r.reason().unwrap().ends_with(":0 is not a dep group"), "{r:?}");

    // A group listing 33 cells is refused before any member is read.
    let mut data = 33u32.to_le_bytes().to_vec();
    for i in 0..33u8 {
        data.extend([i; 32]);
        data.extend(0u32.to_le_bytes());
    }
    let mut node = Node::new();
    node.cells.insert(key(&listed[0]), live(&data));
    let r = chain_reason(&p, &e, &node).unwrap();
    assert_eq!(r.reason(), Some("cell dep groups list more than 32 cells"));
    assert_eq!(node.calls.borrow().iter().filter(|c| c.starts_with("get_live_cell")).count(), 1);

    // A header dep the node does not have.
    let raw = v.tx.raw().as_builder().header_deps(vec![packed::Byte32::from_slice(&[5; 32]).unwrap()].pack()).build();
    let tx = v.tx.clone().as_builder().raw(raw).build();
    let mut node = Node::new();
    let members = 1u32.to_le_bytes().iter().copied().chain([2u8; 32]).chain(0u32.to_le_bytes()).collect::<Vec<_>>();
    node.cells.insert(key(&listed[0]), live(&members));
    node.cells.insert(format!("0x{}:0x0", "02".repeat(32)), live(&[0]));
    let r = chain_reason(&Proof { tx, ..p.clone() }, &e, &node).unwrap();
    assert_eq!(r.reason(), Some(format!("header dep 0x{} is not live (unknown)", "05".repeat(32)).as_str()));

    // A node that cannot be reached is an error, not a refusal.
    let mut node = Node::new();
    node.fail = true;
    assert!(matches!(chain_reason(&p, &e, &node), Err(VerifyError::Rpc(_))));
}

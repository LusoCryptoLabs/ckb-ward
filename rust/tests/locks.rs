// Locks assembled by ../tests/elf.ts (fixtures/elf.json, made by fixtures/make-elf.ts), their code
// cells served by a scripted node, run by the crate's own VM. Each refusal comes with its control:
// the same proof with the probes off is accepted, so the probe is what refuses.
mod common;

use std::cell::RefCell;
use std::collections::HashMap;

use ckb_types::{bytes::Bytes, core::ScriptHashType, packed, prelude::*, H256};
use ckb_ward::{iso_time, message, proof_template, Expect, Proof, ProofOptions, Rpc, RpcError, Verdict, VerifyOptions, TESTNET_GENESIS};
use common::*;
use serde_json::{json, Value};

fn elf(name: &str) -> Vec<u8> {
    let all: Value = serde_json::from_str(include_str!("fixtures/elf.json")).unwrap();
    hexbytes(all[name].as_str().unwrap())
}

const NOW_MS: i64 = 1_795_000_000_000;

/// A node with one code cell and the headers it is given.
struct Node {
    code: (String, Vec<u8>),
    headers: HashMap<String, Value>,
    calls: RefCell<Vec<String>>,
}

impl Rpc for Node {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.calls.borrow_mut().push(method.into());
        Ok(match method {
            "get_block_hash" => json!(TESTNET_GENESIS),
            // A testnet epoch of 2026-11-05, after the 2023 hardfork, like the tip.
            "get_tip_header" => json!({ "epoch": "0x3739", "number": "0x15f0000" }),
            "get_live_cell" => {
                let k = format!("{}:{}", params[0]["tx_hash"].as_str().unwrap(), params[0]["index"].as_str().unwrap());
                if k != self.code.0 {
                    return Ok(json!({ "cell": null, "status": "unknown" }));
                }
                let data: String = self.code.1.iter().map(|b| format!("{b:02x}")).collect();
                json!({ "status": "live", "cell": {
                    "output": { "capacity": "0x174876e800", "lock": { "code_hash": format!("0x{}", "9b".repeat(32)), "hash_type": "type", "args": "0x" }, "type": null },
                    "data": { "content": format!("0x{data}"), "hash": format!("0x{}", "00".repeat(32)) } } })
            }
            "get_header" => self.headers.get(params[0].as_str().unwrap()).cloned().unwrap_or(Value::Null),
            m => panic!("unexpected {m}"),
        })
    }
}

struct Case {
    node: Node,
    proof: Proof,
    expect: Expect,
}

fn case(bin: Vec<u8>, account: &str, witness: &[u8], opts: ProofOptions) -> Case {
    let dep_tx = [0x7au8; 32];
    let dep =
        packed::CellDep::new_builder().out_point(packed::OutPoint::new_builder().tx_hash(dep_tx.pack()).index(0u32).build()).dep_type(0u8).build();
    let lock = packed::Script::new_builder()
        .code_hash(ckb_hash::blake2b_256(&bin).pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::new().pack())
        .build();
    let chain = H256::from_slice(&hexbytes(TESTNET_GENESIS)).unwrap();
    let text = message("dao.example", account, &lock, &chain, &iso_time(NOW_MS), &format!("n-{account}")).unwrap();
    let tpl = proof_template(&lock, &text, &opts);
    let raw = tpl.raw().as_builder().cell_deps(vec![dep].pack()).build();
    let tx = tpl.as_builder().raw(raw).witnesses(vec![Bytes::copy_from_slice(witness).pack()].pack()).build();
    let mut expect = expect_for(&text);
    expect.now = Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(NOW_MS as u64 + 1000));
    let node = Node { code: (format!("0x{}:0x0", "7a".repeat(32)), bin), headers: HashMap::new(), calls: RefCell::new(vec![]) };
    Case { node, proof: Proof { lock, message: text, tx }, expect }
}

fn run(c: &Case, probes: bool) -> Verdict {
    ckb_ward::verify(&c.proof, &c.expect, &c.node, &VerifyOptions { probes, max_cycles: 2_000_000, ..Default::default() }, |_| true).unwrap()
}

#[test]
fn an_always_success_lock_is_refused_it_opens_with_an_empty_witness() {
    let c = case(elf("alwaysSuccess"), "mallory", b"", ProofOptions::default());
    assert_eq!(run(&c, true).reason(), Some("no exclusive control: the lock opens with an empty witness"));
    assert!(run(&c, false).is_accepted(), "control: probes off, accepted");
}

#[test]
fn a_password_lock_is_refused_the_same_witness_opens_another_message() {
    let c = case(elf("passwordOpen"), "alice", b"open", ProofOptions::default());
    assert_eq!(run(&c, true).reason(), Some("no exclusive control: the same witness opens another message"));
    assert!(run(&c, false).is_accepted(), "control: probes off, accepted");
    // The lock is not open to anyone: without the password it refuses.
    let none = case(elf("passwordOpen"), "mallory", b"", ProofOptions::default());
    assert_eq!(run(&none, false).reason(), Some("lock exited 2"));
}

#[test]
fn a_lock_that_never_ends_stops_at_the_cycle_limit() {
    let c = case(elf("endlessLoop"), "loop", b"", ProofOptions::default());
    let r = run(&c, false);
    let reason = r.reason().unwrap();
    assert!(reason.starts_with("lock did not run: "), "{reason}");
    assert!(reason.contains("max cycles exceeded"), "{reason}");
}

#[test]
fn the_debuggers_own_syscall_does_not_exist_here() {
    // ckb-debugger adds syscall 9001 for development; a node does not have it, and neither does this VM.
    let c = case(elf("debuggerSyscall"), "dbg", b"", ProofOptions::default());
    let reason = run(&c, false).reason().unwrap().to_string();
    assert!(reason.starts_with("lock did not run: ") && reason.contains("9001"), "{reason}");
}

#[test]
fn a_since_the_lock_needs_is_carried() {
    let low = case(elf("since100"), "s0", b"", ProofOptions { since: 0, ..Default::default() });
    assert_eq!(run(&low, false).reason(), Some("lock exited 24"));
    let high = case(elf("since100"), "s1", b"", ProofOptions { since: 100, ..Default::default() });
    assert!(run(&high, false).is_accepted(), "the since the wallet sets reaches the lock");
    // It reads no signature, so the probes refuse it on their own.
    assert!(run(&high, true).reason().unwrap().starts_with("no exclusive control"));
}

#[test]
fn a_header_the_lock_needs_is_read_from_the_node() {
    let header = ckb_types::core::HeaderView::new_advanced_builder()
        .number(1234u64)
        .epoch(ckb_types::core::EpochNumberWithFraction::new(10, 0, 1000).pack())
        .compact_target(0x1d00ffffu32)
        .build();
    let hash = header.hash();
    let opts = ProofOptions { header_deps: vec![hash.clone()], ..Default::default() };
    let mut c = case(elf("headerLock"), "h", b"", opts.clone());
    let key = format!("0x{}", hash.as_slice().iter().map(|b| format!("{b:02x}")).collect::<String>());
    // Without the header on the node: refused before the lock runs.
    assert_eq!(run(&c, false).reason(), Some(format!("header dep {key} is not live (unknown)").as_str()));
    c.node.headers.insert(key, serde_json::to_value(ckb_jsonrpc_types::HeaderView::from(header)).unwrap());
    assert!(run(&c, false).is_accepted());
    // Control: with no header dep the lock cannot load one.
    let none = case(elf("headerLock"), "h0", b"", ProofOptions::default());
    assert_eq!(run(&none, false).reason(), Some("lock exited 7"));
}

#[test]
fn what_a_lock_prints_is_kept() {
    let c = case(elf("printHelloExit0"), "p", b"", ProofOptions::default());
    let deps = ckb_ward::verify::resolve_cell_deps(&c.node, &c.proof.tx.raw().cell_deps().into_iter().collect::<Vec<_>>(), 32).unwrap();
    let consensus = ckb_ward::consensus_for(&H256::from_slice(&hexbytes(TESTNET_GENESIS)).unwrap()).unwrap().unwrap();
    let r = ckb_ward::run::run_lock(&c.proof.tx, &c.proof.lock, &deps, &[], consensus, 14137, 1_000_000).unwrap();
    assert_eq!(r.code, Some(0));
    assert_eq!(r.output, "hello\n");
}

#[test]
fn a_proof_without_its_lock_code_is_refused_not_an_error() {
    // The prover chose the deps; leaving the lock's code out is the prover's doing, so it is a
    // refusal, not an error a backend would retry.
    let mut c = case(elf("alwaysSuccess"), "nodeps", b"", ProofOptions::default());
    let raw = c.proof.tx.raw().as_builder().cell_deps(Vec::<packed::CellDep>::new().pack()).build();
    c.proof.tx = c.proof.tx.clone().as_builder().raw(raw).build();
    let r = ckb_ward::verify(&c.proof, &c.expect, &c.node, &VerifyOptions::default(), |_| true).expect("a verdict, not an error");
    let reason = r.reason().unwrap();
    assert!(reason.starts_with("lock did not run: ") && reason.contains("ScriptNotFound"), "{reason}");
}

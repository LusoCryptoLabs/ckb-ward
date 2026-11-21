// The 17 signed proofs of ../tests/vectors, through this crate: the template, verify() accepting
// each, and the controls each must refuse, with the exit codes the TypeScript suite asserts.
mod common;

use ckb_types::{bytes::Bytes, packed, prelude::*};
use ckb_ward::{
    json, proof_out_point, proof_template, read_proof, run::run_lock, tip_epoch, verify, verify::resolve_cell_deps, Proof, Verdict, VerifyOptions,
    MAX_DEP_GROUP_MEMBERS,
};
use common::*;

fn proof(v: &Vector) -> Proof {
    Proof { lock: v.lock.clone(), message: v.message.clone(), tx: v.tx.clone() }
}

fn show(r: &Verdict) -> String {
    match r {
        Verdict::Accepted(a) => format!("ACCEPTED, cycles {}", a.cycles),
        Verdict::Refused(r) => format!("REFUSED, {}", r.reason),
    }
}

/// Runs the lock on a transaction directly, skipping the verifier's template check.
fn run_raw(v: &Vector, tx: &packed::Transaction, extra: Option<ckb_ward::run::DepCell>, skip: Option<&packed::OutPoint>) -> ckb_ward::LockRun {
    let rpc = chain(&v.network);
    let deps: Vec<packed::CellDep> = tx.raw().cell_deps().into_iter().filter(|d| Some(&d.out_point()) != skip).collect();
    let mut cells = resolve_cell_deps(&rpc, &deps, MAX_DEP_GROUP_MEMBERS).unwrap_or_else(|e| panic!("{}: deps: {e:?}", v.name));
    cells.extend(extra);
    let chain_hash = h256(&ckb_ward::parse_message(&v.message).unwrap().chain);
    let consensus = ckb_ward::consensus_for(&chain_hash).unwrap().unwrap();
    run_lock(tx, &v.lock, &cells, &[], consensus, tip_epoch(&rpc).unwrap(), ckb_ward::DEFAULT_MAX_CYCLES).unwrap()
}

#[test]
fn template_matches_every_signed_proof() {
    let all = vectors();
    assert_eq!(all.len(), 17);
    for v in &all {
        let input = v.tx.raw().inputs().get(0).unwrap();
        assert_eq!(input.previous_output(), proof_out_point(&v.lock, &v.message), "{}: out point", v.name);
        let fields = read_proof(&v.tx, &v.lock).unwrap_or_else(|| panic!("{}: read_proof", v.name));
        assert_eq!(fields, ckb_ward::parse_message(&v.message).unwrap());
        // The template handed to a wallet, read back, with the wallet's cell deps, since and
        // header deps, has the signed transaction's hash.
        let tpl = json::transaction_from_json(&json::template_json(&v.lock, &v.message, &Default::default())).unwrap();
        assert_eq!(tpl.calc_tx_hash(), proof_template(&v.lock, &v.message, &Default::default()).calc_tx_hash());
        let raw = tpl.raw().as_builder().cell_deps(v.tx.raw().cell_deps()).build();
        assert_eq!(tpl.as_builder().raw(raw).build().calc_tx_hash(), v.tx.calc_tx_hash(), "{}: template hash", v.name);
        // read_proof refuses another lock and another message.
        let other_lock = v.lock.clone().as_builder().args(Bytes::from(vec![1u8; 20]).pack()).build();
        assert!(read_proof(&v.tx, &other_lock).is_none(), "{}", v.name);
    }
}

#[test]
fn every_vector_is_accepted() {
    for v in vectors() {
        let r = verify(&proof(&v), &expect_for(&v.message), &chain(&v.network), &VerifyOptions::default(), |_| true).unwrap();
        println!("{}: {}", v.name, show(&r));
        let Verdict::Accepted(a) = r else { panic!("{}: {}", v.name, show(&r)) };
        // The deps it used, for the binding to record: every listed dep, plus dep group members.
        for d in v.tx.raw().cell_deps() {
            assert!(a.cell_deps.contains(&d.out_point()), "{}: dep missing from the result", v.name);
        }
        assert!(a.cycles > 0);
    }
    save_fixture();
}

#[test]
fn another_message_is_refused_by_the_template_and_by_the_lock() {
    for v in vectors() {
        let other = other_message(&v.message);
        let r = verify(&Proof { message: other.clone(), ..proof(&v) }, &expect_for(&other), &chain(&v.network), &VerifyOptions::default(), |_| true)
            .unwrap();
        assert_eq!(r.reason(), Some("not the proof template for this lock and message"), "{}", v.name);
        // The lock refuses it as well: the same witness on the other message's template.
        let tpl = proof_template(&v.lock, &other, &Default::default());
        let raw = tpl.raw().as_builder().cell_deps(v.tx.raw().cell_deps()).build();
        let tpl = tpl.as_builder().raw(raw).witnesses(v.tx.witnesses()).build();
        let run = run_raw(&v, &tpl, None, None);
        println!("{}: other message, lock run directly: exit {:?}", v.name, run.code);
        assert_eq!(run.code, Some(v.other_message_exit), "{}", v.name);
    }
    save_fixture();
}

#[test]
fn the_empty_witness_probe_is_refused_by_every_lock() {
    for v in vectors() {
        let run = run_raw(&v, &with_witness(&v.tx, vec![]), None, None);
        assert_ne!(run.code, Some(0), "{}", v.name);
    }
    save_fixture();
}

#[test]
fn one_signature_bit_flipped_is_refused() {
    for v in vectors() {
        let tx = flip_witness_byte(&v.tx, v.signature_byte);
        let r = verify(&Proof { tx, ..proof(&v) }, &expect_for(&v.message), &chain(&v.network), &VerifyOptions::default(), |_| true).unwrap();
        println!("{}: {}", v.name, show(&r));
        assert_eq!(r.reason(), Some(format!("lock exited {}", v.signature_flip_exit).as_str()), "{}", v.name);
    }
    save_fixture();
}

#[test]
fn every_control_is_refused() {
    let mut n = 0;
    for v in vectors() {
        let Some(controls) = v.raw["controls"].as_object() else { continue };
        for (name, c) in controls {
            n += 1;
            let tx = json::transaction_from_json(&c["tx"]).unwrap();
            let r = verify(&Proof { tx: tx.clone(), ..proof(&v) }, &expect_for(&v.message), &chain(&v.network), &VerifyOptions::default(), |_| true)
                .unwrap();
            println!("{} {name}: {}", v.name, show(&r));
            let reason = r.reason().unwrap_or_else(|| panic!("{} {name}: accepted", v.name)).to_string();
            if c["forgedDep"].is_null() {
                assert_eq!(reason, format!("lock exited {}", c["exit"].as_i64().unwrap()), "{} {name}", v.name);
                continue;
            }
            assert!(reason.starts_with("cell dep 0x") && reason.contains(" is not live"), "{} {name}: {reason}", v.name);
            // Precondition: with the prover's copy of that dep, the lock accepts. So the refusal
            // above is the verifier reading deps from the chain, not the signature failing.
            let f = &c["forgedDep"];
            let op = packed::OutPoint::new_builder()
                .tx_hash(packed::Byte32::from_slice(&hexbytes(f["cell_dep"]["out_point"]["tx_hash"].as_str().unwrap())).unwrap())
                .index(u32::from_str_radix(f["cell_dep"]["out_point"]["index"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap())
                .build();
            let output: ckb_jsonrpc_types::CellOutput = serde_json::from_value(f["output"].clone()).unwrap();
            let forged =
                ckb_ward::run::DepCell { out_point: op.clone(), output: output.into(), data: Bytes::from(hexbytes(f["data"].as_str().unwrap())) };
            let run = run_raw(&v, &tx, Some(forged), Some(&op));
            println!("{} {name}: prover's copy of the dep, lock run directly: exit {:?}", v.name, run.code);
            assert_eq!(run.code, Some(0), "{} {name}", v.name);
        }
    }
    assert_eq!(n, 19, "controls in the vectors");
    save_fixture();
}

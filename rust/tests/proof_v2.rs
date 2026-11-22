// Form 2 of the proof (SPEC section 4): the input names output 0 of a synthetic previous transaction.
// The 12 signed proofs of ../tests/vectors-v2 through this crate, with the controls each must refuse,
// the forms told apart, and the same checks the TypeScript suite makes (tests/proof-v2.test.ts).
mod common;

use std::cell::Cell;

use ckb_types::{packed, prelude::*};
use ckb_ward::{
    json, proof_previous, proof_template, proof_version_of, read_proof, run::run_lock, tip_epoch, verify, verify::resolve_cell_deps, Proof,
    ProofOptions, ProofVersion, VerifyOptions, MAX_DEP_GROUP_MEMBERS, PROOF_INDEX, PROOF_INPUT_CAPACITY, PROOF_TAG_V2,
};
use common::*;

fn v2() -> Vec<Vector> {
    vectors_in("tests/vectors-v2")
}

fn proof(v: &Vector) -> Proof {
    Proof { lock: v.lock.clone(), message: v.message.clone(), tx: v.tx.clone() }
}

fn run_raw(v: &Vector, tx: &packed::Transaction) -> ckb_ward::LockRun {
    let rpc = chain(&v.network);
    let deps: Vec<packed::CellDep> = tx.raw().cell_deps().into_iter().collect();
    let cells = resolve_cell_deps(&rpc, &deps, MAX_DEP_GROUP_MEMBERS).unwrap_or_else(|e| panic!("{}: deps: {e:?}", v.name));
    let genesis = h256(&ckb_ward::parse_message(&v.message).unwrap().chain);
    let consensus = ckb_ward::consensus_for(&genesis).unwrap().unwrap();
    run_lock(tx, &v.lock, &cells, &[], consensus, tip_epoch(&rpc).unwrap(), ckb_ward::DEFAULT_MAX_CYCLES).unwrap()
}

/// A form-1 or form-2 template for the vector's own lock and message, with the vector's deps and witness.
fn with_form(v: &Vector, message: &str, version: ProofVersion) -> packed::Transaction {
    let tpl = proof_template(&v.lock, message, &ProofOptions { version, ..Default::default() });
    let raw = tpl.raw().as_builder().cell_deps(v.tx.raw().cell_deps()).build();
    tpl.as_builder().raw(raw).witnesses(v.tx.witnesses()).build()
}

#[test]
fn there_is_a_proof_for_each_software_key_lock() {
    assert_eq!(v2().len(), 12);
    for v in v2() {
        assert_eq!(v.raw["version"], 2, "{}", v.file);
    }
}

#[test]
fn forms_are_read_by_their_bytes() {
    for v in v2() {
        let input = v.tx.raw().inputs().get(0).unwrap().previous_output();
        let index: u32 = input.index().unpack();
        assert_eq!(index, 0, "{}: output 0 of the previous transaction", v.file);
        assert_eq!(input.tx_hash(), proof_previous(&v.lock, &v.message).calc_tx_hash(), "{}", v.file);
        assert_eq!(proof_version_of(&v.lock, &v.message, &v.tx), Some(ProofVersion::V2), "{}", v.file);
        assert!(read_proof(&v.tx, &v.lock).is_some(), "{}: read_proof", v.file);
    }
    for v in vectors() {
        assert_eq!(proof_version_of(&v.lock, &v.message, &v.tx), Some(ProofVersion::V1), "{}", v.file);
        let index: u32 = v.tx.raw().inputs().get(0).unwrap().previous_output().index().unpack();
        assert_eq!(index, PROOF_INDEX);
    }
}

#[test]
fn the_previous_transaction_binds_tag_lock_and_message_and_cannot_be_committed() {
    let v = v2().remove(0);
    let prev = proof_previous(&v.lock, &v.message);
    let raw = prev.raw();
    assert_eq!(raw.inputs().len(), 0, "no inputs: a node refuses it");
    let outputs: Vec<packed::CellOutput> = raw.outputs().into_iter().collect();
    let cap0: u64 = outputs[0].capacity().unpack();
    assert_eq!(cap0, PROOF_INPUT_CAPACITY);
    assert_eq!(outputs[0].lock(), v.lock);
    assert!(outputs[0].type_().to_opt().is_none());
    assert_eq!(raw.outputs_data().get(0).unwrap().raw_data().len(), 0, "the proof input's cell has no data");
    let mut want = PROOF_TAG_V2.to_vec();
    want.extend_from_slice(v.lock.calc_script_hash().as_slice());
    want.extend_from_slice(v.message.as_bytes());
    assert_eq!(raw.outputs_data().get(1).unwrap().raw_data().to_vec(), want);
    let cap1: u64 = outputs[1].capacity().unpack();
    assert_eq!(cap1, (8 + 32 + 1 + v.lock.args().raw_data().len() as u64 + want.len() as u64) * 100_000_000);
    assert_ne!(proof_previous(&v.lock, &other_message(&v.message)).calc_tx_hash(), prev.calc_tx_hash());
}

/// What a platform's free checks do with a proof: the claim callback is the witness that it got past them all.
fn free(v: &Vector, tx: &packed::Transaction) -> (bool, String) {
    let claimed = Cell::new(false);
    let r = verify(&Proof { tx: tx.clone(), ..proof(v) }, &expect_for(&v.message), &NoChain, &VerifyOptions::default(), |_| {
        claimed.set(true);
        false
    })
    .unwrap();
    (claimed.get(), r.reason().unwrap_or("ACCEPTED").to_string())
}

#[test]
fn form_one_and_form_two_are_told_apart_and_anything_between_is_refused() {
    let refused = "not the proof template for this lock and message";
    let v = v2().into_iter().find(|v| v.file == "secp256k1.json").unwrap();
    assert_eq!(free(&v, &v.tx), (true, "nonce already used".into()), "control: form 2 passes every free check");
    let one = vectors().into_iter().find(|x| x.file == "secp256k1.json").unwrap();
    assert!(free(&one, &one.tx).0, "control: form 1 still does");
    let edit = |tx: &packed::Transaction, hash: Option<packed::Byte32>, index: u32| {
        let mut input = tx.raw().inputs().get(0).unwrap().as_builder();
        let old = tx.raw().inputs().get(0).unwrap().previous_output();
        input = input.previous_output(packed::OutPoint::new_builder().tx_hash(hash.unwrap_or(old.tx_hash())).index(index).build());
        let raw = tx.raw().as_builder().inputs(vec![input.build()].pack()).build();
        tx.clone().as_builder().raw(raw).build()
    };
    assert_eq!(free(&v, &edit(&v.tx, None, PROOF_INDEX)).1, refused);
    assert_eq!(free(&v, &edit(&v.tx, Some(proof_previous(&v.lock, &other_message(&v.message)).calc_tx_hash()), 0)).1, refused);
    assert_eq!(free(&v, &edit(&v.tx, None, 1)).1, refused);
    assert_eq!(free(&one, &edit(&one.tx, None, 0)).1, refused);
    let form_one_out_point = one.tx.raw().inputs().get(0).unwrap().previous_output().tx_hash();
    assert_eq!(free(&v, &edit(&v.tx, Some(form_one_out_point), 0)).1, refused);
}

#[test]
fn every_form_two_proof_is_accepted() {
    for v in v2() {
        let r = verify(&proof(&v), &expect_for(&v.message), &chain(&v.network), &VerifyOptions::default(), |_| true).unwrap();
        println!("{}: {}", v.name, r.reason().unwrap_or("ACCEPTED"));
        assert!(r.is_accepted(), "{}: {:?}", v.name, r.reason());
    }
    save_fixture();
}

#[test]
fn controls_are_refused_by_the_lock_or_the_template() {
    let mut controls = 0;
    for v in v2() {
        let other = other_message(&v.message);
        let r = verify(&Proof { message: other.clone(), ..proof(&v) }, &expect_for(&other), &chain(&v.network), &VerifyOptions::default(), |_| true)
            .unwrap();
        assert_eq!(r.reason(), Some("not the proof template for this lock and message"), "{}", v.name);
        assert_eq!(
            run_raw(&v, &with_form(&v, &other, ProofVersion::V2)).code,
            Some(v.other_message_exit),
            "{}: the witness on another message",
            v.name
        );
        let flipped = verify(
            &Proof { tx: flip_witness_byte(&v.tx, v.signature_byte), ..proof(&v) },
            &expect_for(&v.message),
            &chain(&v.network),
            &VerifyOptions::default(),
            |_| true,
        )
        .unwrap();
        assert_eq!(flipped.reason(), Some(format!("lock exited {}", v.signature_flip_exit).as_str()), "{}", v.name);
        assert_ne!(run_raw(&v, &with_witness(&v.tx, vec![])).code, Some(0), "{}: empty witness", v.name);
        for (name, c) in v.raw["controls"].as_object().into_iter().flatten() {
            controls += 1;
            let tx = json::transaction_from_json(&c["tx"]).unwrap();
            let r = verify(&Proof { tx, ..proof(&v) }, &expect_for(&v.message), &chain(&v.network), &VerifyOptions::default(), |_| true).unwrap();
            assert_eq!(r.reason(), Some(format!("lock exited {}", c["exit"].as_i64().unwrap()).as_str()), "{} {name}", v.name);
        }
    }
    assert!(controls >= 15, "controls in the form 2 vectors: {controls}");
    save_fixture();
}

#[test]
fn a_signature_of_one_form_does_not_open_the_other() {
    for v in v2() {
        let r1 = run_raw(&v, &with_form(&v, &v.message, ProofVersion::V1));
        assert_ne!(r1.code, Some(0), "{}: the form 2 witness on the form 1 template", v.name);
        if let Some(one) = vectors().into_iter().find(|x| x.file == v.file) {
            let tx = with_form(&one, &one.message, ProofVersion::V2);
            let tx = tx.as_builder().witnesses(one.tx.witnesses()).build();
            assert_ne!(run_raw(&one, &tx).code, Some(0), "{}: the form 1 witness on the form 2 template", v.name);
        }
    }
    save_fixture();
}

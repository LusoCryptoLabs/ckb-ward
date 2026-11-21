// deps_live_at and dao_weight_at on real testnet history: the same cells, blocks and amounts the
// TypeScript suite checks (tests/snapshot.test.ts and tests/weight.test.ts).
mod common;

use ckb_types::{bytes::Bytes, core::ScriptHashType, packed, prelude::*};
use ckb_ward::{dao_weight_at, deps_live_at, tip_number, verify, Proof, Rpc, Verdict, VerifyOptions};
use common::*;
use serde_json::json;

const UPGRADED: &str = "0xe3c204947c3f457410af242747146b3330a05d9f02d095b2636ac9368a3acce4";
const UPGRADE_TX: &str = "0x1d791fd5f8edfa9199346ff8ec19d0d341a3adb4f43c26ea32a4d59b94fc1eab";
const DEPOSITS_TX: &str = "0x72067b401bbe8a7b7a3baf496dbb3eb232bbb8330eccba00b4674d00c1be8087";
const WITHDRAW_TX: &str = "0xf9138c1cd8eae3bab560e071d1e72ed67b2c05b39a83b17407911be6d826e8ad";
const DEPOSITS_BLOCK: u64 = 22983301;
const WITHDRAW_BLOCK: u64 = 22983305;
const CKB: u64 = 100_000_000;

fn op(tx_hash: &str, index: u32) -> packed::OutPoint {
    packed::OutPoint::new_builder().tx_hash(packed::Byte32::from_slice(&hexbytes(tx_hash)).unwrap()).index(index).build()
}

fn block_of(rpc: &impl Rpc, tx_hash: &str) -> u64 {
    let t = rpc.call("get_transaction", json!([tx_hash])).unwrap();
    u64::from_str_radix(t["tx_status"]["block_number"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
}

fn lock(args: &str) -> packed::Script {
    packed::Script::new_builder()
        .code_hash(packed::Byte32::from_slice(&hexbytes("0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8")).unwrap())
        .hash_type(ScriptHashType::Type)
        .args(Bytes::from(hexbytes(args)).pack())
        .build()
}

const DEPOSITOR: &str = "0x8346bdc27e75417b9761947a3fb3baef42b80789";

#[test]
fn a_cell_spent_by_an_upgrade_is_live_the_block_before_and_not_from_the_upgrade() {
    let rpc = chain("testnet");
    let spent = block_of(&rpc, UPGRADE_TX);
    let before = deps_live_at(&rpc, &[op(UPGRADED, 0)], spent - 1, 20).unwrap();
    let at = deps_live_at(&rpc, &[op(UPGRADED, 0)], spent, 20).unwrap();
    println!("upgrade in block {spent}: before {}; at it {}", before.deps[0].reason, at.deps[0].reason);
    assert!(before.live);
    assert_eq!(before.deps[0].reason, "spent after the snapshot");
    assert!(!at.live);
    assert_eq!(at.deps[0].spent_at, Some(spent));
    save_fixture();
}

#[test]
fn a_cell_created_after_the_snapshot_is_not_live_at_it() {
    let rpc = chain("testnet");
    let created = block_of(&rpc, UPGRADE_TX);
    let r = deps_live_at(&rpc, &[op(UPGRADE_TX, 0)], created - 1, 20).unwrap();
    assert!(!r.live);
    assert_eq!(r.deps[0].reason, format!("created in block {created}, after the snapshot"));
    // Control: from its own block it is live (it is the current code cell).
    assert!(deps_live_at(&rpc, &[op(UPGRADE_TX, 0)], created, 20).unwrap().live);
    save_fixture();
}

#[test]
fn a_real_proofs_deps_are_live_at_the_tip_and_one_spent_cell_makes_the_binding_not_count() {
    let v = vectors().into_iter().find(|v| v.file == "secp256k1.json").unwrap();
    let rpc = chain("testnet");
    let r = verify(
        &Proof { lock: v.lock.clone(), message: v.message.clone(), tx: v.tx.clone() },
        &expect_for(&v.message),
        &rpc,
        &VerifyOptions::default(),
        |_| true,
    )
    .unwrap();
    let Verdict::Accepted(a) = r else { panic!("{r:?}") };
    let tip = tip_number(&rpc).unwrap();
    let now = deps_live_at(&rpc, &a.cell_deps, tip, 20).unwrap();
    println!("{} cells: {:?}", a.cell_deps.len(), now.deps.iter().map(|d| &d.reason).collect::<Vec<_>>());
    assert!(now.live);
    assert!(a.cell_deps.len() >= 2, "the dep group's members are included");
    let spent = block_of(&rpc, UPGRADE_TX);
    let mut mixed = a.cell_deps.clone();
    mixed.push(op(UPGRADED, 0));
    let m = deps_live_at(&rpc, &mixed, tip, 20).unwrap();
    assert!(!m.live);
    assert_eq!(m.deps.iter().filter(|d| !d.live).map(|d| d.spent_at).collect::<Vec<_>>(), vec![Some(spent)]);
    save_fixture();
}

#[test]
fn a_snapshot_past_the_tip_is_refused_not_answered() {
    let rpc = chain("testnet");
    let tip = tip_number(&rpc).unwrap();
    let e = deps_live_at(&rpc, &[op(UPGRADED, 0)], tip + 1000, 20).unwrap_err();
    assert!(e.0.contains("past the tip"), "{e}");
    let e = dao_weight_at(&rpc, &lock(DEPOSITOR), tip + 1000, 50).unwrap_err();
    assert!(e.0.contains("past the tip"), "{e}");
    save_fixture();
}

#[test]
fn the_history_the_tests_read_is_where_they_say() {
    let rpc = chain("testnet");
    assert_eq!(block_of(&rpc, DEPOSITS_TX), DEPOSITS_BLOCK);
    assert_eq!(block_of(&rpc, WITHDRAW_TX), WITHDRAW_BLOCK);
    save_fixture();
}

#[test]
fn dao_weight_follows_deposits_and_withdrawal() {
    let rpc = chain("testnet");
    let r = dao_weight_at(&rpc, &lock(DEPOSITOR), DEPOSITS_BLOCK - 1, 50).unwrap();
    assert_eq!(r.weight, 0);
    assert_eq!(r.deposits.len() + r.withdrawing.len(), 0);

    for at in [DEPOSITS_BLOCK, WITHDRAW_BLOCK - 1] {
        let r = dao_weight_at(&rpc, &lock(DEPOSITOR), at, 50).unwrap();
        println!("block {at}: {} CKB in {} deposits", r.weight / u128::from(CKB), r.deposits.len());
        assert_eq!(r.weight, u128::from(500 * CKB));
        let mut caps: Vec<u64> = r.deposits.iter().map(|d| d.capacity).collect();
        caps.sort();
        assert_eq!(caps, vec![200 * CKB, 300 * CKB]);
        assert!(r.withdrawing.is_empty());
    }

    let r = dao_weight_at(&rpc, &lock(DEPOSITOR), WITHDRAW_BLOCK, 50).unwrap();
    assert_eq!(r.weight, u128::from(300 * CKB));
    assert_eq!(r.deposits.len(), 1);
    // The precondition of the double count: the withdrawing cell is live and keeps the DAO type.
    assert_eq!(r.withdrawing.len(), 1);
    assert_eq!(r.withdrawing[0].capacity, 200 * CKB);
    assert_eq!(r.withdrawing[0].out_point.tx_hash(), packed::Byte32::from_slice(&hexbytes(WITHDRAW_TX)).unwrap());

    // A lock whose args are a prefix of the depositor's weighs nothing.
    let prefix = &DEPOSITOR[..DEPOSITOR.len() - 2];
    assert_eq!(dao_weight_at(&rpc, &lock(prefix), WITHDRAW_BLOCK, 50).unwrap().weight, 0);

    // A history longer than the pages allowed is refused, not cut short.
    let e = dao_weight_at(&rpc, &lock(DEPOSITOR), WITHDRAW_BLOCK, 0).unwrap_err();
    assert!(e.0.contains("did not end within 0 pages"), "{e}");
    save_fixture();
}

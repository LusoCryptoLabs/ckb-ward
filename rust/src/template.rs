//! The proof transaction (SPEC section 4): one input at an out point that cannot exist, one output
//! under the claimed lock holding the message.
use ckb_hash::new_blake2b;
use ckb_types::{bytes::Bytes, packed, prelude::*};

use crate::message::{parse_message, MessageFields};

/// Domain separation for the proof out point. 18 bytes, ends with a line feed. It names the bytes
/// of the signed transaction: a change to those bytes gets a new tag.
pub const PROOF_TAG: &[u8] = b"CKB lock proof v1\n";
/// The tag of form 2 (SPEC section 4, "Form 2"). Form 2 has the same message, output and witness as
/// form 1; only the input differs: it names output 0 of a synthetic previous transaction instead of
/// an out point that cannot exist, so a signer that checks every input against the transaction its
/// hash names can follow it. This tag is in that previous transaction's data.
pub const PROOF_TAG_V2: &[u8] = b"CKB lock proof v2\n";

/// The form of a proof: 1 names an out point of index 0xffffffff, 2 a synthetic previous transaction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProofVersion {
    #[default]
    V1,
    V2,
}
/// Output index of the proof out point. No transaction has 2^32 - 1 outputs.
pub const PROOF_INDEX: u32 = 0xffff_ffff;
/// Capacity of the proof input as the verifier resolves it. A lock that limits what a key may move
/// then sees the whole account leave, so only a key that may move everything can sign a proof.
pub const PROOF_INPUT_CAPACITY: u64 = u64::MAX;
const SHANNONS: u64 = 100_000_000;

/// Form 1's out point: tx hash = ckbhash(PROOF_TAG || lock script hash || message), index 0xffffffff.
pub fn proof_out_point(lock: &packed::Script, message: &str) -> packed::OutPoint {
    proof_out_point_in(lock, message, ProofVersion::V1)
}

/// The proof's out point in `version`. Form 2: the hash of the synthetic previous transaction
/// ([`proof_previous`]), index 0.
pub fn proof_out_point_in(lock: &packed::Script, message: &str, version: ProofVersion) -> packed::OutPoint {
    if version == ProofVersion::V2 {
        return packed::OutPoint::new_builder().tx_hash(proof_previous(lock, message).calc_tx_hash()).index(0u32).build();
    }
    let mut h = new_blake2b();
    h.update(PROOF_TAG);
    h.update(lock.calc_script_hash().as_slice());
    h.update(message.as_bytes());
    let mut tx_hash = [0u8; 32];
    h.finalize(&mut tx_hash);
    packed::OutPoint::new_builder().tx_hash(tx_hash.pack()).index(PROOF_INDEX).build()
}

/// Form 2's synthetic previous transaction: no inputs (so it can never be committed), the proof
/// input's cell at index 0 (capacity u64::MAX, the claimed lock, no type, no data), and at index 1 an
/// output under the same lock whose data is `PROOF_TAG_V2 || lock hash || message`, with the capacity
/// that data occupies. Its hash binds the tag, the lock and the message, as form 1's out point does.
/// A host gives it to a signer that asks for the transaction an input names; it is never sent anywhere.
pub fn proof_previous(lock: &packed::Script, message: &str) -> packed::Transaction {
    let mut data = Vec::with_capacity(PROOF_TAG_V2.len() + 32 + message.len());
    data.extend_from_slice(PROOF_TAG_V2);
    data.extend_from_slice(lock.calc_script_hash().as_slice());
    data.extend_from_slice(message.as_bytes());
    let capacity = (8 + occupied_size(lock) + data.len() as u64).saturating_mul(SHANNONS);
    let cell = packed::CellOutput::new_builder().capacity(PROOF_INPUT_CAPACITY).lock(lock.clone()).build();
    let tag_cell = packed::CellOutput::new_builder().capacity(capacity).lock(lock.clone()).build();
    let raw = packed::RawTransaction::new_builder()
        .version(0u32)
        .outputs(vec![cell, tag_cell].pack())
        .outputs_data(vec![Bytes::new().pack(), Bytes::from(data).pack()].pack())
        .build();
    packed::Transaction::new_builder().raw(raw).build()
}

/// The `since` and header deps a lock may need (SPEC section 12). Both default to a plain proof.
#[derive(Clone, Debug, Default)]
pub struct ProofOptions {
    /// The input's `since`, to satisfy a matured absolute time lock.
    pub since: u64,
    /// Block hashes a header-reading lock needs. The verifier reads the headers live.
    pub header_deps: Vec<packed::Byte32>,
    /// The form of the proof. Default form 1.
    pub version: ProofVersion,
}

fn occupied_size(script: &packed::Script) -> u64 {
    32 + 1 + script.args().raw_data().len() as u64
}

/// The cell the verifier resolves the proof input to: capacity u64::MAX, the claimed lock, no
/// type, no data.
pub fn proof_input(lock: &packed::Script) -> (packed::CellOutput, Bytes) {
    let output = packed::CellOutput::new_builder().capacity(PROOF_INPUT_CAPACITY).lock(lock.clone()).build();
    (output, Bytes::new())
}

/// The proof transaction for `lock` and `message`, with no cell deps and no witnesses: those are
/// the wallet's to fill. To hand it to a wallet, use [`crate::json::template_json`], which also
/// carries the input cell so a signer can compute the sighash without the chain.
pub fn proof_template(lock: &packed::Script, message: &str, opts: &ProofOptions) -> packed::Transaction {
    let data = message.as_bytes();
    let capacity = (8 + occupied_size(lock) + data.len() as u64).saturating_mul(SHANNONS);
    let input = packed::CellInput::new_builder().previous_output(proof_out_point_in(lock, message, opts.version)).since(opts.since).build();
    let output = packed::CellOutput::new_builder().capacity(capacity).lock(lock.clone()).build();
    let raw = packed::RawTransaction::new_builder()
        .version(0u32)
        .header_deps(opts.header_deps.clone().pack())
        .inputs(vec![input].pack())
        .outputs(vec![output].pack())
        .outputs_data(vec![Bytes::copy_from_slice(data).pack()].pack())
        .build();
    packed::Transaction::new_builder().raw(raw).build()
}

/// The template for `tx`'s claimed lock and message, with the fields a prover sets (cell deps,
/// header deps, the input's since) copied from `tx`. Its hash equals `tx`'s hash only when `tx` is
/// the proof transaction for that lock and message; the hash covers every field but witnesses.
pub(crate) fn template_like(lock: &packed::Script, message: &str, tx: &packed::Transaction, version: ProofVersion) -> packed::Transaction {
    let raw = tx.raw();
    let since: u64 = raw.inputs().get(0).map(|i| i.since().unpack()).unwrap_or(0);
    let tpl = proof_template(lock, message, &ProofOptions { since, header_deps: raw.header_deps().into_iter().collect(), version });
    let tpl_raw = tpl.raw().as_builder().cell_deps(raw.cell_deps()).build();
    tpl.as_builder().raw(tpl_raw).build()
}

/// The form (1 or 2) whose template `tx` equals for `lock` and `message`, or None when it is neither.
pub fn proof_version_of(lock: &packed::Script, message: &str, tx: &packed::Transaction) -> Option<ProofVersion> {
    let raw = tx.raw();
    if raw.inputs().len() != 1 || raw.outputs().len() != 1 || raw.outputs_data().len() != 1 {
        return None;
    }
    let hash = tx.calc_tx_hash();
    [ProofVersion::V1, ProofVersion::V2].into_iter().find(|v| template_like(lock, message, tx, *v).calc_tx_hash() == hash)
}

/// For wallets. When `tx` is exactly the proof template for `lock` and the message in its output,
/// returns the message's fields, so a wallet can show a proof request instead of a transfer.
/// Anything else gives None.
pub fn read_proof(tx: &packed::Transaction, lock: &packed::Script) -> Option<MessageFields> {
    let raw = tx.raw();
    if raw.inputs().len() != 1 || raw.outputs().len() != 1 || raw.outputs_data().len() != 1 {
        return None;
    }
    let index: u32 = raw.inputs().get(0)?.previous_output().index().unpack();
    if index != PROOF_INDEX && index != 0 {
        return None;
    }
    let data = raw.outputs_data().get(0)?.raw_data();
    let text = std::str::from_utf8(&data).ok()?;
    proof_version_of(lock, text, tx)?;
    let fields = parse_message(text).ok()?;
    // The text shows this lock hash line to the person: it must be the lock the transaction is for.
    if fields.lock_hash != crate::util::script_hash_hex(lock) {
        return None;
    }
    Some(fields)
}

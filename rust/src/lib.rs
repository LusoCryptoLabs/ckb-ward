//! Ward lock proofs for a Rust backend: prove that the holder of a key controls a CKB lock, for any
//! lock that signs the transaction hash. The prover signs a transaction that can never be committed;
//! the verifier rebuilds it from the lock and the message, reads the lock's cell deps live from the
//! chain, and runs the lock in CKB-VM with ckb-script, the node's own crate. Nothing moves on chain.
//!
//! The same format and checks as the TypeScript package `ckb-ward` (SPEC in `docs/SPEC.md`):
//!
//! 1. [`message()`] writes the six lines the platform stores and the wallet signs;
//! 2. [`json::template_json`] gives the proof transaction to hand to the wallet;
//! 3. [`verify()`] (or [`verify_json`]) checks what comes back.
//!
//! For counting weight from bindings, [`deps_live_at`] and [`dao_weight_at`] read a snapshot block.
//!
//! ```no_run
//! use std::time::Duration;
//! use ckb_ward::{iso_time, json, message, verify_json, Expect, RpcClient, Verdict, VerifyOptions};
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let lock_json = serde_json::json!({});
//! # let signed_tx_json = serde_json::json!({});
//! # let (now_ms, nonce, chain) = (0i64, "n-1", ckb_ward::H256::default());
//! // 1. Issue: store the message with the nonce, hand the template to the wallet.
//! let lock = json::script_from_json(&lock_json)?;
//! let text = message("dao.example", "user-42", &lock, &chain, &iso_time(now_ms), nonce)?;
//! let template = json::template_json(&lock, &text, &Default::default());
//!
//! // 2. Verify what the wallet signed.
//! let expect = Expect {
//!     message: text.clone(),
//!     domain: "dao.example".into(),
//!     account: "user-42".into(),
//!     nonce: nonce.into(),
//!     chain,
//!     max_age: Duration::from_secs(600),
//!     now: None,
//! };
//! let rpc = RpcClient::new("https://testnet.ckb.dev/rpc");
//! let claim = |_: &ckb_ward::MessageFields| true; // your compare-and-set on the nonce
//! match verify_json(&lock_json, &text, &signed_tx_json, &expect, &rpc, &VerifyOptions::default(), claim)? {
//!     Verdict::Accepted(a) => println!("bound, cell deps to record: {}", a.cell_deps.len()),
//!     Verdict::Refused(r) => println!("refused: {}", r.reason),
//! }
//! # let _ = template;
//! # Ok(())
//! # }
//! ```
pub mod chain;
pub mod json;
pub mod message;
pub mod run;
pub mod snapshot;
pub mod template;
mod util;
pub mod verify;
pub mod weight;

/// The node's types crate this one is built on, so a caller needs no matching `ckb-types` of its own.
pub use ckb_types;
/// The type of [`Expect::chain`].
pub use ckb_types::H256;

#[cfg(feature = "rpc")]
pub use chain::RpcClient;
pub use chain::{tip_epoch, tip_number, Rpc, RpcError, RPC_TIMEOUT};
pub use message::{iso_time, message, parse_message, parse_time, MessageError, MessageFields, MAX_MESSAGE_BYTES};
pub use run::{consensus_for, LockRun, DEFAULT_MAX_CYCLES, MAINNET_GENESIS, TESTNET_GENESIS};
pub use snapshot::{deps_live_at, DepAtSnapshot, DepsAtSnapshot};
pub use template::{proof_input, proof_out_point, proof_template, read_proof, ProofOptions, PROOF_INDEX, PROOF_INPUT_CAPACITY, PROOF_TAG};
pub use verify::{
    duplicate_cell_dep, omnilock_admin, verify, verify_json, Accepted, Expect, Proof, Refused, Verdict, VerifyError, VerifyOptions, CLOCK_SKEW,
    MAX_CELL_DEPS, MAX_DEP_GROUP_MEMBERS, MAX_HEADER_DEPS, MAX_TX_BYTES, MAX_WITNESS_BYTES, OMNILOCK_CODE_HASHES,
};
pub use weight::{dao_weight_at, DaoCell, DaoWeight, DAO_DEPOSIT_DATA, NERVOS_DAO_CODE_HASH};

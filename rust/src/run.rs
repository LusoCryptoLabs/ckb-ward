//! Running the lock of input 0 the way a node would: ckb-script, the node's own crate, under the
//! chain's consensus from its bundled spec, for a transaction submitted at a tip in the epoch given,
//! with only the node's syscalls. The same arrangement as `ward-vm` in `../vm`.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use ckb_chain_spec::{consensus::Consensus, ChainSpec};
use ckb_script::{RunMode, ScriptGroupType, TransactionScriptsVerifier, TxVerifyEnv};
use ckb_traits::{CellDataProvider, ExtensionProvider, HeaderProvider};
use ckb_types::{
    bytes::Bytes,
    core::{
        cell::{resolve_transaction, CellMeta, CellMetaBuilder, CellProvider, CellStatus, HeaderChecker},
        error::OutPointError,
        EpochNumberWithFraction, HeaderView, TransactionInfo,
    },
    packed::{self, Byte32, OutPoint},
    prelude::*,
    H256,
};

use crate::template::proof_input;

/// Cycle limit for one run. 70,000,000 is ten times the largest lock measured (SPEC section 13).
pub const DEFAULT_MAX_CYCLES: u64 = 70_000_000;
/// Most text kept from what a lock prints through the debug syscall.
const MAX_KEPT_OUTPUT: usize = 1 << 20;

/// Genesis hash of CKB mainnet.
pub const MAINNET_GENESIS: &str = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
/// Genesis hash of the public testnet (Pudge).
pub const TESTNET_GENESIS: &str = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";

/// Result of running input 0's lock. `code` 0 means the lock accepted; None means it did not run
/// to an exit (out of cycles, a VM error), and `output` says why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockRun {
    pub code: Option<i8>,
    pub cycles: Option<u64>,
    /// What the lock printed through the debug syscall, or the error when it did not run.
    pub output: String,
}

/// A cell dep as read live from the chain.
#[derive(Clone, Debug)]
pub struct DepCell {
    pub out_point: OutPoint,
    pub output: packed::CellOutput,
    pub data: Bytes,
}

fn consensus_of(name: &str, slot: &'static OnceLock<Result<Arc<Consensus>, String>>) -> Result<Arc<Consensus>, String> {
    slot.get_or_init(|| {
        let spec = ChainSpec::load_from(&ckb_resource::Resource::bundled(format!("specs/{name}.toml"))).map_err(|e| format!("chain spec: {e}"))?;
        Ok(Arc::new(spec.build_consensus().map_err(|e| format!("consensus: {e}"))?))
    })
    .clone()
}

/// The consensus of mainnet or the public testnet, from the spec bundled with the node's crates
/// (building it checks the genesis hash). None for another chain: pass its consensus to the
/// verifier yourself.
pub fn consensus_for(genesis: &H256) -> Option<Result<Arc<Consensus>, String>> {
    static MAINNET: OnceLock<Result<Arc<Consensus>, String>> = OnceLock::new();
    static TESTNET: OnceLock<Result<Arc<Consensus>, String>> = OnceLock::new();
    let g = crate::util::hex(genesis.as_bytes());
    match g.as_str() {
        MAINNET_GENESIS => Some(consensus_of("mainnet", &MAINNET)),
        TESTNET_GENESIS => Some(consensus_of("testnet", &TESTNET)),
        _ => None,
    }
}

/// The cells and headers one run may read, and nothing else.
#[derive(Clone)]
struct Cells {
    cells: Arc<HashMap<OutPoint, CellMeta>>,
    headers: Arc<HashMap<Byte32, HeaderView>>,
}

impl CellProvider for Cells {
    fn cell(&self, out_point: &OutPoint, _with_data: bool) -> CellStatus {
        self.cells.get(out_point).cloned().map(CellStatus::live_cell).unwrap_or(CellStatus::Unknown)
    }
}
impl HeaderChecker for Cells {
    fn check_valid(&self, block_hash: &Byte32) -> Result<(), OutPointError> {
        if self.headers.contains_key(block_hash) {
            Ok(())
        } else {
            Err(OutPointError::InvalidHeader(block_hash.clone()))
        }
    }
}
impl CellDataProvider for Cells {
    fn get_cell_data(&self, out_point: &OutPoint) -> Option<Bytes> {
        self.cells.get(out_point).and_then(|c| c.mem_cell_data.clone())
    }
    fn get_cell_data_hash(&self, out_point: &OutPoint) -> Option<Byte32> {
        self.cells.get(out_point).and_then(|c| c.mem_cell_data_hash.clone())
    }
}
impl HeaderProvider for Cells {
    fn get_header(&self, block_hash: &Byte32) -> Option<HeaderView> {
        self.headers.get(block_hash).cloned()
    }
}
impl ExtensionProvider for Cells {
    fn get_block_extension(&self, _hash: &Byte32) -> Option<packed::Bytes> {
        None
    }
}

/// The cell as ckb-debugger's mock gives it when no header is named: block 0, epoch 0, no hash.
fn meta(out_point: OutPoint, output: packed::CellOutput, data: Bytes) -> CellMeta {
    CellMetaBuilder::from_cell_output(output, data)
        .out_point(out_point)
        .transaction_info(TransactionInfo::new(0, EpochNumberWithFraction::new(0, 0, 1800), Byte32::default(), 0))
        .build()
}

/// Runs the lock script group of input 0 of `tx`, with that input resolved to the proof input of
/// `lock` (capacity u64::MAX, no type, no data), the given cell deps (dep group members included)
/// and headers. A transaction that cannot be resolved from them, or whose lock code is missing,
/// comes back as a run with no exit code. Err only when the transaction has no input.
pub fn run_lock(
    tx: &packed::Transaction,
    lock: &packed::Script,
    deps: &[DepCell],
    headers: &[HeaderView],
    consensus: Arc<Consensus>,
    tip_epoch: u64,
    max_cycles: u64,
) -> Result<LockRun, String> {
    let input = tx.raw().inputs().get(0).ok_or("the transaction has no input")?;
    let (cell, data) = proof_input(lock);
    let mut cells = HashMap::new();
    cells.insert(input.previous_output(), meta(input.previous_output(), cell, data));
    for d in deps {
        cells.insert(d.out_point.clone(), meta(d.out_point.clone(), d.output.clone(), d.data.clone()));
    }
    let res = Cells { cells: Arc::new(cells), headers: Arc::new(headers.iter().map(|h| (h.hash(), h.clone())).collect()) };
    // A transaction that cannot be resolved, or whose lock code is not among its deps, is the
    // prover's doing: the lock did not run, and the proof is refused (not an error to retry).
    let not_run = |e: String| LockRun { code: None, cycles: None, output: e };
    let rtx = match resolve_transaction(tx.clone().into_view(), &mut HashSet::new(), &res, &res) {
        Ok(r) => r,
        Err(e) => return Ok(not_run(format!("resolving the transaction: {e}"))),
    };

    let tip = HeaderView::new_advanced_builder().epoch(EpochNumberWithFraction::new(tip_epoch, 0, 1).pack()).build();
    let env = Arc::new(TxVerifyEnv::new_submit(&tip));
    let printed = Arc::new(Mutex::new(String::new()));
    let sink = printed.clone();
    let printer = Arc::new(move |_: &Byte32, message: &str| {
        let mut out = sink.lock().unwrap_or_else(|p| p.into_inner());
        if out.len() < MAX_KEPT_OUTPUT {
            out.push_str(message.trim_end_matches('\n'));
            out.push('\n');
        }
    });
    let lock_hash = lock.calc_script_hash();
    let verifier = TransactionScriptsVerifier::new_with_debug_printer(Arc::new(rtx), res, consensus, env, printer);
    let Some(group) = verifier.find_script_group(ScriptGroupType::Lock, &lock_hash) else {
        return Ok(not_run("input 0's lock has no script group".into()));
    };
    let mut scheduler = match verifier.create_scheduler(group) {
        Ok(s) => s,
        Err(e) => return Ok(not_run(e.to_string())),
    };
    let result = scheduler.run(RunMode::LimitCycles(max_cycles));
    let output = std::mem::take(&mut *printed.lock().unwrap_or_else(|p| p.into_inner()));
    Ok(match result {
        Ok(r) => LockRun { code: Some(r.exit_code), cycles: Some(r.consumed_cycles), output },
        Err(e) => LockRun { code: None, cycles: None, output: format!("{output}{e}") },
    })
}

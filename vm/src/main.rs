//! ward-vm: runs the lock of input 0 of a Ward proof as a CKB node would.
//!
//! It reads ckb-debugger's mock transaction format (the file `verify()` already builds), and runs
//! the lock script group of input 0 with ckb-script under the consensus of the chain named, for a
//! transaction submitted at a tip in the epoch given: the VM version and the syscalls are the ones
//! the node would use, and nothing else is available to the script.
//!
//!   ward-vm --tx-file <mock.json> --chain mainnet|testnet --epoch <tip epoch number> [--max-cycles N]
//!
//! Prints one line of JSON on stdout: {"code":0,"cycles":"1645417"} when the lock ran to an exit
//! (code is the lock's exit code), or {"code":null,"error":"..."} when it did not. What the lock
//! prints through the debug syscall goes to stderr. Exit status 0 when it printed a result, 2 on a
//! usage or input error.
use std::collections::HashSet;
use std::sync::Arc;

use ckb_chain_spec::ChainSpec;
use ckb_mock_tx_types::{MockTransaction, ReprMockTransaction, Resource};
use ckb_script::{RunMode, ScriptGroupType, TransactionScriptsVerifier, TxVerifyEnv};
use ckb_types::core::cell::resolve_transaction;
use ckb_types::core::{EpochNumberWithFraction, HeaderView};
use ckb_types::packed::Byte32;
use ckb_types::prelude::*;

const DEFAULT_MAX_CYCLES: u64 = 70_000_000;

struct Args {
    tx_file: String,
    chain: String,
    epoch: u64,
    max_cycles: u64,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let (mut tx_file, mut chain, mut epoch, mut max_cycles) = (None, None, None, DEFAULT_MAX_CYCLES);
    while let Some(a) = it.next() {
        let mut value = || it.next().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--tx-file" => tx_file = Some(value()?),
            "--chain" => chain = Some(value()?),
            "--epoch" => epoch = Some(value()?.parse::<u64>().map_err(|e| format!("--epoch: {e}"))?),
            "--max-cycles" => max_cycles = value()?.parse::<u64>().map_err(|e| format!("--max-cycles: {e}"))?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let chain = chain.ok_or("--chain is required (mainnet or testnet)")?;
    if chain != "mainnet" && chain != "testnet" {
        return Err(format!("--chain must be mainnet or testnet, not {chain}"));
    }
    Ok(Args {
        tx_file: tx_file.ok_or("--tx-file is required")?,
        chain,
        epoch: epoch.ok_or("--epoch is required: the epoch number of the chain's tip")?,
        max_cycles,
    })
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn run(args: &Args) -> Result<String, String> {
    let text = std::fs::read_to_string(&args.tx_file).map_err(|e| format!("reading {}: {e}", args.tx_file))?;
    let repr: ReprMockTransaction = serde_json::from_str(&text).map_err(|e| format!("mock transaction: {e}"))?;
    let mock: MockTransaction = repr.into();
    let resource = Resource::from_mock_tx(&mock)?;
    let rtx = resolve_transaction(mock.core_transaction(), &mut HashSet::new(), &resource, &resource)
        .map_err(|e| format!("resolving the transaction: {e}"))?;
    let lock_hash: Byte32 = rtx
        .resolved_inputs
        .first()
        .ok_or("the transaction has no input")?
        .cell_output
        .lock()
        .calc_script_hash();

    // The chain's own spec, as bundled with the node: its hardfork epochs decide the VM version and
    // the syscalls. Building it also checks the genesis hash, so a wrong spec cannot load.
    let spec = ChainSpec::load_from(&ckb_resource::Resource::bundled(format!("specs/{}.toml", args.chain)))
        .map_err(|e| format!("chain spec: {e}"))?;
    let consensus = Arc::new(spec.build_consensus().map_err(|e| format!("consensus: {e}"))?);
    let tip = HeaderView::new_advanced_builder()
        .epoch(EpochNumberWithFraction::new(args.epoch, 0, 1).pack())
        .build();
    let env = Arc::new(TxVerifyEnv::new_submit(&tip));

    let printer = Arc::new(|_: &Byte32, message: &str| {
        let message = message.trim_end_matches('\n');
        if !message.is_empty() {
            eprintln!("Script log: {message}");
        }
    });
    let verifier = TransactionScriptsVerifier::new_with_debug_printer(Arc::new(rtx), resource, consensus, env, printer);
    let group = verifier
        .find_script_group(ScriptGroupType::Lock, &lock_hash)
        .ok_or("input 0's lock has no script group")?;
    let mut scheduler = verifier.create_scheduler(group).map_err(|e| format!("{e}"))?;
    Ok(match scheduler.run(RunMode::LimitCycles(args.max_cycles)) {
        Ok(r) => format!("{{\"code\":{},\"cycles\":\"{}\"}}", r.exit_code, r.consumed_cycles),
        Err(e) => format!("{{\"code\":null,\"error\":{}}}", json_string(&e.to_string())),
    })
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("ward-vm: {e}");
            std::process::exit(2);
        }
    };
    match run(&args) {
        Ok(line) => println!("{line}"),
        Err(e) => {
            eprintln!("ward-vm: {e}");
            std::process::exit(2);
        }
    }
}

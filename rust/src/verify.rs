//! Checking a proof (SPEC section 5). The same steps, in the same order and with the same refusal
//! texts, as `verify()` in the TypeScript package.
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ckb_chain_spec::consensus::Consensus;
use ckb_jsonrpc_types as rpc;
use ckb_types::{bytes::Bytes, core::HeaderView, packed, prelude::*, H256};
use serde_json::{json, Value};

use crate::chain::{tip_epoch, Deadline, Rpc, RpcError, VERIFY_DEADLINE};
use crate::message::{parse_message, parse_time, MessageFields};
use crate::run::{consensus_for, run_lock, DepCell, LockRun, DEFAULT_MAX_CYCLES};
use crate::template::template_like;
use crate::util::{hex, hex_num, unhex};

/// Largest number of cell deps a proof may list (JoyID, the largest measured, uses 6).
pub const MAX_CELL_DEPS: usize = 16;
/// Largest number of header deps a proof may list.
pub const MAX_HEADER_DEPS: usize = 8;
/// Most cells all dep groups of a proof may list together, counted before any member is read.
pub const MAX_DEP_GROUP_MEMBERS: usize = 32;
/// Largest transaction as the node counts it in a block (its bytes plus a 4 byte offset): the
/// consensus block limit on testnet and mainnet.
pub const MAX_TX_BYTES: usize = 597_000;
/// Default largest witness, in bytes.
pub const MAX_WITNESS_BYTES: usize = 65_536;
/// Allowed clock difference for "Issued at" in the future.
pub const CLOCK_SKEW: Duration = Duration::from_secs(60);

/// Omnilock, by type hash of its deployments and by data hash of their code. An Omnilock whose
/// flags byte (args byte 21) has bit 0 set is in administrator mode: an administrator can sign for
/// it, so the verifier refuses it (SPEC section 6, rule 6). A copy under another code hash is not
/// recognised.
pub const OMNILOCK_CODE_HASHES: [&str; 6] = [
    "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb", // testnet type hash (CCC)
    "0x79f90bb5e892d80dd213439eeab551120eb417678824f282b4ffb5f21bad2e1e", // testnet type hash, 2022 deployment
    "0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26", // mainnet type hash (RFC 0042)
    "0x6b29b6f10346b43c540e53806ba88ba0fe3a0c3a29d7448ef555840c8f8318fa", // testnet code since 2024-04-12
    "0x768f306681da232ceb0b94f436c5f813377179762a831c5ad8797bd4fd2d118d", // mainnet code; testnet code 2024-01 to 2024-04
    "0x1bf147d1c95a5ad51016bd426c33f364257e685af54df26fc69ec40e3ae267d1", // testnet code, 2022 deployment
];

/// True for an Omnilock with the administrator flag set.
pub fn omnilock_admin(lock: &packed::Script) -> bool {
    let args = lock.args().raw_data();
    OMNILOCK_CODE_HASHES.contains(&hex(lock.code_hash().as_slice()).as_str()) && args.len() > 21 && args[21] & 1 == 1
}

/// What the prover hands in: the lock it claims, the message it was asked to sign, the signed tx.
#[derive(Clone, Debug)]
pub struct Proof {
    pub lock: packed::Script,
    pub message: String,
    pub tx: packed::Transaction,
}

/// What the platform issued and expects back. A verifier that skips a field accepts proofs made for
/// another platform, account, lock, chain or time, so every field but `now` is required.
#[derive(Clone, Debug)]
pub struct Expect {
    /// The exact message the platform issued for this nonce, as it stored it. Compared byte for byte.
    pub message: String,
    /// The platform's own domain.
    pub domain: String,
    /// The account the lock is being linked to.
    pub account: String,
    /// The nonce the platform issued for this account and lock.
    pub nonce: String,
    /// Genesis hash of the chain, from the platform's config (never from the proof or the node).
    pub chain: H256,
    /// How long after "Issued at" the message is still accepted.
    pub max_age: Duration,
    /// The time to check against. None: the system clock.
    pub now: Option<SystemTime>,
}

/// Settings of [`verify`]. `Default` gives the values the TypeScript package uses.
#[derive(Clone)]
pub struct VerifyOptions {
    /// After the lock accepts, run it twice more: with an empty witness, and with the same witness
    /// on the template of another message. If either opens, nobody holds the lock alone, and the
    /// proof is refused. Default true. Turn off only to measure what the probes stop.
    pub probes: bool,
    /// Largest witness accepted, in bytes. Default [`MAX_WITNESS_BYTES`].
    pub max_witness_bytes: usize,
    /// Cycle limit of each lock run. Default [`DEFAULT_MAX_CYCLES`].
    pub max_cycles: u64,
    /// Time allowed for all the chain reads of one call together. Default [`VERIFY_DEADLINE`]. A
    /// read that would start after it fails with an error: the node is too slow.
    pub deadline: Duration,
    /// The consensus to run the lock under. None: mainnet's or testnet's from the bundled spec,
    /// chosen by `expect.chain`; another chain then fails with [`VerifyError::NoConsensus`].
    pub consensus: Option<Arc<Consensus>>,
}

impl Default for VerifyOptions {
    fn default() -> Self {
        Self { probes: true, max_witness_bytes: MAX_WITNESS_BYTES, max_cycles: DEFAULT_MAX_CYCLES, deadline: VERIFY_DEADLINE, consensus: None }
    }
}

/// A proof the lock accepted.
#[derive(Clone, Debug)]
pub struct Accepted {
    pub fields: MessageFields,
    pub cycles: u64,
    /// Every cell the proof's deps resolved to, dep group members included, read live. The lock's
    /// code and settings live there: a binding stays valid only while all of them are still live.
    pub cell_deps: Vec<packed::OutPoint>,
}

/// A proof refused, and why. `run` is the lock run that decided it, when one did.
#[derive(Clone, Debug)]
pub struct Refused {
    pub reason: String,
    pub run: Option<LockRun>,
}

/// The outcome of [`verify`].
#[derive(Clone, Debug)]
pub enum Verdict {
    Accepted(Accepted),
    Refused(Refused),
}

impl Verdict {
    pub fn is_accepted(&self) -> bool {
        matches!(self, Verdict::Accepted(_))
    }
    /// The refusal reason, or None when accepted.
    pub fn reason(&self) -> Option<&str> {
        match self {
            Verdict::Accepted(_) => None,
            Verdict::Refused(r) => Some(&r.reason),
        }
    }
}

/// Not a refusal: the check could not be completed. Try again later, or fix the setup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// The node could not be reached or gave an answer that is not what the method returns.
    Rpc(RpcError),
    /// The lock could not be started.
    Runner(String),
    /// No consensus for `expect.chain`: pass one in [`VerifyOptions::consensus`].
    NoConsensus(String),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Rpc(e) => write!(f, "chain read failed: {e}"),
            VerifyError::Runner(e) => write!(f, "lock runner failed: {e}"),
            VerifyError::NoConsensus(e) => write!(f, "no consensus: {e}"),
        }
    }
}
impl std::error::Error for VerifyError {}
impl From<RpcError> for VerifyError {
    fn from(e: RpcError) -> Self {
        VerifyError::Rpc(e)
    }
}

fn refuse(reason: impl Into<String>) -> Result<Verdict, VerifyError> {
    Ok(Verdict::Refused(Refused { reason: reason.into(), run: None }))
}

fn key(op: &packed::OutPoint) -> String {
    let index: u32 = op.index().unpack();
    format!("{}:{index}", hex(op.tx_hash().as_slice()))
}

/// The first out point listed twice, as the node refuses it (DuplicateCellDeps).
pub fn duplicate_cell_dep(cell_deps: &[packed::CellDep]) -> Option<packed::OutPoint> {
    let mut listed = HashSet::new();
    cell_deps.iter().map(|d| d.out_point()).find(|op| !listed.insert(key(op)))
}

/// A cell dep or header dep the verifier refuses: not live, not a dep group, listed twice, or too
/// many cells. The text is the refusal reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DepError {
    Refused(String),
    Rpc(RpcError),
}
impl From<RpcError> for DepError {
    fn from(e: RpcError) -> Self {
        DepError::Rpc(e)
    }
}

fn out_point_json(op: &packed::OutPoint) -> Value {
    let index: u32 = op.index().unpack();
    json!({ "tx_hash": hex(op.tx_hash().as_slice()), "index": hex_num(index.into()) })
}

fn live_cell(rpc: &impl Rpc, op: &packed::OutPoint) -> Result<DepCell, DepError> {
    let r = rpc.call("get_live_cell", json!([out_point_json(op), true]))?;
    let status = r.get("status").and_then(Value::as_str).unwrap_or("undefined");
    if status != "live" {
        return Err(DepError::Refused(format!("cell dep {} is not live ({status})", key(op))));
    }
    let output: rpc::CellOutput = serde_json::from_value(r["cell"]["output"].clone()).map_err(|e| RpcError(format!("get_live_cell output: {e}")))?;
    let data = r["cell"]["data"]["content"].as_str().ok_or_else(|| RpcError("get_live_cell: no data".into()))?;
    let data = unhex(data).map_err(|e| RpcError(format!("get_live_cell data: {e}")))?;
    Ok(DepCell { out_point: op.clone(), output: output.into(), data: Bytes::from(data) })
}

/// Every cell dep as the chain has it now, read as a live cell, dep groups expanded. Bounded: an
/// out point listed twice is refused before any read; the dep groups' member counts are read from
/// their data and refused above `max_members` before any member is read; a member already read is
/// not read again.
pub fn resolve_cell_deps(rpc: &impl Rpc, cell_deps: &[packed::CellDep], max_members: usize) -> Result<Vec<DepCell>, DepError> {
    if let Some(twice) = duplicate_cell_dep(cell_deps) {
        return Err(DepError::Refused(format!("cell dep {} is listed twice", key(&twice))));
    }
    let mut out = Vec::new();
    let mut groups: Vec<(packed::OutPoint, Bytes, usize)> = Vec::new();
    let mut members = 0usize;
    for dep in cell_deps {
        let cell = live_cell(rpc, &dep.out_point())?;
        let is_group = u8::from(dep.dep_type()) == 1;
        if is_group {
            let data = cell.data.clone();
            let n = if data.len() >= 4 { u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize } else { usize::MAX };
            if n == usize::MAX || data.len() != 4 + 36 * n {
                return Err(DepError::Refused(format!("cell dep {} is not a dep group", key(&dep.out_point()))));
            }
            members += n;
            if members > max_members {
                return Err(DepError::Refused(format!("cell dep groups list more than {max_members} cells")));
            }
            groups.push((dep.out_point(), data, n));
        }
        out.push(cell);
    }
    let mut seen: HashSet<String> = cell_deps.iter().map(|d| key(&d.out_point())).collect();
    for (_, data, n) in groups {
        for i in 0..n {
            let member = packed::OutPoint::from_slice(&data[4 + 36 * i..40 + 36 * i]).expect("36 bytes");
            if !seen.insert(key(&member)) {
                continue;
            }
            out.push(live_cell(rpc, &member)?);
        }
    }
    Ok(out)
}

/// Every header dep read live from the chain, by block hash, in the order listed, each read once.
pub fn resolve_headers(rpc: &impl Rpc, header_deps: &[packed::Byte32]) -> Result<Vec<HeaderView>, DepError> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dep in header_deps {
        let hash = hex(dep.as_slice());
        if !seen.insert(hash.clone()) {
            continue;
        }
        let h = rpc.call("get_header", json!([hash]))?;
        if h.is_null() {
            return Err(DepError::Refused(format!("header dep {hash} is not live (unknown)")));
        }
        let view: rpc::HeaderView = serde_json::from_value(h).map_err(|e| RpcError(format!("get_header: {e}")))?;
        out.push(view.into());
    }
    Ok(out)
}

fn now_ms(t: SystemTime) -> i128 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i128,
        Err(e) => -(e.duration().as_millis() as i128),
    }
}

fn check_expect(f: &MessageFields, e: &Expect, message: &str) -> Option<&'static str> {
    if message != e.message {
        return Some("message is not the one issued");
    }
    if f.domain != e.domain {
        return Some("message is for another domain");
    }
    if f.account != e.account {
        return Some("message is for another account");
    }
    if f.nonce != e.nonce {
        return Some("message has another nonce");
    }
    if f.chain != hex(e.chain.as_bytes()) {
        return Some("message names another chain");
    }
    let Some(issued) = parse_time(&f.issued_at) else {
        return Some("bad issued at");
    };
    let issued = issued as i128;
    let age_ms = now_ms(e.now.unwrap_or_else(SystemTime::now)) - issued;
    if age_ms * 1_000_000 > e.max_age.as_nanos() as i128 {
        return Some("message expired");
    }
    if age_ms < -(CLOCK_SKEW.as_millis() as i128) {
        return Some("message issued in the future");
    }
    None
}

fn missing_expect(e: &Expect) -> Option<String> {
    for (k, v) in [("message", &e.message), ("domain", &e.domain), ("account", &e.account), ("nonce", &e.nonce)] {
        if v.is_empty() {
            return Some(format!("expect.{k} is required"));
        }
    }
    None
}

/// The same message with the nonce replaced by a fresh random one: a message nobody was asked to sign.
fn probe_message(message: &str) -> String {
    let mut r = [0u8; 16];
    getrandom::getrandom(&mut r).expect("system randomness");
    let at = message.rfind("\nNonce: ").expect("a parsed message ends with its nonce line");
    format!("{}\nNonce: probe-{}", &message[..at], &hex(&r)[2..])
}

fn with_witnesses(tx: &packed::Transaction, witnesses: packed::BytesVec) -> packed::Transaction {
    tx.clone().as_builder().witnesses(witnesses).build()
}

/// Checks a proof. Accepted means the claimed lock accepted the proof transaction that the
/// verifier itself built from (lock, message), with every cell dep read live from the chain, and
/// the message is exactly the one the platform issued (`expect`). Refusals that need no chain read
/// come first. `claim_nonce` is called once, after every free check has passed and before the first
/// chain read: return false when the nonce is already used, and put the platform's compare-and-set
/// there, so each nonce pays for at most one set of chain reads and lock runs. Err only when the
/// node cannot be reached, the lock cannot be started, or there is no consensus for the chain.
pub fn verify(
    proof: &Proof,
    expect: &Expect,
    rpc: &impl Rpc,
    opts: &VerifyOptions,
    claim_nonce: impl FnOnce(&MessageFields) -> bool,
) -> Result<Verdict, VerifyError> {
    if let Some(m) = missing_expect(expect) {
        return refuse(m);
    }
    let fields = match parse_message(&proof.message) {
        Ok(f) => f,
        Err(e) => return refuse(format!("malformed proof: {e}")),
    };
    let (lock, tx) = (&proof.lock, &proof.tx);
    if fields.lock_hash != hex(lock.calc_script_hash().as_slice()) {
        return refuse("message names another lock");
    }
    if omnilock_admin(lock) {
        return refuse("omnilock in administrator mode: an administrator can sign for it");
    }
    if let Some(r) = check_expect(&fields, expect, &proof.message) {
        return refuse(r);
    }
    if tx.witnesses().len() != 1 {
        return refuse("exactly one witness expected");
    }
    if tx.as_slice().len() + 4 > MAX_TX_BYTES {
        return refuse("transaction too large");
    }
    if tx.witnesses().get(0).map(|w| w.raw_data().len()).unwrap_or(0) > opts.max_witness_bytes {
        return refuse("witness too large");
    }
    let raw = tx.raw();
    let cell_deps: Vec<packed::CellDep> = raw.cell_deps().into_iter().collect();
    let header_deps: Vec<packed::Byte32> = raw.header_deps().into_iter().collect();
    if cell_deps.len() > MAX_CELL_DEPS {
        return refuse("too many cell deps");
    }
    if header_deps.len() > MAX_HEADER_DEPS {
        return refuse("too many header deps");
    }
    if let Some(twice) = duplicate_cell_dep(&cell_deps) {
        return refuse(format!("cell dep {} is listed twice", key(&twice)));
    }
    // Cell deps, header deps and the input's since are the prover's to fill, like the witness: they
    // are copied from the submitted transaction, so the hash check does not pin them. The out point
    // and the output stay pinned, so the proof still commits to the lock and the message.
    if template_like(lock, &proof.message, tx).calc_tx_hash() != tx.calc_tx_hash() {
        return refuse("not the proof template for this lock and message");
    }
    let consensus = match &opts.consensus {
        Some(c) => c.clone(),
        None => match consensus_for(&expect.chain) {
            Some(c) => c.map_err(VerifyError::NoConsensus)?,
            None => return Err(VerifyError::NoConsensus(format!("{} is not mainnet or testnet", hex(expect.chain.as_bytes())))),
        },
    };

    // Every check above is free. From here on each step reads the chain or runs the lock.
    if !claim_nonce(&fields) {
        return refuse("nonce already used");
    }
    let timed = Deadline { rpc, until: std::time::Instant::now() + opts.deadline };
    let rpc = &timed;
    let genesis = rpc.call("get_block_hash", json!(["0x0"]))?;
    if genesis.as_str() != Some(fields.chain.as_str()) {
        return refuse("the node is on another chain");
    }
    let resolved = resolve_cell_deps(rpc, &cell_deps, MAX_DEP_GROUP_MEMBERS).and_then(|d| Ok((d, resolve_headers(rpc, &header_deps)?)));
    let (deps, headers) = match resolved {
        Ok(r) => r,
        Err(DepError::Refused(reason)) => return refuse(reason),
        Err(DepError::Rpc(e)) => return Err(e.into()),
    };
    let epoch = tip_epoch(rpc)?;
    let run = |t: &packed::Transaction| run_lock(t, lock, &deps, &headers, consensus.clone(), epoch, opts.max_cycles).map_err(VerifyError::Runner);

    let first = run(tx)?;
    match first.code {
        Some(0) => {}
        Some(code) => return Ok(Verdict::Refused(Refused { reason: format!("lock exited {code}"), run: Some(first) })),
        None => {
            let last = first.output.lines().last().unwrap_or("").to_string();
            return Ok(Verdict::Refused(Refused { reason: format!("lock did not run: {last}"), run: Some(first) }));
        }
    }
    if opts.probes {
        let empty = with_witnesses(tx, vec![Bytes::new().pack()].pack());
        let a = run(&empty)?;
        if a.code == Some(0) {
            return Ok(Verdict::Refused(Refused { reason: "no exclusive control: the lock opens with an empty witness".into(), run: Some(a) }));
        }
        let other = with_witnesses(&template_like(lock, &probe_message(&proof.message), tx), tx.witnesses());
        let b = run(&other)?;
        if b.code == Some(0) {
            return Ok(Verdict::Refused(Refused { reason: "no exclusive control: the same witness opens another message".into(), run: Some(b) }));
        }
    }
    Ok(Verdict::Accepted(Accepted { fields, cycles: first.cycles.unwrap_or(0), cell_deps: deps.iter().map(|d| d.out_point.clone()).collect() }))
}

/// [`verify`] for a proof as JSON, the way it arrives from a browser: the lock and the transaction
/// in CCC's form or the JSON RPC form. A lock or transaction that does not parse is refused with
/// "malformed proof", as the TypeScript `verify` refuses it.
pub fn verify_json(
    lock: &Value,
    message: &str,
    tx: &Value,
    expect: &Expect,
    rpc: &impl Rpc,
    opts: &VerifyOptions,
    claim_nonce: impl FnOnce(&MessageFields) -> bool,
) -> Result<Verdict, VerifyError> {
    if let Some(m) = missing_expect(expect) {
        return refuse(m);
    }
    let parsed = crate::json::script_from_json(lock).and_then(|l| Ok((l, crate::json::transaction_from_json(tx)?)));
    match parsed {
        Ok((lock, tx)) => verify(&Proof { lock, message: message.to_string(), tx }, expect, rpc, opts, claim_nonce),
        Err(e) => refuse(format!("malformed proof: {e}")),
    }
}

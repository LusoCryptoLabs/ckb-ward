// Shared by the integration tests: the vectors of ../../tests/vectors, and the chain they need.
//
// The chain comes from one of three places:
//   default            tests/fixtures/rpc.json.gz, answers recorded from the nodes (no network)
//   CKB_WARD_ONLINE=1  the testnet and mainnet RPC, live
//   CKB_WARD_RECORD=1  live, and every answer written to tests/fixtures/rpc.json.gz
// A call the fixture does not have fails the test: re-record after changing what a test reads.
#![allow(dead_code)]
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use ckb_types::{bytes::Bytes, packed, prelude::*, H256};
use ckb_ward::{json, parse_message, parse_time, Expect, Rpc, RpcClient, RpcError};
use serde_json::Value;

pub const TESTNET_RPC: &str = "https://testnet.ckb.dev/rpc";
pub const MAINNET_RPC: &str = "https://mainnet.ckb.dev/rpc";

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

#[derive(Clone, Debug)]
pub struct Vector {
    pub file: String,
    pub name: String,
    pub network: String,
    pub raw: Value,
    pub lock: packed::Script,
    pub message: String,
    pub tx: packed::Transaction,
    pub signature_byte: usize,
    pub other_message_exit: i8,
    pub signature_flip_exit: i8,
}

pub fn vectors() -> Vec<Vector> {
    let dir = repo().join("tests/vectors");
    let mut files: Vec<_> =
        std::fs::read_dir(&dir).expect("tests/vectors").map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    files
        .into_iter()
        .map(|p| {
            let raw: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            Vector {
                file: p.file_name().unwrap().to_string_lossy().into(),
                name: raw["name"].as_str().unwrap().into(),
                network: raw["network"].as_str().unwrap_or("testnet").into(),
                lock: json::script_from_json(&raw["lock"]).unwrap(),
                message: raw["message"].as_str().unwrap().into(),
                tx: json::transaction_from_json(&raw["tx"]).unwrap(),
                signature_byte: raw["signatureByte"].as_u64().unwrap() as usize,
                other_message_exit: raw["otherMessageExit"].as_i64().unwrap() as i8,
                signature_flip_exit: raw["signatureFlipExit"].as_i64().unwrap() as i8,
                raw,
            }
        })
        .collect()
}

/// What a platform that issued `message` passes as `expect`: the message as stored, its own domain
/// and chain, the account and nonce, a 10 minute window, and a clock one minute after issue.
pub fn expect_for(message: &str) -> Expect {
    let f = parse_message(message).unwrap();
    let issued = parse_time(&f.issued_at).unwrap();
    Expect {
        message: message.into(),
        domain: f.domain,
        account: f.account,
        nonce: f.nonce,
        chain: h256(&f.chain),
        max_age: Duration::from_secs(600),
        now: Some(UNIX_EPOCH + Duration::from_millis((issued + 60_000) as u64)),
    }
}

pub fn h256(s: &str) -> H256 {
    let b = hexbytes(s);
    H256::from_slice(&b).unwrap()
}

pub fn hexbytes(s: &str) -> Vec<u8> {
    let d = s.strip_prefix("0x").unwrap();
    (0..d.len()).step_by(2).map(|i| u8::from_str_radix(&d[i..i + 2], 16).unwrap()).collect()
}

/// The same message with one more character in the nonce.
pub fn other_message(message: &str) -> String {
    format!("{message}x")
}

/// A copy of the transaction with one bit flipped in witness 0 at the given byte offset.
pub fn flip_witness_byte(tx: &packed::Transaction, offset: usize) -> packed::Transaction {
    let mut w = tx.witnesses().get(0).unwrap().raw_data().to_vec();
    w[offset] ^= 1;
    tx.clone().as_builder().witnesses(vec![Bytes::from(w).pack()].pack()).build()
}

pub fn with_witness(tx: &packed::Transaction, w: Vec<u8>) -> packed::Transaction {
    tx.clone().as_builder().witnesses(vec![Bytes::from(w).pack()].pack()).build()
}

enum Mode {
    Replay,
    Online,
    Record,
}

fn mode() -> Mode {
    if std::env::var("CKB_WARD_RECORD").as_deref() == Ok("1") {
        Mode::Record
    } else if std::env::var("CKB_WARD_ONLINE").as_deref() == Ok("1") {
        Mode::Online
    } else {
        Mode::Replay
    }
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rpc.json.gz")
}

// Long strings (the cell data of lock code, 2 MB for the secp256k1 table) are kept once each, by
// content, under "blobs", and the file is gzipped.
const BLOB: usize = 4096;

fn pack(v: &Value, blobs: &mut BTreeMap<String, String>) -> Value {
    match v {
        Value::String(s) if s.len() > BLOB => {
            let id = format!("@blob:{}", hex_of(&ckb_hash::blake2b_256(s.as_bytes())));
            blobs.entry(id.clone()).or_insert_with(|| s.clone());
            Value::String(id)
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| pack(x, blobs)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), pack(x, blobs))).collect()),
        other => other.clone(),
    }
}

fn unpack(v: Value, blobs: &BTreeMap<String, String>) -> Value {
    match v {
        Value::String(s) if s.starts_with("@blob:") => Value::String(blobs[&s].clone()),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| unpack(x, blobs)).collect()),
        Value::Object(m) => Value::Object(m.into_iter().map(|(k, x)| (k, unpack(x, blobs))).collect()),
        other => other,
    }
}

fn hex_of(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn read_fixture() -> BTreeMap<String, Value> {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(fixture_path()) else { return BTreeMap::new() };
    let mut text = String::new();
    flate2::read::GzDecoder::new(file).read_to_string(&mut text).expect("rpc.json.gz");
    let mut doc: Value = serde_json::from_str(&text).expect("rpc.json.gz is JSON");
    let blobs: BTreeMap<String, String> = serde_json::from_value(doc["blobs"].take()).unwrap_or_default();
    let calls: BTreeMap<String, Value> = serde_json::from_value(doc["calls"].take()).unwrap_or_default();
    calls.into_iter().map(|(k, v)| (k, unpack(v, &blobs))).collect()
}

fn write_fixture(all: &BTreeMap<String, Value>) {
    use std::io::Write;
    let mut blobs = BTreeMap::new();
    let calls: BTreeMap<String, Value> = all.iter().map(|(k, v)| (k.clone(), pack(v, &mut blobs))).collect();
    let text = serde_json::to_string_pretty(&serde_json::json!({ "calls": calls, "blobs": blobs })).unwrap() + "\n";
    std::fs::create_dir_all(fixture_path().parent().unwrap()).unwrap();
    let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(fixture_path()).unwrap(), flate2::Compression::best());
    gz.write_all(text.as_bytes()).unwrap();
    gz.finish().unwrap();
}

fn fixture() -> &'static Mutex<BTreeMap<String, Value>> {
    static F: OnceLock<Mutex<BTreeMap<String, Value>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(read_fixture()))
}

/// Writes the recorded answers. Call at the end of a test in record mode.
pub fn save_fixture() {
    if matches!(mode(), Mode::Record) {
        // Merged with the file as it is now: several test binaries record into it.
        let map = fixture().lock().unwrap();
        let mut all = read_fixture();
        all.extend(map.iter().map(|(k, v)| (k.clone(), v.clone())));
        write_fixture(&all);
    }
}

/// The chain of one network, from the place `mode()` says.
pub struct Chain {
    network: String,
    live: Option<RpcClient>,
}

pub fn chain(network: &str) -> Chain {
    let url = if network == "mainnet" { MAINNET_RPC } else { TESTNET_RPC };
    let live = match mode() {
        Mode::Replay => None,
        _ => Some(RpcClient::with_timeout(url, Duration::from_secs(30))),
    };
    Chain { network: network.into(), live }
}

impl Rpc for Chain {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let key = format!("{} {method} {params}", self.network);
        match (&self.live, mode()) {
            (None, _) => fixture().lock().unwrap().get(&key).cloned().ok_or_else(|| RpcError(format!("not recorded: {key}"))),
            (Some(rpc), Mode::Record) => {
                let mut map = fixture().lock().unwrap();
                if let Some(v) = map.get(&key) {
                    return Ok(v.clone());
                }
                let v = rpc.call(method, params)?;
                map.insert(key, v.clone());
                Ok(v)
            }
            (Some(rpc), _) => rpc.call(method, params),
        }
    }
}

/// A chain that must not be read: the test fails if a check that should be free reads it.
pub struct NoChain;
impl Rpc for NoChain {
    fn call(&self, method: &str, _params: Value) -> Result<Value, RpcError> {
        panic!("{method} was called, but this check should not read the chain");
    }
}

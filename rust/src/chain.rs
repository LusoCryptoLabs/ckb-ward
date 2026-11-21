//! Reading the chain. Everything this crate reads goes through [`Rpc`], one JSON RPC call at a time,
//! with the same methods the TypeScript verifier calls. [`RpcClient`] speaks to a node over HTTP;
//! a backend with its own client implements the trait instead.
use std::io::Read;
use std::time::Duration;

use serde_json::Value;

/// A failed chain read: the node could not be reached, answered with an error, or answered with
/// something that is not what the method returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcError(pub String);

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for RpcError {}

/// One JSON RPC call to a CKB node: `method` with `params`, returning the `result` field.
pub trait Rpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError>;
}

impl<T: Rpc + ?Sized> Rpc for &T {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        (**self).call(method, params)
    }
}

/// Default timeout of one chain read.
pub const RPC_TIMEOUT: Duration = Duration::from_secs(10);
/// Default time for all the chain reads of one `verify` call. A proof makes at most 57 reads.
pub const VERIFY_DEADLINE: Duration = Duration::from_secs(60);
/// Largest answer accepted from the node, in bytes: the largest cell a proof can list is under 1 MB of hex.
pub const MAX_RPC_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

/// An [`Rpc`] that stops reading once `until` has passed: a call that would start later fails. The
/// time allowed for the reads of one verification is shared by all of them.
pub struct Deadline<'a, R: Rpc> {
    pub rpc: &'a R,
    pub until: std::time::Instant,
}

impl<R: Rpc> Rpc for Deadline<'_, R> {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if std::time::Instant::now() >= self.until {
            return Err(RpcError(format!("{method}: the time allowed for this verification has passed")));
        }
        self.rpc.call(method, params)
    }
}

/// Throws unless the node's indexer has indexed up to block `at`. An indexer that lags answers as the
/// chain was a few blocks ago: a deposit spent since would still look live. The search by script
/// (`get_transactions`) reads the indexer, so the check is made before it is used.
pub fn indexer_reaches(rpc: &impl Rpc, at: u64) -> Result<(), RpcError> {
    let tip = rpc.call("get_indexer_tip", Value::Array(vec![]))?;
    match num(&tip["block_number"], "get_indexer_tip block_number") {
        Ok(n) if n >= at => Ok(()),
        Ok(n) => Err(RpcError(format!("the indexer is at block {n}, behind the snapshot block {at}"))),
        Err(_) => Err(RpcError("the indexer is at block unknown, behind the snapshot block".to_string())),
    }
}

/// A blocking JSON RPC client for a CKB node. Each call fails after the timeout, body included.
#[cfg(feature = "rpc")]
pub struct RpcClient {
    url: String,
    agent: ureq::Agent,
    id: std::sync::atomic::AtomicU64,
}

#[cfg(feature = "rpc")]
impl RpcClient {
    pub fn new(url: impl Into<String>) -> Self {
        Self::with_timeout(url, RPC_TIMEOUT)
    }

    pub fn with_timeout(url: impl Into<String>, timeout: Duration) -> Self {
        Self { url: url.into(), agent: ureq::AgentBuilder::new().timeout(timeout).build(), id: 0.into() }
    }
}

#[cfg(feature = "rpc")]
impl Rpc for RpcClient {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.id.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let body = serde_json::json!({ "id": id, "jsonrpc": "2.0", "method": method, "params": params });
        let res = self.agent.post(&self.url).send_json(body).map_err(|e| RpcError(format!("{method}: {e}")))?;
        // Never buffer more than the cap: a node that answers without end must not fill the memory.
        let mut text = Vec::new();
        res.into_reader().take(MAX_RPC_RESPONSE_BYTES + 1).read_to_end(&mut text).map_err(|e| RpcError(format!("{method}: {e}")))?;
        if text.len() as u64 > MAX_RPC_RESPONSE_BYTES {
            return Err(RpcError(format!("{method}: the node's answer is larger than {MAX_RPC_RESPONSE_BYTES} bytes")));
        }
        let mut v: Value = serde_json::from_slice(&text).map_err(|e| RpcError(format!("{method}: {e}")))?;
        if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
            let msg = e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.to_string());
            return Err(RpcError(format!("{method}: {msg}")));
        }
        Ok(v.get_mut("result").map(Value::take).unwrap_or(Value::Null))
    }
}

/// A number the node writes as `0x` hex.
pub(crate) fn num(v: &Value, what: &str) -> Result<u64, RpcError> {
    let s = v.as_str().ok_or_else(|| RpcError(format!("{what}: not a hex number")))?;
    u64::from_str_radix(s.strip_prefix("0x").unwrap_or("_"), 16).map_err(|_| RpcError(format!("{what}: not a hex number")))
}

/// The epoch number of the tip block (`get_tip_header`).
pub fn tip_epoch(rpc: &impl Rpc) -> Result<u64, RpcError> {
    let tip = rpc.call("get_tip_header", Value::Array(vec![]))?;
    Ok(num(&tip["epoch"], "get_tip_header epoch")? & 0xff_ffff)
}

/// The number of the tip block (`get_tip_header`).
pub fn tip_number(rpc: &impl Rpc) -> Result<u64, RpcError> {
    let tip = rpc.call("get_tip_header", Value::Array(vec![]))?;
    num(&tip["number"], "get_tip_header number")
}

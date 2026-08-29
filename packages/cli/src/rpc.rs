//! Minimal JSON-RPC client and the handful of contract reads the miner needs.
//!
//! Hand-rolled rather than pulled from a framework: the miner touches six
//! methods and three view functions, and every dependency here would also have
//! to be audited by anyone running this against a wallet with real funds.

use primitive_types::U256;
use serde_json::{json, Value};

use crate::hash::keccak;

pub struct Rpc {
    url: String,
    agent: ureq::Agent,
    id: std::cell::Cell<u64>,
}

#[derive(Debug)]
pub enum RpcError {
    Transport(String),
    Node { code: i64, message: String },
    Decode(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Transport(m) => write!(f, "rpc unreachable: {m}"),
            RpcError::Node { code, message } => write!(f, "node error {code}: {message}"),
            RpcError::Decode(m) => write!(f, "malformed response: {m}"),
        }
    }
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(20))
                .build(),
            id: std::cell::Cell::new(1),
        }
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.id.get();
        self.id.set(id + 1);

        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let resp: Value = self
            .agent
            .post(&self.url)
            .send_json(body)
            .map_err(|e| RpcError::Transport(e.to_string()))?
            .into_json()
            .map_err(|e| RpcError::Decode(e.to_string()))?;

        if let Some(err) = resp.get("error") {
            return Err(RpcError::Node {
                code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
                message: err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            });
        }
        resp.get("result")
            .cloned()
            .ok_or_else(|| RpcError::Decode("no result field".into()))
    }

    pub fn chain_id(&self) -> Result<u64, RpcError> {
        hex_u64(&self.call("eth_chainId", json!([]))?)
    }

    pub fn block_timestamp(&self) -> Result<u64, RpcError> {
        let b = self.call("eth_getBlockByNumber", json!(["latest", false]))?;
        hex_u64(b.get("timestamp").ok_or_else(|| RpcError::Decode("no timestamp".into()))?)
    }

    pub fn balance(&self, address: &[u8; 20]) -> Result<U256, RpcError> {
        let v = self.call("eth_getBalance", json!([hex_addr(address), "latest"]))?;
        hex_u256(&v)
    }

    pub fn tx_count(&self, address: &[u8; 20]) -> Result<u64, RpcError> {
        hex_u64(&self.call("eth_getTransactionCount", json!([hex_addr(address), "pending"]))?)
    }

    pub fn gas_price(&self) -> Result<U256, RpcError> {
        hex_u256(&self.call("eth_gasPrice", json!([]))?)
    }

    /// `eth_call` against the token, returning the raw 32-byte word.
    pub fn view(&self, to: &[u8; 20], data: &[u8]) -> Result<U256, RpcError> {
        let v = self.call(
            "eth_call",
            json!([{ "to": hex_addr(to), "data": format!("0x{}", hex::encode(data)) }, "latest"]),
        )?;
        hex_u256(&v)
    }

    /// A view returning several words — a struct getter such as
    /// `epochs(uint256)` or `minerEpoch(address,uint256)`.
    pub fn view_words(&self, to: &[u8; 20], data: &[u8], words: usize) -> Result<Vec<U256>, RpcError> {
        let v = self.call(
            "eth_call",
            json!([{ "to": hex_addr(to), "data": format!("0x{}", hex::encode(data)) }, "latest"]),
        )?;
        let raw = v.as_str().unwrap_or_default().trim_start_matches("0x");
        let bytes = hex::decode(raw).map_err(|e| RpcError::Decode(e.to_string()))?;
        let mut out = Vec::with_capacity(words);
        for i in 0..words {
            let start = i * 32;
            if start + 32 > bytes.len() {
                return Err(RpcError::Decode(format!("wanted {words} words, got {} bytes", bytes.len())));
            }
            out.push(U256::from_big_endian(&bytes[start..start + 32]));
        }
        Ok(out)
    }

    pub fn send_raw(&self, raw: &[u8]) -> Result<String, RpcError> {
        let v = self.call("eth_sendRawTransaction", json!([format!("0x{}", hex::encode(raw))]))?;
        Ok(v.as_str().unwrap_or_default().to_string())
    }

    /// Poll until the transaction is mined. Returns whether it succeeded.
    pub fn wait_receipt(&self, hash: &str, tries: u32) -> Result<Option<bool>, RpcError> {
        for _ in 0..tries {
            let v = self.call("eth_getTransactionReceipt", json!([hash]))?;
            if !v.is_null() {
                let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("0x0");
                return Ok(Some(status == "0x1"));
            }
            std::thread::sleep(std::time::Duration::from_millis(700));
        }
        Ok(None)
    }
}

/// First four bytes of keccak256 of the signature, as the EVM selects functions.
pub fn selector(signature: &str) -> [u8; 4] {
    let h = keccak(signature.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

pub fn call_data(signature: &str, args: &[U256]) -> Vec<u8> {
    let mut out = selector(signature).to_vec();
    for a in args {
        let mut w = [0u8; 32];
        a.to_big_endian(&mut w);
        out.extend_from_slice(&w);
    }
    out
}

pub fn call_data_addr(signature: &str, addr: &[u8; 20], args: &[U256]) -> Vec<u8> {
    let mut out = selector(signature).to_vec();
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(addr);
    out.extend_from_slice(&w);
    for a in args {
        let mut v = [0u8; 32];
        a.to_big_endian(&mut v);
        out.extend_from_slice(&v);
    }
    out
}

pub fn hex_addr(a: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(a))
}

fn hex_u64(v: &Value) -> Result<u64, RpcError> {
    let s = v.as_str().ok_or_else(|| RpcError::Decode("expected hex string".into()))?;
    u64::from_str_radix(s.trim_start_matches("0x"), 16)
        .map_err(|e| RpcError::Decode(e.to_string()))
}

fn hex_u256(v: &Value) -> Result<U256, RpcError> {
    let s = v.as_str().ok_or_else(|| RpcError::Decode("expected hex string".into()))?;
    let s = s.trim_start_matches("0x");
    if s.is_empty() {
        return Ok(U256::zero());
    }
    U256::from_str_radix(s, 16).map_err(|e| RpcError::Decode(e.to_string()))
}

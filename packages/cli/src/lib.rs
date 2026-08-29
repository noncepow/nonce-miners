//! Library surface for the NONCE miner, so the integration tests can reach the
//! hash and the search without going through the binary.

pub mod hash;

#[cfg(feature = "gpu")]
pub mod gpu;
pub mod miner;
pub mod rpc;
pub mod strategy;
pub mod wallet;

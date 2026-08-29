//! The proof-of-work hash.
//!
//! Must produce byte-identical output to `Nonce.sol`:
//!
//! ```solidity
//! keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce))
//! ```
//!
//! That is 84 bytes: 32 challenge, 20 address, 32 big-endian nonce. One byte of
//! disagreement and every solution this miner finds is rejected on chain —
//! silently, because the failure looks like bad luck. `tests/parity.rs` checks
//! this against digest vectors the contract itself produced.

use primitive_types::U256;
use tiny_keccak::{Hasher, Keccak};

pub const PREIMAGE_LEN: usize = 32 + 20 + 32;
const NONCE_OFFSET: usize = 52;

/// Reusable preimage buffer for one (challenge, miner) pair.
///
/// The nonce is rewritten in place per attempt so the hot loop allocates
/// nothing; at a few hundred thousand hashes a second, an allocation per
/// attempt dominates the hash itself.
#[derive(Clone)]
pub struct Preimage {
    buf: [u8; PREIMAGE_LEN],
}

impl Preimage {
    pub fn new(challenge: [u8; 32], miner: [u8; 20]) -> Self {
        let mut buf = [0u8; PREIMAGE_LEN];
        buf[..32].copy_from_slice(&challenge);
        buf[32..52].copy_from_slice(&miner);
        Self { buf }
    }

    /// Write the nonce as 32 big-endian bytes, exactly as the EVM lays out a
    /// uint256. Always writes all 32 so a smaller value cannot inherit high
    /// bytes from the previous attempt.
    #[inline(always)]
    pub fn set_nonce(&mut self, nonce: U256) {
        nonce.to_big_endian(&mut self.buf[NONCE_OFFSET..]);
    }

    /// Fast path for the search loop: only the low 8 bytes change while the
    /// upper 24 stay fixed within a worker's slice.
    #[inline(always)]
    pub fn set_nonce_low(&mut self, low: u64) {
        self.buf[PREIMAGE_LEN - 8..].copy_from_slice(&low.to_be_bytes());
    }

    #[inline(always)]
    pub fn digest(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        let mut k = Keccak::v256();
        k.update(&self.buf);
        k.finalize(&mut out);
        out
    }

    pub fn bytes(&self) -> &[u8; PREIMAGE_LEN] {
        &self.buf
    }
}

/// `type(uint256).max / uint256(digest)` — the contract's difficulty score.
pub fn score_of(digest: &[u8; 32]) -> U256 {
    let d = U256::from_big_endian(digest);
    if d.is_zero() {
        U256::zero()
    } else {
        U256::MAX / d
    }
}

/// One-shot digest, for tests and verification rather than the hot loop.
pub fn digest(challenge: [u8; 32], miner: [u8; 20], nonce: U256) -> [u8; 32] {
    let mut p = Preimage::new(challenge, miner);
    p.set_nonce(nonce);
    p.digest()
}

pub fn keccak(input: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut k = Keccak::v256();
    k.update(input);
    k.finalize(&mut out);
    out
}

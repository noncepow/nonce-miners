//! The CUDA kernel must agree with the EVM, not merely with the CPU miner.
//!
//! A wrong keccak kernel does not fail loudly. It returns digests that look like
//! hashes, pass a plausibility glance, and are rejected by the contract every
//! time — which presents as persistent bad luck rather than a bug. So the kernel
//! is checked against the same digest vectors the contract itself produced, read
//! straight out of the GPU buffer with no CPU re-verification in between.
//!
//! Skipped when no GPU adapter is available, so CI without one still passes.

#![cfg(feature = "gpu")]

use std::path::Path;

use nonce_miner::gpu::Gpu;
use nonce_miner::hash::digest as cpu_digest;
use primitive_types::U256;
use serde_json::Value;

fn vectors() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors.json");
    let raw = std::fs::read_to_string(path).expect("vectors.json missing");
    serde_json::from_str(&raw).expect("vectors.json is not valid JSON")
}

fn bytes32(s: &str) -> [u8; 32] {
    let v = hex::decode(s.trim_start_matches("0x")).expect("bad hex");
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    out
}

fn address(s: &str) -> [u8; 20] {
    let v = hex::decode(s.trim_start_matches("0x")).expect("bad hex");
    let mut out = [0u8; 20];
    out.copy_from_slice(&v);
    out
}

fn gpu() -> Option<Gpu> {
    match Gpu::new() {
        Ok(g) => {
            eprintln!("gpu: {}", g.name);
            Some(g)
        }
        Err(e) => {
            eprintln!("skipping GPU tests: {e}");
            None
        }
    }
}

/// The whole point of the file: the kernel's digest, byte for byte, against
/// digests the contract produced.
#[test]
fn kernel_digest_matches_the_contract() {
    let Some(g) = gpu() else { return };

    for v in vectors() {
        let challenge = bytes32(v["challenge"].as_str().unwrap());
        let miner = address(v["miner"].as_str().unwrap());
        let nonce = U256::from_dec_str(v["nonce"].as_str().unwrap()).unwrap();
        let want = bytes32(v["digest"].as_str().unwrap());

        // Base at the exact nonce, so invocation 0 hashes precisely it.
        let out = g.raw_digests(challenge, miner, nonce, 1).expect("dispatch failed");
        let got = out
            .iter()
            .find(|(n, _)| *n == nonce)
            .unwrap_or_else(|| panic!("kernel never produced nonce {nonce}"));

        assert_eq!(
            hex::encode(got.1),
            hex::encode(want),
            "kernel disagrees with the contract at nonce {nonce}"
        );
    }
}

/// Nonces that straddle the 32- and 64-bit boundaries exercise the carry the
/// kernel does by hand, and the byte-swap that places them across two lanes.
#[test]
fn kernel_handles_the_word_boundaries() {
    let Some(g) = gpu() else { return };

    let challenge = [0x5Au8; 32];
    let miner = [0xC3u8; 20];
    let bases = [
        U256::zero(),
        U256::from(u32::MAX as u64 - 4),
        U256::from(u64::MAX - 300),
        U256::from(1u64) << 63,
        (U256::from(1u64) << 200) + U256::from(7u64),
    ];

    for base in bases {
        let out = g.raw_digests(challenge, miner, base, 1).expect("dispatch failed");
        assert!(!out.is_empty(), "no output at base {base}");
        for (nonce, got) in out {
            let want = cpu_digest(challenge, miner, nonce);
            assert_eq!(
                hex::encode(got),
                hex::encode(want),
                "kernel disagrees with the CPU at nonce {nonce} (base {base})"
            );
        }
    }
}

/// Every thread in a launch must hash its own nonce. A kernel that ignored the
/// thread id would still return plausible digests — all identical.
#[test]
fn every_thread_hashes_a_distinct_nonce() {
    let Some(g) = gpu() else { return };

    let challenge = [0x11u8; 32];
    let miner = [0x22u8; 20];
    let base = U256::from(1_000_000u64);
    let count = 256u32;

    let out = g.raw_digests(challenge, miner, base, count).expect("dispatch failed");
    assert_eq!(out.len(), count as usize, "one result per nonce searched");

    let mut nonces: Vec<U256> = out.iter().map(|(n, _)| *n).collect();
    nonces.sort();
    nonces.dedup();
    assert_eq!(nonces.len(), out.len(), "invocations produced duplicate nonces");

    for (nonce, got) in &out {
        assert_eq!(hex::encode(got), hex::encode(cpu_digest(challenge, miner, *nonce)));
    }
}

/// The target filter must actually reject: with an impossible target nothing
/// should come back, or the search would submit garbage.
#[test]
fn an_unreachable_target_yields_nothing() {
    let Some(g) = gpu() else { return };

    let out = g
        .search([0x33u8; 32], [0x44u8; 20], U256::one(), U256::zero(), 4)
        .expect("dispatch failed");
    assert!(out.is_empty(), "a target of 1 must be unreachable, got {} hits", out.len());
}

/// Solutions the GPU returns through the mining path must genuinely clear the
/// target and reproduce on the CPU.
#[test]
fn returned_solutions_are_valid() {
    let Some(g) = gpu() else { return };

    // One nonce in 4096 qualifies, so 4 x 65,536 nonces should yield ~64 hits.
    // Searching only a few hundred would make an empty result unremarkable and
    // the test meaningless.
    let target = U256::MAX >> 12;
    let challenge = [0x77u8; 32];
    let miner = [0x88u8; 20];
    let per_launch = 65_536u32;

    let mut total = 0;
    for i in 0..4u64 {
        let out = g
            .search(challenge, miner, target, U256::from(i * per_launch as u64), per_launch)
            .expect("dispatch failed");
        for s in &out {
            assert_eq!(cpu_digest(challenge, miner, s.nonce), s.digest, "digest not reproducible");
            assert!(U256::from_big_endian(&s.digest) <= target, "returned a digest above target");
        }
        total += out.len();
    }
    assert!(total > 0, "found no solutions against a 1-in-4096 target");
}

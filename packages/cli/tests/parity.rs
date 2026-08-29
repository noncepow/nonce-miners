//! The Rust miner's digest must match the contract byte for byte.
//!
//! The vectors in `tests/vectors.json` were produced by the EVM itself, via
//! `packages/contracts/script/DigestVectors.s.sol`, not by another Rust or
//! JavaScript implementation. Checking one implementation against another only
//! proves they agree with each other; the contract is the authority.
//!
//! A one-byte disagreement here does not throw. It makes every solution this
//! miner finds get rejected on chain, which presents as persistent bad luck.

use std::path::Path;

use nonce_miner::hash::{digest, score_of, Preimage, PREIMAGE_LEN};
use primitive_types::U256;
use serde_json::Value;

fn vectors() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors.json");
    let raw = std::fs::read_to_string(path).expect("vectors.json missing — regenerate with forge script DigestVectors.s.sol");
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

#[test]
fn fixture_actually_has_vectors() {
    assert!(vectors().len() >= 64, "expected at least 64 EVM-generated vectors");
}

#[test]
fn digest_matches_the_contract() {
    for v in vectors() {
        let challenge = bytes32(v["challenge"].as_str().unwrap());
        let miner = address(v["miner"].as_str().unwrap());
        let nonce = U256::from_dec_str(v["nonce"].as_str().unwrap()).unwrap();

        let got = digest(challenge, miner, nonce);
        let want = bytes32(v["digest"].as_str().unwrap());
        assert_eq!(
            hex::encode(got),
            hex::encode(want),
            "digest mismatch for nonce {}",
            v["nonce"].as_str().unwrap()
        );
    }
}

#[test]
fn score_matches_the_contract() {
    for v in vectors() {
        let challenge = bytes32(v["challenge"].as_str().unwrap());
        let miner = address(v["miner"].as_str().unwrap());
        let nonce = U256::from_dec_str(v["nonce"].as_str().unwrap()).unwrap();

        let got = score_of(&digest(challenge, miner, nonce));
        let want = U256::from_dec_str(v["score"].as_str().unwrap()).unwrap();
        assert_eq!(got, want, "score mismatch for nonce {}", v["nonce"].as_str().unwrap());
    }
}

#[test]
fn boundary_nonces_are_covered() {
    let covered: Vec<String> =
        vectors().iter().map(|v| v["nonce"].as_str().unwrap().to_string()).collect();
    for n in ["0", "1", &(U256::from(1u64) << 64).to_string(), &U256::MAX.to_string()] {
        assert!(covered.contains(&n.to_string()), "fixtures should cover nonce {n}");
    }
}

#[test]
fn preimage_layout_is_challenge_address_nonce() {
    let challenge = [0x11u8; 32];
    let miner = [0x22u8; 20];
    let mut p = Preimage::new(challenge, miner);
    p.set_nonce(U256::one());

    let b = p.bytes();
    assert_eq!(b.len(), PREIMAGE_LEN);
    assert_eq!(&b[..32], &challenge[..]);
    assert_eq!(&b[32..52], &miner[..]);
    assert_eq!(U256::from_big_endian(&b[52..]), U256::one());
}

/// The search loop rewrites only the low eight bytes. If that ever leaves stale
/// high bytes behind, every hash after the first is computed on a nonce the
/// miner does not think it used — and the submitted nonce would not reproduce.
#[test]
fn rewriting_the_nonce_clears_the_previous_value() {
    let mut p = Preimage::new([0u8; 32], [0u8; 20]);
    p.set_nonce(U256::MAX);
    assert_eq!(U256::from_big_endian(&p.bytes()[52..]), U256::MAX);
    p.set_nonce(U256::from(5u64));
    assert_eq!(U256::from_big_endian(&p.bytes()[52..]), U256::from(5u64));
}

#[test]
fn low_word_writes_agree_with_full_writes() {
    let challenge = [0xABu8; 32];
    let miner = [0xCDu8; 20];
    for n in [0u64, 1, 255, 65_536, u32::MAX as u64, u64::MAX] {
        let mut a = Preimage::new(challenge, miner);
        a.set_nonce(U256::from(n));

        let mut b = Preimage::new(challenge, miner);
        b.set_nonce(U256::zero());
        b.set_nonce_low(n);

        assert_eq!(a.bytes(), b.bytes(), "low-word write diverged at {n}");
    }
}

#[test]
fn zero_digest_does_not_divide_by_zero() {
    assert_eq!(score_of(&[0u8; 32]), U256::zero());
}

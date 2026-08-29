//! The keystore holds the only copy of a mining key. A round trip that silently
//! stores the wrong bytes, or a file that still contains the key in the clear,
//! would only be discovered when the wallet is needed and the funds are gone.
//!
//! Each test points `NONCE_KEYSTORE` at its own file. Tests in one binary share
//! a process, and `set_var` is process-wide, so they run under a mutex rather
//! than in parallel — otherwise one test's path would be read by another.

use std::sync::{Mutex, MutexGuard, OnceLock};

use nonce_miner::keystore;

/// Anvil's first well-known development key, and the address it derives to.
/// Public knowledge, funded on no real network.
const KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS: &str = "f39fd6e51aad88f6f4ce6ab8827279cfffb92266";

fn serialize() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
}

/// A fresh keystore path, removed when the guard drops.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("nonce-keystore-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let path = dir.join("keystore.json");
        std::env::set_var("NONCE_KEYSTORE", &path);
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        std::env::remove_var("NONCE_KEYSTORE");
    }
}

#[test]
fn an_imported_key_decrypts_back_to_the_same_wallet() {
    let _g = serialize();
    let _s = Scratch::new("import");

    let stored = keystore::import_with_password(KEY, "correct horse battery", false)
        .expect("import should succeed");
    assert_eq!(hex::encode(stored.address), ADDRESS, "imported the wrong key");

    let loaded = keystore::load_with_password("correct horse battery").expect("decrypt");
    assert_eq!(
        hex::encode(loaded.address),
        ADDRESS,
        "the key that came back is not the key that went in"
    );
}

/// A key that cannot be taken back out is a key held hostage by this tool.
#[test]
fn an_imported_key_can_be_exported_unchanged() {
    let _g = serialize();
    let _s = Scratch::new("export");

    keystore::import_with_password(KEY, "pw", false).expect("import");

    let exported = keystore::export_with_password("pw").expect("export");
    assert_eq!(exported, KEY, "the exported key is not the key that went in");

    assert!(
        keystore::export_with_password("wrong").is_err(),
        "the wrong password must not reveal the key"
    );
}

/// A generated key must be exportable too, or it could only ever be used here.
#[test]
fn a_generated_key_can_be_exported_and_reimported() {
    let _g = serialize();
    let _s = Scratch::new("exportgen");

    let made = keystore::create_with_password("pw", false).expect("generate");
    let exported = keystore::export_with_password("pw").expect("export");

    // Round trip it through a fresh keystore: same key, same address.
    let reimported =
        keystore::import_with_password(&exported, "other", true).expect("reimport");
    assert_eq!(made.address, reimported.address, "the round trip changed the key");
}

#[test]
fn the_wrong_password_does_not_yield_a_wallet() {
    let _g = serialize();
    let _s = Scratch::new("wrongpw");

    keystore::import_with_password(KEY, "right", false).expect("import");
    assert!(
        keystore::load_with_password("wrong").is_err(),
        "a wrong password must fail rather than return some other key"
    );
}

/// The whole point of the file: the secret must not be sitting in it.
#[test]
fn the_stored_file_does_not_contain_the_key() {
    let _g = serialize();
    let _s = Scratch::new("noplaintext");

    keystore::import_with_password(KEY, "pw", false).expect("import");
    let raw = std::fs::read_to_string(keystore::path()).expect("read keystore");

    let bare = KEY.trim_start_matches("0x");
    assert!(!raw.contains(bare), "the private key is in the file in the clear");
    assert!(!raw.to_lowercase().contains(&bare.to_lowercase()), "key present, different case");

    // ...and it is a real V3 keystore rather than something homegrown.
    let json: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(json["version"], 3);
    assert_eq!(json["crypto"]["cipher"], "aes-128-ctr");
    assert_eq!(json["crypto"]["kdf"], "scrypt");
    assert_eq!(json["address"], ADDRESS);
}

#[test]
fn an_existing_keystore_is_not_overwritten_by_accident() {
    let _g = serialize();
    let _s = Scratch::new("overwrite");

    keystore::import_with_password(KEY, "pw", false).expect("first import");

    let second = keystore::create_with_password("pw", false);
    assert!(second.is_err(), "creating over an existing keystore must be refused");

    // The original key is still there and still decrypts.
    let loaded = keystore::load_with_password("pw").expect("original survives");
    assert_eq!(hex::encode(loaded.address), ADDRESS);

    // --force is the deliberate way through, and it really does replace.
    let replaced = keystore::create_with_password("pw", true).expect("forced replace");
    assert_ne!(
        hex::encode(replaced.address),
        ADDRESS,
        "--force should have generated a new key"
    );
}

#[test]
fn a_generated_key_is_usable_and_distinct() {
    let _g = serialize();
    let _s = Scratch::new("generate");

    let first = keystore::create_with_password("pw", false).expect("generate");
    let loaded = keystore::load_with_password("pw").expect("decrypt");
    assert_eq!(first.address, loaded.address);

    let second = keystore::create_with_password("pw", true).expect("generate again");
    assert_ne!(first.address, second.address, "generation must not be deterministic");
}

#[test]
fn a_malformed_key_is_rejected_before_anything_is_written() {
    let _g = serialize();
    let _s = Scratch::new("malformed");

    for bad in ["not-hex", "0x1234", &"11".repeat(31), &"00".repeat(32)] {
        assert!(
            keystore::import_with_password(bad, "pw", false).is_err(),
            "{bad} should have been rejected"
        );
    }
    assert!(!keystore::exists(), "a rejected import must leave no keystore behind");
}

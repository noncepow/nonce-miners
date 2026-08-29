//! Encrypted keystore for the mining key.
//!
//! Until now the key could only come from `NONCE_PRIVATE_KEY`, which keeps it
//! out of shell history and process listings but leaves the operator to store
//! it themselves — usually in a shell profile, in the clear. Writing it to disk
//! unencrypted would give up the one property that setup was protecting, so the
//! key is stored in the [Web3 Secret Storage] format instead: scrypt-derived
//! key, AES-128-CTR, keccak MAC. The same file geth, foundry and MetaMask read,
//! so a key created here is not trapped here.
//!
//! A password is prompted for and never echoed. The private key itself is never
//! printed, never an argument, and never written in the clear.
//!
//! [Web3 Secret Storage]: https://ethereum.org/en/developers/docs/data-structures-and-encoding/web3-secret-storage/

use std::path::PathBuf;

use k256::ecdsa::SigningKey;
use rand::rngs::OsRng;

use crate::wallet::Wallet;

const FILE_NAME: &str = "keystore.json";

/// Read a secret without echoing it.
///
/// When stdin is a terminal this reads from the terminal, so the value never
/// reaches the shell. When it is not — a pipe, a CI step, a test — it reads the
/// piped line instead. Without that fallback the command hangs waiting on a
/// terminal that is not there, which is how every non-interactive use of it
/// would fail.
fn read_secret(label: &str) -> Result<String, String> {
    use std::io::{BufRead, IsTerminal};
    if std::io::stdin().is_terminal() {
        return rpassword::prompt_password(label)
            .map_err(|e| format!("could not read input: {e}"));
    }
    // Not a terminal, so there is no echo to suppress — take the line as it
    // comes, minus the line ending.
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| format!("could not read input: {e}"))?;
    while line.ends_with('\n') || line.ends_with('\r') {
        line.pop();
    }
    Ok(line)
}

/// Where the keystore lives. `NONCE_KEYSTORE` overrides it, so several wallets
/// can be kept side by side.
pub fn path() -> PathBuf {
    if let Ok(p) = std::env::var("NONCE_KEYSTORE") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".nonce").join(FILE_NAME)
}

pub fn exists() -> bool {
    path().is_file()
}

/// Generate a new key and store it encrypted. Returns the wallet.
pub fn create(force: bool) -> Result<Wallet, String> {
    guard_overwrite(force)?;
    let password = read_new_password()?;
    create_with_password(&password, force)
}

/// The body of [`create`], with the password supplied instead of prompted, so
/// the encryption round trip is testable without a terminal.
pub fn create_with_password(password: &str, force: bool) -> Result<Wallet, String> {
    guard_overwrite(force)?;
    // Generated through k256 rather than as 32 random bytes, so the result is
    // always a valid secp256k1 scalar rather than almost always one.
    let key = SigningKey::random(&mut OsRng);
    write_keystore(&key.to_bytes(), password)
}

/// Import an existing key, read from the terminal without echo.
pub fn import(force: bool) -> Result<Wallet, String> {
    guard_overwrite(force)?;

    // Prompted rather than taken as an argument: an argument would sit in shell
    // history and in every process listing for the life of the command.
    let entered = read_secret("Private key (input hidden): ")?;
    let bytes = parse_key(&entered)?;
    let password = read_new_password()?;
    write_keystore(&bytes, &password)
}

/// The body of [`import`], with both secrets supplied rather than prompted.
pub fn import_with_password(private_key: &str, password: &str, force: bool) -> Result<Wallet, String> {
    guard_overwrite(force)?;
    let bytes = parse_key(private_key)?;
    write_keystore(&bytes, password)
}

fn parse_key(entered: &str) -> Result<Vec<u8>, String> {
    let cleaned = entered.trim().trim_start_matches("0x");
    let bytes = hex::decode(cleaned).map_err(|_| "private key is not hex".to_string())?;
    if bytes.len() != 32 {
        return Err(format!("private key must be 32 bytes, got {}", bytes.len()));
    }
    // Reject a bad scalar now, while the user is still here to retype it.
    SigningKey::from_slice(&bytes).map_err(|_| "not a valid secp256k1 key".to_string())?;
    Ok(bytes)
}

/// The stored address, without asking for the password.
pub fn stored_address() -> Result<String, String> {
    let p = path();
    let raw = std::fs::read_to_string(&p)
        .map_err(|_| format!("no keystore at {} — run `nonce-miner wallet new`", p.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("keystore is not valid JSON: {e}"))?;
    json.get("address")
        .and_then(|v| v.as_str())
        .map(|s| format!("0x{}", s.trim_start_matches("0x")))
        .ok_or_else(|| "keystore has no address field".to_string())
}

/// Decrypt the keystore, prompting for the password.
pub fn load() -> Result<Wallet, String> {
    let p = path();
    if !p.is_file() {
        return Err(format!(
            "no keystore at {}. Create one with `nonce-miner wallet new`, or set NONCE_PRIVATE_KEY",
            p.display()
        ));
    }
    let password = read_secret("Keystore password: ")?;
    load_with_password(&password)
}

/// The body of [`load`], with the password supplied rather than prompted.
pub fn load_with_password(password: &str) -> Result<Wallet, String> {
    let secret = eth_keystore::decrypt_key(path(), password)
        .map_err(|_| "wrong password, or the keystore is corrupt".to_string())?;
    Wallet::from_hex(&hex::encode(secret))
}

// ---------------------------------------------------------------------------

fn guard_overwrite(force: bool) -> Result<(), String> {
    let p = path();
    if p.is_file() && !force {
        return Err(format!(
            "a keystore already exists at {}. Pass --force to replace it — the key it holds \
             cannot be recovered afterwards",
            p.display()
        ));
    }
    Ok(())
}

/// Ask twice. A password typed blind and stored wrong makes the key
/// unrecoverable, and the mistake only surfaces later.
fn read_new_password() -> Result<String, String> {
    let first = read_secret("New keystore password: ")?;
    if first.is_empty() {
        return Err("an empty password leaves the key effectively unencrypted".into());
    }
    let again = read_secret("Confirm password: ")?;
    if first != again {
        return Err("passwords did not match".into());
    }
    Ok(first)
}

fn write_keystore(secret: &[u8], password: &str) -> Result<Wallet, String> {
    let wallet = Wallet::from_hex(&hex::encode(secret))?;

    let p = path();
    let dir = p.parent().ok_or_else(|| "keystore path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "keystore path has no file name".to_string())?;

    eth_keystore::encrypt_key(dir, &mut OsRng, secret, password, Some(name))
        .map_err(|e| format!("could not encrypt the keystore: {e}"))?;

    // The format's address field is behind a crate feature that changes the
    // struct, so it is written here instead. Unknown fields are ignored on
    // read, so this stays compatible with every other wallet.
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("could not read back: {e}"))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("keystore is not valid JSON: {e}"))?;
    if let Some(obj) = json.as_object_mut() {
        obj.insert("address".into(), serde_json::Value::String(hex::encode(wallet.address)));
    }
    std::fs::write(&p, serde_json::to_string_pretty(&json).unwrap_or(raw))
        .map_err(|e| format!("could not write {}: {e}", p.display()))?;

    restrict(&p);
    Ok(wallet)
}

/// Owner-only. On Windows the file inherits the profile directory's ACL, which
/// is already user-scoped, so there is nothing equivalent to set.
#[cfg(unix)]
fn restrict(p: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_p: &std::path::Path) {}

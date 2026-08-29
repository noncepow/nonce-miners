//! Key handling and EIP-1559 transaction signing.
//!
//! The key is read from the environment and never printed, never logged, and
//! never sent anywhere but the signature it produces.

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use primitive_types::U256;
use rlp::RlpStream;

use crate::hash::keccak;

pub struct Wallet {
    key: SigningKey,
    pub address: [u8; 20],
}

impl Wallet {
    pub fn from_hex(private_key: &str) -> Result<Self, String> {
        let clean = private_key.trim().trim_start_matches("0x");
        let bytes = hex::decode(clean).map_err(|_| "private key is not hex".to_string())?;
        if bytes.len() != 32 {
            return Err("private key must be 32 bytes".into());
        }
        let key = SigningKey::from_slice(&bytes).map_err(|_| "invalid secp256k1 key".to_string())?;

        // Address = last 20 bytes of keccak256(uncompressed pubkey without the
        // 0x04 prefix).
        let pubkey = key.verifying_key().to_encoded_point(false);
        let hash = keccak(&pubkey.as_bytes()[1..]);
        let mut address = [0u8; 20];
        address.copy_from_slice(&hash[12..]);

        Ok(Self { key, address })
    }
}

pub struct Tx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee: U256,
    pub max_fee: U256,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: U256,
    pub data: Vec<u8>,
}

impl Tx {
    /// Encode and sign as an EIP-1559 (type 0x02) transaction.
    pub fn sign(&self, wallet: &Wallet) -> Result<Vec<u8>, String> {
        let unsigned = self.encode(None);
        let mut payload = vec![0x02u8];
        payload.extend_from_slice(&unsigned);
        let digest = keccak(&payload);

        let (sig, recid): (Signature, RecoveryId) = wallet
            .key
            .sign_prehash_recoverable(&digest)
            .map_err(|e| format!("signing failed: {e}"))?;

        let r = U256::from_big_endian(&sig.r().to_bytes());
        let s = U256::from_big_endian(&sig.s().to_bytes());
        let signed = self.encode(Some((recid.to_byte() as u64, r, s)));

        let mut out = vec![0x02u8];
        out.extend_from_slice(&signed);
        Ok(out)
    }

    fn encode(&self, sig: Option<(u64, U256, U256)>) -> Vec<u8> {
        let mut s = RlpStream::new();
        s.begin_list(if sig.is_some() { 12 } else { 9 });
        s.append(&self.chain_id);
        s.append(&self.nonce);
        s.append(&self.max_priority_fee);
        s.append(&self.max_fee);
        s.append(&self.gas_limit);
        s.append(&self.to.as_slice());
        s.append(&self.value);
        s.append(&self.data);
        s.begin_list(0); // empty access list
        if let Some((v, r, sv)) = sig {
            s.append(&v);
            s.append(&r);
            s.append(&sv);
        }
        s.out().to_vec()
    }
}

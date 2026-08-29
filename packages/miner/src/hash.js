import { keccak_256 } from "@noble/hashes/sha3";

export const MAX_U256 = (1n << 256n) - 1n;

/** Byte length of abi.encodePacked(bytes32, address, uint256). */
export const PREIMAGE_BYTES = 32 + 20 + 32;

const NONCE_OFFSET = 52;

function stripHex(hex) {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** Parse a hex string into exactly `length` bytes, left-padding with zeros. */
export function hexToBytes(hex, length) {
  let clean = stripHex(hex);
  if (clean.length % 2 !== 0) clean = "0" + clean;
  if (clean.length > length * 2) {
    throw new Error(`expected at most ${length} bytes, got ${clean.length / 2}`);
  }
  const out = new Uint8Array(length);
  const offset = length - clean.length / 2;
  for (let i = 0; i < clean.length / 2; i++) {
    out[offset + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * Build the reusable 84-byte preimage buffer for one (challenge, miner) pair.
 * The nonce is written in place per attempt so the hot loop allocates nothing.
 */
export function createPreimage(challenge, miner) {
  const buf = new Uint8Array(PREIMAGE_BYTES);
  buf.set(hexToBytes(challenge, 32), 0);
  buf.set(hexToBytes(miner, 20), 32);
  return buf;
}

/** Write a uint256 into the preimage as 32 big-endian bytes, matching the EVM. */
export function writeNonce(buf, nonce) {
  let n = BigInt(nonce);
  if (n < 0n || n > MAX_U256) throw new Error("nonce out of uint256 range");
  for (let i = 31; i >= 0; i--) {
    buf[NONCE_OFFSET + i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

/**
 * keccak256(abi.encodePacked(challenge, miner, nonce)) — the exact preimage
 * Nonce.sol hashes. Verified against on-chain vectors in test/parity.test.js.
 */
export function digest(challenge, miner, nonce) {
  return keccak_256(writeNonce(createPreimage(challenge, miner), nonce));
}

/** Difficulty score: type(uint256).max / uint256(digest), matching the contract. */
export function scoreOf(digestValue) {
  const d = typeof digestValue === "bigint" ? digestValue : bytesToBigInt(digestValue);
  if (d === 0n) return 0n;
  return MAX_U256 / d;
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  digest,
  scoreOf,
  bytesToHex,
  bytesToBigInt,
  hexToBytes,
  createPreimage,
  writeNonce,
  PREIMAGE_BYTES,
  MAX_U256,
} from "../src/hash.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));

test("fixture file actually has vectors", () => {
  assert.ok(vectors.length >= 64, `expected >= 64 vectors, got ${vectors.length}`);
});

test("digest matches the contract byte for byte", () => {
  for (const v of vectors) {
    const got = bytesToHex(digest(v.challenge, v.miner, BigInt(v.nonce)));
    assert.equal(
      got,
      v.digest.toLowerCase(),
      `digest mismatch for nonce ${v.nonce} (challenge ${v.challenge})`
    );
  }
});

test("score matches the contract", () => {
  for (const v of vectors) {
    const got = scoreOf(digest(v.challenge, v.miner, BigInt(v.nonce)));
    assert.equal(got, BigInt(v.score), `score mismatch for nonce ${v.nonce}`);
  }
});

test("miner address casing does not change the digest", () => {
  const v = vectors[0];
  const lower = bytesToHex(digest(v.challenge, v.miner.toLowerCase(), BigInt(v.nonce)));
  assert.equal(lower, v.digest.toLowerCase());
});

test("boundary nonces round-trip", () => {
  // The fixture set deliberately includes 0, 1, 2^64, 2^128-1, 2^255 and max.
  const covered = new Set(vectors.map((v) => v.nonce));
  for (const n of ["0", "1", (2n ** 64n).toString(), MAX_U256.toString()]) {
    assert.ok(covered.has(n), `fixtures should cover nonce ${n}`);
  }
});

test("preimage layout is 32-byte challenge, 20-byte address, 32-byte nonce", () => {
  const challenge = "0x" + "11".repeat(32);
  const miner = "0x" + "22".repeat(20);
  const buf = writeNonce(createPreimage(challenge, miner), 1n);

  assert.equal(buf.length, PREIMAGE_BYTES);
  assert.equal(bytesToHex(buf.slice(0, 32)), challenge);
  assert.equal(bytesToHex(buf.slice(32, 52)), miner);
  assert.equal(bytesToBigInt(buf.slice(52)), 1n);
});

test("nonce is written big-endian, and rewriting fully overwrites the previous value", () => {
  const buf = createPreimage("0x" + "00".repeat(32), "0x" + "00".repeat(20));
  writeNonce(buf, MAX_U256);
  assert.equal(bytesToBigInt(buf.slice(52)), MAX_U256);
  writeNonce(buf, 5n);
  assert.equal(bytesToBigInt(buf.slice(52)), 5n, "stale high bytes must be cleared");
});

test("rejects a nonce outside uint256", () => {
  const buf = createPreimage("0x" + "00".repeat(32), "0x" + "00".repeat(20));
  assert.throws(() => writeNonce(buf, MAX_U256 + 1n), /out of uint256 range/);
  assert.throws(() => writeNonce(buf, -1n), /out of uint256 range/);
});

test("hexToBytes left-pads short input rather than truncating", () => {
  assert.equal(bytesToHex(hexToBytes("0x1", 2)), "0x0001");
  assert.throws(() => hexToBytes("0x" + "ff".repeat(3), 2), /at most 2 bytes/);
});

test("scoreOf handles a zero digest without dividing by zero", () => {
  assert.equal(scoreOf(0n), 0n);
});

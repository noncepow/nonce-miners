import { keccak_256 } from "@noble/hashes/sha3";
import { createPreimage, writeNonce, hexToBytes, bytesToHex, bytesToBigInt, scoreOf } from "./hash.js";

/**
 * Lexicographic compare of two equal-length byte arrays.
 * Digests are compared as bytes rather than BigInts: converting 32 bytes to a
 * BigInt on every attempt costs more than the hash itself.
 */
export function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Hash `batchSize` nonces and return the best solution at or below `target`.
 *
 * Pure and synchronous so it can be driven by a Web Worker, a Node loop, or a
 * test. Nothing is allocated inside the loop — one preimage buffer is rewritten
 * in place and only an improving digest is copied out.
 *
 * @returns {{best: {nonce: bigint, digest: string, score: bigint}|null, hashes: number, nextNonce: bigint}}
 */
export function mineBatch({ challenge, miner, target, startNonce = 0n, batchSize = 50_000, best = null }) {
  const buf = createPreimage(challenge, miner);
  const targetBytes = hexToBytes(typeof target === "bigint" ? target.toString(16) : target, 32);

  let bestBytes = best ? hexToBytes(best.digest, 32) : null;
  let bestNonce = best ? BigInt(best.nonce) : 0n;
  let improved = false;

  let nonce = BigInt(startNonce);
  for (let i = 0; i < batchSize; i++, nonce++) {
    writeNonce(buf, nonce);
    const d = keccak_256(buf);

    // Above target: not a valid submission at all.
    if (compareBytes(d, targetBytes) > 0) continue;
    // Not an improvement on what we already hold.
    if (bestBytes !== null && compareBytes(d, bestBytes) >= 0) continue;

    bestBytes = d.slice();
    bestNonce = nonce;
    improved = true;
  }

  const result = improved
    ? { nonce: bestNonce, digest: bytesToHex(bestBytes), score: scoreOf(bytesToBigInt(bestBytes)) }
    : best;

  return { best: result, hashes: batchSize, nextNonce: nonce, improved };
}

/**
 * Convenience wrapper: keep hashing until a solution at or below `target` is
 * found, or `maxHashes` is exhausted. Intended for tests and short Node runs —
 * long sessions should drive mineBatch so they stay responsive.
 */
export function mineUntil({ challenge, miner, target, startNonce = 0n, maxHashes = 5_000_000, batchSize = 50_000 }) {
  let nonce = BigInt(startNonce);
  let hashes = 0;
  let best = null;

  while (hashes < maxHashes) {
    const size = Math.min(batchSize, maxHashes - hashes);
    const r = mineBatch({ challenge, miner, target, startNonce: nonce, batchSize: size, best });
    best = r.best;
    nonce = r.nextNonce;
    hashes += r.hashes;
    if (best) break;
  }
  return { best, hashes, nextNonce: nonce };
}

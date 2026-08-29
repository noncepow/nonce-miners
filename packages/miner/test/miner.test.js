import test from "node:test";
import assert from "node:assert/strict";

import { mineBatch, mineUntil, compareBytes } from "../src/miner.js";
import { digest, bytesToHex, bytesToBigInt, scoreOf, MAX_U256 } from "../src/hash.js";
import { shouldSubmit, createStrategy, newEpochState, DEFAULT_STRATEGY } from "../src/strategy.js";

const CHALLENGE = "0x" + "ab".repeat(32);
const MINER = "0x00000000000000000000000000000000000A11cE";

/** An easy target so tests stay fast: ~1 in 256 nonces qualify. */
const EASY = "0x00" + "ff".repeat(31);
const GENESIS_TARGET = (MAX_U256 >> 16n).toString(16);

test("compareBytes orders lexicographically", () => {
  assert.equal(compareBytes(Uint8Array.from([0, 1]), Uint8Array.from([0, 2])), -1);
  assert.equal(compareBytes(Uint8Array.from([1, 0]), Uint8Array.from([0, 255])), 1);
  assert.equal(compareBytes(Uint8Array.from([7, 7]), Uint8Array.from([7, 7])), 0);
});

test("a found solution really is at or below target, and rehashes identically", () => {
  const { best } = mineUntil({ challenge: CHALLENGE, miner: MINER, target: EASY, maxHashes: 100_000 });
  assert.ok(best, "should find a solution against an easy target");

  const rehashed = bytesToHex(digest(CHALLENGE, MINER, best.nonce));
  assert.equal(rehashed, best.digest, "reported digest must be reproducible");
  assert.ok(bytesToBigInt(digest(CHALLENGE, MINER, best.nonce)) <= BigInt(EASY), "digest must clear the target");
  assert.equal(best.score, scoreOf(bytesToBigInt(digest(CHALLENGE, MINER, best.nonce))));
});

test("mining the real genesis target succeeds within a reasonable budget", () => {
  const { best, hashes } = mineUntil({
    challenge: CHALLENGE,
    miner: MINER,
    target: GENESIS_TARGET,
    maxHashes: 2_000_000,
  });
  assert.ok(best, `no solution in ${hashes} hashes against MAX>>16`);
  assert.ok(bytesToBigInt(digest(CHALLENGE, MINER, best.nonce)) <= MAX_U256 >> 16n);
});

test("solutions are bound to the miner address", () => {
  const { best } = mineUntil({ challenge: CHALLENGE, miner: MINER, target: EASY, maxHashes: 100_000 });
  const otherMiner = "0x000000000000000000000000000000000000b0B0";
  const forOther = bytesToBigInt(digest(CHALLENGE, otherMiner, best.nonce));
  assert.notEqual(forOther, bytesToBigInt(digest(CHALLENGE, MINER, best.nonce)));
});

test("a new challenge invalidates the old solution", () => {
  const { best } = mineUntil({ challenge: CHALLENGE, miner: MINER, target: EASY, maxHashes: 100_000 });
  const nextChallenge = "0x" + "cd".repeat(32);
  assert.notEqual(bytesToHex(digest(nextChallenge, MINER, best.nonce)), best.digest);
});

test("mineBatch only reports an improvement, never a regression", () => {
  let state = mineUntil({ challenge: CHALLENGE, miner: MINER, target: EASY, maxHashes: 100_000 });
  const first = state.best;

  const r = mineBatch({
    challenge: CHALLENGE,
    miner: MINER,
    target: EASY,
    startNonce: state.nextNonce,
    batchSize: 200_000,
    best: first,
  });

  assert.ok(r.best.score >= first.score, "best score must never go down");
  if (r.improved) assert.ok(r.best.score > first.score, "improved implies a strictly better score");
  else assert.equal(r.best, first);
});

test("mineBatch resumes from nextNonce without repeating work", () => {
  const a = mineBatch({ challenge: CHALLENGE, miner: MINER, target: EASY, startNonce: 0n, batchSize: 1000 });
  assert.equal(a.nextNonce, 1000n);
  const b = mineBatch({ challenge: CHALLENGE, miner: MINER, target: EASY, startNonce: a.nextNonce, batchSize: 1000 });
  assert.equal(b.nextNonce, 2000n);
});

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

test("holds the hash until the epoch is closing", () => {
  const s = { best: { score: 100n }, submitted: null, submitsUsed: 0, msLeftInEpoch: 30_000 };
  assert.equal(shouldSubmit(s).submit, false);
  assert.equal(shouldSubmit({ ...s, msLeftInEpoch: 3_000 }).submit, true);
});

test("does not submit without a valid hash", () => {
  const r = shouldSubmit({ best: null, submitted: null, submitsUsed: 0, msLeftInEpoch: 1_000 });
  assert.equal(r.submit, false);
});

test("respects the 10-submit cap", () => {
  const s = { best: { score: 100n }, submitted: null, submitsUsed: 10, msLeftInEpoch: 1_000 };
  assert.equal(shouldSubmit(s).submit, false);
  assert.match(shouldSubmit(s).reason, /cap/);
});

test("rerolls only when the improvement clears the factor", () => {
  const base = { submitted: { score: 100n }, submitsUsed: 1, msLeftInEpoch: 20_000 };
  assert.equal(shouldSubmit({ ...base, best: { score: 199n } }).submit, false, "1.99x is not worth a fee");
  assert.equal(shouldSubmit({ ...base, best: { score: 200n } }).submit, true, "2x is");
});

test("never rerolls after the epoch has ended", () => {
  const r = shouldSubmit({
    best: { score: 1000n },
    submitted: { score: 1n },
    submitsUsed: 1,
    msLeftInEpoch: 0,
  });
  assert.equal(r.submit, false);
});

test("minScore skips junk hashes to save the fee", () => {
  const config = createStrategy({ minScore: 500n });
  const s = { best: { score: 100n }, submitted: null, submitsUsed: 0, msLeftInEpoch: 1_000 };
  assert.equal(shouldSubmit(s, config).submit, false);
  assert.equal(shouldSubmit({ ...s, best: { score: 900n } }, config).submit, true);
});

test("rejects a submit cap the contract would reject too", () => {
  assert.throws(() => createStrategy({ maxSubmits: 11 }), /between 1 and 10/);
  assert.throws(() => createStrategy({ maxSubmits: 0 }), /between 1 and 10/);
});

test("epoch state starts clean", () => {
  const s = newEpochState(42);
  assert.equal(s.epoch, 42);
  assert.equal(s.best, null);
  assert.equal(s.submitsUsed, 0);
  assert.equal(DEFAULT_STRATEGY.maxSubmits, 10, "default matches MAX_SUBMITS_PER_EPOCH");
});

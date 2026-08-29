# @nonce/miner

Keccak256 proof-of-work miner for NONCE. Same core in the browser (Web Worker) and in Node.

## The thing that matters

The miner and the contract must hash the *identical* preimage:

```
keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce))   // 84 bytes
```

One byte of disagreement and every solution the miner finds is rejected on chain — silently,
because the failure looks like bad luck. So the digest is checked against vectors generated
by the contract itself rather than against a reimplementation:

```bash
# regenerate from the contract repository: forge script script/DigestVectors.s.sol
node --test test/*.test.js
```

`test/vectors.json` holds 64 EVM-produced digest/score pairs covering nonce `0`, `1`, `2^64`,
`2^128-1`, `2^255` and `2^256-1`. Regenerate it whenever the preimage in `Nonce.sol` changes.

## Usage

```js
import { mineBatch, shouldSubmit, newEpochState } from "@nonce/miner";

const r = mineBatch({ challenge, miner, target, startNonce, batchSize: 20_000, best });
```

`mineBatch` is pure and synchronous, and allocates nothing in the loop — one 84-byte buffer is
rewritten per attempt. Drive it from a worker, a Node loop, or a test.

### Browser

```js
const w = new Worker(new URL("@nonce/miner/worker", import.meta.url), { type: "module" });
w.postMessage({ type: "start", challenge, miner, target, epoch });
w.onmessage = (e) => { /* "progress" | "solution" | "stopped" */ };
w.postMessage({ type: "challenge", challenge: next, epoch: epoch + 1 });  // on epoch rollover
```

The worker yields between batches so a `challenge` message lands promptly. A worker that
blocked through an epoch boundary would keep grinding a stale challenge.

### Node

```bash
NONCE_ADDRESS=0x... NONCE_PRIVATE_KEY=0x... node bin/mine.js --rpc http://127.0.0.1:8545
```

Flags: `--rpc` `--address` `--batch` `--max-submits` (1–10) `--lead-ms` `--once`.
The key is read from the environment only — never pass it as an argument.

## Submit strategy

Every submit costs the fee whether or not it improves your best, and the contract caps you at
10 per epoch. The default therefore holds the best hash until the epoch is nearly over and
sends once, rerolling early only when a new hash is at least **2×** better.

```js
createStrategy({ maxSubmits: 10, rerollFactor: 2n, submitLeadMs: 6000, minScore: 0n });
```

`minScore` skips submitting junk hashes entirely, which matters most when the token price is
low relative to the fee.

## Testing against a live epoch

```bash
NONCE_ADDRESS=0x... NONCE_PRIVATE_KEY=0x...   node bin/mine.js --rpc https://... --lead-ms 60000
```

`--lead-ms 60000` submits immediately rather than waiting out the 60-second epoch, which is
what you want when checking the setup works. Leave it at the default when actually mining:
holding the best hash until the epoch closes is what the fee is for.

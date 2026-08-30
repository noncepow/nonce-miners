# NONCE

**A proof-of-work token that funds its own liquidity**

Version 1.0 · Robinhood Chain (4663) · [nonce-spec.md](nonce-spec.md) is the normative specification

---

## Abstract

NONCE is an ERC-20 token whose only issuance path is proof of work. There is no pre-mine,
no allowlist, no investor allocation and no team wallet: every token in circulation was
produced by someone spending compute to find a hash.

Three design choices distinguish it from earlier on-chain proof-of-work tokens. Emission
follows a smooth polynomial curve rather than discrete halvings, so there is no night on
which the reward drops by half and half the miners leave. Each epoch's reward is split
**proportionally** among everyone who submitted, rather than paid entirely to one winner,
so a laptop is never shut out. And the protocol's liquidity is **built by mining itself** —
a fraction of every reward and every submit fee accumulates into a permanently locked
Uniswap v4 position, so the token's market depth is a function of how much work has been
done on it rather than of how much capital a founder was willing to post.

This document describes the mechanism, the economics, and the parts of both that are
unfavourable.

---

## 1. Motivation

Fair-launch tokens have a liquidity problem. A launch with no pre-sale raises no capital,
so either the founder funds the pool from their own pocket — reintroducing the insider
they were trying to avoid — or the pool starts empty and the first buyer eats catastrophic
slippage.

The usual answer is a bonding curve or a launchpad, both of which reintroduce a privileged
party. NONCE takes a different route: the act of mining is also the act of funding the pool.
Every submitted solution pays a small fee in ETH, and every epoch routes part of its
emission to the same place. Liquidity is therefore *earned*, and it accrues in proportion to
genuine participation rather than to anyone's balance sheet.

Prior art informs three specific decisions:

- **Bitcoin** established the 21M cap and the credibility of pure issuance-by-work, but its
  discrete halvings produce cliff events, and its difficulty targets a global hashrate that
  a single-chain token cannot assume.
- **0xBitcoin** brought proof of work to the EVM but rotates the challenge on every
  successful mint. Every other miner's in-flight work is destroyed the instant someone lands
  a solution, which makes browser and small-scale mining pointless.
- **ORE** demonstrated proportional distribution: everyone who submits earns something.
  This is the single most important property for participation breadth.
- **Pearl** demonstrated smooth polynomial emission in place of halving cliffs.

NONCE combines ORE's distribution with Pearl's emission curve, fixes the challenge-rotation
problem, and adds protocol-owned liquidity funded by the mining itself.

---

## 2. Supply and emission

Total supply is capped at **21,000,000**. Of that, **210,000** (1%) is minted once at deploy
directly into the liquidity contract — never to a wallet — leaving **20,790,000** to be
mined. The seed is carved *out of* the cap, not added to it, so total supply can never
exceed 21M.

Cumulative emission follows

```
A(t) = MINEABLE_SUPPLY × t / (t + H)        MINEABLE_SUPPLY = 20,790,000,  H = 100,000
R(t) = A(t + 1) − A(t)
```

where `t` is the epoch number and one epoch is 60 seconds.

The per-epoch reward is defined as the **discrete difference** of the cumulative curve
rather than its continuous derivative. This is not cosmetic: it makes the sum of all epoch
rewards equal `A(t)` exactly, with no drift accumulating from repeated integer division.
The property is asserted by fuzz test over arbitrary epoch ranges.

| Milestone | Epoch | Cumulative | % of 21M | Reward/min |
|-----------|-------|------------|----------|------------|
| Start | 0 | 0 | 0% | 207.90 |
| Day 1 | 1,440 | 295,126 | 1.4% | 202.04 |
| Day 7 | 10,080 | 1,903,735 | 9.1% | 171.57 |
| Day 21 | 30,240 | 4,827,162 | 23.0% | 122.56 |
| Day 69 | 100,000 | 10,395,000 | 49.5% | 51.97 |
| Day 208 | 300,000 | 15,592,500 | 74.2% | 12.99 |
| Day 694 | 1,000,000 | 18,900,000 | 90.0% | 1.72 |
| Year 2 | 1,051,200 | 18,984,058 | 90.4% | 1.57 |

Half the mineable supply is emitted by roughly day 69 (`t = H`), three quarters by day 208.
The curve approaches the cap asymptotically, so the tail never fully exhausts and there is
always a reward — however small — for continued work.

### 2.1 Rollover

If nobody mines an epoch, its emission is not burned. It rolls into the next epoch that
does receive a submission. Because `A(t)` is closed-form, the contract computes an arbitrary
gap in constant time:

```
pot(e) = A(e + 1) − A(lastOpenedEpoch)
```

A gap of ten epochs and a gap of ten thousand cost identical gas. There is no loop and no
unbounded state.

---

## 3. Mining

### 3.1 The work

A valid solution is a nonce whose digest falls at or below the current target:

```
digest = keccak256(challenge ‖ msg.sender ‖ nonce)     // 84-byte preimage
require(uint256(digest) <= target)
```

Keccak256 is the EVM's native hash, so verification costs roughly 30 gas plus calldata.

The miner's address sits **inside the preimage**. A solution is therefore bound to the
wallet that found it: it cannot be extracted from the mempool and submitted by someone else,
resold, or replayed. This also makes a per-wallet cap pointless — splitting work across
wallets does not reduce the work — so none exists.

### 3.2 Challenge rotation

The challenge rotates **once per epoch**, not once per solution. This is the correction to
0xBitcoin's central flaw. Under per-mint rotation, a miner with 1% of the hashrate has their
search invalidated roughly every time anyone else succeeds, which makes small-scale mining a
lottery on latency rather than on work. Per-epoch rotation gives every wallet an independent
search space for the full minute.

A future epoch's challenge is derivable in advance, so mining can begin the instant an epoch
starts rather than waiting for a first mover. Once an epoch opens, its challenge is pinned
and cannot shift under the miners already working on it.

### 3.3 Submission

A wallet may submit at most **10 times per epoch**, and only its **best** hash counts.
Additional submissions are rerolls: a better hash replaces the previous one, a worse hash
changes nothing but still costs the fee. The rational strategy is to mine most of the
minute, submit once near the close, and reroll only on a materially better result — the
reference miner defaults to a 2× improvement threshold, roughly where a second fee pays for
itself.

### 3.4 Distribution

Every valid submitter earns, in proportion to the quality of their best hash:

```
score  = type(uint256).max / uint256(bestDigest)
share  = score / totalScoreThisEpoch
reward = epochPot × share
```

A GPU explores more of the space and usually finds a better hash than a CPU, and earns
accordingly. But a CPU is never shut out and never spends an entire session earning nothing,
which is what a winner-takes-all design does to small participants.

### 3.5 Difficulty

The target is a spam filter, not a reward mechanism: it sets the minimum hash quality worth
putting on chain and has no influence on how the pot is divided.

| Parameter | Value |
|-----------|-------|
| Genesis target | `type(uint256).max >> 16` |
| Retarget | every 60 epochs (~1 hour) |
| Target submissions | 50 per epoch |
| Clamp | 4× per window |
| Floor | never easier than genesis |

At the genesis target roughly one hash in 65,536 qualifies, so a 2 MH/s laptop finds well
over a thousand valid hashes per minute. Nobody is priced out at launch.

The retarget arithmetic divides before multiplying and clamps the denominator before use, so
neither the ratio nor the product can overflow regardless of submission volume — a shape
that has produced live failures in comparable systems when the target sits near its ceiling
during slow opening epochs.

---

## 4. Economics

### 4.1 Fees

Each submission costs a small ETH fee on top of gas: **0.00002 ETH** at launch, split evenly
between the treasury and the liquidity accumulator.

The fee halves automatically every 100,000 epochs and is a **one-way ratchet** — the owner
may lower it at any time, including to zero, but the contract will not permit an increase
under any circumstances.

### 4.2 Tax

Before each epoch is distributed, **5%** is taken: 1% to the treasury, 4% to liquidity.
Miners keep 95%. The split is adjustable but the **total is capped at 5% in the contract**;
it can be moved to 0%/5% or 5%/0% but never to 6%.

Over the full curve this is approximately 207,900 NONCE to the treasury and 831,600 NONCE
to liquidity. There is no transfer tax — buying, selling and moving NONCE cost nothing
beyond gas.

The contract predates this terminology and still names the destination `devWallet`, its
share `devBps`, and its withdrawal `withdrawDevEth()`. Those identifiers are what appear in
the ABI and the verified source; "treasury" and `dev*` are the same single address.

### 4.3 Protocol-owned liquidity

The token side of the pool is the 210,000 seed plus 4% of every epoch. The ETH side is half
of every submit fee. Roughly hourly, the contract pairs what has accumulated into a
NONCE/ETH position on Uniswap v4.

| Source | Side | Amount | When |
|---|---|---|---|
| LP seed | NONCE | 210,000, carved out of the 21M cap | once, at deploy |
| Epoch tax | NONCE | 4% of the epoch's emission | every epoch |
| Submit fee | ETH | half of every fee | every submission |
| Deposit | both | everything accumulated, paired | every 60 epochs |
| Trading fees | both | 1% of pool volume | harvested to the treasury |

Nothing in that table flows the other way. There is no entry for a withdrawal, because no
function decreases or burns the position — the only value that ever leaves is trading fees,
and those go to an account that can actually move them.

Three properties matter, and each addresses a specific way this goes wrong in practice:

**The position is genuinely full range.** Ticks are `−887200` and `887200`, aligned to a tick
spacing of 200; no wider aligned pair exists. Native ETH is `currency0`, so the pool price
reads as NONCE-per-ETH. If NONCE falls, the price moves past the upper tick and the position
converts to 100% NONCE — the ETH is bought out by the market rather than stranded inside a
position nobody can withdraw.

**The starting price is derived from the amounts on hand**, as `sqrt(nonce/eth) × 2^96`,
rather than chosen in advance. At full range the required ratio is fixed by the price, so
initialising at an arbitrary price leaves the surplus side unconsumed — this is the most
common cause of funds stranded in a deployment helper. Any remaining dust stays in the
adapter and is folded into the next deposit, because deposits read live balances rather than
the amount they were handed.

**Fees are payable to a wallet, in both currencies.** The position NFT is held by the
contract and no function decreases or burns its liquidity, so the principal is locked
permanently. Trading fees are separate: `collectFees()` is permissionless to call, its
destination is immutable, and it pays out **both** ETH and NONCE directly to the treasury,
an externally owned account. Nothing is forwarded into a contract that cannot move it.

### 4.4 Staking

Locking NONCE multiplies a miner's score linearly, up to 2×:

```
effectiveScore = score × (1 + min(staked / stakeTarget, 1))
stakeTarget    = max(epochReward(now) × 5, 100 NONCE)
```

The target is **dynamic**, tracking the emission curve — about 1,040 NONCE on day one,
shrinking as rewards do. A fixed target would quietly penalise late arrivals, charging them
months of mining for the same boost an early miner obtained in minutes.

Stakes lock for **7 days**, and topping up restarts the lock on the whole balance. This is
what makes the multiplier honest: without it a miner could stake, submit, and withdraw
inside a single 60-second epoch, taking a 2× boost on capital they never committed.

---

## 5. Governance surface

Enforced by the contract, not by promise:

| Action | Possible |
|--------|----------|
| Lower the submit fee | Yes — one-way, never upward |
| Change the tax split | Yes — total capped at 5% |
| Change the treasury address | Yes |
| Adjust the stake target multiple | Yes |
| Collect LP trading fees | Yes — permissionless; destination immutable |
| Raise the fee | **No** |
| Exceed 5% total tax | **No** |
| Change the emission curve | **No** — supply and H are constants |
| Withdraw LP principal | **No** — no decrease or burn path exists |
| Redirect LP fees | **No** — the recipient is immutable |
| Mint tokens | **No** — only mining and the one-time seed |
| Pause mining | **No** — no pause function exists |

---

## 6. Distribution channels

Four interfaces share one hash implementation: a browser miner using Web Workers, a
GPU-accelerated CLI, an MCP server exposing mining as agent tools, and a packaged agent
skill that installs and operates the miner end to end.

They share the implementation deliberately. A second implementation of the preimage is a
second opportunity to disagree with the EVM by one byte — a failure that presents as
persistent bad luck rather than as an error. The JavaScript miner is therefore verified
against digest vectors generated by the contract itself, covering nonce `0`, `1`, `2^64`,
`2^128−1`, `2^255` and `2^256−1`.

---

## 7. Limitations

Stated plainly, because each of these affects whether the system is worth participating in.

**Per-epoch variance is large.** The score of a best-of-N hash search is heavy-tailed. Expected
score scales with hashrate, but any individual epoch is far noisier than that average: a CPU
will occasionally out-earn a GPU and a GPU will occasionally have a bad minute. Published
distribution figures describe long-run averages, not what a given minute pays.

**No profitability guarantee.** Nothing in the protocol ensures mining covers electricity or
rent. The system is self-correcting rather than protective: if price falls, miners leave,
the remaining miners' shares rise, and mining becomes viable again at a smaller scale. That
correction operates on the participant count, not on anyone's individual outcome.

**The launch price is not chosen.** Because the pool is initialised from accumulated amounts,
the opening price is a function of early mining activity. With few miners the pool is thin
and the implied valuation very low. This is intentional — it is the cost of refusing to seed
liquidity from anyone's balance sheet — but it means early price discovery is noisy.

**Difficulty targets submissions, not hashrate.** With a target of 50 submissions per epoch
and a 10-submission cap per wallet, the difficulty controller responds to participation
breadth rather than to total work. As the miner count grows, the target tightens and the
weakest hardware is progressively priced out of submitting, even though reward shares remain
proportional.

**The treasury tax is real.** 5% of emission is not zero, and the owner controls its split and the
LP fee destination. The constraints above bound what that control can do, but they do not
eliminate it.

**Deployed on Robinhood Chain mainnet (4663).**

| | |
|---|---|
| Nonce | `0xadf0ab9d892F7d9B82935364A2f623480a19681F` |
| AutoLP | `0xC86F6897bCeE878d38dbFCbdc03a608B3a7b71cD` |
| Treasury | `0x2cEE8f80923e313C64795c90746f7395c6F74262` |

Both are verified on Blockscout — a full bytecode match, not a partial one — so the
source above can be read against what actually runs.

Every mechanism described here ran on testnet (46630) first, against the same Uniswap v4
deployment that mainnet uses: liquidity minted, fees harvested in both currencies, the
seven-day lock enforced, and the difficulty retarget exercised. **They have not been
audited by a third party.**

---

## 8. Parameters

| Constant | Value |
|----------|-------|
| `MAX_SUPPLY` | 21,000,000 × 10¹⁸ |
| `LP_SEED` | 210,000 × 10¹⁸ |
| `MINEABLE_SUPPLY` | 20,790,000 × 10¹⁸ |
| `H` | 100,000 |
| `EPOCH_DURATION` | 60 seconds |
| `MAX_SUBMITS_PER_EPOCH` | 10 |
| `GENESIS_TARGET` | `type(uint256).max >> 16` |
| `RETARGET_WINDOW` | 60 epochs |
| `TARGET_SUBMITS_PER_EPOCH` | 50 |
| `DIFFICULTY_CLAMP` | 4× |
| `INITIAL_SUBMIT_FEE` | 0.00002 ETH |
| `FEE_HALVING_INTERVAL` | 100,000 epochs |
| `MAX_TAX_BPS` | 500 (5%) |
| `STAKE_LOCK_DURATION` | 7 days |
| `MULTIPLIER_CAP` | 2× |
| Pool fee / tick spacing | 1.00% / 200 |
| Position range | −887,200 … 887,200 |

---

## References

- Nakamoto, S. *Bitcoin: A Peer-to-Peer Electronic Cash System*, 2008.
- 0xBitcoin — EIP-918 mineable token standard.
- ORE — proportional proof-of-work distribution.
- Uniswap v4 — [developers.uniswap.org/docs/protocols/v4](https://developers.uniswap.org/docs/protocols/v4/deployments)
- Full technical specification: [nonce-spec.md](nonce-spec.md)

---
name: nonce-mining
description: Set up and operate a NONCE proof-of-work miner end to end — check the wallet can pay fees, start and stop mining, claim rewards, and manage the staking multiplier. Use when the user wants to mine NONCE, asks how their mining is going, wants to claim mined tokens, or wants to stake for the mining boost.
---

# Mining NONCE

NONCE is an ERC-20 whose only issuance path is proof of work. This skill covers getting a
miner running and keeping it healthy.

The MCP server does the work; this document is the procedure around it — what to check
before spending anything, and how to read what comes back.

## Before mining anything

Run the preflight. It is read-only and answers the three questions that decide whether
mining is worth starting at all:

```bash
node scripts/preflight.mjs
```

It reports:

1. **Chain and contract** — is the RPC live, and does the address hold the expected token
2. **Wallet funding** — every submission costs an ETH fee *on top of gas*. A wallet with
   zero ETH cannot mine at all, and one with a few cents' worth will stop within minutes.
3. **What an epoch currently pays** — so the fee can be compared against the reward

If `NONCE_PRIVATE_KEY` is unset the server still runs, but read-only: status and protocol
tools work, mining and claiming do not.

## Configuration

The MCP server reads everything from its own environment. Never pass a private key as a
tool argument, and never print one back to the user.

```json
{
  "mcpServers": {
    "nonce": {
      "command": "npx",
      "args": ["-y", "@noncepow/mcp-server"],
      "env": {
        "NONCE_RPC_URL": "https://rpc.mainnet.chain.robinhood.com",
        "NONCE_ADDRESS": "0xadf0ab9d892F7d9B82935364A2f623480a19681F",
        "NONCE_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

## Operating a miner

**Starting.** Call `nonce_start_mining`. Report the hashrate from `nonce_status` a few
seconds later rather than immediately — the first reading is taken over a fraction of a
second and is meaningless.

Leave `backend` on `auto` unless asked. It uses the `nonce-miner` binary when the machine
has it, and the GPU when there is one: 475 MH/s on a CUDA card against 70 KH/s in-process.
Since rewards are split by score, that gap decides whether mining covers its own fees.

If `nonce_status` reports a hashrate in the tens of KH/s, the binary is not installed and
the user is mining with the JavaScript fallback. Say so, and give them the one command:
`cargo install --git https://github.com/noncepow/nonce-miners nonce-miner`. Do not let
someone burn fees at 70 KH/s without knowing there is a 6,000x option.

**Reporting progress.** `nonce_status` is the single source of truth. Two fields are
routinely misread:

- `bestScore` is the best hash held *for the current epoch only*. It resets every 60
  seconds. A falling number is not a problem.
- `submitsThisEpoch` counts fee-paying submissions, capped at 10 by the contract. It is not
  a count of solutions found.

**Stopping.** `nonce_stop_mining`. Work already submitted still earns; nothing is lost, and
unclaimed rewards stay claimable indefinitely.

## Claiming

`nonce_claim` settles finished epochs. The **current epoch is never claimable** — if a user
asks why their reward is zero seconds after mining started, this is why.

If a claim runs out of gas, retry with a lower `max_epochs`. Each participated epoch adds
work to the transaction, so a wallet that mined for days needs several smaller claims
rather than one large one.

## Staking

Staking multiplies mining score linearly up to **2×**. Two properties matter and both
surprise people:

- The **stake target moves.** It tracks the emission curve, so the amount needed for the
  full 2× shrinks over time. Read `stakeTarget` from `nonce_status` rather than assuming a
  number.
- Stakes **lock for 7 days**, and staking again **restarts the lock on the whole balance**.
  Say this before staking, not after. A user who tops up on day 6 expecting to withdraw on
  day 7 will be locked for another week.

## Judgement calls

**Do not start mining without saying what it costs.** Each submission is a real ETH fee plus
gas. State the fee and the wallet balance first.

**Do not promise profit.** Rewards are split proportionally among everyone who submits, so
earnings depend on how many others are mining and on the token's price — neither of which is
knowable in advance. Per-epoch variance is also large: the score of a best-of-N hash search
is heavy-tailed, so a single epoch tells you very little.

**Tune the strategy rather than mining harder.** If a user is spending more on fees than
they are earning, `nonce_set_strategy` is the lever: raise `min_score` to skip weak hashes,
or lower `max_submits`. Mining more hours does not fix a fee-losing configuration.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every submission reverts | Stale challenge — the epoch rotated mid-flight. Routine; the miner recovers on its own. |
| `nonce_status` shows a `lastError` about funds | Wallet is out of ETH. Fees are ETH, not NONCE. |
| Claim reverts | Too many epochs in one transaction. Lower `max_epochs`. |
| Unstake refused | The 7-day lock is still running. `lockRemainingSeconds` says how long. |
| Read-only errors on mining tools | `NONCE_PRIVATE_KEY` is not set in the server's env block. |

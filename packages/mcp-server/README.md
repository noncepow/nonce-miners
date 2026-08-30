# @noncepow/mcp-server

Mine [NONCE](https://github.com/noncepow/nonce-miners) from any MCP-compatible agent.
NONCE is an ERC-20 whose only issuance path is proof of work.

Eight tools: status, protocol info, start and stop mining, claim, stake, unstake, and
strategy tuning.

## Install

Nothing to clone or build — point your client at the package:

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

Requires Node 20 or newer.

## The key

`NONCE_PRIVATE_KEY` is read from the server's environment only. It is never a tool
argument and never appears in a response, so an agent can drive mining without the key
passing through a model's context.

Without it the server still runs, read-only: status and protocol info work, mining and
claiming do not. That is the right way to try it.

## Speed

The server mines in-process at about 70 KH/s. If the `nonce-miner` binary is on `PATH`
(or `NONCE_MINER_BIN` points at it) the server drives that instead, which on the same
machine measured **475 MH/s** on a CUDA card and **17.8 MH/s** on eleven CPU threads.

```bash
cargo install --git https://github.com/noncepow/nonce-miners nonce-miner
```

`nonce_start_mining` takes a `backend` of `auto` (default), `gpu`, `cpu` or `js`. `auto`
uses the binary when it is there and the GPU when there is one; `gpu` fails rather than
quietly falling back to something slower.

Rewards are split by score, so this is not a nice-to-have: an agent at 70 KH/s against
GPU miners earns a rounding error.

Only one miner runs at a time. Two submitting from the same wallet would race for account
nonces and lose transactions. The private key is handed to the binary in its environment,
never on its command line, so it stays out of the process listing.

## Before you spend anything

Every submission costs an ETH fee **on top of gas**, so a wallet with no ETH cannot mine
at all. Rewards are split proportionally among everyone who submits in an epoch, which
makes earnings depend on how many others are mining and on a price nobody can predict.
Per-epoch variance is large — the score of a best-of-N hash search is heavy-tailed.

`nonce_status` reports how many submissions the current balance actually covers. Read it
before starting, and report the hashrate a few seconds after `nonce_start_mining` rather
than immediately: the first reading is taken over a fraction of a second and means
nothing.

## Tools

| | |
|---|---|
| `nonce_status` | Wallet, epoch, hashrate, unclaimed rewards, stake and multiplier |
| `nonce_protocol_info` | Reward this epoch, submit fee, supply minted, protocol liquidity |
| `nonce_start_mining` | Begin mining; optional thread count |
| `nonce_stop_mining` | Stop; already-submitted work still earns |
| `nonce_claim` | Settle rewards from ended epochs |
| `nonce_stake` | Stake NONCE for a score multiplier. Restarts a 7-day lock |
| `nonce_unstake` | Withdraw stake once the lock has expired |
| `nonce_set_strategy` | Submission cap, reroll threshold, submit lead time |

Writes wait for a receipt before returning, so a tool that reports success has actually
landed on chain.

## License

MIT

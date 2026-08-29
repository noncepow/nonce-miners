# NONCE — miners

[NONCE](https://x.com/noncepow) is an ERC-20 token with no pre-sale, no team
allocation and no way to buy your way into the supply. The only way any of it comes into
existence is by finding hashes. This repository holds the tools that do that.

Four of them, all computing the same hash: a Rust CLI that uses your GPU, a JavaScript
miner that runs in Node or a browser tab, an MCP server so an AI agent can mine, and the
operating procedure that goes with it.

See [WHITEPAPER.md](WHITEPAPER.md) for the protocol itself.

---

## Quick start

Pick the one that fits. Each command is the whole installation.

**Rust CLI** — fastest by a wide margin. Needs a [Rust toolchain](https://rustup.rs):

```bash
cargo install --git https://github.com/noncepow/nonce-miners nonce-miner
```

```bash
nonce-miner wallet new     # make a wallet, then send it some ETH
nonce-miner status         # check everything before spending anything
nonce-miner --gpu          # mine
```

**Node miner** — nothing to install:

```bash
npx -y @noncepow/miner --rpc https://... --address 0x...
```

**Agent** — put this in your MCP client's config and ask it to mine:

```json
{
  "mcpServers": {
    "nonce": {
      "command": "npx",
      "args": ["-y", "@noncepow/mcp-server"],
      "env": {
        "NONCE_RPC_URL": "https://...",
        "NONCE_ADDRESS": "0x...",
        "NONCE_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

`NONCE_RPC_URL` and `NONCE_ADDRESS` are read from the environment, so with those exported
`nonce-miner --gpu` is the entire command.

---

## How mining works

Time is cut into **60-second epochs**. Each epoch has a challenge, and you search for a
nonce whose hash comes out below a difficulty target. Finding one is the work; there is no
shortcut.

When you find one you **submit** it, which costs a small ETH fee on top of gas. You may
submit up to ten times per epoch, but only your best hash counts — the rest are rerolls.

At the end of the epoch its reward is split **proportionally**: your share is your best
score over the sum of everyone's best scores. So this is not winner-take-all, and a slow
miner still earns — just less. It also means your earnings depend on how many other people
are mining, which you cannot control or predict.

Rewards accumulate and are collected with a separate `claim`. Staking NONCE multiplies your
score up to 2x, at the cost of locking it for seven days.

---

## Wallet

```bash
nonce-miner wallet new              # generate a key
nonce-miner wallet import           # bring an existing one
nonce-miner wallet address          # who am I, without typing a password
nonce-miner wallet export           # take the key back out
```

The key is encrypted with a password into the [Web3 Secret Storage] V3 format — the same
file geth, foundry and MetaMask read, so a key made here is not trapped here. It lives at
`~/.nonce/keystore.json`; set `NONCE_KEYSTORE` to keep more than one.

Passwords and imported keys are typed, never passed as arguments, so neither reaches shell
history or a process listing. **There is no copy of the password.** Lose it and the key is
gone with it.

`NONCE_PRIVATE_KEY` still takes precedence when set, for setups that already had it.

[Web3 Secret Storage]: https://ethereum.org/en/developers/docs/data-structures-and-encoding/web3-secret-storage/

---

## CLI miner (Rust)

`nonce-miner status` answers, in one place, every question that otherwise costs you a
failed run: is the chain reachable, is there a contract at that address, what does an
epoch pay right now, does this wallet have a usable key, how many submissions can it
afford, is a GPU actually available — and where you stand:

```
network
  ok   ~774.77 MH/s across the field
  ok   median of the last 25 epochs — the mean of this quantity does not converge
  ok   rough: expect it within a factor of two, and biased high by staking

rewards
  ok   1,392.5668 NONCE in the wallet
  ok   9,079.7817 NONCE unclaimed — claim it to move it into the wallet
  ok   100.0000 NONCE staked
  ok   100.00% of epoch 54 was yours
```

While mining, each closed epoch reports your rate and your share of it.

The network figure is an estimate, and deliberately labelled as one. A score is
`2^256 / digest`, so a best-of-N search scores about N — but the *mean* of that quantity
does not exist, and averaging it never settles: against a miner holding a flat 478 MH/s a
running mean climbed past 1.5 GH/s and kept climbing. The median behaves, so that is what
is quoted.

| Backend | Hashrate |
|---|---|
| Browser / Node, 1 thread | 70 KH/s |
| Rust CPU, 4 threads | 8.36 MH/s |
| CUDA, RTX 4060 | **470 MH/s** |

Measured with the card to itself. Two miners sharing one GPU get about half each, which
looks like a regression if you are not expecting it.

The GPU path needs an Nvidia driver and nvrtc — **no CUDA toolkit**, because the kernel is
compiled at runtime. See [packages/cli/README.md](packages/cli/README.md) for the WSL setup
and the Windows toolchain note.

| Flag | Default | |
|---|---|---|
| `--threads` | cores − 1 | Leaves the machine usable |
| `--max-submits` | 10 | The contract's own cap |
| `--reroll-factor` | 2 | Resubmit only on an improvement this large |
| `--lead-ms` | 12000 | Submit this long before the epoch closes |
| `--gas-limit` | 1400000 | Sized to carry an auto-LP deposit; unused gas is refunded |
| `--gpu` | | Use the CUDA backend |
| `--once` | | Mine a single epoch and exit |

Two defaults are worth understanding before changing them, because both prevent a *silent*
failure. `--gas-limit` is sized so a submission can carry the protocol's periodic liquidity
deposit; the contract stands down from it unless 700k gas remains, and a smaller limit
defers that deposit quietly, forever. `--lead-ms` has to cover signing, broadcast and
inclusion, because the contract recomputes your hash against whichever epoch the
transaction *lands* in — arrive a moment late and it is hashed against a different
challenge and rejected, which reads as bad luck rather than a missed deadline.

---

## Node miner (JavaScript)

```bash
npx -y @noncepow/miner --rpc https://... --address 0x...
```

Reads `NONCE_PRIVATE_KEY` from the environment. The same module drives the browser miner
through a Web Worker — see [packages/miner/README.md](packages/miner/README.md).

---

## Agents

`packages/mcp-server` exposes mining as eight MCP tools: status, protocol info, start and
stop, claim, stake, unstake, and strategy tuning. It is published to npm, so the config in
the quick start is the entire setup.

The private key stays in the server's environment. It is never a tool argument and never
appears in a response, so an agent can drive mining without the key passing through a
model's context. Without a key the server still runs, read-only — which is the right way to
try it.

**An agent mines as fast as the machine it is on.** If the `nonce-miner` binary is
installed the server drives it rather than mining in-process — measured on the same box:
475 MH/s on a CUDA card, 17.8 MH/s on eleven CPU threads, against 70 KH/s for the
JavaScript loop. Rewards are split by score, so that gap is the difference between mining
and appearing to.

`nonce_start_mining` takes a `backend`:

| | |
|---|---|
| `auto` *(default)* | the binary if installed, with the GPU if there is one |
| `gpu` | require the binary and CUDA; fail rather than quietly go slower |
| `cpu` | the binary, all cores, no GPU |
| `js` | the in-process JavaScript miner, nothing to install |

Only one miner ever runs: two submitting from the same wallet would race for account
nonces and lose transactions. The key reaches the binary through its environment, never on
its command line.

`packages/skill/SKILL.md` is the operating procedure that goes with those tools — what to
check before spending anything, and the things people consistently misread:

```bash
cd packages/skill && node scripts/preflight.mjs
```

---

## The hash

Every miner here computes the same digest the contract does:

```
keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce))
```

84 bytes — 32 challenge, 20 address, 32 big-endian nonce. The address is inside the
preimage, which is why a solution you find cannot be stolen and submitted by someone else.

One byte of disagreement and every solution you find is rejected on chain, silently,
presenting as persistent bad luck rather than an error. So every implementation is checked
against digest vectors the **contract itself** produced, covering nonce `0`, `1`, `2^64`,
`2^128-1`, `2^255` and `2^256-1`. Checking one implementation against another would only
prove they agree with each other.

```bash
cd packages/cli && cargo test              # 26 tests: parity, GPU parity, keystore, strategy
cd packages/miner && node --test test/*.test.js
```

The GPU parity tests read digests straight out of the card's buffer, and skip when no CUDA
device is present — a skipped parity test proves nothing, so check that they actually ran.

---

## Before you mine

Every submission costs an ETH fee **on top of gas**, so a wallet with no ETH cannot mine at
all. `nonce-miner status` tells you how many submissions your balance covers.

Rewards are split among everyone who submits, so what you earn depends on how many others
are mining and on a price nobody can predict. Per-epoch variance is large, because the
score of a best-of-N hash search is heavy-tailed: most epochs pay below average and a few
pay far above it.

Read the limitations section of the whitepaper before committing hardware to this.

## License

MIT

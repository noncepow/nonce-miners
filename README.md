# NONCE — miners

Mining tools for [NONCE](https://x.com/noncepow), an ERC-20 whose only issuance path is
proof of work. Four ways to mine, one hash implementation.

See [WHITEPAPER.md](WHITEPAPER.md) for the protocol itself.

| | |
|---|---|
| `packages/cli` | Rust. CUDA at 470 MH/s, or multi-threaded CPU at 2.09 MH/s per thread |
| `packages/miner` | JavaScript. Browser Web Worker and a Node CLI |
| `packages/mcp-server` | Mine from any MCP-compatible agent |
| `packages/skill` | Agent skill: preflight and operating procedure |

---

## Install

Nothing to clone. Each of these is the whole installation.

**Rust CLI** — the fast one. Needs a Rust toolchain:

```bash
cargo install --git https://github.com/noncepow/nonce-miners nonce-miner
```

**Node miner** — no install step at all:

```bash
npx -y @noncepow/miner --rpc https://... --address 0x...
```

**Agent** — put this in your MCP client's config:

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

Then make a wallet and mine:

```bash
nonce-miner wallet new
nonce-miner --gpu --rpc https://... --address 0x...
```

`NONCE_RPC_URL` and `NONCE_ADDRESS` are read from the environment, so with those exported
`nonce-miner --gpu` is the whole command.

---

## The hash

Every miner here computes the same digest the contract does:

```
keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce))
```

84 bytes — 32 challenge, 20 address, 32 big-endian nonce. One byte of disagreement and
every solution found is rejected on chain, silently, presenting as persistent bad luck
rather than an error.

So every implementation is checked against digest vectors the **contract itself** produced,
covering nonce `0`, `1`, `2^64`, `2^128-1`, `2^255` and `2^256-1`. Checking one
implementation against the other would only prove they agree with each other.

```bash
cd packages/cli && cargo test              # 26 tests: parity, GPU parity, keystore, strategy
cd packages/miner && node --test test/*.test.js
```

The GPU parity tests read digests straight out of the card's buffer and skip when no CUDA
device is present — a skipped parity test proves nothing, so check that they ran.

---

## Wallet

```bash
nonce-miner wallet new              # generate a key
nonce-miner wallet import           # bring an existing one
nonce-miner wallet address          # who am I, without typing a password
nonce-miner wallet export           # take the key back out
```

The key is encrypted with a password into the [Web3 Secret Storage] V3 format — scrypt,
AES-128-CTR, keccak MAC — the same file geth, foundry and MetaMask read, so a key created
here is not trapped here. It lives at `~/.nonce/keystore.json`; `NONCE_KEYSTORE` points
somewhere else, which is how you keep more than one.

Passwords and imported keys are typed, never passed as arguments, so neither reaches shell
history or a process listing. There is no copy of the password: lose it and the key is
gone. `NONCE_PRIVATE_KEY` still takes precedence when set, for setups that already had it.

[Web3 Secret Storage]: https://ethereum.org/en/developers/docs/data-structures-and-encoding/web3-secret-storage/

---

## CLI miner (Rust)

Fastest of the four. Each thread searches a disjoint slice of the nonce space, so N threads
do N threads of distinct work.

| Backend | Hashrate |
|---|---|
| Browser / Node, 1 thread | 70 KH/s |
| Rust CPU, 4 threads | 8.36 MH/s |
| CUDA, RTX 4060 | **470 MH/s** |

Measured with the card to itself. Two miners sharing one GPU get about half each, which
looks like a regression if you are not expecting it.

The GPU path needs an Nvidia driver and nvrtc — no CUDA toolkit; the kernel is compiled at
runtime. Every hit the kernel reports is re-hashed on the CPU before use, because a wrong
kernel returns plausible digests the contract rejects rather than raising an error. See
[packages/cli/README.md](packages/cli/README.md) for the WSL setup and the Windows
toolchain note.

| Flag | Default | |
|---|---|---|
| `--threads` | cores − 1 | Leaves the machine usable |
| `--max-submits` | 10 | The contract's own cap |
| `--reroll-factor` | 2 | Resubmit only on an improvement this large |
| `--lead-ms` | 12000 | Submit this long before the epoch closes |
| `--gas-limit` | 1400000 | Sized to carry an auto-LP deposit; unused gas is refunded |
| `--gpu` | | Use the CUDA backend |
| `--once` | | Mine a single epoch and exit |

Two defaults are worth understanding before you change them. `--gas-limit` is sized so a
submission can carry the protocol's periodic liquidity deposit; the contract stands down
from it unless 700k gas remains, and a limit below that defers the deposit silently,
forever. `--lead-ms` has to cover signing, broadcast and inclusion, because the contract
recomputes the digest against whichever epoch the transaction *lands* in — arrive a moment
late and it is hashed with a different challenge and rejected as bad luck.

---

## Node miner (JavaScript)

```bash
npx -y @noncepow/miner --rpc https://... --address 0x...
```

Reads `NONCE_PRIVATE_KEY` from the environment. The same module drives the browser miner
through a Web Worker — see [packages/miner/README.md](packages/miner/README.md).

---

## Agents

`packages/mcp-server` exposes mining as MCP tools: status, protocol info, start and stop,
claim, stake, unstake, and strategy tuning. It is published to npm, so the config above is
the entire setup.

The private key stays in the server's environment. It is never a tool argument and never
appears in a response, so an agent can drive mining without the key passing through a
model's context. Without it the server still runs, read-only — which is the right way to
try it.

`packages/skill/SKILL.md` is the operating procedure that goes with those tools — what to
check before spending anything, and the things people consistently misread. Start with the
preflight:

```bash
cd packages/skill && node scripts/preflight.mjs
```

It reports whether the chain is reachable, what an epoch currently pays, and how many
submissions the wallet's balance actually covers.

---

## Before you mine

Every submission costs an ETH fee **on top of gas**. A wallet with no ETH cannot mine at
all. Rewards are split proportionally among everyone who submits, so earnings depend on how
many others are mining and on a price nobody can predict — and per-epoch variance is large,
because the score of a best-of-N hash search is heavy-tailed.

Read the limitations section of the whitepaper before committing hardware to this.

## License

MIT

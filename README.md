# NONCE — miners

Mining tools for [NONCE](https://x.com/noncepow), an ERC-20 whose only issuance path is
proof of work. Four ways to mine, one hash implementation.

See [WHITEPAPER.md](WHITEPAPER.md) for the protocol itself.

| | |
|---|---|
| `packages/cli` | Rust. CUDA at 449 MH/s, or multi-threaded CPU at 2.09 MH/s per thread |
| `packages/miner` | JavaScript. Browser Web Worker and a Node CLI |
| `packages/mcp-server` | Mine from any MCP-compatible agent |
| `packages/skill` | Agent skill: preflight and operating procedure |

---

## The hash

Every miner here computes the same digest the contract does:

```
keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce))
```

84 bytes — 32 challenge, 20 address, 32 big-endian nonce. One byte of disagreement and
every solution found is rejected on chain, silently, presenting as persistent bad luck
rather than an error.

So both implementations are checked against digest vectors the **contract itself** produced,
covering nonce `0`, `1`, `2^64`, `2^128-1`, `2^255` and `2^256-1`. Checking one
implementation against the other would only prove they agree with each other.

```bash
cd packages/cli && cargo test         # 13 tests, 8 of them parity
cd packages/miner && node --test test/*.test.js
```

---

## CLI miner (Rust)

Fastest of the four. Each thread searches a disjoint slice of the nonce space, so N threads
do N threads of distinct work.

```bash
cd packages/cli
cargo build --release

./target/release/nonce-miner wallet new          # or `wallet import`
./target/release/nonce-miner --rpc https://... --address 0x...   # CPU
./target/release/nonce-miner --gpu --rpc https://... --address 0x...   # CUDA
```

`wallet new` writes an encrypted V3 keystore to `~/.nonce/keystore.json` and prompts for
its password when mining starts. `NONCE_PRIVATE_KEY` still takes precedence when set.

| Backend | Hashrate |
|---|---|
| Browser / Node, 1 thread | 70 KH/s |
| Rust CPU, 4 threads | 8.36 MH/s |
| CUDA, RTX 4060 | **449 MH/s** |

The GPU path needs an Nvidia driver and `nvrtc64_*.dll` on PATH — no CUDA toolkit. Every
hit the kernel reports is re-hashed on the CPU before use, because a wrong kernel returns
plausible digests the contract rejects rather than raising an error. See
[packages/cli/README.md](packages/cli/README.md).

The key is read from the environment only — never an argument, so it cannot land in shell
history or a process listing.

| Flag | Default | |
|---|---|---|
| `--threads` | cores − 1 | Leaves the machine usable |
| `--max-submits` | 10 | The contract's own cap |
| `--reroll-factor` | 2 | Resubmit only on an improvement this large |
| `--lead-ms` | 6000 | Submit this long before the epoch closes |
| `--gas-limit` | 1400000 | Sized to carry an auto-LP deposit; unused gas is refunded |
| `--once` | | Mine a single epoch and exit |

**Windows toolchain.** With `x86_64-pc-windows-gnu`, rustup's bundled mingw ships `dlltool`
and `ld` but not the assembler, so linking fails with a bare `dlltool.exe: CreateProcess`.
Install a complete mingw-w64 — `winget install -e --id BrechtSanders.WinLibs.POSIX.MSVCRT` —
and put its `bin` on PATH.

---

## Node miner (JavaScript)

```bash
pnpm install
cd packages/miner
NONCE_ADDRESS=0x... NONCE_PRIVATE_KEY=0x... node bin/mine.js --rpc https://...
```

The same module drives the browser miner through a Web Worker. See
[packages/miner/README.md](packages/miner/README.md).

---

## Agents

`packages/mcp-server` exposes mining as MCP tools: status, protocol info, start and stop,
claim, stake, unstake, and strategy tuning.

Published to npm, so there is nothing to clone or build:

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

The private key stays in the server's environment. It is never a tool argument and never
appears in a response, so an agent can drive mining without the key passing through a
model's context. Without it the server still runs, read-only.

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

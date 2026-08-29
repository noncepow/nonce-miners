# nonce-miner

Multi-threaded keccak256 proof-of-work miner for NONCE. Reads the live challenge, target
and fee from the contract, searches with every core it is given, and submits the best hash
before the epoch closes.

## The thing that matters

The digest must be byte-identical to `Nonce.sol`:

```
keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce))
```

84 bytes: 32 challenge, 20 address, 32 big-endian nonce. One byte of disagreement and every
solution this miner finds is rejected on chain — silently, because it presents as persistent
bad luck rather than an error.

So `tests/parity.rs` checks against digest vectors the **contract itself** produced, not
against the JavaScript miner. Two implementations agreeing with each other proves nothing;
the EVM is the authority.

```bash
cargo test                                        # includes the parity vectors
# regenerate from the contract repository: forge script script/DigestVectors.s.sol
```

Regenerate the vectors after any change to the preimage in `Nonce.sol`.

## Build

```bash
cargo build --release
```

**Windows toolchain note.** With `x86_64-pc-windows-gnu`, rustup's bundled mingw ships
`dlltool` and `ld` but not the assembler `as`, so linking fails with
`dlltool.exe: CreateProcess`. Install a complete mingw-w64 — for example
`winget install -e --id BrechtSanders.WinLibs.POSIX.MSVCRT` — and put its `bin` on PATH.
The MSVCRT variant is the one that matches the `-gnu` target; UCRT does not.

## Run

```bash
export NONCE_PRIVATE_KEY=0x...
nonce-miner --rpc https://... --address 0x...
```

The key is read from the environment only. It is never an argument, so it cannot end up in
shell history or a process listing, and it is never printed.

| Flag | Default | |
|---|---|---|
| `--threads` | cores − 1 | Leaves the machine usable while mining |
| `--max-submits` | 10 | The contract's own cap |
| `--reroll-factor` | 2 | Resubmit only on an improvement this large |
| `--lead-ms` | 6000 | Submit this long before the epoch closes |
| `--gas-limit` | 500000 | Per submission |
| `--once` | | Mine a single epoch and exit |

## How the search is split

Each worker owns a disjoint slice of the nonce space, `base + index × 2^40`. Letting every
thread pick its own random start would have them re-hash each other's work — the threads
would run, the hashrate number would look right, and the effective search would be a
fraction of it.

Within a slice only the low eight bytes of the nonce change, so the hot loop rewrites eight
bytes rather than thirty-two and allocates nothing.

## Clock

The epoch deadline is measured against a block timestamp, not the host clock. A machine
running a few seconds behind believes it still has time, submits against a challenge that
has already rotated, and pays gas for a guaranteed revert.

## Not yet done: GPU

This is CPU-only. The specification leaves the GPU backend open between wgpu
(cross-platform) and CUDA (Nvidia, faster), and a keccak256 shader is not something worth
shipping untested — an incorrect one produces valid-looking hashes that the contract
rejects, which is the same silent failure the parity vectors exist to prevent.

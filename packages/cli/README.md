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

## GPU

```bash
nonce-miner --gpu --rpc https://... --address 0x...
```

Measured on an RTX 4060:

| Backend | Hashrate | vs browser |
|---|---|---|
| Browser / Node, 1 thread | 70 KH/s | 1x |
| Rust CPU, 1 thread | 2.09 MH/s | 30x |
| Rust CPU, 4 threads | 8.36 MH/s | 119x |
| CUDA, RTX 4060 | **449 MH/s** | **6,413x** |

Requirements: an Nvidia driver, and `nvrtc64_*.dll` on PATH. **No CUDA toolkit is needed** —
the kernel is compiled at runtime by nvrtc and launched through the driver API. If you do
not have the toolkit, the nvrtc DLLs alone are about 20 MB:

```bash
pip install nvidia-cuda-nvrtc-cu12
# then add .../site-packages/nvidia/cuda_nvrtc/bin to PATH
```

`--gpu-batch` sets nonces per launch (default 1,048,576). Larger keeps the card busy;
smaller hands control back sooner when the epoch rolls over.

### Why the GPU is never trusted

Every hit the kernel reports is **re-hashed on the CPU** before it is used. A wrong kernel
does not raise an error — it returns plausible-looking digests that the contract rejects
every time, which reads as persistent bad luck rather than a bug. The GPU proposes
candidates; the CPU decides.

`tests/gpu_parity.rs` reads digests straight out of the GPU buffer with no CPU
re-verification in between, and compares them against the contract's own vectors. Filtering
through the CPU check first would hide exactly the bug the test exists to catch.

CUDA rather than a portable backend is a deliberate trade: it is Nvidia-only, so AMD and
Apple Silicon miners use the CPU path.

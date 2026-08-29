//! NONCE CLI miner.
//!
//! Reads the live challenge, target and fee from the contract, searches with
//! every core it is given, and submits the best hash before the epoch closes.
//!
//!   NONCE_PRIVATE_KEY=0x... nonce-miner --rpc https://... --address 0x...

// The modules live in the library so the integration tests can reach them;
// re-declaring them here would compile a second, separate copy.
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use primitive_types::U256;

use nonce_miner::miner::{Job, Session};
use nonce_miner::rpc::{call_data, Rpc};
use nonce_miner::strategy::{should_submit, Strategy};
use nonce_miner::keystore;
use nonce_miner::wallet::{Tx, Wallet};

#[derive(Parser)]
#[command(name = "nonce-miner", version, about = "Proof-of-work miner for NONCE")]
struct Args {
    /// Manage the encrypted keystore. Omit to mine.
    #[command(subcommand)]
    command: Option<Command>,

    /// JSON-RPC endpoint
    #[arg(long, env = "NONCE_RPC_URL")]
    rpc: Option<String>,

    /// NONCE token address
    #[arg(long, env = "NONCE_ADDRESS")]
    address: Option<String>,

    /// Worker threads. Defaults to all cores but one, leaving the machine usable.
    #[arg(long)]
    threads: Option<usize>,

    /// Submissions per epoch; the contract caps this at 10.
    #[arg(long, default_value_t = 10)]
    max_submits: u32,

    /// Resubmit only on an improvement of at least this factor.
    #[arg(long, default_value_t = 2)]
    reroll_factor: u64,

    /// Submit once the epoch has this many milliseconds left.
    ///
    /// The budget has to cover the account-nonce read, signing, broadcast and
    /// inclusion. Measured on Robinhood Chain: 1.4-2.6s to confirm, and the
    /// first submission of an epoch also opens it and retargets, so it is
    /// slower still. 6s left barely any margin and lost the occasional race.
    #[arg(long, default_value_t = 12_000)]
    lead_ms: i64,

    /// Gas limit per submission. Sized to carry an auto-LP deposit, which the
    /// contract stands down from unless 700k gas remains. Unused gas is
    /// refunded, so the headroom is free on the submissions that do not use it.
    #[arg(long, default_value_t = 1_400_000)]
    gas_limit: u64,

    /// Mine a single epoch and exit.
    #[arg(long)]
    once: bool,

    /// Use the CUDA backend. Requires an Nvidia driver and nvrtc on PATH.
    #[arg(long)]
    gpu: bool,

    /// Nonces per GPU launch. Larger keeps the card busy; smaller hands control
    /// back sooner when the epoch rolls over.
    #[arg(long, default_value_t = 1_048_576)]
    gpu_batch: u32,
}

#[derive(Subcommand)]
enum Command {
    /// Create, import, or inspect the encrypted mining key
    Wallet {
        #[command(subcommand)]
        action: WalletAction,
    },
    /// Check everything mining needs, without mining or spending anything
    Status,
}

#[derive(Subcommand)]
enum WalletAction {
    /// Generate a new key and store it encrypted
    New {
        /// Replace an existing keystore. The key it holds is gone afterwards.
        #[arg(long)]
        force: bool,
    },
    /// Import an existing key, typed without echo
    Import {
        /// Replace an existing keystore. The key it holds is gone afterwards.
        #[arg(long)]
        force: bool,
    },
    /// Print the stored address without decrypting the key
    Address,
    /// Reveal the private key, so the wallet can be moved elsewhere
    Export,
}

/// One search, whichever backend is driving it.
enum Backend {
    Cpu(Session),
    #[cfg(feature = "gpu")]
    Gpu(nonce_miner::gpu::GpuSession),
}

impl Backend {
    fn best(&self) -> Option<nonce_miner::miner::Solution> {
        match self {
            Backend::Cpu(s) => s.best(),
            #[cfg(feature = "gpu")]
            Backend::Gpu(s) => s.best(),
        }
    }
    fn hashes(&self) -> u64 {
        match self {
            Backend::Cpu(s) => s.hashes(),
            #[cfg(feature = "gpu")]
            Backend::Gpu(s) => s.hashes(),
        }
    }
    fn stop(self) {
        match self {
            Backend::Cpu(s) => s.stop(),
            #[cfg(feature = "gpu")]
            Backend::Gpu(s) => s.stop(),
        }
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("nonce-miner: {e}");
        std::process::exit(1);
    }
}

fn wallet_command(action: &WalletAction) -> Result<(), String> {
    match action {
        WalletAction::New { force } => {
            let w = keystore::create(*force)?;
            println!("address  0x{}", hex::encode(w.address));
            println!("keystore {}", keystore::path().display());
            println!();
            println!("Fund this address before mining — every submission costs an ETH fee on top");
            println!("of gas. There is no copy of the password; without it the key is gone.");
        }
        WalletAction::Import { force } => {
            let w = keystore::import(*force)?;
            println!("address  0x{}", hex::encode(w.address));
            println!("keystore {}", keystore::path().display());
        }
        WalletAction::Address => println!("{}", keystore::stored_address()?),
        WalletAction::Export => {
            let key = keystore::export()?;
            // Warning on stderr, key on stdout: `wallet export > key.txt` then
            // writes the key and nothing else, and the warning is still seen.
            eprintln!("This is the key itself — whoever reads it owns the wallet.");
            eprintln!("It will stay in this terminal's scrollback until you clear it.");
            eprintln!();
            println!("{key}");
        }
    }
    Ok(())
}


/// Wei as ETH, six decimals — enough to see a submission fee, short enough to read.
fn fmt_eth(wei: U256) -> String {
    let one = U256::from(10u64).pow(U256::from(18u64));
    let micro = U256::from(10u64).pow(U256::from(12u64));
    format!("{}.{:06}", wei / one, ((wei % one) / micro).as_u64())
}

/// " (~N submissions)" — the number people actually want from a balance.
fn affordable(balance: U256, fee: U256) -> String {
    if fee.is_zero() {
        return String::new();
    }
    // Gas is small next to the fee on this chain, but not nothing; count it in
    // roughly so the figure is not quietly optimistic.
    let per = fee + fee / U256::from(5u64);
    format!("  (~{} submissions)", (balance / per).as_u64())
}

fn confirm(question: &str) -> Result<bool, String> {
    use std::io::Write;
    print!("{question} [y/N] ");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).map_err(|e| e.to_string())?;
    let a = line.trim().to_ascii_lowercase();
    Ok(a == "y" || a == "yes")
}

fn getting_started() -> String {
    // Built line by line rather than as one continued literal: a `\` continuation
    // keeps the source indentation, which lands in the user's terminal.
    let lines = [
        "",
        "nonce-miner is not configured yet. The whole path, in order:",
        "",
        "  1. a wallet     nonce-miner wallet new",
        "  2. fund it      every submission costs an ETH fee on top of gas",
        "  3. the chain    export NONCE_RPC_URL=https://...",
        "                  export NONCE_ADDRESS=0x...",
        "  4. mine         nonce-miner            (CPU)",
        "                  nonce-miner --gpu      (CUDA)",
        "",
        "  nonce-miner status   checks all of it without spending anything",
        "",
    ];
    format!("{}
  keystore: {}

", lines.join("
"), keystore::path().display())
}

/// Read-only preflight: everything mining needs, checked and reported together,
/// so a problem is found before a fee is ever paid.
fn status_command(args: &Args) -> Result<(), String> {
    let present = |v: &Option<String>| -> Option<String> {
        v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
    };

    println!("wallet");
    let who = match std::env::var("NONCE_PRIVATE_KEY") {
        Ok(k) => match Wallet::from_hex(&k) {
            Ok(w) => {
                println!("  ok   0x{} (from NONCE_PRIVATE_KEY)", hex::encode(w.address));
                Some(w.address)
            }
            Err(e) => {
                println!("  bad  NONCE_PRIVATE_KEY is set but unusable: {e}");
                None
            }
        },
        Err(_) => match keystore::stored_address() {
            // Read from the keystore file, so this never asks for a password.
            Ok(a) => {
                println!("  ok   {a}");
                parse_address(&a).ok()
            }
            Err(_) => {
                println!("  none no wallet yet — `nonce-miner wallet new`");
                None
            }
        },
    };

    let (Some(address), Some(rpc_url)) = (present(&args.address), present(&args.rpc)) else {
        println!("
chain");
        println!("  none set NONCE_RPC_URL and NONCE_ADDRESS (or --rpc and --address)");
        eprint!("{}", getting_started());
        return Err("not configured yet".into());
    };

    let token = parse_address(&address)?;
    let rpc = Rpc::new(&rpc_url);

    println!("
chain");
    let chain_id = rpc.chain_id().map_err(|e| format!("cannot reach the RPC: {e}"))?;
    println!("  ok   connected, chain {chain_id}");
    let epoch = rpc
        .view(&token, &call_data("currentEpoch()", &[]))
        .map_err(|_| format!("no NONCE contract at {address} on chain {chain_id}"))?;
    let fee = rpc.view(&token, &call_data("submitFee()", &[])).map_err(|e| e.to_string())?;
    let supply = rpc.view(&token, &call_data("totalSupply()", &[])).map_err(|e| e.to_string())?;
    let max = rpc.view(&token, &call_data("MAX_SUPPLY()", &[])).map_err(|e| e.to_string())?;
    println!("  ok   NONCE at {address}");
    println!("  ok   epoch {epoch}, fee {} ETH per submission", fmt_eth(fee));
    let wad = U256::from(10u64).pow(U256::from(18u64));
    println!("  ok   minted {} of {}", supply / wad, max / wad);

    println!("
balance");
    match who {
        Some(addr) => {
            let bal = rpc.balance(&addr).map_err(|e| e.to_string())?;
            if bal.is_zero() {
                println!("  none 0 ETH — fund the wallet before mining");
            } else {
                println!("  ok   {} ETH{}", fmt_eth(bal), affordable(bal, fee));
            }
        }
        None => println!("  n/a  no wallet to check"),
    }

    #[cfg(feature = "gpu")]
    {
        println!("
GPU");
        match nonce_miner::gpu::Gpu::new() {
            Ok(g) => println!("  ok   {} — run with --gpu", g.name),
            Err(e) => println!("  none {e}"),
        }
    }

    Ok(())
}

fn parse_address(s: &str) -> Result<[u8; 20], String> {
    let b = hex::decode(s.trim().trim_start_matches("0x")).map_err(|_| "address is not hex")?;
    if b.len() != 20 {
        return Err("address must be 20 bytes".into());
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&b);
    Ok(out)
}

fn run() -> Result<(), String> {
    let args = Args::parse();

    match &args.command {
        Some(Command::Wallet { action }) => return wallet_command(action),
        Some(Command::Status) => return status_command(&args),
        None => {}
    }

    // Arguments before the wallet: unlocking the keystore prompts for a
    // password, and being asked for one only to be told the address was missing
    // wastes the entry and reads as though the password was the problem.
    //
    // An unset shell variable expands to an empty argument, so `--address
    // "$NONCE_ADDRESS"` with nothing set arrives as Some(""). Calling that a
    // malformed address sends you looking at the address rather than at the
    // variable that was never set.
    let present = |v: &Option<String>| -> Option<String> {
        v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
    };
    let (address, rpc_url) = match (present(&args.address), present(&args.rpc)) {
        (Some(a), Some(r)) => (a, r),
        // Reporting only the first missing piece makes setup a queue of walls,
        // each discovered by hitting it. Show the whole path once.
        _ => {
            eprint!("{}", getting_started());
            return Err("not configured yet".into());
        }
    };
    let token = parse_address(&address)?;

    // Never an argument, so the key cannot land in shell history or a process
    // listing. The environment still wins, so existing setups keep working; the
    // keystore is the fallback for everyone who would otherwise have kept the
    // key in a shell profile in the clear.
    let wallet = match std::env::var("NONCE_PRIVATE_KEY") {
        Ok(key) => Wallet::from_hex(&key)?,
        Err(_) if !keystore::exists() => {
            // Being told the name of a command you must now go and run is a poor
            // answer to "I have no wallet". Offer to do it, when there is
            // someone there to answer.
            use std::io::IsTerminal;
            if !std::io::stdin().is_terminal() {
                return Err(format!(
                    "no wallet. Run `nonce-miner wallet new`, or set NONCE_PRIVATE_KEY (looked in {})",
                    keystore::path().display()
                ));
            }
            println!("No wallet yet at {}.", keystore::path().display());
            if !confirm("Create one now?")? {
                return Err("no wallet, so there is nothing to mine with".into());
            }
            let w = keystore::create(false)?;
            println!("
address 0x{}", hex::encode(w.address));
            println!("Fund this address before mining — submissions cost ETH.
");
            w
        }
        Err(_) => keystore::load()?,
    };

    let rpc = Rpc::new(&rpc_url);
    let threads = args
        .threads
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).max(1)));

    let chain_id = rpc.chain_id().map_err(|e| e.to_string())?;
    let epoch_duration = rpc
        .view(&token, &call_data("EPOCH_DURATION()", &[]))
        .map_err(|e| e.to_string())?
        .as_u64();
    let genesis = rpc
        .view(&token, &call_data("genesisTime()", &[]))
        .map_err(|e| e.to_string())?
        .as_u64();
    let balance = rpc.balance(&wallet.address).map_err(|e| e.to_string())?;
    let fee = rpc.view(&token, &call_data("submitFee()", &[])).map_err(|e| e.to_string())?;

    println!("miner    0x{}", hex::encode(wallet.address));
    println!("contract 0x{}  (chain {chain_id})", hex::encode(token));
    if args.gpu {
        #[cfg(feature = "gpu")]
        {
            let probe = nonce_miner::gpu::Gpu::new()?;
            println!("backend  CUDA on {}", probe.name);
        }
    } else {
        println!("backend  CPU, {threads} threads");
    }
    println!("epoch    {epoch_duration}s   fee {} ETH per submission", fmt_eth(fee));
    println!("balance  {} ETH{}", fmt_eth(balance), affordable(balance, fee));
    if balance.is_zero() {
        return Err(
            "this wallet holds no ETH. Every submission costs a fee on top of gas, so mining              cannot start until it is funded"
                .into(),
        );
    }
    if !fee.is_zero() && balance < fee * U256::from(10) {
        eprintln!("warning: this covers fewer than 10 submissions — top up soon");
    }

    let strategy = Strategy {
        max_submits: args.max_submits,
        reroll_factor: U256::from(args.reroll_factor),
        lead_ms: args.lead_ms,
    };

    // Measured against the chain's clock. A host running behind would otherwise
    // believe it still has time, submit against a rotated challenge, and pay gas
    // for a guaranteed revert.
    let chain_now = rpc.block_timestamp().map_err(|e| e.to_string())? as i64;
    let mut skew_ms = chain_now * 1000 - now_ms();

    let mut current_epoch = u64::MAX;
    let mut epoch_fee = U256::zero();
    let mut epoch_gas_price = U256::zero();
    let mut session: Option<Backend> = None;
    let mut submitted: Option<U256> = None;
    let mut submits = 0u32;
    let mut started = Instant::now();

    loop {
        let epoch = rpc
            .view(&token, &call_data("currentEpoch()", &[]))
            .map_err(|e| e.to_string())?
            .as_u64();

        if epoch != current_epoch {
            if let Some(s) = session.take() {
                let hashes = s.hashes();
                let secs = started.elapsed().as_secs_f64().max(0.001);
                println!(
                    "  epoch {current_epoch} done: {hashes} hashes, ~{:.2} MH/s",
                    hashes as f64 / secs / 1e6
                );
                s.stop();
                if args.once {
                    return Ok(());
                }
            }

            let challenge_word = rpc
                .view(&token, &call_data("challengeFor(uint256)", &[U256::from(epoch)]))
                .map_err(|e| e.to_string())?;
            let target = rpc
                .view(&token, &call_data("currentTarget()", &[]))
                .map_err(|e| e.to_string())?;
            let chain_now = rpc.block_timestamp().map_err(|e| e.to_string())? as i64;
            skew_ms = chain_now * 1000 - now_ms();

            // Read once per epoch, not once per submission. Both are stable
            // within an epoch, and a submission is made against a deadline
            // measured in seconds — three sequential round trips before the
            // transaction is even signed is most of that budget.
            epoch_fee = rpc.view(&token, &call_data("submitFee()", &[])).map_err(|e| e.to_string())?;
            epoch_gas_price = rpc.gas_price().map_err(|e| e.to_string())?;

            let mut challenge = [0u8; 32];
            challenge_word.to_big_endian(&mut challenge);
            println!("epoch {epoch}  challenge 0x{}…", hex::encode(&challenge[..8]));

            current_epoch = epoch;
            submitted = None;
            submits = 0;
            started = Instant::now();
            let job = Job { challenge, miner: wallet.address, target, epoch };
            session = Some(if args.gpu {
                #[cfg(feature = "gpu")]
                {
                    let gpu = nonce_miner::gpu::Gpu::new()?;
                    Backend::Gpu(nonce_miner::gpu::GpuSession::start(
                        gpu,
                        job,
                        rand_base(),
                        args.gpu_batch,
                    ))
                }
                #[cfg(not(feature = "gpu"))]
                {
                    return Err("this build has no GPU support; rebuild with --features gpu".into());
                }
            } else {
                Backend::Cpu(Session::start(job, threads, rand_base()))
            });
        }

        if let Some(s) = &session {
            let left = ms_left(genesis, epoch, epoch_duration, skew_ms);
            let best = s.best();

            if should_submit(best.as_ref().map(|b| b.score), submitted, submits, left, &strategy) {
                if let Some(b) = best {
                    // The contract recomputes the digest against whatever epoch
                    // the transaction lands in, so a solution that arrives after
                    // the rotation is hashed with a different challenge and
                    // rejected as AboveTarget — indistinguishable from bad luck.
                    // Better to drop it than to pay gas for a certain revert.
                    if ms_left(genesis, epoch, epoch_duration, skew_ms) <= 0 {
                        eprintln!("  epoch {epoch} rolled before the submission went out; dropped");
                        continue;
                    }
                    match submit(
                        &rpc,
                        &wallet,
                        &token,
                        chain_id,
                        b.nonce,
                        &args,
                        epoch_fee,
                        epoch_gas_price,
                    ) {
                        Ok(hash) => {
                            submits += 1;
                            submitted = Some(b.score);
                            println!(
                                "  submitted score={} nonce={} ({submits}/{}) {hash}",
                                b.score, b.nonce, strategy.max_submits
                            );
                        }
                        // A stale challenge or a lost race is routine; keep mining.
                        Err(e) => eprintln!("  submit failed: {e}"),
                    }
                }
            }
        }

        std::thread::sleep(Duration::from_millis(500));
    }
}

#[allow(clippy::too_many_arguments)]
fn submit(
    rpc: &Rpc,
    wallet: &Wallet,
    token: &[u8; 20],
    chain_id: u64,
    nonce_value: U256,
    args: &Args,
    fee: U256,
    gas_price: U256,
) -> Result<String, String> {
    // Only the account nonce has to be fresh; the fee and the gas price were
    // read when the epoch opened.
    let tx_nonce = rpc.tx_count(&wallet.address).map_err(|e| e.to_string())?;

    // Headroom over the observed base fee so a submission is not stranded when
    // the epoch's first transaction bumps the price.
    let max_fee = gas_price * U256::from(2);

    let tx = Tx {
        chain_id,
        nonce: tx_nonce,
        max_priority_fee: gas_price,
        max_fee,
        gas_limit: args.gas_limit,
        to: *token,
        value: fee,
        data: call_data("submit(uint256)", &[nonce_value]),
    };

    let raw = tx.sign(wallet)?;
    let hash = rpc.send_raw(&raw).map_err(|e| e.to_string())?;

    match rpc.wait_receipt(&hash, 30).map_err(|e| e.to_string())? {
        Some(true) => Ok(hash),
        Some(false) => Err(format!("reverted ({hash})")),
        None => Err(format!("not mined in time ({hash})")),
    }
}

/// Milliseconds left in `epoch`, measured against the chain's clock.
fn ms_left(genesis: u64, epoch: u64, epoch_duration: u64, skew_ms: i64) -> i64 {
    let ends_at = (genesis + (epoch + 1) * epoch_duration) as i64;
    ends_at * 1000 - (now_ms() + skew_ms)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Per-epoch starting point, so restarts do not retrace the same nonces.
fn rand_base() -> u64 {
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let mut x = t.as_nanos() as u64 ^ 0x9E3779B97F4A7C15;
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58476D1CE4E5B9);
    x ^= x >> 27;
    x
}

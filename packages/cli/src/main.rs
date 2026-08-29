//! NONCE CLI miner.
//!
//! Reads the live challenge, target and fee from the contract, searches with
//! every core it is given, and submits the best hash before the epoch closes.
//!
//!   NONCE_PRIVATE_KEY=0x... nonce-miner --rpc https://... --address 0x...

// The modules live in the library so the integration tests can reach them;
// re-declaring them here would compile a second, separate copy.
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clap::Parser;
use primitive_types::U256;

use nonce_miner::miner::{Job, Session};
use nonce_miner::rpc::{call_data, Rpc};
use nonce_miner::strategy::{should_submit, Strategy};
use nonce_miner::wallet::{Tx, Wallet};

#[derive(Parser)]
#[command(name = "nonce-miner", version, about = "Proof-of-work miner for NONCE")]
struct Args {
    /// JSON-RPC endpoint
    #[arg(long, env = "NONCE_RPC_URL")]
    rpc: String,

    /// NONCE token address
    #[arg(long, env = "NONCE_ADDRESS")]
    address: String,

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
    #[arg(long, default_value_t = 6_000)]
    lead_ms: i64,

    /// Gas limit per submission.
    #[arg(long, default_value_t = 500_000)]
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

    // The key comes from the environment only — never an argument, so it cannot
    // land in shell history or a process listing.
    let key = std::env::var("NONCE_PRIVATE_KEY")
        .map_err(|_| "set NONCE_PRIVATE_KEY (never pass a key on the command line)".to_string())?;
    let wallet = Wallet::from_hex(&key)?;

    let token = parse_address(&args.address)?;
    let rpc = Rpc::new(&args.rpc);
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
    println!("epoch    {epoch_duration}s   fee {} wei/submit", fee);
    println!("balance  {} wei", balance);
    if balance.is_zero() {
        return Err("wallet holds no ETH; every submission costs a fee plus gas".into());
    }
    if !fee.is_zero() && balance < fee * U256::from(10) {
        eprintln!("warning: balance covers fewer than 10 submissions");
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
                    match submit(&rpc, &wallet, &token, chain_id, b.nonce, &args) {
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

fn submit(
    rpc: &Rpc,
    wallet: &Wallet,
    token: &[u8; 20],
    chain_id: u64,
    nonce_value: U256,
    args: &Args,
) -> Result<String, String> {
    let fee = rpc.view(token, &call_data("submitFee()", &[])).map_err(|e| e.to_string())?;
    let tx_nonce = rpc.tx_count(&wallet.address).map_err(|e| e.to_string())?;
    let gas_price = rpc.gas_price().map_err(|e| e.to_string())?;

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

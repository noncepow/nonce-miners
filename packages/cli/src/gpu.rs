//! CUDA backend.
//!
//! The kernel is compiled at runtime by nvrtc and launched through the driver
//! API, so no CUDA toolkit is needed to build or run this — only the Nvidia
//! driver, plus `nvrtc64_*.dll` reachable on PATH.
//!
//! **Every hit the GPU reports is re-hashed on the CPU before it is used.** A
//! wrong kernel does not raise an error; it returns plausible-looking digests
//! the contract then rejects, which reads as persistent bad luck rather than a
//! bug. The GPU proposes candidates; the CPU decides.

use std::sync::Arc;

use cudarc::driver::{CudaDevice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::compile_ptx;
use primitive_types::U256;

use crate::hash::{score_of, Preimage};
use crate::miner::Solution;

const BLOCK: u32 = 256;
const MAX_HITS: usize = 256;

pub struct Gpu {
    device: Arc<CudaDevice>,
    pub name: String,
}

impl Gpu {
    /// cudarc loads the CUDA and nvrtc shared libraries lazily and **panics** if
    /// either is missing rather than returning an error, so `?` never sees it.
    /// Left alone, "this machine has no CUDA" reaches the user as a Rust
    /// backtrace and makes the GPU tests fail instead of skipping. Contain the
    /// unwind here so the rest of the program can treat it as the ordinary
    /// error it is. The hook is silenced only across this call, before any
    /// worker threads exist.
    pub fn new() -> Result<Self, String> {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let outcome = std::panic::catch_unwind(Self::init);
        std::panic::set_hook(previous);

        outcome.unwrap_or_else(|_| {
            Err("CUDA is not loadable on this machine - needs an Nvidia driver and nvrtc64_*.dll on PATH".into())
        })
    }

    fn init() -> Result<Self, String> {
        let device = CudaDevice::new(0).map_err(|e| format!("no CUDA device: {e}"))?;
        let name = device.name().unwrap_or_else(|_| "CUDA device".into());

        let ptx = compile_ptx(include_str!("shaders/keccak.cu"))
            .map_err(|e| format!("kernel failed to compile: {e}"))?;
        device
            .load_ptx(ptx, "keccak", &["search"])
            .map_err(|e| format!("kernel failed to load: {e}"))?;

        Ok(Gpu { device, name })
    }

    /// Search `count` nonces from `base`, returning candidates that clear the
    /// target and survive CPU re-verification.
    pub fn search(
        &self,
        challenge: [u8; 32],
        miner: [u8; 20],
        target: U256,
        base: U256,
        count: u32,
    ) -> Result<Vec<Solution>, String> {
        let mut out = Vec::new();
        for (nonce, _) in self.dispatch(challenge, miner, target, base, count)? {
            // Re-hash on the CPU. The GPU proposes; the CPU decides.
            let mut p = Preimage::new(challenge, miner);
            p.set_nonce(nonce);
            let d = p.digest();
            let dv = U256::from_big_endian(&d);
            if dv.is_zero() || dv > target {
                continue;
            }
            out.push(Solution { nonce, digest: d, score: score_of(&d) });
        }
        Ok(out)
    }

    /// Digests exactly as the kernel produced them, with no CPU re-verification.
    ///
    /// Only the parity test uses this. Filtering through the CPU check — which is
    /// what the mining path does — would hide precisely the kernel bug the test
    /// exists to catch.
    pub fn raw_digests(
        &self,
        challenge: [u8; 32],
        miner: [u8; 20],
        base: U256,
        count: u32,
    ) -> Result<Vec<(U256, [u8; 32])>, String> {
        self.dispatch(challenge, miner, U256::MAX, base, count)
    }

    fn dispatch(
        &self,
        challenge: [u8; 32],
        miner: [u8; 20],
        target: U256,
        base: U256,
        count: u32,
    ) -> Result<Vec<(U256, [u8; 32])>, String> {
        let dev = &self.device;
        let step = |what: &'static str| move |e: cudarc::driver::DriverError| format!("{what}: {e}");

        let state =
            dev.htod_copy(absorb(challenge, miner, base).to_vec()).map_err(step("upload state"))?;
        let limit =
            dev.htod_copy(target_words(target).to_vec()).map_err(step("upload target"))?;
        let mut hit_count = dev.htod_copy(vec![0u32]).map_err(step("upload counter"))?;
        // Hit is { u32, u32, [u32; 8] } — ten words.
        let mut hits = dev.alloc_zeros::<u32>(MAX_HITS * 10).map_err(step("allocate hits"))?;

        let f = dev
            .get_func("keccak", "search")
            .ok_or_else(|| "kernel `search` not loaded".to_string())?;

        let cfg = LaunchConfig {
            grid_dim: (count.div_ceil(BLOCK), 1, 1),
            block_dim: (BLOCK, 1, 1),
            shared_mem_bytes: 0,
        };
        unsafe {
            f.launch(cfg, (&state, &limit, base.low_u64(), count, &mut hit_count, &mut hits))
        }
        .map_err(step("launch"))?;

        let found =
            (dev.dtoh_sync_copy(&hit_count).map_err(step("read counter"))?[0] as usize).min(MAX_HITS);
        if found == 0 {
            return Ok(Vec::new());
        }
        let raw = dev.dtoh_sync_copy(&hits).map_err(step("read hits"))?;

        // The high 192 bits come from the base; the kernel only varies the low 64.
        let high = base & !U256::from(u64::MAX);
        let mut out = Vec::with_capacity(found);
        for h in raw.chunks_exact(10).take(found) {
            let low = ((h[1] as u64) << 32) | h[0] as u64;
            let mut d = [0u8; 32];
            for (i, w) in h[2..10].iter().enumerate() {
                d[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
            }
            out.push((high | U256::from(low), d));
        }
        Ok(out)
    }
}

/// Pre-absorb the padded 136-byte block into 25 lanes, leaving the nonce's low
/// 64 bits zero for the kernel to fill in.
fn absorb(challenge: [u8; 32], miner: [u8; 20], base: U256) -> [u64; 25] {
    let mut block = [0u8; 136];
    block[..32].copy_from_slice(&challenge);
    block[32..52].copy_from_slice(&miner);

    // Bytes 52..83 are the nonce, big-endian. The high 24 are fixed for this
    // launch; the low 8 stay zero for the kernel to OR its own value in.
    let mut nonce_be = [0u8; 32];
    base.to_big_endian(&mut nonce_be);
    block[52..76].copy_from_slice(&nonce_be[..24]);

    block[84] = 0x01; // keccak padding, immediately after the 84-byte preimage
    block[135] |= 0x80;

    let mut lanes = [0u64; 25];
    for (i, lane) in lanes.iter_mut().enumerate().take(17) {
        *lane = u64::from_le_bytes(block[i * 8..i * 8 + 8].try_into().unwrap());
    }
    lanes
}

/// Target as eight big-endian words, most significant first.
fn target_words(target: U256) -> [u32; 8] {
    let mut be = [0u8; 32];
    target.to_big_endian(&mut be);
    let mut out = [0u32; 8];
    for (i, w) in out.iter_mut().enumerate() {
        *w = u32::from_be_bytes(be[i * 4..i * 4 + 4].try_into().unwrap());
    }
    out
}

/// A GPU search running in the background, mirroring the CPU `Session` so the
/// mining loop treats the two backends the same way.
pub struct GpuSession {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    hashes: std::sync::Arc<std::sync::atomic::AtomicU64>,
    best: std::sync::Arc<std::sync::Mutex<Option<Solution>>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl GpuSession {
    /// `batch` is nonces per launch. Larger keeps the GPU busy; smaller returns
    /// control sooner when the epoch rolls over.
    pub fn start(gpu: Gpu, job: crate::miner::Job, base: u64, batch: u32) -> Self {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::{Arc, Mutex};

        let stop = Arc::new(AtomicBool::new(false));
        let hashes = Arc::new(AtomicU64::new(0));
        let best: Arc<Mutex<Option<Solution>>> = Arc::new(Mutex::new(None));

        let (s, h, b) = (stop.clone(), hashes.clone(), best.clone());
        let handle = std::thread::spawn(move || {
            let mut nonce = U256::from(base);
            while !s.load(Ordering::Relaxed) {
                match gpu.search(job.challenge, job.miner, job.target, nonce, batch) {
                    Ok(found) => {
                        for sol in found {
                            let mut guard = b.lock().unwrap();
                            if guard.as_ref().map_or(true, |cur| sol.score > cur.score) {
                                *guard = Some(sol);
                            }
                        }
                    }
                    // A launch failure must not kill the miner; the next one may work.
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
                }
                nonce = nonce.saturating_add(U256::from(batch));
                h.fetch_add(batch as u64, Ordering::Relaxed);
            }
        });

        GpuSession { stop, hashes, best, handle: Some(handle) }
    }

    pub fn best(&self) -> Option<Solution> {
        self.best.lock().unwrap().clone()
    }

    pub fn hashes(&self) -> u64 {
        self.hashes.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn stop(mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

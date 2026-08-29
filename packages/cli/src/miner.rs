//! Multi-threaded search.
//!
//! Each worker owns a disjoint slice of the nonce space, so N threads do N
//! threads of distinct work rather than re-hashing each other's. Workers report
//! only improvements, which the coordinator merges.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use primitive_types::U256;

use crate::hash::{score_of, Preimage};

/// Width of one worker's slice. At ~1e12 nonces each and a few million hashes a
/// second, two workers cannot reach each other's range inside an epoch.
const SLICE: u64 = 1 << 40;

#[derive(Clone, Debug)]
pub struct Solution {
    pub nonce: U256,
    pub digest: [u8; 32],
    pub score: U256,
}

pub struct Job {
    pub challenge: [u8; 32],
    pub miner: [u8; 20],
    pub target: U256,
    pub epoch: u64,
}

/// A running search. Dropping it stops the workers.
pub struct Session {
    stop: Arc<AtomicBool>,
    hashes: Arc<AtomicU64>,
    best: Arc<Mutex<Option<Solution>>>,
    handles: Vec<thread::JoinHandle<()>>,
}

impl Session {
    /// Spawn `threads` workers against one epoch's challenge.
    pub fn start(job: Job, threads: usize, base: u64) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let hashes = Arc::new(AtomicU64::new(0));
        let best: Arc<Mutex<Option<Solution>>> = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::channel::<Solution>();

        let mut handles = Vec::with_capacity(threads + 1);

        for i in 0..threads {
            let stop = stop.clone();
            let hashes = hashes.clone();
            let tx = tx.clone();
            let challenge = job.challenge;
            let miner = job.miner;
            let target = job.target;
            let start = base.wrapping_add((i as u64).wrapping_mul(SLICE));

            handles.push(thread::spawn(move || {
                let mut p = Preimage::new(challenge, miner);
                // The high 24 bytes stay fixed for this worker's slice, so only
                // the low 8 are rewritten per attempt.
                p.set_nonce(U256::from(start));
                let mut local_best: Option<U256> = None;
                let mut low = start;
                let mut counted = 0u64;

                loop {
                    for _ in 0..4096 {
                        p.set_nonce_low(low);
                        let d = p.digest();
                        let dv = U256::from_big_endian(&d);

                        if !dv.is_zero() && dv <= target {
                            let s = score_of(&d);
                            if local_best.map_or(true, |b| s > b) {
                                local_best = Some(s);
                                let _ = tx.send(Solution {
                                    nonce: U256::from(low),
                                    digest: d,
                                    score: s,
                                });
                            }
                        }
                        low = low.wrapping_add(1);
                    }
                    counted += 4096;

                    if counted >= 1 << 18 {
                        hashes.fetch_add(counted, Ordering::Relaxed);
                        counted = 0;
                        if stop.load(Ordering::Relaxed) {
                            return;
                        }
                    }
                }
            }));
        }
        drop(tx);

        // Merge worker findings into a single best.
        let merge_best = best.clone();
        handles.push(thread::spawn(move || {
            for s in rx {
                let mut guard = merge_best.lock().unwrap();
                if guard.as_ref().map_or(true, |b| s.score > b.score) {
                    *guard = Some(s);
                }
            }
        }));

        Session { stop, hashes, best, handles }
    }

    pub fn best(&self) -> Option<Solution> {
        self.best.lock().unwrap().clone()
    }

    pub fn hashes(&self) -> u64 {
        self.hashes.load(Ordering::Relaxed)
    }

    pub fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        for h in self.handles {
            let _ = h.join();
        }
    }
}

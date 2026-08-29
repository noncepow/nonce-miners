/**
 * Web Worker mining loop.
 *
 * The page owns the wallet and the clock; this worker only hashes. It yields
 * between batches so `stop` and `challenge` messages are handled promptly —
 * a worker that blocks through a whole epoch would keep mining a stale
 * challenge and every solution it found would be rejected on chain.
 *
 *   const w = new Worker(new URL("@noncepow/miner/worker", import.meta.url), { type: "module" });
 *   w.postMessage({ type: "start", challenge, miner, target, epoch });
 *   w.onmessage = (e) => { ... };   // "progress" | "solution" | "stopped"
 */
import { mineBatch } from "./miner.js";

const BATCH = 20_000;

let running = false;
let job = null;
let nonce = 0n;
let best = null;
let hashes = 0;
let startedAt = 0;
let lastReport = 0;

function post(message) {
  self.postMessage(message);
}

function reset(next) {
  job = next;
  nonce = BigInt(next.startNonce ?? Math.floor(Math.random() * 2 ** 48));
  best = null;
  hashes = 0;
  startedAt = Date.now();
  lastReport = startedAt;
}

function loop() {
  if (!running || !job) return;

  const r = mineBatch({
    challenge: job.challenge,
    miner: job.miner,
    target: job.target,
    startNonce: nonce,
    batchSize: BATCH,
    best,
  });

  nonce = r.nextNonce;
  hashes += r.hashes;

  if (r.improved) {
    best = r.best;
    post({
      type: "solution",
      epoch: job.epoch,
      nonce: best.nonce.toString(),
      digest: best.digest,
      score: best.score.toString(),
      hashes,
    });
  }

  const now = Date.now();
  if (now - lastReport >= 1000) {
    post({
      type: "progress",
      epoch: job.epoch,
      hashes,
      hashrate: Math.round(hashes / Math.max(1, (now - startedAt) / 1000)),
      best: best ? { nonce: best.nonce.toString(), digest: best.digest, score: best.score.toString() } : null,
    });
    lastReport = now;
  }

  // Yield to the message queue before the next batch.
  setTimeout(loop, 0);
}

self.onmessage = (event) => {
  const msg = event.data;

  switch (msg.type) {
    case "start":
      reset(msg);
      if (!running) {
        running = true;
        setTimeout(loop, 0);
      }
      break;

    // New epoch: the challenge changed, so all in-flight work is worthless.
    case "challenge":
      reset({ ...job, challenge: msg.challenge, epoch: msg.epoch, target: msg.target ?? job.target });
      break;

    case "target":
      if (job) job.target = msg.target;
      break;

    case "stop":
      running = false;
      job = null;
      post({ type: "stopped", hashes });
      break;

    default:
      post({ type: "error", message: `unknown message: ${msg.type}` });
  }
};

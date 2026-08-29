/**
 * Mining through the `nonce-miner` binary instead of the in-process JavaScript
 * loop.
 *
 * The JavaScript miner runs one thread at roughly 70 KH/s. The Rust binary does
 * 8 MH/s on four cores and 470 MH/s on a mid-range CUDA card — three orders of
 * magnitude, and the difference between an agent that mines and an agent that
 * merely appears to. Rewards are split by score, so an agent competing against
 * GPUs at 70 KH/s earns a rounding error.
 *
 * The binary owns the wallet while it runs. Both miners submitting from the same
 * address would race for account nonces and lose transactions, so exactly one of
 * them is ever active.
 *
 * The private key is handed over in the child's environment, never on its
 * command line, so it stays out of the process listing — the same rule the
 * binary itself follows.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import type { SessionSnapshot, Strategy } from "./session.js";

export type BackendChoice = "auto" | "gpu" | "cpu" | "js";

const BIN_NAMES = process.platform === "win32" ? ["nonce-miner.exe", "nonce-miner"] : ["nonce-miner"];

/** The binary, if it is anywhere the shell would find it. */
export function locateBinary(): string | null {
  const override = process.env.NONCE_MINER_BIN;
  if (override) return isExecutable(override) ? override : null;

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of BIN_NAMES) {
      const full = join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the binary what it can do. `status` is read-only and spends nothing, so
 * this is safe to run before deciding anything.
 */
export function probeBinary(bin: string, rpcUrl: string, address: string): { gpu: string | null } {
  const r = spawnSync(bin, ["status"], {
    encoding: "utf8",
    timeout: 30_000,
    // Passed in the environment rather than as flags: the binary reads both, and
    // an older build rejects them after a subcommand.
    // No key: status only reads, and a probe should not be able to spend.
    env: {
      ...process.env,
      NONCE_RPC_URL: rpcUrl,
      NONCE_ADDRESS: address,
      NONCE_PRIVATE_KEY: "",
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/^\s*ok\s+(.+?)\s+—\s+run with --gpu/m);
  return { gpu: m ? m[1].trim() : null };
}

type Options = {
  bin: string;
  rpcUrl: string;
  address: string;
  privateKey: string;
  gpu: boolean;
  strategy: Strategy;
};

/** Mirrors MiningSession's surface so the tools do not care which is running. */
export class ExternalMiner {
  private opts: Options;
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private startedAt: number | null = null;

  private epoch: string | null = null;
  private backendLine = "";
  private hashrate = 0; // hashes/s, from the last completed epoch
  private hashesThisEpoch = 0;
  private totalHashes = 0;
  private bestScore: string | null = null;
  private submitsThisEpoch = 0;
  private submitsTotal = 0;
  private lastError: string | null = null;
  private stdoutTail = "";

  constructor(opts: Options) {
    this.opts = opts;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  backend(): string {
    return this.backendLine || (this.opts.gpu ? "CUDA" : "CPU");
  }

  start(): void {
    if (this.child) return;

    const args = [
      "--rpc",
      this.opts.rpcUrl,
      "--address",
      this.opts.address,
      "--max-submits",
      String(this.opts.strategy.maxSubmits),
      "--reroll-factor",
      String(this.opts.strategy.rerollFactor),
      "--lead-ms",
      String(this.opts.strategy.submitLeadMs),
    ];
    if (this.opts.gpu) args.push("--gpu");

    const child = spawn(this.opts.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // The key travels in the environment, never in argv.
      env: { ...process.env, NONCE_PRIVATE_KEY: this.opts.privateKey },
    });
    this.child = child;
    this.startedAt = Date.now();
    this.totalHashes = 0;
    this.submitsTotal = 0;
    this.lastError = null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.consume(chunk));

    child.on("exit", (code, signal) => {
      // A miner that died on its own is not a miner that was stopped, and the
      // difference matters to whoever asks for status next.
      if (this.child && code !== 0 && signal === null) {
        this.lastError = this.lastError ?? `miner exited with code ${code}`;
      }
      this.child = null;
    });
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    if (!c) return;
    c.kill();
    // SIGTERM is ignored while a CUDA launch is in flight; do not leave it running.
    setTimeout(() => {
      if (!c.killed) c.kill("SIGKILL");
    }, 3_000).unref();
  }

  snapshot(): SessionSnapshot {
    return {
      running: this.isRunning(),
      startedAt: this.startedAt,
      epoch: this.epoch,
      hashrate: this.isRunning() ? this.hashrate : 0,
      hashesThisEpoch: this.hashesThisEpoch,
      totalHashes: this.totalHashes,
      bestScore: this.bestScore,
      submitsThisEpoch: this.submitsThisEpoch,
      submitsTotal: this.submitsTotal,
      lastError: this.lastError,
      strategy: {
        maxSubmits: this.opts.strategy.maxSubmits,
        rerollFactor: this.opts.strategy.rerollFactor.toString(),
        submitLeadMs: this.opts.strategy.submitLeadMs,
        minScore: this.opts.strategy.minScore.toString(),
      },
    };
  }

  /** The binary's own output is the only telemetry there is, so it is parsed. */
  private consume(chunk: string): void {
    this.stdoutTail = (this.stdoutTail + chunk).slice(-4_000);
    for (const raw of chunk.split("\n")) {
      const line = raw.trimEnd();
      if (!line) continue;

      let m: RegExpMatchArray | null;

      if ((m = line.match(/^backend\s+(.+)$/))) {
        this.backendLine = m[1].trim();
      } else if ((m = line.match(/^epoch (\d+)\s+challenge/))) {
        this.epoch = m[1];
        this.submitsThisEpoch = 0;
        this.hashesThisEpoch = 0;
        this.bestScore = null;
      } else if ((m = line.match(/^\s*submitted score=(\d+).*\((\d+)\/\d+\)/))) {
        this.bestScore = m[1];
        this.submitsThisEpoch = Number(m[2]);
        this.submitsTotal += 1;
      } else if ((m = line.match(/^\s*epoch \d+ done: (\d+) hashes, ~([\d.]+) MH\/s/))) {
        const hashes = Number(m[1]);
        this.hashesThisEpoch = hashes;
        this.totalHashes += hashes;
        this.hashrate = Math.round(Number(m[2]) * 1e6);
      } else if ((m = line.match(/^\s*submit failed: (.+)$/))) {
        this.lastError = m[1];
      } else if ((m = line.match(/^nonce-miner: (.+)$/))) {
        this.lastError = m[1];
      }
    }
  }

  /** Recent output, for an error that the parser did not recognise. */
  tail(): string {
    return this.stdoutTail;
  }
}

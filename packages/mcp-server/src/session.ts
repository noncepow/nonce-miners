import { mineBatch, shouldSubmit, createStrategy } from "@nonce/miner";

import { type Chain, read, write } from "./chain.js";

const BATCH = 20_000;
const EPOCH_SECONDS = 60;

export type Strategy = {
  maxSubmits: number;
  rerollFactor: bigint;
  submitLeadMs: number;
  minScore: bigint;
};

export type SessionSnapshot = {
  running: boolean;
  startedAt: number | null;
  epoch: string | null;
  hashrate: number;
  hashesThisEpoch: number;
  totalHashes: number;
  bestScore: string | null;
  submitsThisEpoch: number;
  submitsTotal: number;
  lastError: string | null;
  strategy: { maxSubmits: number; rerollFactor: string; submitLeadMs: number; minScore: string };
};

/**
 * A background mining session.
 *
 * The loop yields between batches so `stop` is honoured promptly and so the
 * stdio transport is never starved — a synchronous grind through a whole epoch
 * would make the MCP server stop answering.
 */
export class MiningSession {
  private chain: Chain;
  private strategy: Strategy;

  private running = false;
  private startedAt: number | null = null;
  private epoch: bigint | null = null;
  private challenge: string | null = null;
  private target: bigint | null = null;
  private genesis: bigint | null = null;
  /** chainNow - localNow, in ms; see msLeftInEpoch. */
  private clockSkewMs = 0;

  private nonce = 0n;
  private best: { nonce: bigint; digest: string; score: bigint } | null = null;
  private submitted: { score: bigint } | null = null;

  private hashesThisEpoch = 0;
  private totalHashes = 0;
  private epochStartedAt = Date.now();
  private submitsThisEpoch = 0;
  private submitsTotal = 0;
  private lastError: string | null = null;
  private sending = false;

  constructor(chain: Chain, strategy?: Partial<Strategy>) {
    this.chain = chain;
    this.strategy = createStrategy(strategy) as Strategy;
  }

  isRunning(): boolean {
    return this.running;
  }

  setStrategy(next: Partial<Strategy>): Strategy {
    this.strategy = createStrategy({ ...this.strategy, ...next }) as Strategy;
    return this.strategy;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.chain.account) throw new Error("no wallet");

    this.running = true;
    this.startedAt = Date.now();
    this.totalHashes = 0;
    this.submitsTotal = 0;
    this.lastError = null;
    this.genesis = await read<bigint>(this.chain, "genesisTime");
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.best = null;
    this.submitted = null;
  }

  snapshot(): SessionSnapshot {
    const elapsed = Math.max(0.001, (Date.now() - this.epochStartedAt) / 1000);
    return {
      running: this.running,
      startedAt: this.startedAt,
      epoch: this.epoch?.toString() ?? null,
      hashrate: this.running ? Math.round(this.hashesThisEpoch / elapsed) : 0,
      hashesThisEpoch: this.hashesThisEpoch,
      totalHashes: this.totalHashes,
      bestScore: this.best?.score.toString() ?? null,
      submitsThisEpoch: this.submitsThisEpoch,
      submitsTotal: this.submitsTotal,
      lastError: this.lastError,
      strategy: {
        maxSubmits: this.strategy.maxSubmits,
        rerollFactor: this.strategy.rerollFactor.toString(),
        submitLeadMs: this.strategy.submitLeadMs,
        minScore: this.strategy.minScore.toString(),
      },
    };
  }

  /**
   * Measured against the chain's clock, not the host's. A host running a few
   * seconds behind would otherwise submit into an epoch that has already
   * rotated, which reverts every time and still costs gas.
   */
  private msLeftInEpoch(): number {
    if (this.genesis === null || this.epoch === null) return Number.POSITIVE_INFINITY;
    const endsAt = Number(this.genesis) + Number(this.epoch + 1n) * EPOCH_SECONDS;
    return endsAt * 1000 - (Date.now() + this.clockSkewMs);
  }

  private async syncEpoch(): Promise<void> {
    const epoch = await read<bigint>(this.chain, "currentEpoch");
    if (this.epoch !== null && this.epoch === epoch) return;

    // New epoch: the challenge rotated, so any in-flight work is worthless.
    this.epoch = epoch;
    this.challenge = await read<string>(this.chain, "challengeFor", [epoch]);
    this.target = await read<bigint>(this.chain, "currentTarget");
    const block = await this.chain.publicClient.getBlock();
    this.clockSkewMs = Number(block.timestamp) * 1000 - Date.now();
    this.best = null;
    this.submitted = null;
    this.submitsThisEpoch = 0;
    this.hashesThisEpoch = 0;
    this.epochStartedAt = Date.now();
    this.nonce = BigInt(Math.floor(Math.random() * 2 ** 48));
  }

  private async loop(): Promise<void> {
    let lastSync = 0;

    while (this.running) {
      try {
        if (Date.now() - lastSync > 3_000) {
          await this.syncEpoch();
          lastSync = Date.now();
        }

        if (this.challenge && this.target !== null && this.chain.account) {
          const r = mineBatch({
            challenge: this.challenge,
            miner: this.chain.account,
            target: this.target,
            startNonce: this.nonce,
            batchSize: BATCH,
            best: this.best,
          });
          this.nonce = r.nextNonce;
          this.hashesThisEpoch += r.hashes;
          this.totalHashes += r.hashes;
          if (r.improved) this.best = r.best;

          await this.maybeSubmit();
        }
      } catch (err) {
        this.lastError = shortError(err);
      }

      // Yield so stop() and incoming MCP requests are handled promptly.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private async maybeSubmit(): Promise<void> {
    if (this.sending || !this.best) return;

    const decision = shouldSubmit(
      {
        best: this.best,
        submitted: this.submitted,
        submitsUsed: this.submitsThisEpoch,
        msLeftInEpoch: this.msLeftInEpoch(),
      },
      this.strategy
    );
    if (!decision.submit) return;

    this.sending = true;
    try {
      const fee = await read<bigint>(this.chain, "submitFee");
      await write(this.chain, "submit a solution", "submit", [this.best.nonce], fee);
      this.submitted = { score: this.best.score };
      this.submitsThisEpoch += 1;
      this.submitsTotal += 1;
    } catch (err) {
      // A stale challenge or a lost race is routine; keep mining.
      this.lastError = shortError(err);
    } finally {
      this.sending = false;
    }
  }
}

export function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split("\n")[0];
}

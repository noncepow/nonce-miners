/**
 * Types for @noncepow/miner, which ships as plain ESM JavaScript so the browser
 * worker and the CLI can load it without a build step.
 */
declare module "@noncepow/miner" {
  export type Solution = { nonce: bigint; digest: string; score: bigint };

  export function mineBatch(args: {
    challenge: string;
    miner: string;
    target: bigint | string;
    startNonce?: bigint;
    batchSize?: number;
    best?: Solution | null;
  }): { best: Solution | null; hashes: number; nextNonce: bigint; improved: boolean };

  export function mineUntil(args: {
    challenge: string;
    miner: string;
    target: bigint | string;
    startNonce?: bigint;
    maxHashes?: number;
    batchSize?: number;
  }): { best: Solution | null; hashes: number; nextNonce: bigint };

  export function digest(challenge: string, miner: string, nonce: bigint): Uint8Array;
  export function scoreOf(digest: Uint8Array | bigint): bigint;
  export function bytesToHex(bytes: Uint8Array): string;

  export function createStrategy(overrides?: Record<string, unknown>): {
    maxSubmits: number;
    rerollFactor: bigint;
    submitLeadMs: number;
    minScore: bigint;
  };

  export function shouldSubmit(
    state: {
      best: { score: bigint } | null;
      submitted: { score: bigint } | null;
      submitsUsed: number;
      msLeftInEpoch: number;
    },
    config?: unknown
  ): { submit: boolean; reason: string };

  export function newEpochState(epoch: number | bigint): {
    epoch: number | bigint;
    best: Solution | null;
    submitted: Solution | null;
    submitsUsed: number;
    hashes: number;
    startedAt: number;
  };
}

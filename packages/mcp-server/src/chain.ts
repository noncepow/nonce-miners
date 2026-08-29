import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  type Abi,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import abiJson from "./nonce-abi.json" with { type: "json" };
import { type Config, NoWalletError } from "./config.js";

export const nonceAbi = abiJson as Abi;

export type Chain = {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  account?: Address;
  address: Address;
  chainId: number;
};

export async function connect(config: Config): Promise<Chain> {
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ transport }) as PublicClient;
  const chainId = await publicClient.getChainId();

  if (!config.privateKey) {
    return { publicClient, address: config.nonceAddress, chainId };
  }

  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createWalletClient({ account, transport });
  return {
    publicClient,
    walletClient,
    account: account.address,
    address: config.nonceAddress,
    chainId,
  };
}

export function read<T>(chain: Chain, functionName: string, args: readonly unknown[] = []) {
  return chain.publicClient.readContract({
    address: chain.address,
    abi: nonceAbi,
    functionName,
    args,
  }) as Promise<T>;
}

/**
 * The network's hashrate, estimated from settled epoch scores.
 *
 * A score is `2^256 / digest`, and the best of N draws lands near `2^256 / N`,
 * so a score is roughly the hashes tried. The **median** is used, not the mean:
 * `E[1/min(U_1..U_N)]` diverges, so an average of this quantity never settles —
 * measured against a miner holding a flat 478 MH/s, a running mean climbed past
 * 1.5 GH/s and kept going. The median of a best-of-N score sits at `N / ln 2`,
 * which is divided back out here.
 *
 * Expect it within a factor of two, biased high: staking multiplies a score by
 * up to 2x without any extra hashing.
 */
export async function networkHashrate(
  chain: Chain,
  epoch: bigint,
  epochSeconds: number,
  window = 15
): Promise<number | null> {
  if (epoch === 0n) return null;
  const newest = epoch - 1n;
  const oldest = newest > BigInt(window) - 1n ? newest - (BigInt(window) - 1n) : 0n;

  const epochs: bigint[] = [];
  for (let e = oldest; e <= newest; e++) epochs.push(e);

  const rows = await Promise.all(
    epochs.map((e) =>
      read<readonly [bigint, bigint, number]>(chain, "epochs", [e]).catch(() => null)
    )
  );
  const scores = rows
    .filter((r): r is readonly [bigint, bigint, number] => r !== null)
    .map((r) => Number(r[1]))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  if (scores.length === 0) return null;
  const median = scores[Math.floor(scores.length / 2)];
  return (median * Math.LN2) / epochSeconds;
}

/** The caller's share of a settled epoch, as a percentage. */
export async function epochShare(
  chain: Chain,
  miner: Address,
  epoch: bigint
): Promise<number | null> {
  const [row, mine] = await Promise.all([
    read<readonly [bigint, bigint, number]>(chain, "epochs", [epoch]).catch(() => null),
    read<readonly [bigint, number, boolean]>(chain, "minerEpoch", [miner, epoch]).catch(() => null),
  ]);
  if (!row || !mine || row[1] === 0n) return null;
  return (Number(mine[0]) / Number(row[1])) * 100;
}

/**
 * Send a transaction and wait for it to land.
 *
 * Waiting rather than returning the hash immediately is deliberate: an agent
 * that fires a claim and reports success before the receipt exists will happily
 * report a reverted transaction as done.
 */
export async function write(
  chain: Chain,
  action: string,
  functionName: string,
  args: readonly unknown[] = [],
  value?: bigint
): Promise<{ hash: Hash; gasUsed: bigint; status: "success" | "reverted" }> {
  if (!chain.walletClient || !chain.account) throw new NoWalletError(action);
  const signer = chain.walletClient.account;
  if (!signer) throw new NoWalletError(action);

  const hash = await chain.walletClient.writeContract({
    address: chain.address,
    abi: nonceAbi,
    functionName,
    args,
    value,
    // The wallet client already holds the local signing account. Passing
    // `chain.account` here hands viem a bare address, which it reads as an
    // account the *node* manages and routes to eth_sendTransaction — but the
    // RPC holds no key, so every write failed before it was ever broadcast.
    account: signer,
    chain: null,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  return { hash, gasUsed: receipt.gasUsed, status: receipt.status };
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by every tool
// ---------------------------------------------------------------------------

const WAD = 10n ** 18n;

/** 18-decimal amount to a fixed-point string, without floating-point drift. */
export function formatToken(value: bigint, digits = 4): string {
  const whole = (value / WAD).toString();
  if (digits === 0) return whole;
  const frac = (value % WAD).toString().padStart(18, "0").slice(0, digits);
  return `${whole}.${frac}`;
}

export function formatEth(value: bigint): string {
  return formatEther(value);
}

export function compact(n: number): string {
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) return `${(n / size).toFixed(2)} ${suffix}`;
  }
  return n.toFixed(0);
}

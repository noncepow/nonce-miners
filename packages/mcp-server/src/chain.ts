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

#!/usr/bin/env node
/**
 * Read-only preflight for a NONCE miner.
 *
 * Answers the three questions that decide whether mining is worth starting:
 * is the chain reachable, can the wallet pay the fees, and what does an epoch
 * currently pay. Nothing here sends a transaction or spends anything.
 */
import { createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.NONCE_RPC_URL;
const ADDRESS = process.env.NONCE_ADDRESS;
const KEY = process.env.NONCE_PRIVATE_KEY;

const ABI = [
  "function currentEpoch() view returns (uint256)",
  "function epochReward(uint256) view returns (uint256)",
  "function submitFee() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function pendingRewards(address,uint256) view returns (uint256)",
  "function stakeTarget() view returns (uint256)",
].map(parseSignature);

/** Minimal human-readable ABI parser — avoids pulling in a formatter dependency. */
function parseSignature(sig) {
  const m = sig.match(/^function (\w+)\(([^)]*)\)[^(]*returns \(([^)]*)\)$/);
  const [, name, inputs, outputs] = m;
  const split = (s) => (s.trim() ? s.split(",").map((t) => ({ type: t.trim().split(" ")[0] })) : []);
  return { type: "function", name, stateMutability: "view", inputs: split(inputs), outputs: split(outputs) };
}

const ok = (s) => `  ok   ${s}`;
const warn = (s) => `  warn ${s}`;
const bad = (s) => `  FAIL ${s}`;

function fail(message) {
  console.error(`\n${bad(message)}\n`);
  process.exit(1);
}

const fmt = (v, d = 2) => {
  const whole = (v / 10n ** 18n).toLocaleString("en-US");
  if (d === 0) return whole;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, d);
  return `${whole}.${frac}`;
};

async function main() {
  console.log("NONCE miner preflight\n");

  if (!RPC) fail("NONCE_RPC_URL is not set.");
  if (!ADDRESS) fail("NONCE_ADDRESS is not set.");

  const client = createPublicClient({ transport: http(RPC) });
  const read = (functionName, args = []) =>
    client.readContract({ address: ADDRESS, abi: ABI, functionName, args });

  // 1. Chain and contract ---------------------------------------------------
  let chainId;
  try {
    chainId = await client.getChainId();
  } catch (e) {
    fail(`RPC unreachable: ${e.shortMessage ?? e.message}`);
  }
  console.log(`chain`);
  console.log(ok(`connected, chain id ${chainId}`));

  let symbol;
  try {
    symbol = await read("symbol");
  } catch {
    fail(`No NONCE contract at ${ADDRESS} on chain ${chainId}. Check NONCE_ADDRESS.`);
  }
  console.log(ok(`${symbol} at ${ADDRESS}`));

  // 2. Economics ------------------------------------------------------------
  const [epoch, fee, supply, max] = await Promise.all([
    read("currentEpoch"),
    read("submitFee"),
    read("totalSupply"),
    read("MAX_SUPPLY"),
  ]);
  const reward = await read("epochReward", [epoch]);

  console.log(`\nprotocol`);
  console.log(ok(`epoch ${epoch}, paying ${fmt(reward)} ${symbol} before tax`));
  console.log(ok(`submit fee ${formatEther(fee)} ETH, on top of gas`));
  console.log(ok(`minted ${fmt(supply, 0)} of ${fmt(max, 0)}`));

  // 3. Wallet ---------------------------------------------------------------
  console.log(`\nwallet`);
  if (!KEY) {
    console.log(warn("NONCE_PRIVATE_KEY is not set — read-only. Mining and claiming are unavailable."));
    console.log("\nPreflight passed for read-only use.\n");
    return;
  }

  let account;
  try {
    account = privateKeyToAccount(KEY);
  } catch {
    fail("NONCE_PRIVATE_KEY is not a valid 32-byte hex key.");
  }

  const [eth, balance, pending, stakeTarget] = await Promise.all([
    client.getBalance({ address: account.address }),
    read("balanceOf", [account.address]),
    read("pendingRewards", [account.address, 200n]),
    read("stakeTarget"),
  ]);

  console.log(ok(account.address));

  // Every submission costs the fee plus gas; a wallet that cannot cover a
  // meaningful number of them will stall within minutes of starting.
  const submits = fee > 0n ? eth / fee : 0n;
  if (eth === 0n) {
    console.log(bad(`0 ETH — cannot mine. Fund this address before starting.`));
  } else if (submits < 50n) {
    console.log(warn(`${formatEther(eth)} ETH covers roughly ${submits} submissions before gas.`));
  } else {
    console.log(ok(`${formatEther(eth)} ETH, roughly ${submits} submissions before gas`));
  }

  console.log(ok(`holds ${fmt(balance)} ${symbol}, ${fmt(pending)} unclaimed`));
  console.log(ok(`${fmt(stakeTarget, 0)} ${symbol} staked reaches the 2x multiplier`));

  console.log(
    eth === 0n
      ? "\nPreflight failed: fund the wallet with ETH, then run again.\n"
      : "\nPreflight passed. Start with nonce_start_mining.\n"
  );
  if (eth === 0n) process.exit(1);
}

main().catch((e) => fail(e.shortMessage ?? e.message));

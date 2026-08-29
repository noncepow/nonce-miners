#!/usr/bin/env node
/**
 * NONCE reference miner (Node).
 *
 * Reads the live challenge, target and fee from the contract, mines the current
 * epoch, and submits the best hash before the epoch closes.
 *
 *   NONCE_ADDRESS=0x... NONCE_PRIVATE_KEY=0x... \
 *   node bin/mine.js --rpc http://127.0.0.1:8545
 *
 * Flags: --rpc <url>  --address <0x>  --max-submits <1-10>  --lead-ms <n>  --once
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { mineBatch } from "../src/miner.js";
import { createStrategy, shouldSubmit, newEpochState } from "../src/strategy.js";

const here = dirname(fileURLToPath(import.meta.url));
const abi = JSON.parse(readFileSync(join(here, "../src/nonce-abi.json"), "utf8"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const RPC = arg("rpc", process.env.NONCE_RPC_URL ?? "http://127.0.0.1:8545");
const ADDRESS = arg("address", process.env.NONCE_ADDRESS);
const PRIVATE_KEY = process.env.NONCE_PRIVATE_KEY;
const BATCH = Number(arg("batch", "20000"));

if (!ADDRESS) exit("set NONCE_ADDRESS or pass --address");
if (!PRIVATE_KEY) exit("set NONCE_PRIVATE_KEY (never pass a key on the command line)");

function exit(message) {
  console.error(`nonce-mine: ${message}`);
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
const transport = http(RPC);
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });

const strategy = createStrategy({
  maxSubmits: Number(arg("max-submits", "10")),
  submitLeadMs: Number(arg("lead-ms", "6000")),
});

const read = (functionName, args = []) =>
  publicClient.readContract({ address: ADDRESS, abi, functionName, args });

let chainId;
let epochDuration;
let genesisTime;
let stopping = false;
/** chainNow - localNow, in ms. Without this a local clock running behind makes
    the miner believe it still has time and submit against a rotated challenge,
    which always reverts and burns the gas anyway. */
let clockSkewMs = 0;

async function boot() {
  chainId = await publicClient.getChainId();
  [epochDuration, genesisTime] = await Promise.all([read("EPOCH_DURATION"), read("genesisTime")]);
  await measureClockSkew();

  const balance = await publicClient.getBalance({ address: account.address });
  const fee = await read("submitFee");

  console.log(`miner    ${account.address}`);
  console.log(`contract ${ADDRESS}  (chain ${chainId})`);
  console.log(`epoch    ${epochDuration}s   fee ${formatEther(fee)} ETH/submit`);
  console.log(`balance  ${formatEther(balance)} ETH`);

  if (fee > 0n && balance < fee * 10n) {
    console.warn(`warning: balance covers fewer than 10 submits`);
  }
  if (balance === 0n) exit("miner has no ETH for fees or gas");
}

/** Milliseconds left in the epoch, measured against the chain's clock. */
function msLeftInEpoch(epoch) {
  const endsAt = Number(genesisTime) + Number(epoch + 1n) * Number(epochDuration);
  return endsAt * 1000 - (Date.now() + clockSkewMs);
}

async function measureClockSkew() {
  const block = await publicClient.getBlock();
  clockSkewMs = Number(block.timestamp) * 1000 - Date.now();
}

async function submit(state, best) {
  const fee = await read("submitFee");
  try {
    const hash = await walletClient.writeContract({
      address: ADDRESS,
      abi,
      functionName: "submit",
      args: [best.nonce],
      value: fee,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    state.submitted = best;
    state.submitsUsed += 1;
    console.log(
      `  submitted score=${best.score} nonce=${best.nonce} ` +
        `(${state.submitsUsed}/${strategy.maxSubmits}) gas=${receipt.gasUsed} ${hash}`
    );
  } catch (err) {
    // A stale challenge or a lost race is normal — keep mining rather than dying.
    console.warn(`  submit failed: ${shortError(err)}`);
  }
}

function shortError(err) {
  const m = err?.shortMessage ?? err?.message ?? String(err);
  return m.split("\n")[0];
}

async function run() {
  await boot();

  let state = null;
  let challenge = null;
  let target = null;
  let nonce = BigInt(Math.floor(Math.random() * 2 ** 48));

  while (!stopping) {
    const epoch = await read("currentEpoch");

    if (!state || state.epoch !== epoch) {
      // New epoch: the challenge rotated, so any in-flight work is worthless.
      state = newEpochState(epoch);
      [challenge, target] = await Promise.all([read("challengeFor", [epoch]), read("currentTarget")]);
      await measureClockSkew();
      nonce = BigInt(Math.floor(Math.random() * 2 ** 48));
      console.log(`epoch ${epoch}  challenge ${challenge.slice(0, 18)}…`);
    }

    const r = mineBatch({
      challenge,
      miner: account.address,
      target,
      startNonce: nonce,
      batchSize: BATCH,
      best: state.best,
    });
    nonce = r.nextNonce;
    state.hashes += r.hashes;
    if (r.improved) state.best = r.best;

    const decision = shouldSubmit(
      {
        best: state.best,
        submitted: state.submitted,
        submitsUsed: state.submitsUsed,
        msLeftInEpoch: msLeftInEpoch(epoch),
      },
      strategy
    );
    if (decision.submit) await submit(state, state.best);

    if (msLeftInEpoch(epoch) <= 0 && !state.reported) {
      state.reported = true;
      const rate = Math.round(state.hashes / Math.max(1, (Date.now() - state.startedAt) / 1000));
      console.log(`  epoch ${epoch} done: ${state.hashes} hashes, ~${rate} H/s`);
      if (flag("once")) break;
    }

    // Yield so signals and the RPC keep flowing.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

process.on("SIGINT", () => {
  console.log("\nstopping…");
  stopping = true;
  setTimeout(() => process.exit(0), 250);
});

run().catch((err) => exit(shortError(err)));

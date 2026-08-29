#!/usr/bin/env node
/**
 * NONCE MCP server — mine a proof-of-work token from any MCP-compatible agent.
 *
 * stdio transport: the server holds a private key and runs a miner, so it is a
 * local process, not a remote endpoint.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseEther } from "viem";
import { z } from "zod";

import { ConfigError, NoWalletError, loadConfig } from "./config.js";
import { compact, connect, formatEth, formatToken, read, write, type Chain } from "./chain.js";
import { MiningSession, shortError } from "./session.js";

const ResponseFormat = z.enum(["markdown", "json"]).default("markdown");
type Format = z.infer<typeof ResponseFormat>;

/** Every tool returns both a readable rendering and the structured data behind it. */
function reply(format: Format, markdown: string, data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: format === "json" ? JSON.stringify(data, null, 2) : markdown }],
    structuredContent: data,
  };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/** Wraps a handler so a chain or wallet failure becomes an actionable message. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NoWalletError) return failure(err.message);
    return failure(shortError(err));
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`nonce-mcp-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const chain: Chain = await connect(config);
  const session = new MiningSession(chain);

  const server = new McpServer({ name: "nonce-mcp-server", version: "0.1.0" });

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_status",
    {
      title: "NONCE mining status",
      description: `Current state of this wallet's mining: session activity, hashrate, unclaimed rewards, balance, stake and multiplier.

Call this first. It is read-only and safe to call at any time, including while mining.

Args:
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "wallet": string | null,        // null when the server is read-only
    "epoch": string,                // current epoch number
    "secondsLeftInEpoch": number,
    "mining": {
      "running": boolean,
      "hashrate": number,           // hashes per second, this epoch
      "bestScore": string | null,   // best score held for the current epoch
      "submitsThisEpoch": number,   // of a maximum of 10
      "submitsTotal": number,
      "lastError": string | null
    },
    "rewards": {
      "unclaimed": string,          // NONCE, claimable now
      "balance": string,            // NONCE in the wallet
      "staked": string,
      "multiplier": string,         // e.g. "1.50x", capped at 2x
      "stakeTarget": string,        // NONCE staked for the full 2x
      "lockRemainingSeconds": string
    },
    "eth": string                   // native balance, pays submit fees and gas
  }

Examples:
  - Use when: "how is my mining going?"
  - Use when: "do I have anything to claim?"
  - Don't use when: you want protocol-wide numbers (use nonce_protocol_info)`,
      inputSchema: { response_format: ResponseFormat },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) =>
      guarded(async () => {
        const wallet = chain.account ?? null;
        const [epoch, genesis, epochDuration] = await Promise.all([
          read<bigint>(chain, "currentEpoch"),
          read<bigint>(chain, "genesisTime"),
          read<bigint>(chain, "EPOCH_DURATION"),
        ]);

        let rewards = {
          unclaimed: "0",
          balance: "0",
          staked: "0",
          multiplier: "1.00x",
          stakeTarget: "0",
          lockRemainingSeconds: "0",
        };
        let eth = "0";

        if (wallet) {
          const [pending, balance, staked, multiplier, stakeTarget, lock, native] = await Promise.all([
            read<bigint>(chain, "pendingRewards", [wallet, 200n]),
            read<bigint>(chain, "balanceOf", [wallet]),
            read<bigint>(chain, "staked", [wallet]),
            read<bigint>(chain, "multiplierOf", [wallet]),
            read<bigint>(chain, "stakeTarget"),
            read<bigint>(chain, "lockRemaining", [wallet]),
            chain.publicClient.getBalance({ address: wallet }),
          ]);
          rewards = {
            unclaimed: formatToken(pending),
            balance: formatToken(balance),
            staked: formatToken(staked),
            multiplier: `${(Number(multiplier) / 1e18).toFixed(2)}x`,
            stakeTarget: formatToken(stakeTarget, 0),
            lockRemainingSeconds: lock.toString(),
          };
          eth = formatEth(native);
        }

        const endsAt = Number(genesis) + Number(epoch + 1n) * Number(epochDuration);
        const secondsLeft = Math.max(0, endsAt - Math.floor(Date.now() / 1000));
        const mining = session.snapshot();

        const data = {
          wallet,
          epoch: epoch.toString(),
          secondsLeftInEpoch: secondsLeft,
          mining: {
            running: mining.running,
            hashrate: mining.hashrate,
            bestScore: mining.bestScore,
            submitsThisEpoch: mining.submitsThisEpoch,
            submitsTotal: mining.submitsTotal,
            lastError: mining.lastError,
          },
          rewards,
          eth,
        };

        const md = [
          `**${mining.running ? "Mining" : "Idle"}** · epoch ${epoch} · ${secondsLeft}s left`,
          wallet ? `Wallet \`${wallet}\`` : "_Read-only: no wallet configured._",
          "",
          mining.running
            ? `Hashrate ${compact(mining.hashrate)}H/s · best score ${mining.bestScore ? compact(Number(mining.bestScore)) : "none yet"} · submits ${mining.submitsThisEpoch}/10 this epoch`
            : "Not mining. Use `nonce_start_mining` to begin.",
          "",
          `Unclaimed **${rewards.unclaimed} NONCE** · wallet ${rewards.balance} · staked ${rewards.staked}`,
          `Multiplier ${rewards.multiplier} (2x at ${rewards.stakeTarget} staked) · ${eth} ETH for fees`,
          mining.lastError ? `\n_Last error: ${mining.lastError}_` : "",
        ].join("\n");

        return reply(response_format, md, data);
      })
  );

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_protocol_info",
    {
      title: "NONCE protocol state",
      description: `Protocol-wide numbers: supply, this epoch's reward, submit fee, tax split, difficulty and protocol-owned liquidity.

Read-only. Use it to judge whether mining is worth it right now, or to explain the token to someone.

Args:
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "chainId": number,
    "token": string,                // contract address
    "epoch": string,
    "supply": { "minted": string, "max": string, "mineable": string, "mintedPct": string },
    "epochReward": string,          // NONCE emitted this epoch, before tax
    "submitFee": string,            // ETH per submission
    "tax": { "devBps": string, "lpBps": string, "minersKeepPct": string },
    "difficultyTarget": string,     // hex; a digest must be at or below it
    "liquidity": { "nonce": string, "eth": string }
  }

Examples:
  - Use when: "what does an epoch pay right now?"
  - Use when: "how much of the supply has been mined?"`,
      inputSchema: { response_format: ResponseFormat },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) =>
      guarded(async () => {
        const [epoch, supply, max, mineable, fee, devBps, lpBps, target, lpNonce, lpEth] =
          await Promise.all([
            read<bigint>(chain, "currentEpoch"),
            read<bigint>(chain, "totalSupply"),
            read<bigint>(chain, "MAX_SUPPLY"),
            read<bigint>(chain, "MINEABLE_SUPPLY"),
            read<bigint>(chain, "submitFee"),
            read<bigint>(chain, "devBps"),
            read<bigint>(chain, "lpBps"),
            read<bigint>(chain, "currentTarget"),
            read<bigint>(chain, "lpNonceAccrued"),
            read<bigint>(chain, "lpEthAccrued"),
          ]);
        const reward = await read<bigint>(chain, "epochReward", [epoch]);

        const mintedPct = (Number((supply * 1_000_000n) / max) / 10_000).toFixed(4);
        const minersKeep = (100 - Number(devBps + lpBps) / 100).toFixed(0);

        const data = {
          chainId: chain.chainId,
          token: chain.address,
          epoch: epoch.toString(),
          supply: {
            minted: formatToken(supply, 0),
            max: formatToken(max, 0),
            mineable: formatToken(mineable, 0),
            mintedPct: `${mintedPct}%`,
          },
          epochReward: formatToken(reward),
          submitFee: formatEth(fee),
          tax: {
            devBps: devBps.toString(),
            lpBps: lpBps.toString(),
            minersKeepPct: `${minersKeep}%`,
          },
          difficultyTarget: `0x${target.toString(16)}`,
          liquidity: { nonce: formatToken(lpNonce, 0), eth: formatEth(lpEth) },
        };

        const md = [
          `**NONCE** \`${chain.address}\` · chain ${chain.chainId} · epoch ${epoch}`,
          "",
          `This epoch pays **${data.epochReward} NONCE** before tax; miners keep ${minersKeep}%.`,
          `Each submission costs ${data.submitFee} ETH.`,
          "",
          `Minted ${data.supply.minted} / ${data.supply.max} (${data.supply.mintedPct}); ${data.supply.mineable} is mineable.`,
          `Protocol liquidity: ${data.liquidity.nonce} NONCE + ${data.liquidity.eth} ETH, owned by the contract.`,
        ].join("\n");

        return reply(response_format, md, data);
      })
  );

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_start_mining",
    {
      title: "Start mining NONCE",
      description: `Start mining in the background with the wallet this server was configured with.

Mining runs until stopped. Each submission costs a small ETH fee on top of gas, so the wallet must hold ETH. Solutions are bound to the wallet address and cannot be used by anyone else.

Args:
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "started": boolean, "alreadyRunning": boolean, "wallet": string, "epoch": string }

Examples:
  - Use when: "mine NONCE for me"
  - Don't use when: you only want to check on an existing session (use nonce_status)

Error Handling:
  - Returns a read-only error if NONCE_PRIVATE_KEY was not set for the server
  - Warns when the wallet holds no ETH, since every submission needs a fee`,
      inputSchema: { response_format: ResponseFormat },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) =>
      guarded(async () => {
        if (!chain.account) throw new NoWalletError("mine");

        const already = session.isRunning();
        const [balance, fee, epoch] = await Promise.all([
          chain.publicClient.getBalance({ address: chain.account }),
          read<bigint>(chain, "submitFee"),
          read<bigint>(chain, "currentEpoch"),
        ]);
        if (balance === 0n) {
          return failure(
            `Wallet ${chain.account} holds no ETH. Every submission costs ${formatEth(fee)} ETH plus gas — fund it before mining.`
          );
        }

        if (!already) await session.start();

        const data = {
          started: !already,
          alreadyRunning: already,
          wallet: chain.account,
          epoch: epoch.toString(),
        };
        const md = already
          ? `Already mining as \`${chain.account}\` (epoch ${epoch}).`
          : `Mining started as \`${chain.account}\` at epoch ${epoch}. Fee ${formatEth(fee)} ETH per submission; balance ${formatEth(balance)} ETH.`;
        return reply(response_format, md, data);
      })
  );

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_stop_mining",
    {
      title: "Stop mining NONCE",
      description: `Stop the background mining session. Already-submitted work still earns; nothing is lost.

Args:
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "stopped": boolean, "wasRunning": boolean, "totalHashes": number, "submitsTotal": number }`,
      inputSchema: { response_format: ResponseFormat },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ response_format }) =>
      guarded(async () => {
        const was = session.isRunning();
        const snap = session.snapshot();
        session.stop();
        const data = {
          stopped: true,
          wasRunning: was,
          totalHashes: snap.totalHashes,
          submitsTotal: snap.submitsTotal,
        };
        const md = was
          ? `Mining stopped after ${compact(snap.totalHashes)} hashes and ${snap.submitsTotal} submissions. Anything already submitted still earns — claim it with \`nonce_claim\`.`
          : "Mining was not running.";
        return reply(response_format, md, data);
      })
  );

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_claim",
    {
      title: "Claim mined NONCE",
      description: `Claim rewards from the wallet's finished epochs. The current epoch is still open and is never claimable.

Sends a transaction and waits for the receipt, so a reverted claim is reported as a failure rather than as success.

Args:
  - max_epochs (number): how many of the wallet's participated epochs to settle in one transaction, 1-500 (default: 200). Lower it if the transaction runs out of gas.
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "claimed": string, "transactionHash": string, "gasUsed": string, "balanceAfter": string }

Error Handling:
  - Returns "nothing to claim" when no finished epoch has an unclaimed reward`,
      inputSchema: {
        max_epochs: z.number().int().min(1).max(500).default(200)
          .describe("How many participated epochs to settle in one transaction"),
        response_format: ResponseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ max_epochs, response_format }) =>
      guarded(async () => {
        if (!chain.account) throw new NoWalletError("claim");

        const pending = await read<bigint>(chain, "pendingRewards", [chain.account, BigInt(max_epochs)]);
        if (pending === 0n) {
          return failure(
            "Nothing to claim. Rewards only become claimable once the epoch you mined in has ended."
          );
        }

        const receipt = await write(chain, "claim", "claim", [BigInt(max_epochs)]);
        if (receipt.status !== "success") {
          return failure(`Claim reverted (tx ${receipt.hash}). Try a smaller max_epochs.`);
        }
        const balance = await read<bigint>(chain, "balanceOf", [chain.account]);

        const data = {
          claimed: formatToken(pending),
          transactionHash: receipt.hash,
          gasUsed: receipt.gasUsed.toString(),
          balanceAfter: formatToken(balance),
        };
        return reply(
          response_format,
          `Claimed **${data.claimed} NONCE**. Balance is now ${data.balanceAfter}.\n\nTransaction \`${receipt.hash}\` (${receipt.gasUsed} gas).`,
          data
        );
      })
  );

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_stake",
    {
      title: "Stake NONCE for the mining multiplier",
      description: `Lock NONCE to multiply mining rewards, linearly up to 2x.

The stake locks for 7 days, and staking again restarts the lock on the whole balance. Check nonce_status for the current stakeTarget — the amount needed for the full 2x — which shrinks as emission does.

Args:
  - amount (string): NONCE to stake, as a decimal string, e.g. "250.5"
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "staked": string, "totalStaked": string, "multiplier": string, "unlocksInSeconds": string, "transactionHash": string }

Error Handling:
  - Returns a balance error if the wallet holds less than the requested amount`,
      inputSchema: {
        amount: z.string().regex(/^\d+(\.\d+)?$/, "Use a decimal string such as \"250.5\"")
          .describe("NONCE to stake, as a decimal string"),
        response_format: ResponseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount, response_format }) =>
      guarded(async () => {
        if (!chain.account) throw new NoWalletError("stake");
        const wei = parseEther(amount);
        const balance = await read<bigint>(chain, "balanceOf", [chain.account]);
        if (wei > balance) {
          return failure(`Wallet holds ${formatToken(balance)} NONCE, less than the ${amount} requested.`);
        }

        const receipt = await write(chain, "stake", "stake", [wei]);
        if (receipt.status !== "success") return failure(`Stake reverted (tx ${receipt.hash}).`);

        const [staked, multiplier, lock] = await Promise.all([
          read<bigint>(chain, "staked", [chain.account]),
          read<bigint>(chain, "multiplierOf", [chain.account]),
          read<bigint>(chain, "lockRemaining", [chain.account]),
        ]);
        const data = {
          staked: amount,
          totalStaked: formatToken(staked),
          multiplier: `${(Number(multiplier) / 1e18).toFixed(2)}x`,
          unlocksInSeconds: lock.toString(),
          transactionHash: receipt.hash,
        };
        return reply(
          response_format,
          `Staked ${amount} NONCE. Total staked ${data.totalStaked}, multiplier now **${data.multiplier}**.\n\nLocked for ${(Number(lock) / 86_400).toFixed(1)} days — topping up restarts the lock on the whole balance.`,
          data
        );
      })
  );

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_unstake",
    {
      title: "Unstake NONCE",
      description: `Withdraw staked NONCE. Only possible once the 7-day lock has expired; nonce_status reports the remaining lock.

Lowering the stake lowers the mining multiplier.

Args:
  - amount (string): NONCE to withdraw, as a decimal string
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "unstaked": string, "totalStaked": string, "multiplier": string, "transactionHash": string }

Error Handling:
  - Returns the remaining lock time if the stake is still locked
  - Returns a balance error if the amount exceeds what is staked`,
      inputSchema: {
        amount: z.string().regex(/^\d+(\.\d+)?$/, "Use a decimal string such as \"250.5\"")
          .describe("NONCE to withdraw, as a decimal string"),
        response_format: ResponseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount, response_format }) =>
      guarded(async () => {
        if (!chain.account) throw new NoWalletError("unstake");
        const wei = parseEther(amount);

        const [staked, lock] = await Promise.all([
          read<bigint>(chain, "staked", [chain.account]),
          read<bigint>(chain, "lockRemaining", [chain.account]),
        ]);
        if (lock > 0n) {
          const hours = (Number(lock) / 3_600).toFixed(1);
          return failure(`Stake is locked for another ${hours} hours. Staking restarts the 7-day lock on the whole balance.`);
        }
        if (wei > staked) {
          return failure(`Only ${formatToken(staked)} NONCE is staked, less than the ${amount} requested.`);
        }

        const receipt = await write(chain, "unstake", "unstake", [wei]);
        if (receipt.status !== "success") return failure(`Unstake reverted (tx ${receipt.hash}).`);

        const [nowStaked, multiplier] = await Promise.all([
          read<bigint>(chain, "staked", [chain.account]),
          read<bigint>(chain, "multiplierOf", [chain.account]),
        ]);
        const data = {
          unstaked: amount,
          totalStaked: formatToken(nowStaked),
          multiplier: `${(Number(multiplier) / 1e18).toFixed(2)}x`,
          transactionHash: receipt.hash,
        };
        return reply(
          response_format,
          `Unstaked ${amount} NONCE. Still staked ${data.totalStaked}, multiplier now ${data.multiplier}.`,
          data
        );
      })
  );

  // -------------------------------------------------------------------
  server.registerTool(
    "nonce_set_strategy",
    {
      title: "Configure the mining submit strategy",
      description: `Tune when the miner spends a fee to submit.

Every submission costs the fee whether or not it improves the wallet's best hash, and the contract allows at most 10 per epoch. The defaults hold the best hash until the epoch is nearly over, then submit once, rerolling early only on a materially better result.

Args:
  - max_submits (number): submissions per epoch, 1-10 (default: 10)
  - reroll_factor (number): submit again only when the new best beats the submitted one by this factor (default: 2)
  - submit_lead_ms (number): send the first submission once the epoch has this many milliseconds left (default: 6000)
  - min_score (string): skip submitting below this score, saving the fee on weak hashes (default: "0")
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  { "maxSubmits": number, "rerollFactor": string, "submitLeadMs": number, "minScore": string }

Examples:
  - Use when: "stop wasting fees on bad hashes" -> raise min_score
  - Use when: "submit only once per epoch" -> max_submits=1`,
      inputSchema: {
        max_submits: z.number().int().min(1).max(10).optional()
          .describe("Submissions per epoch; the contract caps this at 10"),
        reroll_factor: z.number().min(1).max(1000).optional()
          .describe("Resubmit only on an improvement of at least this factor"),
        submit_lead_ms: z.number().int().min(0).max(60_000).optional()
          .describe("Milliseconds before the epoch ends at which to submit"),
        min_score: z.string().regex(/^\d+$/).optional()
          .describe("Minimum score worth paying a fee for, as an integer string"),
        response_format: ResponseFormat,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ max_submits, reroll_factor, submit_lead_ms, min_score, response_format }) =>
      guarded(async () => {
        const next = session.setStrategy({
          ...(max_submits !== undefined ? { maxSubmits: max_submits } : {}),
          ...(reroll_factor !== undefined ? { rerollFactor: BigInt(Math.floor(reroll_factor)) } : {}),
          ...(submit_lead_ms !== undefined ? { submitLeadMs: submit_lead_ms } : {}),
          ...(min_score !== undefined ? { minScore: BigInt(min_score) } : {}),
        });

        const data = {
          maxSubmits: next.maxSubmits,
          rerollFactor: next.rerollFactor.toString(),
          submitLeadMs: next.submitLeadMs,
          minScore: next.minScore.toString(),
        };
        return reply(
          response_format,
          `Strategy set: up to **${data.maxSubmits}** submissions per epoch, rerolling at ${data.rerollFactor}x, submitting ${data.submitLeadMs}ms before the epoch closes, skipping scores below ${data.minScore}.`,
          data
        );
      })
  );

  // -------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    session.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`nonce-mcp-server: ${shortError(err)}\n`);
  process.exit(1);
});

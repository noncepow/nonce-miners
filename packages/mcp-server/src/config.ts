import type { Address, Hex } from "viem";

export const CHARACTER_LIMIT = 25_000;

export type Config = {
  rpcUrl: string;
  nonceAddress: Address;
  /** Absent when the server is running read-only. */
  privateKey?: Hex;
};

export class ConfigError extends Error {}

/**
 * Configuration comes from the environment only.
 *
 * The private key is never accepted as a tool argument and is never included in
 * any response: an agent should be able to drive mining without the key ever
 * passing through a model's context.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpcUrl = env.NONCE_RPC_URL?.trim();
  const nonceAddress = env.NONCE_ADDRESS?.trim();
  const privateKey = env.NONCE_PRIVATE_KEY?.trim();

  if (!rpcUrl) {
    throw new ConfigError(
      "NONCE_RPC_URL is not set. Add it to the server's env block in your MCP client config."
    );
  }
  if (!nonceAddress || !/^0x[0-9a-fA-F]{40}$/.test(nonceAddress)) {
    throw new ConfigError(
      "NONCE_ADDRESS is missing or not a valid address. Set it to the deployed NONCE token."
    );
  }
  if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new ConfigError("NONCE_PRIVATE_KEY is set but is not a 32-byte hex key.");
  }

  return {
    rpcUrl,
    nonceAddress: nonceAddress as Address,
    privateKey: privateKey as Hex | undefined,
  };
}

/** Thrown by tools that need a wallet when the server was started without one. */
export class NoWalletError extends Error {
  constructor(action: string) {
    super(
      `This server is running read-only, so it cannot ${action}. ` +
        `Set NONCE_PRIVATE_KEY in the server's env block and restart the MCP client.`
    );
  }
}

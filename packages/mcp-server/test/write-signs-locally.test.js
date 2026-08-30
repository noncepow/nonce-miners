// The write path must sign locally and broadcast a raw transaction.
//
// Handing viem a bare address instead of the signing account makes it treat the
// account as one the *node* manages, so it calls eth_sendTransaction. The RPC
// holds no key, so every write — claim, stake, unstake, and submitting a mined
// solution — failed before it was ever broadcast. Nothing moved on chain and the
// error surfaced as an opaque "JSON is not a valid request object", which reads
// like a malformed request rather than a wallet misconfiguration.
//
// A live chain cannot catch this cheaply, so the test stands up a fake JSON-RPC
// endpoint and asserts on the method that comes out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { connect, write } from "../dist/chain.js";

// Anvil's first well-known development key. Never used for anything real.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// A fixture, not a deployment: this test answers its own RPC, so the address
// only has to be well-formed. A real one here would go stale and send people
// looking for a contract that is not there.
// All lower case: viem validates the checksum of any mixed-case address.
const NONCE_ADDRESS = "0x00000000000000000000000000000000000cafe1";

/** Records every JSON-RPC method it is asked for and answers plausibly. */
function fakeRpc() {
  const methods = [];
  const receipt = {
    transactionHash: "0x" + "11".repeat(32),
    blockNumber: "0x1",
    blockHash: "0x" + "22".repeat(32),
    transactionIndex: "0x0",
    from: "0x" + "33".repeat(20),
    to: NONCE_ADDRESS,
    gasUsed: "0x5208",
    cumulativeGasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    status: "0x1",
    logs: [],
    logsBloom: "0x" + "00".repeat(256),
    type: "0x2",
    contractAddress: null,
  };
  const answers = {
    eth_chainId: "0x1237", // 4663
    eth_getTransactionCount: "0x0",
    eth_gasPrice: "0x3b9aca00",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_estimateGas: "0x186a0",
    eth_blockNumber: "0x1",
    eth_sendRawTransaction: receipt.transactionHash,
    eth_getTransactionReceipt: receipt,
    eth_call: "0x",
    eth_getBlockByNumber: {
      number: "0x1", hash: receipt.blockHash, parentHash: "0x" + "00".repeat(32),
      timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x5208",
      baseFeePerGas: "0x3b9aca00", miner: "0x" + "44".repeat(20),
      transactions: [], nonce: "0x0000000000000000", difficulty: "0x0",
      totalDifficulty: "0x0", extraData: "0x", size: "0x0",
      sha3Uncles: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32),
      transactionsRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32),
      logsBloom: "0x" + "00".repeat(256), uncles: [], mixHash: "0x" + "00".repeat(32),
    },
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const one = (m) => {
        methods.push(m.method);
        const result = answers[m.method];
        return result === undefined
          ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unstubbed ${m.method}` } }
          : { jsonrpc: "2.0", id: m.id, result };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });

  return { server, methods };
}

test("a write signs locally rather than asking the node to sign", async () => {
  const { server, methods } = fakeRpc();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const chain = await connect({
      rpcUrl: url,
      nonceAddress: NONCE_ADDRESS,
      privateKey: TEST_KEY,
    });

    const result = await write(chain, "stake", "stake", [1n]);
    assert.equal(result.status, "success");

    assert.ok(
      methods.includes("eth_sendRawTransaction"),
      "the transaction must be signed locally and sent as a raw transaction"
    );
    assert.ok(
      !methods.includes("eth_sendTransaction"),
      "eth_sendTransaction asks the node to sign, and the node holds no key"
    );
  } finally {
    server.close();
  }
});

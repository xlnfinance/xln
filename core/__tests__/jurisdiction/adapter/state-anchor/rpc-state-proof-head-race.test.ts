import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { ethers } from 'ethers';

import {
  readVerifiedGetProof,
  verifyGetProofResponse,
  type GetProofResponse,
} from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-state-proof';
import { safeStringify } from '../../../../protocol/serialization';

// Anvil's with_database_at reads its best number, then waits for the state
// lock. eth_getProof for the head, issued while the next block executes, is
// answered from that next block's state: a consistent trie under a different
// root. In the E2E stack that was the MM watcher's startup audit at the head
// (STATE_PROOF_NODE_HASH_MISMATCH at verifyCanonicalState:29:29) whenever
// another child mined a block at that moment.

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });

// Runtime JUMPDEST PUSH1 0 JUMP: every call burns its whole gas limit, so the
// block that includes it holds Anvil's state write lock for a measurable time.
const GAS_BURNER_INIT_CODE = '0x6004600c60003960046000f35b600056';
const BURN_GAS = ethers.toQuantity(50_000_000);

let anvil: ChildProcess | null = null;
let rpcUrl = '';
let sender = '';
let burner = '';

// Plain fetch, so no client-side batching or caching can reorder the race.
const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeStringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(safeStringify(body.error));
  return body.result;
};

const head = async (): Promise<{ number: number; stateRoot: string }> => {
  const number = Number(await rpc('eth_blockNumber'));
  const header = (await rpc('eth_getBlockByNumber', [ethers.toQuantity(number), false])) as { stateRoot: string };
  return { number, stateRoot: header.stateRoot };
};

// Automine may answer eth_sendTransaction before the block is stored.
const waitForReceipt = async (hash: unknown): Promise<{ contractAddress?: string | null }> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt as { contractAddress?: string | null };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`RECEIPT_TIMEOUT:${String(hash)}`);
};

// Starts mining head+1 with a gas-burning tx; resolves once that block is stored.
const mineNextBlockSlowly = async (): Promise<void> => {
  await waitForReceipt(await rpc('eth_sendTransaction', [{ from: sender, to: burner, gas: BURN_GAS }]));
};

const outcome = (run: () => unknown): string => {
  try {
    run();
    return 'OK';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

beforeAll(async () => {
  const port = await reservePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31338',
    '--block-gas-limit', '60000000', '--prune-history', '8192', '--silent',
  ], { stdio: 'ignore' });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rpc('eth_blockNumber');
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  [sender] = (await rpc('eth_accounts')) as string[];
  const deployHash = await rpc('eth_sendTransaction', [{ from: sender, data: GAS_BURNER_INIT_CODE }]);
  burner = String((await waitForReceipt(deployHash)).contractAddress);
}, 30_000);

afterAll(() => {
  anvil?.kill('SIGKILL');
});

describe('eth_getProof for the head while Anvil mines the next block', () => {
  test('a raw read proves the next block state, and readVerifiedGetProof still binds to the requested root', async () => {
    // Rounds until the raw read races at least once; the cap bounds a node
    // that never races (then the fixture proves nothing and the test fails).
    let rawRaced = 0;
    for (let round = 0; round < 10 && rawRaced === 0; round += 1) {
      const before = await head();
      const mining = mineNextBlockSlowly();
      await new Promise(resolve => setTimeout(resolve, 5));
      const raw = (await rpc('eth_getProof', [sender, [], ethers.toQuantity(before.number)])) as GetProofResponse;
      await mining;
      const after = await head();
      expect(after.number).toBe(before.number + 1);
      const rawOutcome = outcome(() => verifyGetProofResponse(before.stateRoot, sender, [], raw));
      if (rawOutcome !== 'OK') {
        expect(rawOutcome).toBe('STATE_PROOF_NODE_HASH_MISMATCH');
        // Provenance, not just mismatch: the answer is exactly block N+1's state.
        const served = verifyGetProofResponse(after.stateRoot, sender, [], raw);
        const nonceAfter = BigInt(String(await rpc('eth_getTransactionCount', [sender, ethers.toQuantity(after.number)])));
        expect(served.account?.nonce).toBe(nonceAfter);
        rawRaced += 1;
      }

      // Same race through the reader: it must answer for the requested height.
      const target = await head();
      const racing = mineNextBlockSlowly();
      await new Promise(resolve => setTimeout(resolve, 5));
      const proven = await readVerifiedGetProof(rpc, target.stateRoot, sender, [], target.number);
      await racing;
      expect(Number(await rpc('eth_blockNumber'))).toBe(target.number + 1);
      const expectedNonce = BigInt(String(await rpc('eth_getTransactionCount', [sender, ethers.toQuantity(target.number)])));
      expect(proven.account?.nonce).toBe(expectedNonce);
    }
    // The fixture must actually exercise the race, or the reader assertion proves nothing.
    expect(rawRaced).toBeGreaterThan(0);
  }, 60_000);
});

describe('readVerifiedGetProof re-requests only a response for another root', () => {
  test('a wrong-root response is re-requested; a persistent one is rejected', async () => {
    const at = await head();
    const genuine = (await rpc('eth_getProof', [sender, [], ethers.toQuantity(at.number)])) as GetProofResponse;
    await waitForReceipt(await rpc('eth_sendTransaction', [{ from: sender, to: burner, gas: ethers.toQuantity(30_000) }]));
    const next = (await rpc('eth_getProof', [sender, [], ethers.toQuantity(at.number + 1)])) as GetProofResponse;
    const nextRoot = ((await rpc('eth_getBlockByNumber', [ethers.toQuantity(at.number + 1), false])) as { stateRoot: string }).stateRoot;
    // The mined tx bumps the sender nonce, so the two heights prove different roots.
    expect(nextRoot.toLowerCase()).not.toBe(at.stateRoot.toLowerCase());

    const scripted = (responses: GetProofResponse[]) => {
      const calls: unknown[][] = [];
      const send = async (method: string, params: unknown[]): Promise<unknown> => {
        expect(method).toBe('eth_getProof');
        calls.push(params);
        return responses[Math.min(calls.length, responses.length) - 1];
      };
      return { send, calls };
    };

    const once = scripted([genuine]);
    expect((await readVerifiedGetProof(once.send, at.stateRoot, sender, [], at.number)).account?.nonce)
      .toBe(BigInt(String(genuine.nonce)));
    expect(once.calls).toEqual([[sender, [], ethers.toQuantity(at.number)]]);

    const raced = scripted([next, genuine]);
    expect((await readVerifiedGetProof(raced.send, at.stateRoot, sender, [], at.number)).account?.nonce)
      .toBe(BigInt(String(genuine.nonce)));
    expect(raced.calls.length).toBe(2);

    const racedTwice = scripted([next, next, genuine]);
    expect((await readVerifiedGetProof(racedTwice.send, at.stateRoot, sender, [], at.number)).account?.nonce)
      .toBe(BigInt(String(genuine.nonce)));
    expect(racedTwice.calls.length).toBe(3);

    const persistent = scripted([next]);
    await expect(readVerifiedGetProof(persistent.send, at.stateRoot, sender, [], at.number))
      .rejects.toThrow('STATE_PROOF_NODE_HASH_MISMATCH');
    expect(persistent.calls.length).toBe(3);
  }, 30_000);
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

import {
  assertCanonicalReceiptsRoot,
  bloomMayContain,
  computeCanonicalReceiptsRoot,
  createCanonicalReceiptProofs,
  encodeCanonicalRpcReceipt,
  readAuthenticatedReceiptRange,
  readAuthenticatedLogsForRange,
  verifyCanonicalReceiptProof,
  type CanonicalRpcReceipt,
} from '../jadapter/receipt-root';
import { isTransientRpcUnavailableError } from '../jadapter/rpc';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types';

const zeroBloom = `0x${'00'.repeat(256)}`;

// Independently captured from Anvil 1.4.0 for one EIP-1559 value transfer:
// status=1, cumulativeGasUsed=21000, no logs, transactionIndex=0.
const transferReceipt: CanonicalRpcReceipt = {
  type: '0x2',
  status: '0x1',
  cumulativeGasUsed: '0x5208',
  logsBloom: zeroBloom,
  logs: [],
  transactionIndex: '0x0',
};
const transferReceiptsRoot = '0xf78dfb743fbd92ade140711c8bbc542b5e307f0ab7984eff35d751969fe57efa';

// Independently captured Base mainnet block 10,000,024 (Canyon): one OP
// deposit receipt followed by one legacy receipt.
const baseCanyonReceipts = [
  {
    type: '0x7e',
    status: '0x1',
    cumulativeGasUsed: '0xb735',
    logsBloom: zeroBloom,
    logs: [],
    transactionIndex: '0x0',
    depositNonce: '0x989697',
    depositReceiptVersion: '0x1',
  },
  {
    type: '0x0',
    status: '0x1',
    cumulativeGasUsed: '0x401fb',
    logsBloom: '0x00000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000020000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000020000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    logs: [{
      address: '0x8b97e18ee706d056a5659947a717a7971003f524',
      topics: ['0x37781b10bddad6ff263a2ee57a9ff2272d2bb748635c8bcf9d109de0fce4d45d'],
      data: '0x00000000000000000000000000000000000000000000000000000000000013d7000000000000000000000000000000000002f832d96f8bff63cb6b18a000000000000000000000000000000000000000000819d6c93183b7fd3c01e674aef724',
    }],
    transactionIndex: '0x1',
  },
] as Array<CanonicalRpcReceipt & { depositNonce?: string; depositReceiptVersion?: string }>;
const baseCanyonReceiptsRoot = '0x33e5bcb90f149989124d9e02d6aa4d949da3b51a12c77434bcd2144b764beb82';

const erc20DeployBloom = '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000040020000000000000100000800000000000000000000000010000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000042000000200000000000000000000000002000000000000000000020000000000000000000000000000000000000000000000000000000000000000000';

const anvilPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
let anvil: ChildProcessWithoutNullStreams | undefined;
let anvilRoot = '';
let provider: ethers.JsonRpcProvider;

const reservePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('J_RECEIPT_TEST_PORT_MISSING'));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

beforeAll(async () => {
  const port = await reservePort();
  anvilRoot = await mkdtemp(join(tmpdir(), 'xln-receipt-root-'));
  anvil = spawn('anvil', [
    '--port', String(port),
    '--chain-id', '31337',
    '--silent',
    '--state', join(anvilRoot, 'state.json'),
  ], { env: { ...process.env, TMPDIR: anvilRoot } });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (response.ok) {
        provider = new ethers.JsonRpcProvider(rpcUrl, 31337, { cacheTimeout: -1, batchMaxCount: 1 });
        return;
      }
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error('J_RECEIPT_TEST_ANVIL_START_TIMEOUT');
});

afterAll(async () => {
  await provider?.destroy();
  if (anvil && anvil.exitCode === null) {
    const exited = new Promise<void>((resolve) => anvil!.once('exit', () => resolve()));
    anvil.kill('SIGTERM');
    await Promise.race([exited, Bun.sleep(2_000)]);
    if (anvil.exitCode === null) anvil.kill('SIGKILL');
  }
  if (anvilRoot) await rm(anvilRoot, { recursive: true, force: true });
});

describe('authenticated J watcher receipts', () => {
  test('rejects a mixed-fork range at the exact post-receipt header fence', async () => {
    const block = (number: number, hash: string, parentHash: string) => ({
      number: ethers.toQuantity(number),
      hash,
      parentHash,
      receiptsRoot: `0x${'00'.repeat(32)}`,
      logsBloom: zeroBloom,
      transactions: [],
    });
    const forkA = new Map([
      [1, block(1, `0x${'11'.repeat(32)}`, `0x${'00'.repeat(32)}`)],
      [2, block(2, `0x${'22'.repeat(32)}`, `0x${'11'.repeat(32)}`)],
    ]);
    const forkB = new Map([
      [1, block(1, `0x${'33'.repeat(32)}`, `0x${'00'.repeat(32)}`)],
      [2, block(2, `0x${'44'.repeat(32)}`, `0x${'33'.repeat(32)}`)],
    ]);
    const reads = new Map<number, number>();
    const send = async (method: string, params: unknown[]): Promise<unknown> => {
      expect(method).toBe('eth_getBlockByNumber');
      const height = Number(BigInt(String(params[0])));
      const count = (reads.get(height) ?? 0) + 1;
      reads.set(height, count);
      return structuredClone((count === 1 ? forkA : forkB).get(height));
    };

    const mixedFork = readAuthenticatedReceiptRange(
      send,
      2,
      2,
      ['0x000000000000000000000000000000000000dEaD'],
    );
    await expect(mixedFork).rejects.toThrow('J_RECEIPT_RANGE_REORG');
    await mixedFork.catch((error) => expect(isTransientRpcUnavailableError(error)).toBe(true));
  });

  test('retries an unfinalized parent reorg but fails closed on a certified parent', async () => {
    const blocks = new Map([
      [1, {
        number: '0x1',
        hash: `0x${'11'.repeat(32)}`,
        parentHash: `0x${'00'.repeat(32)}`,
        receiptsRoot: `0x${'00'.repeat(32)}`,
        logsBloom: zeroBloom,
        transactions: [],
      }],
      [2, {
        number: '0x2',
        hash: `0x${'22'.repeat(32)}`,
        parentHash: `0x${'11'.repeat(32)}`,
        receiptsRoot: `0x${'00'.repeat(32)}`,
        logsBloom: zeroBloom,
        transactions: [],
      }],
    ]);
    const send = async (_method: string, params: unknown[]): Promise<unknown> => (
      structuredClone(blocks.get(Number(BigInt(String(params[0])))))
    );
    const read = (finalized: boolean) => readAuthenticatedReceiptRange(
      send,
      2,
      2,
      ['0x000000000000000000000000000000000000dEaD'],
      {
        expectedParent: {
          height: 1,
          hash: `0x${'99'.repeat(32)}`,
          finalized,
        },
      },
    );

    const unfinalized = read(false);
    await expect(unfinalized).rejects.toThrow('J_RECEIPT_RANGE_REORG');
    await unfinalized.catch((error) => expect(isTransientRpcUnavailableError(error)).toBe(true));
    const certified = read(true);
    await expect(certified).rejects.toThrow('J_RECEIPT_FINALIZED_PARENT_REORG');
    await certified.catch((error) => expect(isTransientRpcUnavailableError(error)).toBe(false));
  });

  test('matches the independently captured EIP-2718 receipt-trie root', async () => {
    expect(await computeCanonicalReceiptsRoot([transferReceipt])).toBe(transferReceiptsRoot);
    await expect(assertCanonicalReceiptsRoot([transferReceipt], transferReceiptsRoot)).resolves.toBeUndefined();
  });

  test('proves the independently captured receipt and rejects value/root tampering', async () => {
    const proof = (await createCanonicalReceiptProofs([transferReceipt], transferReceiptsRoot)).get(0);
    if (!proof) throw new Error('J_RECEIPT_TEST_PROOF_MISSING');
    await expect(verifyCanonicalReceiptProof(proof)).resolves.toBeUndefined();
    await expect(verifyCanonicalReceiptProof({
      ...proof,
      encodedReceipt: `${proof.encodedReceipt.slice(0, -2)}00`,
    })).rejects.toThrow('J_RECEIPT_PROOF_VALUE_MISMATCH');
    await expect(verifyCanonicalReceiptProof({
      ...proof,
      receiptsRoot: `0x${'11'.repeat(32)}`,
    })).rejects.toThrow();
  });

  test('matches independently captured Base Canyon deposit receipts', async () => {
    expect(await computeCanonicalReceiptsRoot(baseCanyonReceipts)).toBe(baseCanyonReceiptsRoot);
  });

  test('rejects malformed OP deposit receipt extensions', async () => {
    await expect(encodeCanonicalRpcReceipt({
      ...transferReceipt,
      type: '0x7e',
      depositReceiptVersion: '0x1',
    })).rejects.toThrow('J_RECEIPT_DEPOSIT_VERSION_WITHOUT_NONCE');
    await expect(encodeCanonicalRpcReceipt({
      ...transferReceipt,
      depositNonce: '0x1',
    })).rejects.toThrow('J_RECEIPT_DEPOSIT_FIELDS_ON_WRONG_TYPE');
    await expect(encodeCanonicalRpcReceipt({
      ...transferReceipt,
      type: '0x7e',
      depositNonce: '0x1',
      depositReceiptVersion: '0x2',
    })).rejects.toThrow('J_RECEIPT_DEPOSIT_VERSION_INVALID');
  });

  test('rejects missing receipt quantities instead of coercing them to zero', async () => {
    await expect(encodeCanonicalRpcReceipt({
      ...transferReceipt,
      cumulativeGasUsed: undefined as unknown as string,
    })).rejects.toThrow('J_RECEIPT_CUMULATIVE_GAS_QUANTITY_INVALID');
    await expect(encodeCanonicalRpcReceipt({
      ...transferReceipt,
      status: null as unknown as string,
    })).rejects.toThrow('J_RECEIPT_STATUS_QUANTITY_INVALID');
    await expect(computeCanonicalReceiptsRoot([{
      ...transferReceipt,
      transactionIndex: '' as unknown as string,
    }])).rejects.toThrow('J_RECEIPT_TRANSACTION_INDEX_QUANTITY_INVALID');
  });

  test('fails closed on omitted or reordered receipts', async () => {
    await expect(assertCanonicalReceiptsRoot([], transferReceiptsRoot))
      .rejects.toThrow('J_RECEIPT_ROOT_MISMATCH');
    await expect(computeCanonicalReceiptsRoot([
      { ...transferReceipt, transactionIndex: '0x1' },
    ])).rejects.toThrow('J_RECEIPT_TRANSACTION_INDEX_GAP');
  });

  test('fails closed when an RPC omits a log from an otherwise complete receipt set', async () => {
    await expect(assertCanonicalReceiptsRoot([
      baseCanyonReceipts[0]!,
      { ...baseCanyonReceipts[1]!, logs: [] },
    ], baseCanyonReceiptsRoot)).rejects.toThrow('J_RECEIPT_ROOT_MISMATCH');
  });

  test('uses block bloom only as a no-false-negative receipt-fetch prefilter', () => {
    expect(bloomMayContain(erc20DeployBloom, '0x5fbdb2315678afecb367f032d93f642f64180aa3')).toBe(true);
    expect(bloomMayContain(erc20DeployBloom, '0x000000000000000000000000000000000000dead')).toBe(false);
  });

  test('reconstructs real Anvil logs without trusting eth_getLogs', async () => {
    const wallet = new ethers.Wallet(anvilPrivateKey, provider);
    const token = await new ERC20Mock__factory(wallet).deploy('Receipt Token', 'RCT', 18, 1000n);
    const deploymentReceipt = await token.deploymentTransaction()?.wait();
    if (!deploymentReceipt) throw new Error('J_RECEIPT_TEST_DEPLOYMENT_RECEIPT_MISSING');
    const methods: string[] = [];
    const logs = await readAuthenticatedLogsForRange(
      async (method, params) => {
        methods.push(method);
        const result = await provider.send(method, params);
        if (method !== 'eth_getTransactionReceipt') return result;
        const receipt = structuredClone(result) as { logs?: Array<Record<string, unknown>> };
        for (const log of receipt.logs ?? []) {
          // logIndex is RPC metadata, not part of the receipt trie. A malicious
          // endpoint can forge it while still returning a valid receiptsRoot.
          log.logIndex = '0x3e7';
          log.index = '0x3e7';
        }
        return receipt;
      },
      deploymentReceipt.blockNumber,
      deploymentReceipt.blockNumber,
      [await token.getAddress()],
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.index).toBe(0);
    expect(logs[0]?.address.toLowerCase()).toBe((await token.getAddress()).toLowerCase());
    expect(logs[0]?.topics[0]).toBe(ethers.id('Transfer(address,address,uint256)'));
    expect(methods).toContain('eth_getBlockByNumber');
    expect(methods).toContain('eth_getTransactionReceipt');
    expect(methods).not.toContain('eth_getLogs');
  }, 20_000);

  test('cross-checks complete receipts on Tron-compatible zero-root blocks', async () => {
    const wallet = new ethers.Wallet(anvilPrivateKey, provider);
    const token = await new ERC20Mock__factory(wallet).deploy('Tron Receipt Token', 'TRT', 18, 1000n);
    const deploymentReceipt = await token.deploymentTransaction()?.wait();
    if (!deploymentReceipt) throw new Error('J_RECEIPT_TEST_TRON_DEPLOYMENT_RECEIPT_MISSING');
    const methods: string[] = [];
    const send = async (method: string, params: unknown[]): Promise<unknown> => {
      methods.push(method);
      if (method === 'eth_getBlockReceipts') {
        const block = await provider.send('eth_getBlockByNumber', [params[0], false]) as { transactions: string[] };
        return await Promise.all(block.transactions.map(async (hash) => {
          const receipt = structuredClone(await provider.send('eth_getTransactionReceipt', [hash]));
          receipt.logsBloom = zeroBloom;
          return receipt;
        }));
      }
      const result = await provider.send(method, params);
      if (method !== 'eth_getBlockByNumber') return result;
      return { ...structuredClone(result), receiptsRoot: `0x${'00'.repeat(32)}`, logsBloom: zeroBloom };
    };
    const logs = await readAuthenticatedLogsForRange(
      send,
      deploymentReceipt.blockNumber,
      deploymentReceipt.blockNumber,
      [await token.getAddress()],
      { commitment: 'tron-complete-receipts' },
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.index).toBe(0);
    expect(methods).toContain('eth_getBlockReceipts');
    expect(methods).toContain('eth_getLogs');
    expect(methods).not.toContain('eth_getTransactionReceipt');
  }, 20_000);

  test('halts when Tron receipt and log views disagree', async () => {
    const wallet = new ethers.Wallet(anvilPrivateKey, provider);
    const token = await new ERC20Mock__factory(wallet).deploy('Tron Omission Token', 'TOT', 18, 1000n);
    const deploymentReceipt = await token.deploymentTransaction()?.wait();
    if (!deploymentReceipt) throw new Error('J_RECEIPT_TEST_TRON_OMISSION_RECEIPT_MISSING');
    const send = async (method: string, params: unknown[]): Promise<unknown> => {
      if (method === 'eth_getBlockReceipts') {
        const block = await provider.send('eth_getBlockByNumber', [params[0], false]) as { transactions: string[] };
        return await Promise.all(block.transactions.map(async (hash) => {
          const receipt = structuredClone(await provider.send('eth_getTransactionReceipt', [hash]));
          receipt.logs = [];
          receipt.logsBloom = zeroBloom;
          return receipt;
        }));
      }
      const result = await provider.send(method, params);
      if (method !== 'eth_getBlockByNumber') return result;
      return { ...structuredClone(result), receiptsRoot: `0x${'00'.repeat(32)}`, logsBloom: zeroBloom };
    };

    await expect(readAuthenticatedLogsForRange(
      send,
      deploymentReceipt.blockNumber,
      deploymentReceipt.blockNumber,
      [await token.getAddress()],
      { commitment: 'tron-complete-receipts' },
    )).rejects.toThrow('J_RECEIPT_TRON_LOG_CROSSCHECK_MISMATCH');
  }, 20_000);
});

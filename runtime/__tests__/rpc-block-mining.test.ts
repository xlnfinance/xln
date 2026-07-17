import { describe, expect, test } from 'bun:test';
import { mineRpcToBlockExact } from '../scenarios/rpc-block-mining';

type FakeProvider = {
  block: bigint;
  calls: Array<{ method: string; params: unknown[] }>;
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

const createProvider = (startBlock: bigint, unsupported = new Set<string>()): FakeProvider => {
  const provider: FakeProvider = {
    block: startBlock,
    calls: [],
    async send(method, params) {
      provider.calls.push({ method, params });
      if (method === 'eth_blockNumber') return `0x${provider.block.toString(16)}`;
      if (unsupported.has(method)) throw new Error(`unsupported:${method}`);
      if (method !== 'anvil_mine' && method !== 'hardhat_mine') throw new Error(`unexpected:${method}`);
      const quantity = params[0];
      if (typeof quantity !== 'string') throw new Error('quantity must be hex');
      provider.block += BigInt(quantity);
      return null;
    },
  };
  return provider;
};

describe('exact RPC batch mining', () => {
  test('mines the exact contiguous block count in one Anvil call', async () => {
    const provider = createProvider(10n);
    const result = await mineRpcToBlockExact(provider, 5_770n);

    expect(result).toEqual({
      startBlock: 10n,
      finalBlock: 5_770n,
      minedBlocks: 5_760n,
      method: 'anvil_mine',
    });
    expect(provider.calls.filter(({ method }) => method === 'anvil_mine')).toEqual([
      { method: 'anvil_mine', params: ['0x1680'] },
    ]);
  });

  test('uses a supported batch method only after an unsupported method leaves height unchanged', async () => {
    const provider = createProvider(5n, new Set(['anvil_mine']));
    const result = await mineRpcToBlockExact(provider, 9n);
    expect(result.method).toBe('hardhat_mine');
    expect(result.minedBlocks).toBe(4n);
    expect(provider.block).toBe(9n);
  });

  test('does not mine when the deadline is already satisfied', async () => {
    const provider = createProvider(12n);
    const result = await mineRpcToBlockExact(provider, 10n);
    expect(result.minedBlocks).toBe(0n);
    expect(result.finalBlock).toBe(12n);
    expect(provider.calls.map(({ method }) => method)).toEqual(['eth_blockNumber']);
  });

  test('fails loudly when a batch miner advances the wrong number of blocks', async () => {
    const provider = createProvider(10n);
    const originalSend = provider.send;
    provider.send = async (method, params) => {
      if (method === 'anvil_mine') {
        provider.calls.push({ method, params });
        provider.block += 1n;
        return null;
      }
      return originalSend(method, params);
    };

    await expect(mineRpcToBlockExact(provider, 20n)).rejects.toThrow(
      'RPC_BATCH_MINE_COUNT_MISMATCH:anvil_mine:start=10:requested=10:final=11:target=20',
    );
  });
});

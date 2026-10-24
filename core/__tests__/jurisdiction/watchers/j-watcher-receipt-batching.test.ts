import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { BLOCKCHAIN } from '../../../config/constants';

import { readAuthenticatedReceiptRange, type RpcBatchCall } from '../../../jurisdiction/adapter/receipt-root';
import { sendBatchInChunks } from '../../../jurisdiction/adapter/rpc-utils';

const zeroBloom = `0x${'00'.repeat(256)}`;
const hashFor = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;

const blockFor = (height: number) => ({
  number: ethers.toQuantity(height),
  hash: hashFor(height),
  parentHash: height === 1 ? `0x${'00'.repeat(32)}` : hashFor(height - 1),
  receiptsRoot: `0x${'00'.repeat(32)}`,
  logsBloom: zeroBloom,
  transactions: [],
});

describe('authenticated J watcher RPC batching', () => {
  test.each([false, true])(
    'validates the complete fence bloom after per-pass normalization: malformed=%s',
    async malformed => {
      let pass = 0;
      const result = readAuthenticatedReceiptRange(
        async () => {
          throw new Error('EMPTY_BLOOMS_REQUIRE_NO_RECEIPTS');
        },
        2,
        3,
        ['0x000000000000000000000000000000000000dEaD'],
        {},
        async calls => {
          pass += 1;
          return calls.map(call => {
            const block = blockFor(Number(BigInt(String(call.params[0]))));
            // Normalization is local to each observation. Matching parent/hash
            // bytes never permit a malformed bloom in the second observation.
            block.hash = `  0x${block.hash.slice(2).toUpperCase()}  `;
            block.parentHash = `0x${block.parentHash.slice(2).toUpperCase()}`;
            if (malformed && pass === 2 && block.number === '0x2') block.logsBloom = '0xgg';
            return block;
          });
        },
      );
      if (malformed) await expect(result).rejects.toThrow('J_RECEIPT_BLOOM_HEX_INVALID');
      else
        expect((await result).headers).toEqual(
          [2, 3].map(jHeight => ({
            jHeight,
            jBlockHash: hashFor(jHeight),
            parentHash: hashFor(jHeight - 1),
          })),
        );
      expect(pass).toBe(2);
    },
  );

  test('rejects an interior change across waves even when both endpoints and parent links agree', async () => {
    const rangeSize = BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL;
    const interior = Math.floor(rangeSize / 2);
    let requested = 0;
    const sendBatch = async (calls: readonly RpcBatchCall[]): Promise<unknown[]> => {
      const fence = requested >= rangeSize + 1;
      requested += calls.length;
      return calls.map(call => {
        const height = Number(BigInt(String(call.params[0])));
        const block = blockFor(height);
        // An untrusted RPC can claim unchanged endpoints while changing an
        // interior hash and its child's parent. Both complete observations
        // must still agree; parent continuity alone cannot authenticate this.
        if (fence && height === interior) block.hash = hashFor(rangeSize + 100);
        if (fence && height === interior + 1) block.parentHash = hashFor(rangeSize + 100);
        return block;
      });
    };
    await expect(
      readAuthenticatedReceiptRange(
        async () => {
          throw new Error('EMPTY_BLOOMS_REQUIRE_NO_RECEIPTS');
        },
        2,
        rangeSize + 1,
        ['0x000000000000000000000000000000000000dEaD'],
        {},
        sendBatch,
      ),
    ).rejects.toThrow(`J_RECEIPT_RANGE_REORG:height=${interior}:`);
    expect(requested).toBe(2 * (rangeSize + 1));
  });

  test.each([2, 4, 8] as const)(
    'overlaps at most %i chunks while preserving requested header order',
    async concurrency => {
      const calls = Array.from({ length: concurrency * 128 + 1 }, (_, height) => ({
        method: 'eth_getBlockByNumber',
        params: [height],
      }));
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const replenished = Promise.withResolvers<void>();
      let active = 0;
      let peak = 0;
      const starts: number[] = [];
      const pending = sendBatchInChunks(
        async chunk => {
          const start = Number(chunk[0]!.params[0]);
          starts.push(start);
          peak = Math.max(peak, ++active);
          if (starts.length === concurrency) entered.resolve();
          if (start === concurrency * 128) replenished.resolve();
          if (start === 0) await first.promise;
          if (start === 128) await second.promise;
          await Promise.resolve();
          active--;
          return chunk.map(call => call.params[0]);
        },
        calls,
        concurrency,
      );
      await entered.promise;
      second.resolve();
      await replenished.promise;
      // A slow first request must not leave the other bounded slots idle.
      expect(starts).toEqual(Array.from({ length: concurrency + 1 }, (_, index) => index * 128));
      first.resolve();
      expect(await pending).toEqual(calls.map(call => call.params[0]));
      expect(starts).toEqual(Array.from({ length: concurrency + 1 }, (_, index) => index * 128));
      expect(peak).toBe(concurrency);
      expect(active).toBe(0);
    },
  );

  test.each([2, 4, 8] as const)(
    'drains all %i in-flight chunks before rejecting without launching later chunks',
    async concurrency => {
      const calls = Array.from({ length: concurrency * 128 + 1 }, (_, height) => ({
        method: 'eth_getBlockByNumber',
        params: [height],
      }));
      const sibling = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const failure = new Error('J_RECEIPT_RANGE_REORG');
      const starts: number[] = [];
      let rejected = false;
      const pending = sendBatchInChunks(
        async chunk => {
          const start = Number(chunk[0]!.params[0]);
          starts.push(start);
          if (start === 0) throw failure;
          entered.resolve();
          await sibling.promise;
          return chunk.map(call => call.params[0]);
        },
        calls,
        concurrency,
      ).catch(error => {
        rejected = true;
        return error;
      });
      await entered.promise;
      await Promise.resolve();
      expect(rejected).toBe(false);
      sibling.resolve();
      expect(await pending).toBe(failure);
      expect(starts).toEqual(Array.from({ length: concurrency }, (_, index) => index * 128));
    },
  );

  test('reports the first failed input chunk after draining out-of-order failures', async () => {
    const first = Promise.withResolvers<unknown[]>();
    const second = Promise.withResolvers<unknown[]>();
    const started: number[] = [];
    const earlier = new Error('EARLIER_INPUT_FAILURE');
    const later = new Error('LATER_INPUT_FAILURE');
    const calls = Array.from({ length: 385 }, (_, height) => ({ method: 'eth_getBlockByNumber', params: [height] }));
    let settled = false;
    const pending = sendBatchInChunks(
      chunk => {
        const height = Number(chunk[0]!.params[0]);
        started.push(height);
        return height === 0 ? first.promise : second.promise;
      },
      calls,
      2,
    ).catch(error => {
      settled = true;
      return error;
    });
    second.reject(later);
    await Promise.resolve();
    expect(settled).toBe(false);
    first.reject(earlier);
    expect(await pending).toBe(earlier);
    expect(started).toEqual([0, 128]);
  });

  test.each([
    ['ethereum-trie', 8],
    ['tron-complete-receipts', 1],
  ] as const)('bounds %s header chunks without overlapping the two passes', async (commitment, expectedPeak) => {
    const rangeSize = commitment === 'ethereum-trie' ? 1023 : 511;
    let active = 0;
    let peak = 0;
    const heights: number[] = [];
    const scalarMethods: string[] = [];
    const send = async (method: string): Promise<unknown> => {
      expect(['eth_getBlockReceipts', 'eth_getLogs']).toContain(method);
      expect(active).toBe(0);
      expect(heights).toHaveLength(rangeSize + 1);
      scalarMethods.push(method);
      return [];
    };
    const sendBatch = async (calls: readonly RpcBatchCall[]): Promise<unknown[]> => {
      peak = Math.max(peak, ++active);
      const batchHeights = calls.map(call => Number(BigInt(String(call.params[0]))));
      heights.push(...batchHeights);
      await Promise.resolve();
      active--;
      return batchHeights.map(blockFor);
    };
    const result = await readAuthenticatedReceiptRange(
      send,
      2,
      rangeSize + 1,
      ['0x000000000000000000000000000000000000dEaD'],
      { commitment },
      sendBatch,
    );
    const passHeights = Array.from({ length: rangeSize + 1 }, (_, index) => index + 1);
    expect(heights).toEqual([...passHeights, ...passHeights]);
    expect(result.headers.map(header => header.jHeight)).toEqual(passHeights.slice(1));
    expect(result.logs).toEqual([]);
    expect(peak).toBe(expectedPeak);
    expect(active).toBe(0);
    expect(scalarMethods).toEqual(
      commitment === 'ethereum-trie' ? [] : [...Array<string>(511).fill('eth_getBlockReceipts'), 'eth_getLogs'],
    );
  });

  test.each([BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL, BLOCKCHAIN.J_WATCHER_TRON_MAX_BLOCKS_PER_POLL, 256, 2048])(
    'reads %i headers in bounded RPC batches with the complete reorg fence',
    async rangeSize => {
      let scalarCalls = 0;
      const batches: RpcBatchCall[][] = [];
      const send = async (): Promise<unknown> => {
        scalarCalls += 1;
        throw new Error('SCALAR_RPC_MUST_NOT_RUN');
      };
      const sendBatch = async (calls: readonly RpcBatchCall[]): Promise<unknown[]> => {
        batches.push(calls.map(call => ({ method: call.method, params: [...call.params] })));
        return calls.map(call => blockFor(Number(BigInt(String(call.params[0])))));
      };

      const result = await readAuthenticatedReceiptRange(
        send,
        2,
        rangeSize + 1,
        ['0x000000000000000000000000000000000000dEaD'],
        {},
        sendBatch,
      );

      expect(result.headers).toHaveLength(rangeSize);
      expect(result.logs).toEqual([]);
      expect(scalarCalls).toBe(0);
      expect(batches.length).toBe(2 * Math.ceil((rangeSize + 1) / 128));
      // The production window includes its preceding anchor in both passes.
      // A trailing one-header request adds two network round trips per window.
      if (rangeSize === BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL) {
        expect(batches.map(batch => batch.length)).toEqual(Array<number>(2 * ((rangeSize + 1) / 128)).fill(128));
      }
      expect(batches.every(batch => batch.length <= 128)).toBe(true);
      expect(batches.reduce((total, batch) => total + batch.length, 0)).toBe(2 * (rangeSize + 1));
      expect(batches.every(batch => batch.every(call => call.method === 'eth_getBlockByNumber'))).toBe(true);
    },
  );
});

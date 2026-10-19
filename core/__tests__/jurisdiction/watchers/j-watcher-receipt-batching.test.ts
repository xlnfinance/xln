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
  test.each([2, 4] as const)(
    'overlaps at most %i chunks while preserving requested header order',
    async concurrency => {
      const calls = Array.from({ length: concurrency * 128 + 1 }, (_, height) => ({
        method: 'eth_getBlockByNumber',
        params: [height],
      }));
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let active = 0;
      let peak = 0;
      const starts: number[] = [];
      const pending = sendBatchInChunks(
        async chunk => {
          const start = Number(chunk[0]!.params[0]);
          starts.push(start);
          peak = Math.max(peak, ++active);
          if (starts.length === concurrency) entered.resolve();
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
      await Promise.resolve();
      expect(starts).toEqual(Array.from({ length: concurrency }, (_, index) => index * 128));
      first.resolve();
      expect(await pending).toEqual(calls.map(call => call.params[0]));
      expect(starts).toEqual(Array.from({ length: concurrency + 1 }, (_, index) => index * 128));
      expect(peak).toBe(concurrency);
      expect(active).toBe(0);
    },
  );

  test.each([2, 4] as const)(
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

  test.each([
    ['ethereum-trie', 4],
    ['tron-complete-receipts', 1],
  ] as const)('bounds %s header chunks without overlapping the two passes', async (commitment, expectedPeak) => {
    let active = 0;
    let peak = 0;
    const heights: number[] = [];
    const scalarMethods: string[] = [];
    const send = async (method: string): Promise<unknown> => {
      expect(['eth_getBlockReceipts', 'eth_getLogs']).toContain(method);
      expect(active).toBe(0);
      expect(heights).toHaveLength(512);
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
      512,
      ['0x000000000000000000000000000000000000dEaD'],
      { commitment },
      sendBatch,
    );
    const passHeights = Array.from({ length: 512 }, (_, index) => index + 1);
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
        expect(batches.map(batch => batch.length)).toEqual(Array<number>(8).fill(128));
      }
      expect(batches.every(batch => batch.length <= 128)).toBe(true);
      expect(batches.reduce((total, batch) => total + batch.length, 0)).toBe(2 * (rangeSize + 1));
      expect(batches.every(batch => batch.every(call => call.method === 'eth_getBlockByNumber'))).toBe(true);
    },
  );
});

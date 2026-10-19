import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { BLOCKCHAIN } from '../../../config/constants';

import { readAuthenticatedReceiptRange, type RpcBatchCall } from '../../../jurisdiction/adapter/receipt-root';

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
  test.each([BLOCKCHAIN.J_WATCHER_MAX_BLOCKS_PER_POLL, 256, 2048])(
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
        expect(batches.map(batch => batch.length)).toEqual([128, 128, 128, 128]);
      }
      expect(batches.every(batch => batch.length <= 128)).toBe(true);
      expect(batches.reduce((total, batch) => total + batch.length, 0)).toBe(2 * (rangeSize + 1));
      expect(batches.every(batch => batch.every(call => call.method === 'eth_getBlockByNumber'))).toBe(true);
    },
  );
});

import { afterEach, describe, expect, test } from 'bun:test';

import { prepareAuthenticatedWatcherIngress } from '../jadapter/rpc';
import { setJBlockHeadersIngressTransform } from '../jadapter/watcher';
import type { AuthenticatedReceiptRange } from '../jadapter/receipt-root';

const HASH_A = `0x${'11'.repeat(32)}`;
const HASH_B = `0x${'22'.repeat(32)}`;
const TX_HASH = `0x${'33'.repeat(32)}`;

const rangeWith = (headerHash: string, receiptHash: string): AuthenticatedReceiptRange => ({
  anchor: {
    jHeight: 1,
    jBlockHash: HASH_A,
    parentHash: `0x${'00'.repeat(32)}`,
  },
  headers: [{
    jHeight: 2,
    jBlockHash: headerHash,
    parentHash: `0x${'00'.repeat(32)}`,
  }],
  logs: [{
    address: '0x0000000000000000000000000000000000000001',
    topics: [],
    data: '0x',
    blockNumber: 2,
    blockHash: receiptHash,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    index: 0,
  }],
});

let restoreTransform: (() => void) | null = null;

afterEach(() => {
  restoreTransform?.();
  restoreTransform = null;
});

describe('authenticated watcher header replay boundary', () => {
  test('authenticates a fresh receipt before replaying the recorded header', () => {
    let transformedHeights: number[] = [];
    restoreTransform = setJBlockHeadersIngressTransform((headers) => {
      transformedHeights = headers.map(header => header.jHeight);
      return headers.map(header => ({
        ...header,
        jBlockHash: header.jHeight === 1 ? TX_HASH : HASH_B,
      }));
    });

    const ingress = prepareAuthenticatedWatcherIngress(
      rangeWith(HASH_A, HASH_A),
      { height: 1, hash: TX_HASH, finalized: true },
    );
    expect(ingress.headers).toEqual([{ jHeight: 2, jBlockHash: HASH_B }]);
    expect(ingress.logs.map(log => log.blockHash)).toEqual([HASH_B]);
    expect(ingress.tipBlockHash).toBe(HASH_B);
    expect(transformedHeights).toEqual([1, 2]);
  });

  test('compares a certified parent with recorded identity only after fresh authentication', () => {
    restoreTransform = setJBlockHeadersIngressTransform((headers) =>
      headers.map(header => ({ ...header, jBlockHash: HASH_B })));

    expect(() => prepareAuthenticatedWatcherIngress(
      rangeWith(HASH_A, HASH_A),
      { height: 1, hash: TX_HASH, finalized: true },
    )).toThrow(
      `J_RECEIPT_FINALIZED_PARENT_REORG:height=1:expected=${TX_HASH}:actual=${HASH_B}`,
    );
  });

  test('a replay transform cannot bless an inconsistent receipt/header pair', () => {
    let transformCalls = 0;
    restoreTransform = setJBlockHeadersIngressTransform((headers) => {
      transformCalls += 1;
      return headers.map(header => ({ ...header, jBlockHash: HASH_B }));
    });

    expect(() => prepareAuthenticatedWatcherIngress(
      rangeWith(HASH_A, HASH_B),
      { height: 1, hash: TX_HASH, finalized: true },
    )).toThrow(
      `J_RECEIPT_LOG_HEADER_MISMATCH:2:receipt=${HASH_B}:header=${HASH_A}`,
    );
    expect(transformCalls).toBe(0);
  });
});

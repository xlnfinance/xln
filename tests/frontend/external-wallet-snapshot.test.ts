import { describe, expect, test } from 'bun:test';

import {
  assertExternalSnapshotCount,
  normalizeOptionalTokenId,
  readExternalWalletSnapshotSource,
  requireExternalSnapshotBigInt,
  resolveExternalWalletFinalityDepth,
} from '../../frontend/src/lib/components/Entity/external-wallet-snapshot';

const adapterFixture = (input: {
  head?: unknown;
  finalityDepth?: unknown;
  blockHash?: string | null;
}) => ({
  getCurrentBlockNumber: input.head === undefined ? undefined : async () => input.head,
  getFinalityDepth: input.finalityDepth === undefined ? undefined : () => input.finalityDepth,
  provider: {
    getBlockNumber: async () => input.head ?? 10,
    getBlock: async (height: number) => input.blockHash === null
      ? null
      : { number: height, hash: input.blockHash ?? `0xblock${height}` },
  },
});

describe('external wallet snapshot helpers', () => {
  test('requires bigint snapshot fields and exact array counts', () => {
    expect(requireExternalSnapshotBigInt(7n, 'nativeBalance')).toBe(7n);
    expect(() => requireExternalSnapshotBigInt(null, 'nativeBalance'))
      .toThrow('EXTERNAL_WALLET_SNAPSHOT_FIELD_MISSING:nativeBalance');
    expect(() => assertExternalSnapshotCount([1, 2], 3, 'allowances'))
      .toThrow('EXTERNAL_WALLET_SNAPSHOT_FIELD_COUNT_MISMATCH:allowances:expected=3:actual=2');
  });

  test('normalizes optional token ids conservatively', () => {
    expect(normalizeOptionalTokenId(2)).toBe(2);
    expect(normalizeOptionalTokenId(3n)).toBe(3);
    expect(normalizeOptionalTokenId('4')).toBe(4);
    expect(normalizeOptionalTokenId(-1)).toBeUndefined();
    expect(normalizeOptionalTokenId('not-number')).toBeUndefined();
    expect(normalizeOptionalTokenId(2.5)).toBe(2.5);
  });

  test('resolves finality depth and snapshot source from adapter state', async () => {
    const adapter = adapterFixture({ head: 12, finalityDepth: 2, blockHash: '0xsource' }) as any;

    expect(resolveExternalWalletFinalityDepth(adapter)).toBe(2);
    await expect(readExternalWalletSnapshotSource(adapter)).resolves.toEqual({
      headBlockNumber: 12,
      sourceHeight: 10,
      sourceHash: '0xsource',
      finalityDepth: 2,
    });
  });

  test('fails loud on invalid finality, head, unavailable source, or missing block hash', async () => {
    expect(() => resolveExternalWalletFinalityDepth(adapterFixture({ finalityDepth: -1 }) as any))
      .toThrow('EXTERNAL_WALLET_SNAPSHOT_FINALITY_INVALID:-1');
    await expect(readExternalWalletSnapshotSource(adapterFixture({ head: -1 }) as any))
      .rejects.toThrow('EXTERNAL_WALLET_SNAPSHOT_HEAD_INVALID:-1');
    await expect(readExternalWalletSnapshotSource(adapterFixture({ head: 1, finalityDepth: 2 }) as any))
      .rejects.toThrow('EXTERNAL_WALLET_SNAPSHOT_FINALITY_UNAVAILABLE:head=1:depth=2');
    await expect(readExternalWalletSnapshotSource(adapterFixture({ head: 3, finalityDepth: 1, blockHash: null }) as any))
      .rejects.toThrow('EXTERNAL_WALLET_SNAPSHOT_BLOCK_HASH_MISSING:2');
  });
});

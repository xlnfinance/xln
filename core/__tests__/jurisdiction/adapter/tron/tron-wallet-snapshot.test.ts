import { expect, test } from 'bun:test';
import { safeStringify } from '../../../../protocol/serialization';
import {
  assertTronSnapshotRequestedHeight,
  assertTronSnapshotSourceUnchanged,
  parseTronAccountBalance,
  parseTronConstantUint,
} from '../../../../jurisdiction/adapter/rpc/wallet/tron-wallet-snapshot';
import {
  WalletSnapshotSourceAdvancedError,
  walletSnapshotSourceAdvance,
} from '../../../../jurisdiction/adapter/rpc/wallet/snapshot-source';
const owner = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
test('TRON SUN parser preserves integers above JS precision and binds account owner', () => {
  expect(
    parseTronAccountBalance(
      '{"address":"417e5f4552091a69125d5dfcb7b8c2659029395bdf","balance":100000000000000001}',
      owner,
    ),
  ).toBe(100000000000000001n);
  expect(parseTronAccountBalance('{}', owner)).toBe(0n);
  expect(parseTronAccountBalance('{"address":"417e5f4552091a69125d5dfcb7b8c2659029395bdf"}', owner)).toBe(0n);
  expect(() => parseTronAccountBalance('{"Error":"unavailable"}', owner)).toThrow('OWNER_MISMATCH');
  expect(() =>
    parseTronAccountBalance('{"address":"417e5f4552091a69125d5dfcb7b8c2659029395bdf","balance":-1}', owner),
  ).toThrow('BALANCE_INVALID');
});

test('native source advance discards the read; identity changes and regressions are not advancement', () => {
  // Actual JavaTVM before/after headers from the first rejected production read.
  const before = {
    blockNumber: 53,
    blockHash: '0x000000000000003542a59c4472dfbdea925c3ba34c570902ac387c47243b5826',
    timestamp: 1792448286000,
  };
  const after = {
    blockNumber: 54,
    blockHash: '0x0000000000000036480894d5fd5f4874dfd20bc4e902bfb10e1475a789c4302c',
    timestamp: 1792491252000,
  };
  expect(() => assertTronSnapshotSourceUnchanged(before, before)).not.toThrow();
  expect(() => assertTronSnapshotSourceUnchanged(before, after)).toThrow(WalletSnapshotSourceAdvancedError);
  for (const changed of [
    { ...before, blockHash: after.blockHash },
    { ...before, timestamp: before.timestamp + 1 },
    { ...after, timestamp: before.timestamp },
    { ...before, blockNumber: 52 },
  ]) {
    let rejected = false;
    try {
      assertTronSnapshotSourceUnchanged(before, changed);
    } catch (error) {
      rejected = true;
      expect(walletSnapshotSourceAdvance(error)).toBeNull();
    }
    expect(rejected).toBe(true);
  }
  expect(() => assertTronSnapshotRequestedHeight(53, 54)).toThrow(WalletSnapshotSourceAdvancedError);
  expect(() => assertTronSnapshotRequestedHeight(55, 54)).toThrow('TRON_SNAPSHOT_SOURCE_CHANGED');
  expect(() => assertTronSnapshotRequestedHeight('0x36', 54)).not.toThrow();
});

test('source advancement crosses bundle/JSON boundaries only through its validated disposition', () => {
  const error = new WalletSnapshotSourceAdvancedError(53, 54);
  const wire = JSON.parse(safeStringify({ sourceAdvance: error.sourceAdvance }));
  expect(walletSnapshotSourceAdvance(error)).toEqual(walletSnapshotSourceAdvance(wire));
  expect(walletSnapshotSourceAdvance(new Error('TRON_SNAPSHOT_SOURCE_CHANGED'))).toBeNull();
  for (const sourceAdvance of [
    { code: 'TRON_SNAPSHOT_SOURCE_ADVANCED', previousHeight: 53, currentHeight: 53 },
    { code: 'TRON_SNAPSHOT_SOURCE_ADVANCED', previousHeight: 53, currentHeight: 52 },
    { code: 'TRON_SNAPSHOT_SOURCE_ADVANCED', previousHeight: 53, currentHeight: 54.5 },
    { code: 'TRON_SNAPSHOT_SOURCE_ADVANCED', previousHeight: 53, currentHeight: 54, balance: '1' },
    { code: 'TRON_NATIVE_RPC_HEADER_MISMATCH', previousHeight: 53, currentHeight: 54 },
  ])
    expect(walletSnapshotSourceAdvance({ sourceAdvance })).toBeNull();
});
test('TRON uint result requires successful execution and exact ABI word', () => {
  expect(parseTronConstantUint({ result: { result: true }, constant_result: ['f'.repeat(64)] })).toBe(
    (1n << 256n) - 1n,
  );
  for (const input of [
    { result: { result: false }, constant_result: ['0'.repeat(64)] },
    { result: { result: true }, constant_result: [''] },
    { result: { result: true }, constant_result: ['0'.repeat(64), '0'.repeat(64)] },
  ]) {
    expect(() => parseTronConstantUint(input)).toThrow('CONSTANT_UINT_INVALID');
  }
});

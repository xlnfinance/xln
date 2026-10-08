import { expect, test } from 'bun:test';
import { parseTronAccountBalance, parseTronConstantUint } from '../../../../jurisdiction/adapter/rpc/wallet/tron-wallet-snapshot';
const owner = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
test('TRON SUN parser preserves integers above JS precision and binds account owner', () => {
  expect(parseTronAccountBalance('{"address":"417e5f4552091a69125d5dfcb7b8c2659029395bdf","balance":100000000000000001}', owner)).toBe(100000000000000001n);
  expect(parseTronAccountBalance('{}', owner)).toBe(0n);
  expect(parseTronAccountBalance('{"address":"417e5f4552091a69125d5dfcb7b8c2659029395bdf"}', owner)).toBe(0n);
  expect(() => parseTronAccountBalance('{"Error":"unavailable"}', owner)).toThrow('OWNER_MISMATCH');
  expect(() => parseTronAccountBalance('{"address":"417e5f4552091a69125d5dfcb7b8c2659029395bdf","balance":-1}', owner)).toThrow('BALANCE_INVALID');
});
test('TRON uint result requires successful execution and exact ABI word', () => {
  expect(parseTronConstantUint({ result: { result: true }, constant_result: ['f'.repeat(64)] })).toBe((1n << 256n) - 1n);
  for (const input of [{ result: { result: false }, constant_result: ['0'.repeat(64)] },
    { result: { result: true }, constant_result: [''] }, { result: { result: true }, constant_result: ['0'.repeat(64), '0'.repeat(64)] }]) {
    expect(() => parseTronConstantUint(input)).toThrow('CONSTANT_UINT_INVALID');
  }
});

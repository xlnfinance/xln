import { describe, expect, test } from 'bun:test';

import { shouldRunRustH1AccountSettlementSmoke } from '../../../../scripts/operations/hlt/rust/rust-h1-account-settlement-smoke';
import { assertNativeMoveMoney } from '../../../../scripts/operations/hlt/rust/rust-h1-move-smoke';

describe('production Rust H1 Account settlement smoke boundary', () => {
  test('Move rejects a nonce-only success, lost funds, and credit mistaken for reserve', () => {
    const before = { hubReserve: 100n, peerReserve: 20n, collateral: 0n };
    const funded = { hubReserve: 90n, peerReserve: 20n, collateral: 10n };
    expect(() => assertNativeMoveMoney(before, funded, 'r2c', 10n)).not.toThrow();
    expect(() => assertNativeMoveMoney(funded, before, 'c2r', 10n)).not.toThrow();
    expect(() => assertNativeMoveMoney(before, before, 'r2c', 10n)).toThrow('HLT_NATIVE_MOVE_MONEY_MISMATCH');
    expect(() => assertNativeMoveMoney(before, { ...funded, collateral: 9n }, 'r2c', 10n))
      .toThrow('HLT_NATIVE_MOVE_MONEY_MISMATCH');
    expect(() => assertNativeMoveMoney(before, { ...before, hubReserve: 90n }, 'r2r', 10n))
      .toThrow('HLT_NATIVE_MOVE_MONEY_MISMATCH');
    expect(() => assertNativeMoveMoney(before, { ...before, hubReserve: 90n, peerReserve: 30n }, 'r2r', 10n))
      .not.toThrow();
  });
  test('runs for an explicit sustained Rust functional run at reduced capacity', () => {
    const scaled = {
      requested: '1',
      engine: 'rust' as const,
      evidence: 'functional-smoke' as const,
      users: 130,
      payments: 650,
      offeredPerSecond: 130,
      durationSeconds: 5,
    };
    expect(shouldRunRustH1AccountSettlementSmoke(scaled)).toBe(true);
    expect(shouldRunRustH1AccountSettlementSmoke({ ...scaled, requested: undefined })).toBe(false);
    expect(shouldRunRustH1AccountSettlementSmoke({ ...scaled, requested: '0' })).toBe(false);
    expect(() => shouldRunRustH1AccountSettlementSmoke({ ...scaled, engine: 'ts' }))
      .toThrow('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_REQUIRES_SUSTAINED_FUNCTIONAL_RUN');
    expect(() => shouldRunRustH1AccountSettlementSmoke({ ...scaled, durationSeconds: 1, payments: 130 }))
      .toThrow('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_REQUIRES_SUSTAINED_FUNCTIONAL_RUN');
    expect(() => shouldRunRustH1AccountSettlementSmoke({ ...scaled, requested: 'yes' }))
      .toThrow('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_FLAG_INVALID:yes');
  });
});

import { describe, expect, test } from 'bun:test';

import { shouldRunRustH1AccountSettlementSmoke } from '../../../scripts/operations/hlt/rust/rust-h1-account-settlement-smoke';

describe('production Rust H1 Account settlement smoke boundary', () => {
  test('runs only for the explicit exact 1,000-user five-second Rust smoke', () => {
    const exact = {
      requested: '1',
      engine: 'rust' as const,
      evidence: 'functional-smoke' as const,
      users: 1_000,
      payments: 5_000,
      offeredPerSecond: 1_000,
      durationSeconds: 5,
    };
    expect(shouldRunRustH1AccountSettlementSmoke(exact)).toBe(true);
    expect(shouldRunRustH1AccountSettlementSmoke({ ...exact, requested: undefined })).toBe(false);
    expect(shouldRunRustH1AccountSettlementSmoke({ ...exact, requested: '0' })).toBe(false);
    expect(() => shouldRunRustH1AccountSettlementSmoke({ ...exact, engine: 'ts' }))
      .toThrow('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_REQUIRES_EXACT_FUNCTIONAL_SMOKE');
    expect(() => shouldRunRustH1AccountSettlementSmoke({ ...exact, users: 999 }))
      .toThrow('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_REQUIRES_EXACT_FUNCTIONAL_SMOKE');
    expect(() => shouldRunRustH1AccountSettlementSmoke({ ...exact, requested: 'yes' }))
      .toThrow('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_FLAG_INVALID:yes');
  });
});

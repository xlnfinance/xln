import { describe, expect, test } from 'bun:test';

import {
  assertRustH1DisputeFreeze,
  assertRustH1DisputeFinalized,
  decodeRustH1DisputeAccountStatus,
  type RustH1DisputeAccountStatus,
} from '../../../scripts/operations/hlt/rust/rust-h1-dispute-smoke';
import { shouldRunRustH1DisputeSmoke } from '../../../scripts/operations/hlt/workload/worker-payments';

const HUB = `0x${'11'.repeat(32)}`;
const PEER = `0x${'22'.repeat(32)}`;

const status = (
  overrides: Partial<RustH1DisputeAccountStatus> = {},
): RustH1DisputeAccountStatus => ({
  hubEntityId: HUB,
  counterpartyEntityId: PEER,
  hasAccount: true,
  status: 'active',
  ready: true,
  disputeObservedOnChain: false,
  disputeObservedBlockNumber: null,
  settlementWorkspaceHash: null,
  settlementWorkspaceStatus: null,
  jNonce: 0,
  currentHeight: 7,
  pendingFrameHeight: null,
  mempool: 0,
  runtimeHeight: 20,
  ...overrides,
});

describe('production Rust H1 dispute smoke boundary', () => {
  test('runs only for an explicit exact 1,000-user five-second Rust smoke', () => {
    const exact = {
      requested: '1',
      engine: 'rust' as const,
      evidence: 'functional-smoke' as const,
      users: 1_000,
      payments: 5_000,
      offeredPerSecond: 1_000,
      durationSeconds: 5,
    };
    expect(shouldRunRustH1DisputeSmoke(exact)).toBe(true);
    expect(shouldRunRustH1DisputeSmoke({ ...exact, requested: undefined })).toBe(false);
    expect(shouldRunRustH1DisputeSmoke({ ...exact, requested: '0' })).toBe(false);
    expect(() => shouldRunRustH1DisputeSmoke({ ...exact, engine: 'ts' }))
      .toThrow('HLT_RUST_DISPUTE_SMOKE_REQUIRES_EXACT_FUNCTIONAL_SMOKE');
    expect(() => shouldRunRustH1DisputeSmoke({ ...exact, users: 999 }))
      .toThrow('HLT_RUST_DISPUTE_SMOKE_REQUIRES_EXACT_FUNCTIONAL_SMOKE');
    expect(() => shouldRunRustH1DisputeSmoke({ ...exact, requested: 'yes' }))
      .toThrow('HLT_RUST_DISPUTE_SMOKE_FLAG_INVALID:yes');
  });

  test('decodes the exact native Account status projection', () => {
    expect(decodeRustH1DisputeAccountStatus({
      success: true,
      hubEntityId: HUB,
      counterpartyEntityId: PEER,
      hasAccount: true,
      status: 'disputed',
      ready: false,
      disputeObservedOnChain: true,
      disputeObservedBlockNumber: 9,
      settlementWorkspaceHash: null,
      settlementWorkspaceStatus: null,
      jNonce: 0,
      currentHeight: 7,
      pendingFrameHeight: null,
      mempool: 0,
      tokens: [],
      runtime: { height: 21, timestamp: 1_700_000_000_000 },
    })).toEqual(status({
      status: 'disputed',
      ready: false,
      disputeObservedOnChain: true,
      disputeObservedBlockNumber: 9,
      runtimeHeight: 21,
    }));
  });

  test('requires committed freeze and rejects any later Account mutation', () => {
    const before = status();
    const frozen = status({ status: 'disputed', ready: false, runtimeHeight: 21 });
    const observed = status({
      status: 'disputed',
      ready: false,
      disputeObservedOnChain: true,
      disputeObservedBlockNumber: 9,
      runtimeHeight: 22,
    });
    const rejected = { ...observed, runtimeHeight: 23 };
    expect(() => assertRustH1DisputeFreeze(before, frozen, observed, rejected)).not.toThrow();
    expect(() => assertRustH1DisputeFreeze(
      before,
      frozen,
      observed,
      { ...rejected, currentHeight: 8 },
    )).toThrow('HLT_RUST_DISPUTE_BUSINESS_INPUT_MUTATED_ACCOUNT');
  });

  test('accepts external finality without inventing a bilateral AccountFrame', () => {
    const observed = status({
      status: 'disputed',
      ready: false,
      disputeObservedOnChain: true,
      disputeObservedBlockNumber: 9,
      runtimeHeight: 22,
    });
    const finalized = status({
      status: 'disputed',
      ready: false,
      jNonce: 8,
      currentHeight: observed.currentHeight,
      runtimeHeight: 23,
    });
    expect(() => assertRustH1DisputeFinalized(observed, finalized)).not.toThrow();
    expect(() => assertRustH1DisputeFinalized(
      observed,
      { ...finalized, currentHeight: observed.currentHeight + 1 },
    )).toThrow('HLT_RUST_DISPUTE_FINALITY_SYNTHESIZED_ACCOUNT_FRAME');
  });

  test('fails closed on extra status fields and identifies the exact broken fence', () => {
    expect(() => decodeRustH1DisputeAccountStatus({
      success: true,
      hubEntityId: HUB,
      counterpartyEntityId: PEER,
      hasAccount: true,
      status: 'disputed',
      ready: false,
      disputeObservedOnChain: true,
      disputeObservedBlockNumber: 9,
      currentHeight: 7,
      pendingFrameHeight: null,
      mempool: 0,
      tokens: [],
      runtime: { height: 21, timestamp: 1_700_000_000_000 },
      unexpected: true,
    })).toThrow('HLT_RUST_DISPUTE_STATUS_FIELDS');
    expect(() => assertRustH1DisputeFreeze(
      status(),
      status({ status: 'disputed', ready: true, runtimeHeight: 21 }),
      status({ status: 'disputed', ready: false, disputeObservedOnChain: true, disputeObservedBlockNumber: 9, runtimeHeight: 22 }),
      status({ status: 'disputed', ready: false, disputeObservedOnChain: true, disputeObservedBlockNumber: 9, runtimeHeight: 23 }),
    )).toThrow('HLT_RUST_DISPUTE_PREPARE_NOT_FROZEN');
    expect(() => assertRustH1DisputeFreeze(
      status(),
      status({ status: 'disputed', ready: false, runtimeHeight: 21 }),
      status({ status: 'disputed', ready: false, disputeObservedOnChain: true, disputeObservedBlockNumber: 9, runtimeHeight: 22 }),
      status({ status: 'disputed', ready: true, disputeObservedOnChain: true, disputeObservedBlockNumber: 9, runtimeHeight: 23 }),
    )).toThrow('HLT_RUST_DISPUTE_BUSINESS_INPUT_REOPENED_ACCOUNT');
  });
});

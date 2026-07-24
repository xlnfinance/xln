import { describe, expect, test } from 'bun:test';

import {
  J_BATCH_CONTRACT_LIMITS,
  assertJBatchWithinContractLimits,
  batchAddRevealSecret,
  batchAddReserveToCollateral,
  batchAddSettlement,
  cloneJBatch,
  createEmptyBatch,
  getJBatchContractLimitIssue,
  initJBatch,
} from '../jurisdiction/batch';

const transformer = `0x${'11'.repeat(20)}`;
const secret = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;
const leftEntity = `0x${'11'.repeat(32)}`;
const rightEntity = `0x${'22'.repeat(32)}`;
const entityProvider = `0x${'33'.repeat(20)}`;
const settlementDiff = {
  tokenId: 1,
  leftDiff: -1n,
  rightDiff: 1n,
  collateralDiff: 0n,
  ondeltaDiff: 0n,
};

const addSettlement = (
  state: ReturnType<typeof initJBatch>,
  overrides: {
    diffs?: typeof settlementDiff[];
    forgiveness?: number[];
    sig?: string;
    nonce?: number;
    disablePureC2RShortcut?: boolean;
  } = {},
): void => batchAddSettlement(
  state,
  leftEntity,
  rightEntity,
  overrides.diffs ?? [settlementDiff],
  overrides.forgiveness ?? [],
  overrides.sig ?? '0x1234',
  overrides.nonce ?? 7,
  leftEntity,
  overrides.disablePureC2RShortcut ?? true,
);

describe('j-batch contract limits', () => {
  test('R2C builder mirrors the aggregate 256-pair contract work bound', () => {
    const state = initJBatch();
    for (let tokenId = 1; tokenId <= 4; tokenId += 1) {
      for (let index = 0; index < 64; index += 1) {
        batchAddReserveToCollateral(
          state,
          leftEntity,
          `0x${(tokenId * 64 + index).toString(16).padStart(64, '0')}`,
          tokenId,
          1n,
        );
      }
    }
    expect(getJBatchContractLimitIssue(state.batch)).toBeNull();

    const before = cloneJBatch(state.batch);
    expect(() => batchAddReserveToCollateral(
      state,
      leftEntity,
      `0x${'ff'.repeat(32)}`,
      5,
      1n,
    )).toThrow('J_BATCH_LIMIT_EXCEEDED: reserveToCollateral.pairs total 257/256');
    expect(state.batch).toEqual(before);
  });

  test('mirrors Depository MAX_BATCH_SECRET_REVEALS before submission', () => {
    expect(J_BATCH_CONTRACT_LIMITS.maxSecretReveals).toBe(32);
    const batch = createEmptyBatch();
    for (let index = 0; index < J_BATCH_CONTRACT_LIMITS.maxSecretReveals; index += 1) {
      batch.revealSecrets.push({ transformer, secret: secret(index + 1) });
    }

    expect(getJBatchContractLimitIssue(batch)).toBeNull();
    assertJBatchWithinContractLimits(batch, 'revealSecrets max');

    batch.revealSecrets.push({ transformer, secret: secret(999) });

    expect(getJBatchContractLimitIssue(batch)).toBe('revealSecrets 33/32');
    expect(() => assertJBatchWithinContractLimits(batch, 'revealSecrets max')).toThrow(
      'J_BATCH_LIMIT_EXCEEDED: revealSecrets max: revealSecrets 33/32',
    );
  });

  test('batchAddRevealSecret rejects the 33rd unique reveal even though total ops allows it', () => {
    const state = initJBatch();
    for (let index = 0; index < J_BATCH_CONTRACT_LIMITS.maxSecretReveals; index += 1) {
      batchAddRevealSecret(state, transformer, secret(index + 1));
    }

    expect(state.batch.revealSecrets).toHaveLength(32);
    expect(() => batchAddRevealSecret(state, transformer, secret(33))).toThrow(
      'J_BATCH_LIMIT_EXCEEDED: revealSecrets 33/32',
    );
    expect(state.batch.revealSecrets).toHaveLength(32);
  });

  test('exact signed settlement retry is an idempotent no-op', () => {
    const state = initJBatch();
    addSettlement(state);
    const before = cloneJBatch(state.batch);

    addSettlement(state);

    expect(state.batch).toEqual(before);
  });

  test('same-pair settlement conflict never mutates the already signed operation', () => {
    for (const conflicting of [
      { diffs: [{ ...settlementDiff, leftDiff: -2n, rightDiff: 2n }] },
      { sig: '0x5678' },
      { nonce: 8 },
    ]) {
      const state = initJBatch();
      addSettlement(state);
      const before = cloneJBatch(state.batch);

      expect(() => addSettlement(state, conflicting)).toThrow('J_BATCH_SETTLEMENT_CONFLICT');
      expect(state.batch).toEqual(before);
    }

    const forgivenessState = initJBatch();
    addSettlement(forgivenessState, { diffs: [], forgiveness: [1] });
    const beforeForgivenessConflict = cloneJBatch(forgivenessState.batch);
    expect(() => addSettlement(forgivenessState, { diffs: [], forgiveness: [2] }))
      .toThrow('J_BATCH_SETTLEMENT_CONFLICT');
    expect(forgivenessState.batch).toEqual(beforeForgivenessConflict);
  });

  test('pure C2R settlement shortcut has the same exact-retry and conflict semantics', () => {
    const c2rDiff = [{
      tokenId: 1,
      leftDiff: 5n,
      rightDiff: 0n,
      collateralDiff: -5n,
      ondeltaDiff: -5n,
    }];
    const state = initJBatch();
    addSettlement(state, { diffs: c2rDiff, disablePureC2RShortcut: false });
    const before = cloneJBatch(state.batch);

    addSettlement(state, { diffs: c2rDiff, disablePureC2RShortcut: false });
    expect(state.batch).toEqual(before);

    expect(() => addSettlement(state, {
      diffs: [{ ...c2rDiff[0]!, leftDiff: 6n, collateralDiff: -6n, ondeltaDiff: -6n }],
      disablePureC2RShortcut: false,
    })).toThrow('J_BATCH_SETTLEMENT_CONFLICT');
    expect(state.batch).toEqual(before);
  });

  test('builder and restored-batch audit enforce at most 32 forgiveness IDs', () => {
    const maxIds = Array.from(
      { length: J_BATCH_CONTRACT_LIMITS.maxSettlementForgivenessIds },
      (_, index) => index + 1,
    );
    const state = initJBatch();
    addSettlement(state, { diffs: [], forgiveness: maxIds });
    expect(state.batch.settlements[0]?.forgiveDebtsInTokenIds).toEqual(maxIds);

    const before = cloneJBatch(state.batch);
    const tooMany = [...maxIds, 33];
    const oversizedState = initJBatch();
    expect(() => addSettlement(oversizedState, { diffs: [], forgiveness: tooMany }))
      .toThrow('J_BATCH_LIMIT_EXCEEDED: settlement.forgiveDebtsInTokenIds 33/32');
    expect(oversizedState.batch.settlements).toHaveLength(0);

    const restored = cloneJBatch(before);
    restored.settlements[0]!.forgiveDebtsInTokenIds.push(33);
    expect(getJBatchContractLimitIssue(restored))
      .toBe('settlements[0].forgiveDebtsInTokenIds 33/32');
    expect(() => assertJBatchWithinContractLimits(restored, 'restored batch'))
      .toThrow(
        'J_BATCH_LIMIT_EXCEEDED: restored batch: settlements[0].forgiveDebtsInTokenIds 33/32',
      );
  });
});

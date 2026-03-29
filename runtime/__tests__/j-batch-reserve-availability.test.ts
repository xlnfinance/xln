import { describe, expect, test } from 'bun:test';

import {
  createEmptyBatch,
  getDraftBatchReserveDelta,
  getEffectiveDraftReserveBalance,
  simulateDraftBatchReserveAvailability,
} from '../j-batch';

describe('j-batch draft reserve availability', () => {
  test('counts same-batch collateral-to-reserve as spendable by later reserve ops', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterparty = `0x${'22'.repeat(32)}`;
    const batch = createEmptyBatch();

    batch.collateralToReserve.push({
      counterparty,
      tokenId: 1,
      amount: 22n,
      nonce: 7,
      sig: '0x1234',
    });

    expect(getDraftBatchReserveDelta(entityId, batch, 1)).toBe(22n);
    expect(getEffectiveDraftReserveBalance(entityId, 0n, batch, 1)).toBe(22n);

    batch.reserveToExternalToken.push({
      receivingEntity: `0x${'33'.repeat(32)}`,
      tokenId: 1,
      amount: 22n,
    });

    expect(getDraftBatchReserveDelta(entityId, batch, 1)).toBe(0n);
    expect(getEffectiveDraftReserveBalance(entityId, 0n, batch, 1)).toBe(0n);
  });

  test('tracks net draft reserve after mixed incoming and outgoing ops', () => {
    const entityId = `0x${'44'.repeat(32)}`;
    const batch = createEmptyBatch();

    batch.externalTokenToReserve.push({
      entity: entityId,
      contractAddress: `0x${'55'.repeat(20)}`,
      externalTokenId: 0n,
      tokenType: 1,
      internalTokenId: 1,
      amount: 10n,
    });
    batch.collateralToReserve.push({
      counterparty: `0x${'66'.repeat(32)}`,
      tokenId: 1,
      amount: 7n,
      nonce: 3,
      sig: '0xabcd',
    });
    batch.reserveToCollateral.push({
      tokenId: 1,
      receivingEntity: entityId,
      pairs: [{ entity: `0x${'77'.repeat(32)}`, amount: 5n }],
    });
    batch.reserveToReserve.push({
      receivingEntity: `0x${'88'.repeat(32)}`,
      tokenId: 1,
      amount: 4n,
    });

    expect(getDraftBatchReserveDelta(entityId, batch, 1)).toBe(8n);
    expect(getEffectiveDraftReserveBalance(entityId, 2n, batch, 1)).toBe(10n);
  });

  test('treats outgoing debts as senior claim before reserve withdrawal', () => {
    const entityId = `0x${'99'.repeat(32)}`;
    const batch = createEmptyBatch();
    batch.reserveToExternalToken.push({
      receivingEntity: `0x${'12'.repeat(32)}`,
      tokenId: 1,
      amount: 60n,
    });

    const simulation = simulateDraftBatchReserveAvailability(
      entityId,
      new Map([[1, 100n]]),
      batch,
      new Map([[1, 50n]]),
    );

    expect(simulation.issues).toHaveLength(1);
    expect(simulation.issues[0]).toMatchObject({
      tokenId: 1,
      opType: 'reserveToExternalToken',
      requiredAmount: 60n,
      availableAfterDebt: 50n,
      debtClaimPaid: 50n,
      remainingDebtAfterSweep: 0n,
    });
  });

  test('allows same-batch reserve inflow to cover debt then later spend', () => {
    const entityId = `0x${'aa'.repeat(32)}`;
    const batch = createEmptyBatch();
    batch.externalTokenToReserve.push({
      entity: entityId,
      contractAddress: `0x${'bb'.repeat(20)}`,
      externalTokenId: 0n,
      tokenType: 0,
      internalTokenId: 1,
      amount: 100n,
    });
    batch.reserveToExternalToken.push({
      receivingEntity: `0x${'cc'.repeat(32)}`,
      tokenId: 1,
      amount: 15n,
    });

    const simulation = simulateDraftBatchReserveAvailability(
      entityId,
      new Map([[1, 0n]]),
      batch,
      new Map([[1, 80n]]),
    );

    expect(simulation.issues).toHaveLength(0);
    expect(simulation.reservesByToken.get(1)).toBe(5n);
    expect(simulation.outgoingDebtByToken.get(1) ?? 0n).toBe(0n);
  });

  test('does not let same-batch settlement fund an earlier reserve transfer', () => {
    const entityId = `0x${'dd'.repeat(32)}`;
    const counterparty = `0x${'ee'.repeat(32)}`;
    const batch = createEmptyBatch();

    batch.reserveToReserve.push({
      receivingEntity: `0x${'ff'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
    });
    batch.settlements.push({
      leftEntity: entityId,
      rightEntity: counterparty,
      diffs: [{
        tokenId: 1,
        leftDiff: 10n,
        rightDiff: -10n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      }],
      forgiveDebtsInTokenIds: [],
      sig: '0x1234',
      entityProvider: `0x${'ab'.repeat(20)}`,
      hankoData: '0x',
      nonce: 1,
    });

    const simulation = simulateDraftBatchReserveAvailability(entityId, new Map([[1, 0n]]), batch, new Map());

    expect(simulation.issues).toHaveLength(1);
    expect(simulation.issues[0]).toMatchObject({
      tokenId: 1,
      opType: 'reserveToReserve',
      requiredAmount: 10n,
      availableAfterDebt: 0n,
    });
  });

  test('allows settlement proceeds to fund later reserve withdrawal', () => {
    const entityId = `0x${'12'.repeat(32)}`;
    const counterparty = `0x${'34'.repeat(32)}`;
    const batch = createEmptyBatch();

    batch.settlements.push({
      leftEntity: entityId,
      rightEntity: counterparty,
      diffs: [{
        tokenId: 1,
        leftDiff: 10n,
        rightDiff: -10n,
        collateralDiff: 0n,
        ondeltaDiff: 0n,
      }],
      forgiveDebtsInTokenIds: [],
      sig: '0x1234',
      entityProvider: `0x${'56'.repeat(20)}`,
      hankoData: '0x',
      nonce: 1,
    });
    batch.reserveToExternalToken.push({
      receivingEntity: `0x${'78'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
    });

    const simulation = simulateDraftBatchReserveAvailability(entityId, new Map([[1, 0n]]), batch, new Map());

    expect(simulation.issues).toHaveLength(0);
    expect(simulation.reservesByToken.get(1) ?? 0n).toBe(0n);
  });
});

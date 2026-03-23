import { describe, expect, test } from 'bun:test';

import { createEmptyBatch, getDraftBatchReserveDelta, getEffectiveDraftReserveBalance } from '../j-batch';

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
});

import { describe, expect, test } from 'bun:test';

import {
  buildAddTokenToAccountTx,
  buildBroadcastTx,
  buildDisputeFinalizeTx,
  buildExternalToReserveTx,
  buildMoveSettlementContinuation,
  buildOpenAccountTx,
  buildPrepareDisputeTx,
  buildReopenDisputedAccountTx,
  buildReserveToCollateralTx,
  buildReserveToExternalEoaTx,
  buildReserveToReserveTx,
  buildSettlementApproveTx,
  encodeExternalEoaAsEntity,
} from '../../frontend/src/lib/components/Entity/entity-action-txs';

const entityId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hubId = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const targetId = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const eoa = '0x1111111111111111111111111111111111111111';

describe('entity action tx builders', () => {
  test('builds reserve and external movement txs', () => {
    expect(buildReserveToReserveTx(targetId, 1, 2n)).toEqual({
      type: 'r2r',
      data: { toEntityId: targetId, tokenId: 1, amount: 2n },
    });
    expect(buildReserveToExternalEoaTx(eoa, 3, 4n)).toEqual({
      type: 'r2e',
      data: { receivingEntity: encodeExternalEoaAsEntity(eoa), tokenId: 3, amount: 4n },
    });
    expect(buildExternalToReserveTx({ contractAddress: eoa, amount: 5n, internalTokenId: 9 })).toEqual({
      type: 'e2r',
      data: { contractAddress: eoa, amount: 5n, internalTokenId: 9 },
    });
  });

  test('omits self receiving entity on reserve to collateral', () => {
    expect(buildReserveToCollateralTx({
      counterpartyEntityId: hubId,
      selfEntityId: entityId,
      receivingEntityId: entityId,
      tokenId: 1,
      amount: 2n,
    })).toEqual({
      type: 'r2c',
      data: { counterpartyId: hubId, tokenId: 1, amount: 2n },
    });
    expect(buildReserveToCollateralTx({
      counterpartyEntityId: hubId,
      selfEntityId: entityId,
      receivingEntityId: targetId,
      tokenId: 1,
      amount: 2n,
    })).toEqual({
      type: 'r2c',
      data: { counterpartyId: hubId, receivingEntityId: targetId, tokenId: 1, amount: 2n },
    });
  });

  test('builds account lifecycle and dispute txs', () => {
    const workspaceHash = `0x${'12'.repeat(32)}`;
    expect(buildSettlementApproveTx(hubId, workspaceHash)).toEqual({
      type: 'settle_approve',
      data: { counterpartyEntityId: hubId, workspaceHash },
    });
    expect(buildOpenAccountTx(hubId)).toEqual({ type: 'openAccount', data: { targetEntityId: hubId } });
    expect(buildPrepareDisputeTx(hubId, 'prep', {
      allowUnsafeCrossJTargetDispute: true,
      acceptedCrossJTargetLossAmount: 10n,
    })).toEqual({
      type: 'prepareDispute',
      data: {
        counterpartyEntityId: hubId,
        description: 'prep',
        allowUnsafeCrossJTargetDispute: true,
        acceptedCrossJTargetLossAmount: 10n,
      },
    });
    expect(buildDisputeFinalizeTx(hubId, 'final')).toEqual({ type: 'disputeFinalize', data: { counterpartyEntityId: hubId, description: 'final' } });
    expect(buildReopenDisputedAccountTx(hubId)).toEqual({ type: 'reopenDisputedAccount', data: { counterpartyEntityId: hubId } });
    expect(buildAddTokenToAccountTx(hubId, 4)).toEqual({ type: 'extendCredit', data: { counterpartyEntityId: hubId, tokenId: 4, amount: 0n } });
  });

  test('builds a durable post-settlement continuation', () => {
    expect(buildMoveSettlementContinuation(
      entityId,
      7,
      12n,
      { type: 'reserve_to_collateral', targetEntityId: targetId, counterpartyEntityId: hubId },
      true,
    )).toEqual({
      actions: [
      {
        type: 'r2c',
        counterpartyId: hubId,
        receivingEntityId: targetId,
        tokenId: 7,
        amount: 12n,
      },
      ],
      broadcast: true,
    });
  });
});

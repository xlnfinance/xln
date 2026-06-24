import { describe, expect, test } from 'bun:test';

import {
  buildAddTokenToAccountTx,
  buildBroadcastTx,
  buildDisputeFinalizeTx,
  buildDisputeStartTx,
  buildExternalToReserveTx,
  buildMovePostSettleTxs,
  buildOpenAccountTx,
  buildPrepareDisputeTx,
  buildReopenDisputedAccountTx,
  buildReserveToCollateralTx,
  buildReserveToExternalEoaTx,
  buildReserveToReserveTx,
  buildSettlementApproveTx,
  encodeExternalEoaAsEntity,
  type PendingAssetAutoC2R,
} from '../../frontend/src/lib/components/Entity/entity-action-txs';

const entityId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hubId = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const targetId = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const eoa = '0x1111111111111111111111111111111111111111';

const pending = (patch: Partial<PendingAssetAutoC2R>): PendingAssetAutoC2R => ({
  counterpartyEntityId: hubId,
  tokenId: 7,
  symbol: 'USDC',
  amount: 12n,
  postSettleOp: { type: 'none' },
  broadcast: false,
  phase: 'awaiting_settlement_execute',
  ...patch,
});

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
    expect(buildSettlementApproveTx(hubId)).toEqual({ type: 'settle_approve', data: { counterpartyEntityId: hubId } });
    expect(buildOpenAccountTx(hubId)).toEqual({ type: 'openAccount', data: { targetEntityId: hubId } });
    expect(buildPrepareDisputeTx(hubId, 'prep')).toEqual({ type: 'prepareDispute', data: { counterpartyEntityId: hubId, description: 'prep' } });
    expect(buildDisputeStartTx(hubId, 'start', { allowUnsafeCrossJTargetDispute: true, acceptedCrossJTargetLossAmount: 10n })).toEqual({
      type: 'disputeStart',
      data: {
        counterpartyEntityId: hubId,
        description: 'start',
        allowUnsafeCrossJTargetDispute: true,
        acceptedCrossJTargetLossAmount: 10n,
      },
    });
    expect(buildDisputeFinalizeTx(hubId, 'final')).toEqual({ type: 'disputeFinalize', data: { counterpartyEntityId: hubId, description: 'final' } });
    expect(buildReopenDisputedAccountTx(hubId)).toEqual({ type: 'reopenDisputedAccount', data: { counterpartyEntityId: hubId } });
    expect(buildAddTokenToAccountTx(hubId, 4)).toEqual({ type: 'extendCredit', data: { counterpartyEntityId: hubId, tokenId: 4, amount: 0n } });
  });

  test('builds post-settle follow-up sequence', () => {
    expect(buildMovePostSettleTxs(entityId, pending({
      postSettleOp: { type: 'reserve_to_collateral', targetEntityId: targetId, counterpartyEntityId: hubId },
      broadcast: true,
    }))).toEqual([
      {
        type: 'settle_execute',
        data: { counterpartyEntityId: hubId, disableC2RShortcut: true },
      },
      {
        type: 'r2c',
        data: { counterpartyId: hubId, receivingEntityId: targetId, tokenId: 7, amount: 12n },
      },
      buildBroadcastTx(),
    ]);
  });
});

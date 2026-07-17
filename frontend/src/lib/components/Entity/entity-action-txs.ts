import { zeroPadValue } from 'ethers';
import type { EntityTx } from '@xln/runtime/xln-api';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

export type OpenAccountRebalancePolicy = EntityTxOf<'openAccount'>['data']['rebalancePolicy'];

export type MovePostSettleOp =
  | { type: 'none' }
  | { type: 'r2r'; recipientEntityId: string }
  | { type: 'r2e'; recipientEoa: string }
  | { type: 'reserve_to_collateral'; targetEntityId: string; counterpartyEntityId: string };

export type PendingAssetAutoC2R = {
  counterpartyEntityId: string;
  tokenId: number;
  symbol: string;
  amount: bigint;
  postSettleOp: MovePostSettleOp;
  broadcast: boolean;
  phase: 'awaiting_settlement_execute' | 'awaiting_follow_up';
};

export type DisputeStartOptions = {
  allowUnsafeCrossJTargetDispute?: boolean;
  acceptedCrossJTargetLossAmount?: bigint;
};

export function encodeExternalEoaAsEntity(recipientEoa: string): string {
  return zeroPadValue(recipientEoa, 32).toLowerCase();
}

export function buildBroadcastTx(): EntityTxOf<'j_broadcast'> {
  return { type: 'j_broadcast', data: {} };
}

export function buildReserveToReserveTx(toEntityId: string, tokenId: number, amount: bigint): EntityTxOf<'r2r'> {
  return {
    type: 'r2r',
    data: { toEntityId, tokenId, amount },
  };
}

export function buildReserveToExternalTx(receivingEntity: string, tokenId: number, amount: bigint): EntityTxOf<'r2e'> {
  return {
    type: 'r2e',
    data: { receivingEntity, tokenId, amount },
  };
}

export function buildReserveToExternalEoaTx(recipientEoa: string, tokenId: number, amount: bigint): EntityTxOf<'r2e'> {
  return buildReserveToExternalTx(encodeExternalEoaAsEntity(recipientEoa), tokenId, amount);
}

export function buildReserveToCollateralTx(params: {
  counterpartyEntityId: string;
  selfEntityId: string;
  receivingEntityId?: string;
  tokenId: number;
  amount: bigint;
}): EntityTxOf<'r2c'> {
  const selfEntityId = String(params.selfEntityId || '').trim().toLowerCase();
  const receivingEntityId = String(params.receivingEntityId || selfEntityId).trim().toLowerCase();
  return {
    type: 'r2c',
    data: {
      counterpartyId: params.counterpartyEntityId,
      ...(receivingEntityId !== selfEntityId ? { receivingEntityId } : {}),
      tokenId: params.tokenId,
      amount: params.amount,
    },
  };
}

export function buildExternalToReserveTx(params: {
  contractAddress: string;
  amount: bigint;
  internalTokenId?: number;
}): EntityTxOf<'e2r'> {
  return {
    type: 'e2r',
    data: {
      contractAddress: params.contractAddress,
      amount: params.amount,
      ...(typeof params.internalTokenId === 'number' ? { internalTokenId: params.internalTokenId } : {}),
    },
  };
}

export function buildSettlementApproveTx(
  counterpartyEntityId: string,
  workspaceHash: string,
): EntityTxOf<'settle_approve'> {
  return {
    type: 'settle_approve',
    data: { counterpartyEntityId, workspaceHash },
  };
}

export function buildOpenAccountTx(targetEntityId: string, rebalancePolicy?: OpenAccountRebalancePolicy | null): EntityTxOf<'openAccount'> {
  return {
    type: 'openAccount',
    data: {
      targetEntityId,
      ...(rebalancePolicy ? { rebalancePolicy } : {}),
    },
  };
}

export function buildPrepareDisputeTx(counterpartyEntityId: string, description?: string): EntityTxOf<'prepareDispute'> {
  return {
    type: 'prepareDispute',
    data: {
      counterpartyEntityId,
      ...(description !== undefined ? { description } : {}),
    },
  };
}

export function buildDisputeStartTx(
  counterpartyEntityId: string,
  description?: string,
  options: DisputeStartOptions = {},
): EntityTxOf<'disputeStart'> {
  return {
    type: 'disputeStart',
    data: {
      counterpartyEntityId,
      ...(description !== undefined ? { description } : {}),
      ...(options.allowUnsafeCrossJTargetDispute ? { allowUnsafeCrossJTargetDispute: true } : {}),
      ...(options.acceptedCrossJTargetLossAmount !== undefined
        ? { acceptedCrossJTargetLossAmount: options.acceptedCrossJTargetLossAmount }
        : {}),
    },
  };
}

export function buildDisputeFinalizeTx(counterpartyEntityId: string, description?: string): EntityTxOf<'disputeFinalize'> {
  return {
    type: 'disputeFinalize',
    data: {
      counterpartyEntityId,
      ...(description !== undefined ? { description } : {}),
    },
  };
}

export function buildReopenDisputedAccountTx(counterpartyEntityId: string): EntityTxOf<'reopenDisputedAccount'> {
  return {
    type: 'reopenDisputedAccount',
    data: { counterpartyEntityId },
  };
}

export function buildAddTokenToAccountTx(counterpartyEntityId: string, tokenId: number): EntityTxOf<'extendCredit'> {
  return {
    type: 'extendCredit',
    data: { counterpartyEntityId, tokenId, amount: 0n },
  };
}

export function buildMovePostSettleTxs(entityId: string, pending: PendingAssetAutoC2R): EntityTx[] {
  const selfEntityId = String(entityId || '').trim().toLowerCase();
  const needsFollowUpReserveOp = pending.postSettleOp.type !== 'none';
  const entityTxs: EntityTx[] = [
    {
      type: 'settle_execute',
      data: {
        counterpartyEntityId: pending.counterpartyEntityId,
        ...(needsFollowUpReserveOp ? { disableC2RShortcut: true } : {}),
      },
    },
  ];
  if (pending.postSettleOp.type === 'r2r') {
    entityTxs.push(buildReserveToReserveTx(pending.postSettleOp.recipientEntityId, pending.tokenId, pending.amount));
  }
  if (pending.postSettleOp.type === 'r2e') {
    entityTxs.push(buildReserveToExternalEoaTx(pending.postSettleOp.recipientEoa, pending.tokenId, pending.amount));
  }
  if (pending.postSettleOp.type === 'reserve_to_collateral') {
    entityTxs.push(buildReserveToCollateralTx({
      counterpartyEntityId: pending.postSettleOp.counterpartyEntityId,
      selfEntityId,
      receivingEntityId: pending.postSettleOp.targetEntityId,
      tokenId: pending.tokenId,
      amount: pending.amount,
    }));
  }
  if (pending.broadcast) {
    entityTxs.push(buildBroadcastTx());
  }
  return entityTxs;
}

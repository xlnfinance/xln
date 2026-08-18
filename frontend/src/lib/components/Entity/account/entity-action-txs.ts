import { zeroPadValue } from 'ethers';
import type { EntityTx } from '@xln/core/api/public/runtime-module';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

export type OpenAccountRebalancePolicy = EntityTxOf<'openAccount'>['data']['rebalancePolicy'];
export type OpenAccountDisputeConfig = EntityTxOf<'openAccount'>['data']['disputeConfig'];

export type MovePostSettleOp =
  | { type: 'none' }
  | { type: 'r2r'; recipientEntityId: string }
  | { type: 'r2e'; recipientEoa: string }
  | { type: 'reserve_to_collateral'; targetEntityId: string; counterpartyEntityId: string };

export type SettlementContinuationPlan = NonNullable<
  EntityTxOf<'settle_propose'>['data']['continuation']
>;

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

export function buildOpenAccountTx(
  targetEntityId: string,
  disputeConfig: OpenAccountDisputeConfig,
  rebalancePolicy?: OpenAccountRebalancePolicy | null,
): EntityTxOf<'openAccount'> {
  return {
    type: 'openAccount',
    data: {
      targetEntityId,
      disputeConfig,
      ...(rebalancePolicy ? { rebalancePolicy } : {}),
    },
  };
}

export function buildPrepareDisputeTx(
  counterpartyEntityId: string,
  description?: string,
): EntityTxOf<'prepareDispute'> {
  return {
    type: 'prepareDispute',
    data: {
      counterpartyEntityId,
      ...(description !== undefined ? { description } : {}),
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

export function buildAddTokenToAccountTx(counterpartyEntityId: string, tokenId: number): EntityTxOf<'extendCredit'> {
  return {
    type: 'extendCredit',
    data: { counterpartyEntityId, tokenId, amount: 0n },
  };
}

export function buildMoveSettlementContinuation(
  entityId: string,
  tokenId: number,
  amount: bigint,
  postSettleOp: MovePostSettleOp,
  broadcast: boolean,
): SettlementContinuationPlan {
  const selfEntityId = String(entityId || '').trim().toLowerCase();
  const actions: SettlementContinuationPlan['actions'] = [];
  if (postSettleOp.type === 'r2r') {
    actions.push({
      type: 'r2r',
      toEntityId: postSettleOp.recipientEntityId,
      tokenId,
      amount,
    });
  }
  if (postSettleOp.type === 'r2e') {
    actions.push({
      type: 'r2e',
      receivingEntity: encodeExternalEoaAsEntity(postSettleOp.recipientEoa),
      tokenId,
      amount,
    });
  }
  if (postSettleOp.type === 'reserve_to_collateral') {
    const receivingEntityId = String(postSettleOp.targetEntityId || selfEntityId)
      .trim()
      .toLowerCase();
    actions.push({
      type: 'r2c',
      counterpartyId: postSettleOp.counterpartyEntityId,
      ...(receivingEntityId !== selfEntityId ? { receivingEntityId } : {}),
      tokenId,
      amount,
    });
  }
  return { actions, broadcast };
}

import type { JurisdictionEvent } from '../types';
import type { CanonicalJEvent } from './event-catalog';
import {
  decodeFields,
  defineEventNormalizer,
  isActionKind,
  isBatchOperationType,
  isPositiveUint256,
  normalizeAddress,
  normalizeBigNumberish,
  normalizeBytes32,
  normalizeEntity,
  normalizeInt,
  normalizeString,
  type JurisdictionEventNormalizer,
} from './event-normalization-primitives';
import { walletEventNormalizers } from './event-normalizers-wallet';

const foundation = defineEventNormalizer('FoundationBootstrapped', data =>
  decodeFields(data, {
    recipient: normalizeAddress,
    boardHash: normalizeBytes32,
    controlTokenId: normalizeBigNumberish,
    dividendTokenId: normalizeBigNumberish,
  }));

const entityRegistered = defineEventNormalizer('EntityRegistered', data =>
  decodeFields(data, {
    entityId: normalizeBytes32,
    entityNumber: normalizeBigNumberish,
    boardHash: normalizeBytes32,
  }));

const boardActivated = defineEventNormalizer('BoardActivated', data => {
  const decoded = decodeFields(data, {
    entityId: normalizeBytes32,
    previousBoardHash: normalizeBytes32,
    newBoardHash: normalizeBytes32,
    previousBoardValidUntil: normalizeBigNumberish,
  });
  return decoded && BigInt(decoded.previousBoardValidUntil) > 0n ? decoded : null;
});

const reserveUpdated = defineEventNormalizer('ReserveUpdated', data =>
  decodeFields(data, {
    entity: normalizeEntity,
    tokenId: normalizeInt,
    newBalance: normalizeBigNumberish,
  }));

const secretRevealed = defineEventNormalizer('SecretRevealed', data => {
  const decoded = decodeFields(data, {
    hashlock: normalizeString,
    revealer: normalizeString,
    secret: normalizeString,
  });
  return decoded ? { ...decoded, revealer: decoded.revealer.toLowerCase() } : null;
});

const accountSettled = defineEventNormalizer('AccountSettled', data =>
  decodeFields(data, {
    leftEntity: normalizeEntity,
    rightEntity: normalizeEntity,
    tokenId: normalizeInt,
    leftReserve: normalizeBigNumberish,
    rightReserve: normalizeBigNumberish,
    collateral: normalizeBigNumberish,
    ondelta: normalizeBigNumberish,
    nonce: normalizeInt,
  }));

const disputeStarted = defineEventNormalizer('DisputeStarted', data => {
  const decoded = decodeFields(data, {
    sender: normalizeEntity,
    counterentity: normalizeEntity,
    nonce: normalizeBigNumberish,
    proofbodyHash: normalizeString,
    disputeTimeout: normalizeInt,
  });
  if (!decoded || decoded.disputeTimeout <= 0) return null;
  const batchNonce = normalizeInt(data['batchNonce']);
  return {
    ...decoded,
    watchSeed: normalizeString(data['watchSeed']) ?? '0x',
    starterInitialArguments:
      normalizeString(data['starterInitialArguments']) ?? '0x',
    starterIncrementedArguments:
      normalizeString(data['starterIncrementedArguments']) ?? '0x',
    ...(batchNonce !== null ? { batchNonce } : {}),
  };
});

const disputeFinalized = defineEventNormalizer('DisputeFinalized', data => {
  const decoded = decodeFields(data, {
    sender: normalizeEntity,
    counterentity: normalizeEntity,
    initialNonce: normalizeBigNumberish,
    initialProofbodyHash: normalizeString,
    finalProofbodyHash: normalizeString,
  });
  if (!decoded) return null;
  const batchNonce = normalizeInt(data['batchNonce']);
  return { ...decoded, ...(batchNonce !== null ? { batchNonce } : {}) };
});

const debtCreated = defineEventNormalizer('DebtCreated', data =>
  decodeFields(data, {
    debtor: normalizeEntity,
    creditor: normalizeEntity,
    tokenId: normalizeInt,
    amount: normalizeBigNumberish,
    debtIndex: normalizeInt,
  }));

const debtEnforced = defineEventNormalizer('DebtEnforced', data =>
  decodeFields(data, {
    debtor: normalizeEntity,
    creditor: normalizeEntity,
    tokenId: normalizeInt,
    amountPaid: normalizeBigNumberish,
    remainingAmount: normalizeBigNumberish,
    newDebtIndex: normalizeInt,
  }));

const debtForgiven = defineEventNormalizer('DebtForgiven', data =>
  decodeFields(data, {
    debtor: normalizeEntity,
    creditor: normalizeEntity,
    tokenId: normalizeInt,
    amountForgiven: normalizeBigNumberish,
    debtIndex: normalizeInt,
  }));

const hankoBatchProcessed = defineEventNormalizer('HankoBatchProcessed', data => {
  const decoded = decodeFields(data, {
    entityId: normalizeBytes32,
    batchHash: normalizeBytes32,
    nonce: normalizeInt,
  });
  return decoded && decoded.nonce >= 1 ? decoded : null;
});

const batchOperationSkipped = defineEventNormalizer('BatchOperationSkipped', data => {
  const decoded = decodeFields(data, {
    entityId: normalizeBytes32,
    batchHash: normalizeBytes32,
    nonce: normalizeInt,
    operationIndex: normalizeInt,
  });
  const operationType = normalizeInt(data['operationType']);
  const reason = normalizeInt(data['reason']);
  if (
    !decoded ||
    decoded.nonce < 1 ||
    decoded.operationIndex < 0 ||
    !isBatchOperationType(operationType) ||
    reason !== 0
  ) {
    return null;
  }
  return { ...decoded, operationType, reason };
});

const actionExecuted = defineEventNormalizer('EntityProviderActionExecuted', data => {
  const decoded = decodeFields(data, {
    entityId: normalizeBytes32,
    actionNonce: normalizeBigNumberish,
    actionHash: normalizeBytes32,
  });
  const actionKind = normalizeInt(data['actionKind']);
  if (!decoded || !isPositiveUint256(decoded.actionNonce) || !isActionKind(actionKind)) {
    return null;
  }
  return { ...decoded, actionKind };
});

const actionCancelled = defineEventNormalizer('EntityProviderActionCancelled', data => {
  const decoded = decodeFields(data, {
    entityId: normalizeBytes32,
    actionNonce: normalizeBigNumberish,
    cancelledActionHash: normalizeBytes32,
    cancelHash: normalizeBytes32,
  });
  const cancelledActionKind = normalizeInt(data['cancelledActionKind']);
  if (
    !decoded ||
    !isPositiveUint256(decoded.actionNonce) ||
    !isActionKind(cancelledActionKind)
  ) {
    return null;
  }
  return { ...decoded, cancelledActionKind };
});

export const EVENT_NORMALIZERS: Readonly<
  Record<JurisdictionEvent['type'] | CanonicalJEvent, JurisdictionEventNormalizer>
> = {
  FoundationBootstrapped: foundation,
  EntityRegistered: entityRegistered,
  BoardActivated: boardActivated,
  ReserveUpdated: reserveUpdated,
  ...walletEventNormalizers,
  SecretRevealed: secretRevealed,
  AccountSettled: accountSettled,
  DisputeStarted: disputeStarted,
  DisputeFinalized: disputeFinalized,
  DebtCreated: debtCreated,
  DebtEnforced: debtEnforced,
  DebtForgiven: debtForgiven,
  HankoBatchProcessed: hankoBatchProcessed,
  BatchOperationSkipped: batchOperationSkipped,
  EntityProviderActionExecuted: actionExecuted,
  EntityProviderActionCancelled: actionCancelled,
};

import type { JurisdictionEvent } from '../../types/jurisdiction-events';
import type { CanonicalJEvent } from './event-catalog';
import {
  decodeFields,
  defineEventNormalizer,
  isActionKind,
  isPositiveUint256,
  normalizeAddress,
  normalizeBigNumberish,
  normalizeBoolean,
  normalizeBytes32,
  normalizeEntity,
  normalizeHexBytes,
  normalizeInt,
  normalizeString,
  type JurisdictionEventNormalizer,
} from './event-normalization-primitives';
import { walletEventNormalizers } from './event-normalizers-wallet';
import { validateProofBody } from './batch-validation';
import type { ProofBodyStruct } from '../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';

const normalizeProofBody = (value: unknown): ProofBodyStruct =>
  validateProofBody(structuredClone(value), 'J_EVENT_PROOFBODY') as ProofBodyStruct;

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
    proposerIsLeft: normalizeBoolean,
    proofbodyHash: normalizeString,
    watchSeed: normalizeBytes32,
    starterInitialArguments: normalizeHexBytes,
    starterCounterArguments: normalizeHexBytes,
    starterCounterProofCommitment: normalizeBytes32,
    initialProofbody: normalizeProofBody,
    disputeTimeout: normalizeInt,
    disputeStartTimestamp: normalizeInt,
    leftResponseSeconds: normalizeInt,
    rightResponseSeconds: normalizeInt,
  });
  if (
    !decoded ||
    decoded.disputeStartTimestamp <= 0 ||
    decoded.leftResponseSeconds < 0 ||
    decoded.rightResponseSeconds < 0 ||
    decoded.disputeTimeout !==
      decoded.disputeStartTimestamp + decoded.leftResponseSeconds + decoded.rightResponseSeconds
  ) return null;
  const batchNonce = normalizeInt(data['batchNonce']);
  return {
    ...decoded,
    ...(batchNonce !== null ? { batchNonce } : {}),
  };
});

const disputeFinalized = defineEventNormalizer('DisputeFinalized', data => {
  const decoded = decodeFields(data, {
    sender: normalizeEntity,
    counterentity: normalizeEntity,
    initialNonce: normalizeBigNumberish,
    // Recovered from calldata only after finalizationEvidenceHash matches the
    // receipt-authenticated event commitment.
    initialProofbodyHash: normalizeString,
    finalProofbodyHash: normalizeString,
    finalizationEvidenceHash: normalizeString,
    finalProofbody: normalizeProofBody,
  });
  if (!decoded) return null;
  const batchNonce = normalizeInt(data['batchNonce']);
  return { ...decoded, ...(batchNonce !== null ? { batchNonce } : {}) };
});

const normalizeBytes32Quartet = (value: unknown): [string, string, string, string] | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const reveals = value.map(normalizeBytes32);
  if (reveals.some(reveal => reveal === null)) return null;
  return reveals as [string, string, string, string];
};

const hashLadderRevealRegistered = defineEventNormalizer('HashLadderRevealRegistered', data => {
  const decoded = decodeFields(data, {
    entity: normalizeEntity,
    counterpartyEntity: normalizeEntity,
    ladderHash: normalizeBytes32,
    fillRatio: normalizeInt,
    fullSecret: normalizeBytes32,
    reveals: normalizeBytes32Quartet,
    targetRole: normalizeBoolean,
    revealedAt: normalizeInt,
  });
  // Solidity emits uint16. Enforce that ABI boundary again before signed
  // J-range consensus: synthetic/provider-corrupt evidence must not install a
  // ratio that later fails Runtime's canonical uint16 settlement conversion.
  if (
    !decoded
    || decoded.fillRatio <= 0
    || decoded.fillRatio > 0xffff
    || decoded.revealedAt <= 0
  ) return null;
  return decoded;
});

const counterDisputeRegistered = defineEventNormalizer('CounterDisputeRegistered', data =>
  decodeFields(data, {
    sender: normalizeEntity,
    counterentity: normalizeEntity,
    nonce: normalizeInt,
    proposerIsLeft: normalizeBoolean,
    proofbodyHash: normalizeBytes32,
    counterProofbody: normalizeProofBody,
  }),
);

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
  CounterDisputeRegistered: counterDisputeRegistered,
  HashLadderRevealRegistered: hashLadderRevealRegistered,
  DebtCreated: debtCreated,
  DebtEnforced: debtEnforced,
  DebtForgiven: debtForgiven,
  HankoBatchProcessed: hankoBatchProcessed,
  EntityProviderActionExecuted: actionExecuted,
  EntityProviderActionCancelled: actionCancelled,
};

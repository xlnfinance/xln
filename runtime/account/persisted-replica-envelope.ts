import { FINANCIAL, LIMITS } from '../config/constants';
import type { AccountReplica } from '../types/account';
import { validatePersistedFrameDelta } from './persisted-state-core';
import {
  persistedArray,
  persistedBigInt,
  persistedBoolean,
  persistedBytes32,
  persistedEnum,
  persistedHex,
  persistedMap,
  persistedOptional,
  persistedRecord,
  persistedString,
  persistedTokenId,
  persistedUint,
  persistedUint256,
} from './persisted-value-primitives';

const WITHDRAWAL_STATUSES = new Set([
  'pending', 'approved', 'rejected', 'timed_out',
] as const);
const WITHDRAWAL_DIRECTIONS = new Set(['outgoing', 'incoming'] as const);

const validateProofHeader = (account: Record<string, unknown>, context: string): void => {
  const header = persistedRecord(account['proofHeader'], [
    'fromEntity', 'toEntity', 'nextProofNonce',
  ], [], `${context}.proofHeader`);
  persistedBytes32(header['fromEntity'], `${context}.proofHeader.fromEntity`);
  persistedBytes32(header['toEntity'], `${context}.proofHeader.toEntity`);
  if (header['fromEntity'] === header['toEntity']) {
    throw new Error(`${context}.proofHeader endpoints must be distinct`);
  }
  persistedUint(header['nextProofNonce'], `${context}.proofHeader.nextProofNonce`);
};

const validateProofBody = (account: Record<string, unknown>, context: string): void => {
  const body = persistedRecord(account['proofBody'], [
    'tokenIds', 'deltas',
  ], ['htlcLocks'], `${context}.proofBody`);
  const tokenIds = persistedArray(body['tokenIds'], `${context}.proofBody.tokenIds`, LIMITS.MAX_ACCOUNT_TOKEN_ROWS)
    .map((tokenId, index) => persistedTokenId(tokenId, `${context}.proofBody.tokenIds[${index}]`));
  const deltas = persistedArray(body['deltas'], `${context}.proofBody.deltas`, LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  if (deltas.length !== tokenIds.length) throw new Error(`${context}.proofBody token/delta length mismatch`);
  let previous = -1;
  tokenIds.forEach((tokenId, index) => {
    if (tokenId <= previous) throw new Error(`${context}.proofBody.tokenIds must be sorted and unique`);
    previous = tokenId;
    persistedBigInt(deltas[index], `${context}.proofBody.deltas[${index}]`, -(1n << 255n), (1n << 255n) - 1n);
  });
  if (body['htlcLocks'] !== undefined) {
    persistedArray(body['htlcLocks'], `${context}.proofBody.htlcLocks`, LIMITS.MAX_ACCOUNT_HTLC_LOCKS)
      .forEach((raw, index) => {
        const lock = persistedRecord(raw, [
          'deltaIndex', 'amount', 'revealedUntilTimestamp', 'hash',
        ], [], `${context}.proofBody.htlcLocks[${index}]`);
        const deltaIndex = persistedUint(lock['deltaIndex'], `${context}.proofBody.htlcLocks[${index}].deltaIndex`);
        if (deltaIndex >= tokenIds.length) throw new Error(`${context}.proofBody.htlcLocks[${index}] deltaIndex out of range`);
        persistedUint256(lock['amount'], `${context}.proofBody.htlcLocks[${index}].amount`);
        persistedUint(lock['revealedUntilTimestamp'], `${context}.proofBody.htlcLocks[${index}].revealedUntilTimestamp`);
        persistedBytes32(lock['hash'], `${context}.proofBody.htlcLocks[${index}].hash`);
      });
  }
};

const validateWithdrawals = (account: Record<string, unknown>, context: string): void => {
  const withdrawals = persistedMap(
    account['pendingWithdrawals'],
    `${context}.pendingWithdrawals`,
    LIMITS.ACCOUNT_MEMPOOL_SIZE,
  );
  for (const [key, raw] of withdrawals) {
    const withdrawal = persistedRecord(raw, [
      'requestId', 'tokenId', 'amount', 'requestedAt', 'direction', 'status',
    ], ['signature'], `${context}.pendingWithdrawals[${String(key)}]`);
    const requestId = persistedString(withdrawal['requestId'], `${context}.pendingWithdrawals.requestId`, 256);
    if (key !== requestId) throw new Error(`${context}.pendingWithdrawals requestId must match Map key`);
    persistedTokenId(withdrawal['tokenId'], `${context}.pendingWithdrawals[${requestId}].tokenId`);
    persistedBigInt(
      withdrawal['amount'],
      `${context}.pendingWithdrawals[${requestId}].amount`,
      1n,
      FINANCIAL.MAX_PAYMENT_AMOUNT,
    );
    persistedUint(withdrawal['requestedAt'], `${context}.pendingWithdrawals[${requestId}].requestedAt`);
    persistedEnum(withdrawal['direction'], WITHDRAWAL_DIRECTIONS, `${context}.pendingWithdrawals[${requestId}].direction`);
    persistedEnum(withdrawal['status'], WITHDRAWAL_STATUSES, `${context}.pendingWithdrawals[${requestId}].status`);
    persistedOptional(withdrawal['signature'], item => persistedHex(item, `${context}.pendingWithdrawals[${requestId}].signature`));
  }
};

const validateRebalanceShadow = (account: Record<string, unknown>, context: string): void => {
  const shadow = persistedRecord(account['shadow'], ['rebalance'], [
    'rejectedFrameEvidence',
  ], `${context}.shadow`);
  const rebalance = persistedRecord(shadow['rebalance'], [
    'policy', 'submittedAtByToken',
  ], ['activeQuote', 'pendingRequest'], `${context}.shadow.rebalance`);
  const policies = persistedMap(rebalance['policy'], `${context}.shadow.rebalance.policy`, LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  for (const [key, raw] of policies) {
    const tokenId = persistedTokenId(key, `${context}.shadow.rebalance.policy.key`);
    const policy = persistedRecord(raw, [
      'r2cRequestSoftLimit', 'hardLimit', 'maxAcceptableFee',
    ], ['setByLeft'], `${context}.shadow.rebalance.policy[${tokenId}]`);
    const soft = persistedUint256(policy['r2cRequestSoftLimit'], `${context}.shadow.rebalance.policy[${tokenId}].r2cRequestSoftLimit`);
    const hard = persistedUint256(policy['hardLimit'], `${context}.shadow.rebalance.policy[${tokenId}].hardLimit`);
    if (hard < soft) throw new Error(`${context}.shadow.rebalance.policy[${tokenId}] hardLimit < softLimit`);
    persistedUint256(policy['maxAcceptableFee'], `${context}.shadow.rebalance.policy[${tokenId}].maxAcceptableFee`);
    persistedOptional(policy['setByLeft'], item => persistedBoolean(item, `${context}.shadow.rebalance.policy[${tokenId}].setByLeft`));
  }
  const submitted = persistedMap(
    rebalance['submittedAtByToken'],
    `${context}.shadow.rebalance.submittedAtByToken`,
    LIMITS.MAX_ACCOUNT_TOKEN_ROWS,
  );
  for (const [key, timestamp] of submitted) {
    persistedTokenId(key, `${context}.shadow.rebalance.submittedAtByToken.key`);
    persistedUint(timestamp, `${context}.shadow.rebalance.submittedAtByToken[${String(key)}]`);
  }
};

const validatePendingForwards = (account: Record<string, unknown>, context: string): void => {
  if (account['pendingForwards'] === undefined) return;
  persistedArray(account['pendingForwards'], `${context}.pendingForwards`, LIMITS.ACCOUNT_MEMPOOL_SIZE)
    .forEach((raw, index) => {
      const forward = persistedRecord(raw, ['tokenId', 'amount', 'route'], [
        'description', 'deliveryMode', 'trustedGatewayEntityId',
      ], `${context}.pendingForwards[${index}]`);
      persistedTokenId(forward['tokenId'], `${context}.pendingForwards[${index}].tokenId`);
      persistedBigInt(forward['amount'], `${context}.pendingForwards[${index}].amount`, 1n, FINANCIAL.MAX_PAYMENT_AMOUNT);
      persistedArray(forward['route'], `${context}.pendingForwards[${index}].route`, FINANCIAL.MAX_ROUTE_HOPS)
        .forEach((entityId, hop) => persistedBytes32(entityId, `${context}.pendingForwards[${index}].route[${hop}]`));
      persistedOptional(forward['description'], item => persistedString(item, `${context}.pendingForwards[${index}].description`, 256));
      if (forward['deliveryMode'] !== undefined && forward['deliveryMode'] !== 'trusted') {
        throw new Error(`${context}.pendingForwards[${index}].deliveryMode is invalid`);
      }
      persistedOptional(
        forward['trustedGatewayEntityId'],
        item => persistedBytes32(item, `${context}.pendingForwards[${index}].trustedGatewayEntityId`),
      );
    });
};

const validateDisputeScalars = (account: Record<string, unknown>, context: string): void => {
  for (const field of [
    'currentDisputeProofNonce', 'counterpartyDisputeProofNonce',
  ] as const) persistedOptional(account[field], item => persistedUint(item, `${context}.${field}`));
  for (const field of [
    'currentDisputeProofBodyHash', 'currentDisputeHash',
    'counterpartyDisputeProofBodyHash', 'counterpartyDisputeHash',
    'lastRollbackFrameHash',
  ] as const) persistedOptional(account[field], item => persistedBytes32(item, `${context}.${field}`));
  for (const field of [
    'currentFrameHanko', 'counterpartyFrameHanko', 'currentDisputeProofHanko',
    'counterpartyDisputeProofHanko', 'counterpartySettlementHanko', 'hankoSignature',
  ] as const) persistedOptional(account[field], item => persistedHex(item, `${context}.${field}`));
};

export const validatePersistedAccountReplicaEnvelope = (
  account: Record<string, unknown>,
  context: string,
): void => {
  validateProofHeader(account, context);
  validateProofBody(account, context);
  validateWithdrawals(account, context);
  validateRebalanceShadow(account, context);
  validatePendingForwards(account, context);
  validateDisputeScalars(account, context);
  persistedArray(account['pendingSignatures'], `${context}.pendingSignatures`, LIMITS.ACCOUNT_MEMPOOL_SIZE)
    .forEach((signature, index) => persistedString(signature, `${context}.pendingSignatures[${index}]`));
  const currentHeight = persistedUint(account['currentHeight'], `${context}.currentHeight`);
  persistedUint(account['rollbackCount'], `${context}.rollbackCount`);
  const currentFrame = account['currentFrame'] as AccountReplica['currentFrame'];
  if (currentFrame.height !== currentHeight) {
    throw new Error(`${context}.currentHeight must equal currentFrame.height`);
  }
  persistedBytes32(currentFrame.accountStateRoot, `${context}.currentFrame.accountStateRoot`);
  if (currentFrame.height > 0) {
    persistedBytes32(currentFrame.stateHash, `${context}.currentFrame.stateHash`);
    if (currentFrame.height > 1) {
      persistedBytes32(currentFrame.prevFrameHash, `${context}.currentFrame.prevFrameHash`);
    }
  }
  currentFrame.deltas.forEach((delta, index) => validatePersistedFrameDelta(delta, `${context}.currentFrame.deltas[${index}]`));
  if (account['pendingFrame'] !== undefined) {
    const pending = account['pendingFrame'] as AccountReplica['pendingFrame'];
    if (!pending || pending.height !== currentHeight + 1) {
      throw new Error(`${context}.pendingFrame.height must follow currentHeight`);
    }
    persistedBytes32(pending.accountStateRoot, `${context}.pendingFrame.accountStateRoot`);
    persistedBytes32(pending.stateHash, `${context}.pendingFrame.stateHash`);
    pending?.deltas.forEach((delta, index) => validatePersistedFrameDelta(delta, `${context}.pendingFrame.deltas[${index}]`));
  }
};

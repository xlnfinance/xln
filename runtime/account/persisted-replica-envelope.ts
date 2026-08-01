import { FINANCIAL, LIMITS } from '../config/constants';
import type { AccountReplica } from '../types/account';
import { validatePersistedFrameDelta } from './persisted-state-core';
import {
  persistedArray,
  persistedBigInt,
  persistedBytes32,
  persistedMap,
  persistedRecord,
  persistedString,
  persistedTokenId,
  persistedUint,
  persistedUint256,
} from './persisted-value-primitives';

const validateProofHeader = (account: Record<string, unknown>, context: string): void => {
  const header = persistedRecord(account['proofHeader'], `${context}.proofHeader`);
  const from = persistedBytes32(header['fromEntity'], `${context}.proofHeader.fromEntity`);
  const to = persistedBytes32(header['toEntity'], `${context}.proofHeader.toEntity`);
  if (from === to) throw new Error(`${context}.proofHeader endpoints must be distinct`);
  persistedUint(header['nextProofNonce'], `${context}.proofHeader.nextProofNonce`);
};

const validateProofBody = (account: Record<string, unknown>, context: string): void => {
  const body = persistedRecord(account['proofBody'], `${context}.proofBody`);
  const tokenIds = persistedArray(
    body['tokenIds'], `${context}.proofBody.tokenIds`, LIMITS.MAX_ACCOUNT_TOKEN_ROWS,
  ).map((tokenId, index) => persistedTokenId(tokenId, `${context}.proofBody.tokenIds[${index}]`));
  const deltas = persistedArray(body['deltas'], `${context}.proofBody.deltas`, LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  if (deltas.length !== tokenIds.length) throw new Error(`${context}.proofBody token/delta length mismatch`);
  tokenIds.forEach((tokenId, index) => {
    if (index > 0 && tokenId <= tokenIds[index - 1]!) {
      throw new Error(`${context}.proofBody.tokenIds must be sorted and unique`);
    }
    persistedBigInt(deltas[index], `${context}.proofBody.deltas[${index}]`, -(1n << 255n), (1n << 255n) - 1n);
  });
  persistedArray(body['htlcLocks'] ?? [], `${context}.proofBody.htlcLocks`, LIMITS.MAX_ACCOUNT_HTLC_LOCKS)
    .forEach((raw, index) => {
      const lock = persistedRecord(raw, `${context}.proofBody.htlcLocks[${index}]`);
      const deltaIndex = persistedUint(lock['deltaIndex'], `${context}.proofBody.htlcLocks[${index}].deltaIndex`);
      if (deltaIndex >= tokenIds.length) throw new Error(`${context}.proofBody HTLC deltaIndex out of range`);
      persistedUint256(lock['amount'], `${context}.proofBody.htlcLocks[${index}].amount`);
      persistedUint(lock['revealedUntilTimestamp'], `${context}.proofBody.htlcLocks[${index}].revealedUntilTimestamp`);
      persistedBytes32(lock['hash'], `${context}.proofBody.htlcLocks[${index}].hash`);
    });
};

const validateWithdrawals = (account: Record<string, unknown>, context: string): void => {
  const withdrawals = persistedMap(
    account['pendingWithdrawals'], `${context}.pendingWithdrawals`, LIMITS.ACCOUNT_MEMPOOL_SIZE,
  );
  for (const [key, raw] of withdrawals) {
    const withdrawal = persistedRecord(raw, `${context}.pendingWithdrawals[${String(key)}]`);
    const requestId = persistedString(withdrawal['requestId'], `${context}.pendingWithdrawals.requestId`, 256);
    if (key !== requestId) throw new Error(`${context}.pendingWithdrawals requestId must match Map key`);
    persistedTokenId(withdrawal['tokenId'], `${context}.pendingWithdrawals[${requestId}].tokenId`);
    persistedBigInt(
      withdrawal['amount'], `${context}.pendingWithdrawals[${requestId}].amount`,
      1n, FINANCIAL.MAX_PAYMENT_AMOUNT,
    );
    persistedUint(withdrawal['requestedAt'], `${context}.pendingWithdrawals[${requestId}].requestedAt`);
    if (!['outgoing', 'incoming'].includes(String(withdrawal['direction']))) {
      throw new Error(`${context}.pendingWithdrawals[${requestId}].direction is invalid`);
    }
    if (!['pending', 'approved', 'rejected', 'timed_out'].includes(String(withdrawal['status']))) {
      throw new Error(`${context}.pendingWithdrawals[${requestId}].status is invalid`);
    }
  }
};

export const validatePersistedAccountReplicaEnvelope = (
  account: Record<string, unknown>,
  context: string,
): void => {
  validateProofHeader(account, context);
  validateProofBody(account, context);
  validateWithdrawals(account, context);
  const currentHeight = persistedUint(account['currentHeight'], `${context}.currentHeight`);
  persistedUint(account['rollbackCount'], `${context}.rollbackCount`);
  const currentFrame = account['currentFrame'] as AccountReplica['currentFrame'];
  if (currentFrame.height !== currentHeight) {
    throw new Error(`${context}.currentHeight must equal currentFrame.height`);
  }
  currentFrame.deltas.forEach((delta, index) =>
    validatePersistedFrameDelta(delta, `${context}.currentFrame.deltas[${index}]`));
  const pending = account['pendingFrame'] as AccountReplica['pendingFrame'];
  if (!pending) return;
  if (pending.height !== currentHeight + 1) throw new Error(`${context}.pendingFrame height is not next`);
  pending.deltas.forEach((delta, index) =>
    validatePersistedFrameDelta(delta, `${context}.pendingFrame.deltas[${index}]`));
};

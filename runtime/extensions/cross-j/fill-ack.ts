import { ethers } from 'ethers';
import { getCrossJurisdictionCommittedProofRatio } from './index';
import type { AccountTx } from '../../types';
import type { CrossJurisdictionPendingFill } from '../../types/cross-jurisdiction';

export const CROSS_J_PENDING_FILL_ACK_TTL_MS = 5 * 60_000;

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

const normalizeAckKind = (tx: CrossSwapFillAckTx): CrossJurisdictionPendingFill['ackKind'] => {
  if (tx.data.ackKind === 'cancel') return 'cancel';
  if (tx.data.ackKind === 'fill') return 'fill';
  return tx.data.cancelRemainder === true &&
    (tx.data.executionSourceAmount ?? 0n) === 0n &&
    (tx.data.executionTargetAmount ?? 0n) === 0n
    ? 'cancel'
    : 'fill';
};

export const buildCrossJurisdictionFillId = (input: {
  routeHash?: string;
  offerId: string;
  fillSeq?: number;
  cumulativeFillRatio: number;
  fillNumerator?: bigint | undefined;
  fillDenominator?: bigint | undefined;
  cumulativeSourceAmount?: bigint;
  cumulativeTargetAmount?: bigint;
}): string => ethers.keccak256(ethers.toUtf8Bytes([
  input.routeHash || '',
  input.offerId,
  Math.max(0, Math.floor(Number(input.fillSeq ?? 0) || 0)),
  getCrossJurisdictionCommittedProofRatio({
    orderId: input.offerId,
    cumulativeFillRatio: input.cumulativeFillRatio,
    fillNumerator: input.fillNumerator,
    fillDenominator: input.fillDenominator,
  }),
  (input.cumulativeSourceAmount ?? 0n).toString(),
  (input.cumulativeTargetAmount ?? 0n).toString(),
].join('|'))).toLowerCase();

const getCrossJurisdictionFillAckProofRatio = (tx: CrossSwapFillAckTx): number =>
  getCrossJurisdictionCommittedProofRatio({
    orderId: tx.data.offerId,
    cumulativeFillRatio: tx.data.cumulativeFillRatio,
    fillNumerator: tx.data.fillNumerator,
    fillDenominator: tx.data.fillDenominator,
  });

export const buildCrossJurisdictionPendingFillFromAck = (
  tx: CrossSwapFillAckTx,
  updatedAt: number,
): CrossJurisdictionPendingFill | null => {
  const fillSeq = Math.max(0, Math.floor(Number(tx.data.fillSeq ?? 0) || 0));
  const cumulativeFillRatio = getCrossJurisdictionFillAckProofRatio(tx);
  const cumulativeSourceAmount = tx.data.cumulativeSourceAmount ?? 0n;
  const cumulativeTargetAmount = tx.data.cumulativeTargetAmount ?? 0n;
  if (cumulativeFillRatio <= 0 && normalizeAckKind(tx) !== 'cancel') return null;
  const previousFillSeq = tx.data.previousFillSeq === undefined
    ? undefined
    : Math.max(0, Math.floor(Number(tx.data.previousFillSeq) || 0));
  const fillId = buildCrossJurisdictionFillId({
      routeHash: tx.data.routeHash || '',
      offerId: tx.data.offerId,
      fillSeq,
      cumulativeFillRatio,
      fillNumerator: tx.data.fillNumerator,
      fillDenominator: tx.data.fillDenominator,
      cumulativeSourceAmount,
      cumulativeTargetAmount,
  });
  return {
    fillId,
    ackKind: normalizeAckKind(tx),
    ...(previousFillSeq !== undefined ? { previousFillSeq } : {}),
    fillSeq,
    cumulativeFillRatio,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
    ...(tx.data.fillNumerator !== undefined ? { fillNumerator: tx.data.fillNumerator } : {}),
    ...(tx.data.fillDenominator !== undefined ? { fillDenominator: tx.data.fillDenominator } : {}),
    routeHash: String(tx.data.routeHash || ''),
    updatedAt: Number(updatedAt || 0),
    firstSeenAt: Number(updatedAt || 0),
  };
};

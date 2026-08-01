import { LIMITS } from '../config/constants';
import type { Delta } from '../types/account';
import {
  persistedBigInt,
  persistedAddress,
  persistedBoolean,
  persistedBytes32,
  persistedMap,
  persistedOptional,
  persistedRecord,
  persistedString,
  persistedTokenId,
  persistedUint,
  persistedUint16,
  persistedUint256,
  persistedInt256,
} from './persisted-value-primitives';

const validateDeltaValue = (value: unknown, context: string): Delta => {
  const delta = persistedRecord(value, [
    'tokenId', 'collateral', 'ondelta', 'offdelta', 'leftCreditLimit',
    'rightCreditLimit', 'leftAllowance', 'rightAllowance', 'leftHold',
    'rightHold',
  ], [], context);
  const tokenId = persistedTokenId(delta['tokenId'], `${context}.tokenId`);
  persistedUint256(delta['collateral'], `${context}.collateral`);
  persistedInt256(delta['ondelta'], `${context}.ondelta`);
  persistedInt256(delta['offdelta'], `${context}.offdelta`);
  for (const field of [
    'leftCreditLimit', 'rightCreditLimit', 'leftAllowance', 'rightAllowance',
    'leftHold', 'rightHold',
  ] as const) persistedUint256(delta[field], `${context}.${field}`);
  return { ...delta, tokenId } as unknown as Delta;
};

const validateDeltaMap = (value: unknown, context: string): void => {
  const deltas = persistedMap(value, context, LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  for (const [key, rawDelta] of deltas) {
    const tokenId = persistedTokenId(key, `${context}.key`);
    const delta = validateDeltaValue(rawDelta, `${context}[${tokenId}]`);
    if (delta.tokenId !== tokenId) {
      throw new Error(`${context}[${tokenId}].tokenId must match its Map key`);
    }
  }
};

const validateCreditLimits = (value: unknown, context: string): void => {
  const limits = persistedRecord(value, ['ownLimit', 'peerLimit'], [], context);
  persistedUint256(limits['ownLimit'], `${context}.ownLimit`);
  persistedUint256(limits['peerLimit'], `${context}.peerLimit`);
};

const validateDisputeConfig = (value: unknown, context: string): void => {
  const config = persistedRecord(
    value,
    ['leftDisputeDelay', 'rightDisputeDelay'],
    [],
    context,
  );
  persistedUint16(config['leftDisputeDelay'], `${context}.leftDisputeDelay`);
  persistedUint16(config['rightDisputeDelay'], `${context}.rightDisputeDelay`);
};

const validateTokenAmountMap = (
  value: unknown,
  context: string,
  minimum: bigint,
): void => {
  const map = persistedMap(value, context, LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  for (const [key, amount] of map) {
    persistedTokenId(key, `${context}.key`);
    persistedBigInt(amount, `${context}[${String(key)}]`, minimum, (1n << 256n) - 1n);
  }
};

const validateRebalanceFeeStates = (value: unknown, context: string): void => {
  const states = persistedMap(value, context, LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
  for (const [key, raw] of states) {
    const tokenId = persistedTokenId(key, `${context}.key`);
    const state = persistedRecord(raw, [
      'requestId', 'feeTokenId', 'feePaidUpfront', 'requestedAmount',
      'policyVersion', 'requestedAt', 'requestedByLeft',
    ], ['refund'], `${context}[${tokenId}]`);
    persistedString(state['requestId'], `${context}[${tokenId}].requestId`, 256);
    persistedTokenId(state['feeTokenId'], `${context}[${tokenId}].feeTokenId`);
    persistedUint256(state['feePaidUpfront'], `${context}[${tokenId}].feePaidUpfront`);
    persistedBigInt(state['requestedAmount'], `${context}[${tokenId}].requestedAmount`, 1n, (1n << 256n) - 1n);
    persistedUint(state['policyVersion'], `${context}[${tokenId}].policyVersion`);
    if (state['policyVersion'] === 0) throw new Error(`${context}[${tokenId}].policyVersion must be positive`);
    persistedUint(state['requestedAt'], `${context}[${tokenId}].requestedAt`);
    persistedBoolean(state['requestedByLeft'], `${context}[${tokenId}].requestedByLeft`);
    persistedOptional(state['refund'], rawRefund => {
      const refund = persistedRecord(rawRefund, ['reason', 'refundedAmount'], [], `${context}[${tokenId}].refund`);
      if (!['policy_mismatch', 'timeout', 'fee_too_low', 'manual'].includes(String(refund['reason']))) {
        throw new Error(`${context}[${tokenId}].refund.reason is invalid`);
      }
      persistedUint256(refund['refundedAmount'], `${context}[${tokenId}].refund.refundedAmount`);
    });
  }
};

export const validatePersistedAccountStateCore = (
  state: Record<string, unknown>,
  context: string,
): void => {
  persistedBytes32(state['leftEntity'], `${context}.leftEntity`);
  persistedBytes32(state['rightEntity'], `${context}.rightEntity`);
  const domain = persistedRecord(
    state['domain'],
    ['chainId', 'depositoryAddress'],
    [],
    `${context}.domain`,
  );
  const chainId = persistedUint(domain['chainId'], `${context}.domain.chainId`);
  if (chainId === 0) throw new Error(`${context}.domain.chainId must be positive`);
  persistedAddress(domain['depositoryAddress'], `${context}.domain.depositoryAddress`);
  persistedBytes32(state['watchSeed'], `${context}.watchSeed`);
  validateDeltaMap(state['deltas'], `${context}.deltas`);
  validateCreditLimits(state['globalCreditLimits'], `${context}.globalCreditLimits`);
  validateDisputeConfig(state['disputeConfig'], `${context}.disputeConfig`);
  persistedUint(state['jNonce'], `${context}.jNonce`);
  persistedUint(state['lastFinalizedJHeight'], `${context}.lastFinalizedJHeight`);
  validateTokenAmountMap(state['requestedRebalance'], `${context}.requestedRebalance`, 1n);
  validateRebalanceFeeStates(state['requestedRebalanceFeeState'], `${context}.requestedRebalanceFeeState`);
};

export const validatePersistedFrameDelta = validateDeltaValue;

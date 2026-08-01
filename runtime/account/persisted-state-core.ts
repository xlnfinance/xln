import { LIMITS } from '../config/constants';
import type { Delta } from '../types/account';
import {
  persistedAddress,
  persistedBigInt,
  persistedBoolean,
  persistedBytes32,
  persistedMap,
  persistedRecord,
  persistedTokenId,
  persistedUint,
  persistedUint16,
  persistedUint256,
  persistedInt256,
} from './persisted-value-primitives';

const validateDeltaValue = (value: unknown, context: string): Delta => {
  const delta = persistedRecord(value, context);
  const tokenId = persistedTokenId(delta['tokenId'], `${context}.tokenId`);
  const uint = (field: keyof Delta): bigint =>
    persistedUint256(delta[field], `${context}.${field}`);
  return {
    tokenId,
    collateral: uint('collateral'),
    ondelta: persistedInt256(delta['ondelta'], `${context}.ondelta`),
    offdelta: persistedInt256(delta['offdelta'], `${context}.offdelta`),
    leftCreditLimit: uint('leftCreditLimit'),
    rightCreditLimit: uint('rightCreditLimit'),
    leftAllowance: uint('leftAllowance'),
    rightAllowance: uint('rightAllowance'),
    leftHold: uint('leftHold'),
    rightHold: uint('rightHold'),
  };
};

const validateDeltaMap = (value: unknown, context: string): void => {
  for (const [key, raw] of persistedMap(value, context, LIMITS.MAX_ACCOUNT_TOKEN_ROWS)) {
    const tokenId = persistedTokenId(key, `${context}.key`);
    if (validateDeltaValue(raw, `${context}[${tokenId}]`).tokenId !== tokenId) {
      throw new Error(`${context}[${tokenId}].tokenId must match its Map key`);
    }
  }
};

const validateTokenAmounts = (value: unknown, context: string): void => {
  for (const [key, amount] of persistedMap(value, context, LIMITS.MAX_ACCOUNT_TOKEN_ROWS)) {
    persistedTokenId(key, `${context}.key`);
    persistedBigInt(amount, `${context}[${String(key)}]`, 0n, (1n << 256n) - 1n);
  }
};

export const validatePersistedAccountStateCore = (
  state: Record<string, unknown>,
  context: string,
): void => {
  persistedBytes32(state['leftEntity'], `${context}.leftEntity`);
  persistedBytes32(state['rightEntity'], `${context}.rightEntity`);
  const domain = persistedRecord(state['domain'], `${context}.domain`);
  if (persistedUint(domain['chainId'], `${context}.domain.chainId`) === 0) {
    throw new Error(`${context}.domain.chainId must be positive`);
  }
  persistedAddress(domain['depositoryAddress'], `${context}.domain.depositoryAddress`);
  persistedBytes32(state['watchSeed'], `${context}.watchSeed`);
  validateDeltaMap(state['deltas'], `${context}.deltas`);
  const limits = persistedRecord(state['globalCreditLimits'], `${context}.globalCreditLimits`);
  persistedUint256(limits['ownLimit'], `${context}.globalCreditLimits.ownLimit`);
  persistedUint256(limits['peerLimit'], `${context}.globalCreditLimits.peerLimit`);
  const dispute = persistedRecord(state['disputeConfig'], `${context}.disputeConfig`);
  persistedUint16(dispute['leftDisputeDelay'], `${context}.disputeConfig.leftDisputeDelay`);
  persistedUint16(dispute['rightDisputeDelay'], `${context}.disputeConfig.rightDisputeDelay`);
  persistedUint(state['jNonce'], `${context}.jNonce`);
  persistedUint(state['lastFinalizedJHeight'], `${context}.lastFinalizedJHeight`);
  validateTokenAmounts(state['requestedRebalance'], `${context}.requestedRebalance`);
  const feeStates = persistedMap(
    state['requestedRebalanceFeeState'],
    `${context}.requestedRebalanceFeeState`,
    LIMITS.MAX_ACCOUNT_TOKEN_ROWS,
  );
  for (const [key, raw] of feeStates) {
    persistedTokenId(key, `${context}.requestedRebalanceFeeState.key`);
    const fee = persistedRecord(raw, `${context}.requestedRebalanceFeeState[${String(key)}]`);
    persistedTokenId(fee['feeTokenId'], `${context}.requestedRebalanceFeeState.feeTokenId`);
    persistedUint256(fee['feePaidUpfront'], `${context}.requestedRebalanceFeeState.feePaidUpfront`);
    persistedUint256(fee['requestedAmount'], `${context}.requestedRebalanceFeeState.requestedAmount`);
    persistedUint(fee['policyVersion'], `${context}.requestedRebalanceFeeState.policyVersion`);
    persistedUint(fee['requestedAt'], `${context}.requestedRebalanceFeeState.requestedAt`);
    persistedBoolean(fee['requestedByLeft'], `${context}.requestedRebalanceFeeState.requestedByLeft`);
  }
};

export const validatePersistedFrameDelta = validateDeltaValue;

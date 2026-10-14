import { ethers } from 'ethers';
import type { ProofBodyStruct } from '../../../../jurisdictions/typechain-types/Depository.sol/Depository.js';
import { PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';
import type {
  JBatch,
  OptionalDisputeArgumentWarning,
  SanitizedOptionalDisputeArgument,
} from './types';

export const J_BATCH_CONTRACT_LIMITS = {
  maxTotalOps: 50,
  maxSettlements: 32,
  maxSettlementDiffs: 32,
  maxSettlementForgivenessIds: 32,
  maxDisputeStarts: 8,
  maxCounterDisputes: 8,
  maxDisputeFinalizations: 1,
  maxReserveToCollateralPairs: 64,
  maxReserveToCollateralPairsTotal: 256,
  maxSecretReveals: 32,
  maxHashLadderRegistrations: 32,
  maxEncodedBatchBytes: 256 * 1024,
  maxDisputeProofBodyBytes: 176 * 1024,
  maxDisputeStarterArgumentsBytes: 64 * 1024,
  maxDisputeProofTokens: 128,
  maxDisputeTransformers: 32,
} as const;

export const batchOpCount = (batch: JBatch): number =>
  batch.reserveToReserve.length +
  batch.reserveToCollateral.length +
  batch.collateralToReserve.length +
  batch.settlements.length +
  batch.disputeStarts.length +
  batch.counterDisputes.length +
  batch.disputeFinalizations.length +
  batch.externalTokenToReserve.length +
  batch.reserveToExternalToken.length +
  batch.revealSecrets.length +
  batch.hashLadderRegistrations.length;

export const requireBatchRoom = (batch: JBatch, operation: string, addedOps = 1): void => {
  const nextSize = batchOpCount(batch) + Math.max(0, addedOps);
  if (nextSize <= J_BATCH_CONTRACT_LIMITS.maxTotalOps) return;
  throw new Error(
    `J_BATCH_LIMIT_EXCEEDED: ${operation} would exceed total ops ` +
      `${nextSize}/${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`,
  );
};

export const requireArrayRoom = (name: string, current: number, added: number, max: number): void => {
  const next = current + Math.max(0, added);
  if (next > max) throw new Error(`J_BATCH_LIMIT_EXCEEDED: ${name} ${next}/${max}`);
};

const getTopLevelLimitIssue = (batch: JBatch): string | null => {
  const counts: Array<[string, number, number]> = [
    ['total ops', batchOpCount(batch), J_BATCH_CONTRACT_LIMITS.maxTotalOps],
    ['settlements', batch.settlements.length, J_BATCH_CONTRACT_LIMITS.maxSettlements],
    ['disputeStarts', batch.disputeStarts.length, J_BATCH_CONTRACT_LIMITS.maxDisputeStarts],
    ['counterDisputes', batch.counterDisputes.length, J_BATCH_CONTRACT_LIMITS.maxCounterDisputes],
    ['disputeFinalizations', batch.disputeFinalizations.length, J_BATCH_CONTRACT_LIMITS.maxDisputeFinalizations],
    ['revealSecrets', batch.revealSecrets.length, J_BATCH_CONTRACT_LIMITS.maxSecretReveals],
    ['hashLadderRegistrations', batch.hashLadderRegistrations.length, J_BATCH_CONTRACT_LIMITS.maxHashLadderRegistrations],
  ];
  const exceeded = counts.find(([, count, limit]) => count > limit);
  return exceeded ? `${exceeded[0]} ${exceeded[1]}/${exceeded[2]}` : null;
};

const getCollateralLimitIssue = (batch: JBatch): string | null => {
  for (const [index, operation] of batch.reserveToCollateral.entries()) {
    if (operation.tokenId <= 0 || !Number.isSafeInteger(operation.tokenId)) {
      return `reserveToCollateral[${index}].tokenId must be a positive safe integer`;
    }
    if (operation.pairs.length === 0) return `reserveToCollateral[${index}].pairs must not be empty`;
    if (operation.pairs.some(pair => pair.amount <= 0n)) {
      return `reserveToCollateral[${index}].pairs amounts must be positive`;
    }
    if (operation.pairs.length > J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairs) {
      return `reserveToCollateral[${index}].pairs ${operation.pairs.length}/${J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairs}`;
    }
  }
  const count = batch.reserveToCollateral.reduce((sum, operation) => sum + operation.pairs.length, 0);
  return count > J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairsTotal
    ? `reserveToCollateral.pairs total ${count}/${J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairsTotal}`
    : null;
};

const getSettlementLimitIssue = (batch: JBatch): string | null => {
  for (const [index, settlement] of batch.settlements.entries()) {
    if (settlement.diffs.length > J_BATCH_CONTRACT_LIMITS.maxSettlementDiffs) {
      return `settlements[${index}].diffs ${settlement.diffs.length}/${J_BATCH_CONTRACT_LIMITS.maxSettlementDiffs}`;
    }
    const forgivenessCount = settlement.forgiveDebtsInTokenIds.length;
    if (forgivenessCount > J_BATCH_CONTRACT_LIMITS.maxSettlementForgivenessIds) {
      return `settlements[${index}].forgiveDebtsInTokenIds ${forgivenessCount}/${J_BATCH_CONTRACT_LIMITS.maxSettlementForgivenessIds}`;
    }
  }
  return null;
};

export const getJBatchContractLimitIssue = (batch: JBatch): string | null =>
  getTopLevelLimitIssue(batch) ?? getCollateralLimitIssue(batch) ?? getSettlementLimitIssue(batch);

export const assertJBatchWithinContractLimits = (batch: JBatch, context = 'jBatch'): void => {
  const issue = getJBatchContractLimitIssue(batch);
  if (issue) throw new Error(`J_BATCH_LIMIT_EXCEEDED: ${context}: ${issue}`);
};

export const encodedHexBytes = (value: string, label: string): number => {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`J_DISPUTE_HEX_INVALID:${label}`);
  return (value.length - 2) / 2;
};

const PROOF_BODY_PARAM = ethers.ParamType.from(PROOF_BODY_ABI);

const assertOrderedProofTokens = (proofbody: ProofBodyStruct, context: string): void => {
  for (let index = 1; index < proofbody.tokenIds.length; index += 1) {
    const previous = proofbody.tokenIds[index - 1];
    const current = proofbody.tokenIds[index];
    if (previous === undefined || current === undefined || BigInt(previous) >= BigInt(current)) {
      throw new Error(`J_DISPUTE_PROOFBODY_TOKEN_ORDER_INVALID:${context}:${index}`);
    }
  }
};

export const assertDisputeProofBodyWithinContractLimits = (
  proofbody: ProofBodyStruct,
  context: string,
  encodedProofBody?: string,
): void => {
  if (proofbody.tokenIds.length !== proofbody.offdeltas.length) {
    throw new Error(`J_DISPUTE_PROOFBODY_LENGTH_MISMATCH:${context}`);
  }
  if (proofbody.tokenIds.length > J_BATCH_CONTRACT_LIMITS.maxDisputeProofTokens) {
    throw new Error(`J_DISPUTE_PROOFBODY_TOKEN_LIMIT:${context}:${proofbody.tokenIds.length}`);
  }
  if (proofbody.transformers.length > J_BATCH_CONTRACT_LIMITS.maxDisputeTransformers) {
    throw new Error(`J_DISPUTE_PROOFBODY_TRANSFORMER_LIMIT:${context}:${proofbody.transformers.length}`);
  }
  assertOrderedProofTokens(proofbody, context);
  const encoded = encodedProofBody ?? ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [proofbody]);
  const size = encodedHexBytes(encoded, `${context}.proofbody`);
  if (size > J_BATCH_CONTRACT_LIMITS.maxDisputeProofBodyBytes) {
    throw new Error(`J_DISPUTE_PROOFBODY_BYTES_EXCEEDED:${context}:${size}/${J_BATCH_CONTRACT_LIMITS.maxDisputeProofBodyBytes}`);
  }
};

export const assertDisputeArgumentsWithinContractLimits = (
  argumentsHex: readonly string[],
  context: string,
): void => {
  const total = argumentsHex.reduce(
    (sum, value, index) => sum + encodedHexBytes(value, `${context}[${index}]`),
    0,
  );
  if (total > J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes) {
    throw new Error(`J_DISPUTE_ARGUMENT_BYTES_EXCEEDED:${context}:${total}/${J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes}`);
  }
};

const estimatedArgumentBytes = (value: unknown): number =>
  typeof value === 'string' && value.startsWith('0x') ? Math.max(0, Math.floor((value.length - 2) / 2)) : 0;

const optionalArgumentWarning = (
  code: OptionalDisputeArgumentWarning['code'],
  context: string,
  originalBytes: number,
): SanitizedOptionalDisputeArgument => ({
  value: '0x',
  warnings: [{
    code,
    context,
    originalBytes,
    limitBytes: J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
  }],
});

const decodeOptionalArgument = (value: string): boolean => {
  try {
    ethers.AbiCoder.defaultAbiCoder().decode(['bytes[]'], value);
    return true;
  } catch {
    return false;
  }
};

export const sanitizeOptionalDisputeArgument = (
  value: unknown,
  context: string,
): SanitizedOptionalDisputeArgument => {
  if (value === '0x') return { value, warnings: [] };
  let size: number;
  try {
    if (typeof value !== 'string') throw new Error('not hex');
    size = encodedHexBytes(value, context);
  } catch {
    return optionalArgumentWarning('DISPUTE_OPTIONAL_ARGUMENT_MALFORMED', context, estimatedArgumentBytes(value));
  }
  if (size > J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes) {
    return optionalArgumentWarning('DISPUTE_OPTIONAL_ARGUMENT_OVERSIZED', context, size);
  }
  return decodeOptionalArgument(value)
    ? { value, warnings: [] }
    : optionalArgumentWarning('DISPUTE_OPTIONAL_ARGUMENT_MALFORMED', context, size);
};

export const sanitizeOptionalDisputeStarterArgumentPair = (
  initialValue: unknown,
  counterValue: unknown,
  context: string,
): Readonly<{
  initial: string;
  counter: string;
  warnings: readonly OptionalDisputeArgumentWarning[];
}> => {
  const initial = sanitizeOptionalDisputeArgument(initialValue, `${context}.initial`);
  const counter = sanitizeOptionalDisputeArgument(counterValue, `${context}.counter`);
  const warnings = [...initial.warnings, ...counter.warnings];
  const total = encodedHexBytes(initial.value, `${context}.initial`) +
    encodedHexBytes(counter.value, `${context}.counter`);
  if (total <= J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes) {
    return { initial: initial.value, counter: counter.value, warnings };
  }
  warnings.push({
    code: 'DISPUTE_OPTIONAL_ARGUMENT_AGGREGATE_OVERSIZED',
    context: `${context}.counter`,
    originalBytes: total,
    limitBytes: J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
  });
  return { initial: initial.value, counter: '0x', warnings };
};

import { ethers } from 'ethers';
import { DepositoryBounds__factory } from '../../../../jurisdictions/typechain-types/factories/DepositoryBounds__factory';
import { decodeSignedAmount } from '../../../protocol/crypto/abi-money';
import { requireArray, requireBoundaryRecord } from '../../../protocol/boundary/boundary-primitives';
import { encodeCooperativeUpdateDiff, hashDepositoryBatchHankoPayload } from '../../../hanko/onchain-domain';
import { validateJBatch } from '../batch-validation';
import { encodedHexBytes, J_BATCH_CONTRACT_LIMITS } from './limits';
import type { JBatch } from './types';

const getDepositoryBatchParam = (): ethers.ParamType => {
  const method = DepositoryBounds__factory.createInterface().getFunction('assertBatch');
  const batch = method?.inputs[0];
  if (!batch || batch.baseType !== 'tuple') throw new Error('J_BATCH_ABI_SCHEMA_MISSING');
  return batch;
};

const DEPOSITORY_BATCH_PARAM = getDepositoryBatchParam();

export const encodeJBatch = (batch: JBatch): string => {
  const contractBatch = {
    ...batch,
    settlements: batch.settlements.map(settlement => ({
      ...settlement,
      diffs: settlement.diffs.map(encodeCooperativeUpdateDiff),
    })),
  };
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode([DEPOSITORY_BATCH_PARAM], [contractBatch]);
  const size = encodedHexBytes(encoded, 'encodedBatch');
  if (size > J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes) {
    throw new Error(`J_BATCH_ENCODED_BYTES_EXCEEDED:${size}/${J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes}`);
  }
  return encoded;
};

/**
 * Solidity permits unnamed nested tuples that ethers cannot objectify.
 * Materialize positional Results from the pinned ParamType tree.
 */
export const materializeAbiValue = (
  param: ethers.ParamType,
  value: unknown,
  context: string,
): unknown => {
  if (param.baseType === 'array') {
    const itemParam = param.arrayChildren;
    if (!itemParam || !Array.isArray(value)) throw new Error(`J_BATCH_ABI_ARRAY_INVALID:${context}`);
    return Array.from(value, (item, index) => materializeAbiValue(itemParam, item, `${context}[${index}]`));
  }
  if (param.baseType !== 'tuple') return value;
  if (!param.components || !Array.isArray(value)) throw new Error(`J_BATCH_ABI_TUPLE_INVALID:${context}`);
  return Object.fromEntries(param.components.map((component, index) => {
    if (!component.name) throw new Error(`J_BATCH_ABI_COMPONENT_UNNAMED:${context}[${index}]`);
    return [component.name, materializeAbiValue(component, value[index], `${context}.${component.name}`)];
  }));
};

const decodeSettlementAmounts = (value: unknown): void => {
  const batch = requireBoundaryRecord(value, 'J_BATCH_ABI_RESULT');
  for (const rawSettlement of requireArray(batch['settlements'], 'J_BATCH_ABI_SETTLEMENTS')) {
    const settlement = requireBoundaryRecord(rawSettlement, 'J_BATCH_ABI_SETTLEMENT');
    for (const rawDiff of requireArray(settlement['diffs'], 'J_BATCH_ABI_DIFFS')) {
      const diff = requireBoundaryRecord(rawDiff, 'J_BATCH_ABI_DIFF');
      for (const field of ['leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff']) {
        diff[field] = decodeSignedAmount(diff[field]);
      }
    }
  }
};

export const decodeJBatch = (encodedBatch: string): JBatch => {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode([DEPOSITORY_BATCH_PARAM], encodedBatch);
  const batch = materializeAbiValue(DEPOSITORY_BATCH_PARAM, decoded[0], 'batch');
  decodeSettlementAmounts(batch);
  validateJBatch(batch, 'J_BATCH_ABI_RESULT');
  return batch;
};

export const computeBatchHankoHash = (
  chainId: bigint,
  depositoryAddress: string,
  encodedBatch: string,
  nonce: bigint,
): string =>
  hashDepositoryBatchHankoPayload({ chainId, depositoryAddress }, encodedBatch, nonce);

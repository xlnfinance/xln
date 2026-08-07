import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { isUsableContractAddress } from '../../../../jurisdiction/machine/contract-address';
import {
  type OptionalDisputeArgumentWarning,
} from '../../../../jurisdiction/machine/batch';
import {
  type DepositoryHankoDomain,
} from '../../../../protocol/dispute/proof-builder';
import { createStructuredLogger, shortId } from '../../../../infra/logger';

export const disputeLog = createStructuredLogger('entity.dispute');

export const warnDisputeUnlessQuiet = (
  env: EntityRuntimeContext,
  message: string,
  fields: Record<string, unknown>,
): void => {
  if (env.quietRuntimeLogs === true) return;
  disputeLog.warn(message, fields);
};

export const reportOptionalArgumentWarnings = (
  env: EntityRuntimeContext,
  counterpartyEntityId: string,
  warnings: readonly OptionalDisputeArgumentWarning[],
): void => {
  for (const warning of warnings) {
    warnDisputeUnlessQuiet(env, 'arguments.sanitized', {
      counterparty: shortId(counterpartyEntityId),
      ...warning,
    });
  }
};

export const isProofBodyStruct = (value: unknown): value is ProofBodyStruct => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['offdeltas']) &&
    Array.isArray(candidate['tokenIds']) &&
    Array.isArray(candidate['transformers'])
  );
};

export const requireProofBodyStruct = (
  value: unknown,
  entityId: string,
  counterpartyEntityId: string,
  source: string,
): ProofBodyStruct => {
  if (!isProofBodyStruct(value)) {
    throw new Error(
      `DISPUTE_FINALIZE_PROOFBODY_INVALID: entity=${entityId} counterparty=${counterpartyEntityId} source=${source}`,
    );
  }
  return value;
};

const toBigIntStrict = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`DISPUTE_FINALIZE_PROOFBODY_VALUE_INVALID:${label}`);
};

const requireBytesLike = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`DISPUTE_FINALIZE_PROOFBODY_BYTES_INVALID:${label}`);
  }
  return value;
};

const requireAddressLike = (value: unknown, label: string): string => {
  if (!isUsableContractAddress(value)) {
    throw new Error(`DISPUTE_FINALIZE_PROOFBODY_ADDRESS_INVALID:${label}`);
  }
  return value;
};

export const canonicalizeProofBodyStruct = (
  value: ProofBodyStruct,
  entityId: string,
  counterpartyEntityId: string,
  source: string,
): ProofBodyStruct => {
  const proofBody = requireProofBodyStruct(value, entityId, counterpartyEntityId, source);
  return {
    watchSeed: requireBytesLike(proofBody.watchSeed, `${source}.watchSeed`),
    offdeltas: proofBody.offdeltas.map(
      (entry, index) => toBigIntStrict(entry, `${source}.offdeltas[${index}]`),
    ),
    tokenIds: proofBody.tokenIds.map(
      (entry, index) => toBigIntStrict(entry, `${source}.tokenIds[${index}]`),
    ),
    transformers: proofBody.transformers.map((transformer, transformerIndex) => ({
      transformerAddress: requireAddressLike(
        transformer.transformerAddress,
        `${source}.transformers[${transformerIndex}].transformerAddress`,
      ),
      encodedBatch: requireBytesLike(
        transformer.encodedBatch,
        `${source}.transformers[${transformerIndex}].encodedBatch`,
      ),
      allowances: transformer.allowances.map((allowance, allowanceIndex) => ({
        deltaIndex: toBigIntStrict(
          allowance.deltaIndex,
          `${source}.transformers[${transformerIndex}].allowances[${allowanceIndex}].deltaIndex`,
        ),
        rightAllowance: toBigIntStrict(
          allowance.rightAllowance,
          `${source}.transformers[${transformerIndex}].allowances[${allowanceIndex}].rightAllowance`,
        ),
        leftAllowance: toBigIntStrict(
          allowance.leftAllowance,
          `${source}.transformers[${transformerIndex}].allowances[${allowanceIndex}].leftAllowance`,
        ),
      })),
    })),
  };
};

export const resolveDepositoryHankoDomain = (
  entityState: EntityState,
): DepositoryHankoDomain | null => {
  const jurisdiction = entityState.config.jurisdiction;
  const address = jurisdiction?.depositoryAddress || '';
  if (!isUsableContractAddress(address)) return null;
  const chainId = Number(jurisdiction?.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`DISPUTE_HANKO_CHAIN_ID_INVALID:${String(jurisdiction?.chainId)}`);
  }
  return { chainId, depositoryAddress: address };
};

const hasQueuedDisputeOperation = (
  state: EntityState,
  counterpartyEntityId: string,
  kind: 'disputeStarts' | 'disputeFinalizations',
): boolean => {
  const target = String(counterpartyEntityId || '').toLowerCase();
  if (!target) return false;
  const draft = state.jBatchState?.batch?.[kind] || [];
  const sent = state.jBatchState?.sentBatch?.batch?.[kind] || [];
  return [...draft, ...sent].some(
    operation => String(operation?.counterentity || '').toLowerCase() === target,
  );
};

export const hasQueuedDisputeStart = (
  state: EntityState,
  counterpartyEntityId: string,
): boolean => hasQueuedDisputeOperation(state, counterpartyEntityId, 'disputeStarts');

export const hasQueuedDisputeFinalize = (
  state: EntityState,
  counterpartyEntityId: string,
): boolean => hasQueuedDisputeOperation(state, counterpartyEntityId, 'disputeFinalizations');

export const collectDisputeEvidenceReadinessIssues = (
  account: AccountReplica,
  now: number,
): string[] => {
  const issues: string[] = [];
  const readyAfter = Number(account.disputePrepare?.readyAfter ?? 0);
  if (readyAfter > now) issues.push(`cooldown:${readyAfter - now}ms`);
  const pendingOrderbookRemovals =
    account.disputePrepare?.pendingOrderbookRemovalIds?.length ?? 0;
  if (pendingOrderbookRemovals > 0) {
    issues.push(`orderbookRemovals:${pendingOrderbookRemovals}`);
  }
  return issues;
};

import { readFileSync } from 'node:fs';
import { generateLazyEntityId } from '../../../../../core/entity/factory';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../../core/protocol/boundary-validation';
import { UINT256_MAX } from '../../../../../core/protocol/boundary/integer-ranges';
import { safeParse } from '../../../../../core/protocol/serialization';
import {
  chainBindingFields,
  decodeChainBinding,
  requireAuthorityCatalog,
  requireAuthorityRevision,
} from '../authority';
import { address, hex, integer, money, text } from '../boundary';
import type { ChainBinding, NonceGrant } from '../providers';

export type SourceC2RAuthority = Readonly<{
  version: 1;
  operation: 'source-c2r';
  approved: boolean;
  candidateHead: string;
  candidateDigest: string;
  catalogDigest: string;
  expiresAt: number;
  apiBase: string;
  chain: ChainBinding;
  hubEntity: string;
  userEntity: string;
  userSigner: string;
  payer: NonceGrant &
    Readonly<{
      gasLimit: bigint;
      maxFeePerGasWei: bigint;
      maxPriorityFeePerGasWei: bigint;
      totalFeeLimitWei: bigint;
    }>;
  settlement: Readonly<{
    amountAtoms: bigint;
    accountNonceBefore: number;
    accountNonce: number;
    hubBatchNonce: bigint;
    hubReserveBeforeAtoms: bigint;
    userReserveBeforeAtoms: bigint;
  }>;
}>;

const decodePayer = (input: unknown): SourceC2RAuthority['payer'] => {
  const row = requireBoundaryRecord(input, 'USDC_SOURCE_C2R_PAYER_INVALID');
  requireExactBoundaryKeys(
    row,
    ['address', 'firstNonce', 'gasLimit', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'totalFeeLimitWei'],
    [],
    'USDC_SOURCE_C2R_PAYER_FIELDS',
  );
  const payer = {
    address: address(row['address']),
    firstNonce: integer(row['firstNonce']),
    gasLimit: money(row['gasLimit']),
    maxFeePerGasWei: money(row['maxFeePerGasWei']),
    maxPriorityFeePerGasWei: money(row['maxPriorityFeePerGasWei']),
    totalFeeLimitWei: money(row['totalFeeLimitWei']),
  };
  if (
    !Number.isSafeInteger(payer.firstNonce + 1) ||
    payer.gasLimit === 0n ||
    payer.maxFeePerGasWei === 0n ||
    payer.maxPriorityFeePerGasWei > payer.maxFeePerGasWei ||
    payer.gasLimit * payer.maxFeePerGasWei > payer.totalFeeLimitWei
  )
    throw new Error('USDC_SOURCE_C2R_FEE_LIMIT_INVALID');
  return payer;
};

const decodeSettlement = (input: unknown): SourceC2RAuthority['settlement'] => {
  const row = requireBoundaryRecord(input, 'USDC_SOURCE_C2R_SETTLEMENT_INVALID');
  requireExactBoundaryKeys(
    row,
    [
      'amountAtoms',
      'accountNonceBefore',
      'accountNonce',
      'hubBatchNonce',
      'hubReserveBeforeAtoms',
      'userReserveBeforeAtoms',
    ],
    [],
    'USDC_SOURCE_C2R_SETTLEMENT_FIELDS',
  );
  const settlement = {
    amountAtoms: money(row['amountAtoms']),
    accountNonceBefore: integer(row['accountNonceBefore']),
    accountNonce: integer(row['accountNonce']),
    hubBatchNonce: money(row['hubBatchNonce']),
    hubReserveBeforeAtoms: money(row['hubReserveBeforeAtoms']),
    userReserveBeforeAtoms: money(row['userReserveBeforeAtoms']),
  };
  if (
    settlement.amountAtoms !== 1_000_000n ||
    settlement.accountNonce <= settlement.accountNonceBefore ||
    settlement.hubBatchNonce === 0n ||
    settlement.hubBatchNonce > BigInt(Number.MAX_SAFE_INTEGER) ||
    settlement.hubReserveBeforeAtoms + settlement.amountAtoms > UINT256_MAX
  )
    throw new Error('USDC_SOURCE_C2R_SETTLEMENT_SCOPE_INVALID');
  return settlement;
};

const validateScope = ({ chain, hubEntity, userEntity, userSigner, payer }: SourceC2RAuthority) => {
  if (
    chain.chainId !== 11155111 ||
    hubEntity === userEntity ||
    generateLazyEntityId([payer.address], 1n).toLowerCase() !== hubEntity ||
    generateLazyEntityId([userSigner], 1n).toLowerCase() !== userEntity
  )
    throw new Error('USDC_SOURCE_C2R_CHAIN_OR_IDENTITY_INVALID');
  for (const required of [chain.depository, chain.entityProvider, chain.token])
    if (!chain.codeHashes[required]) throw new Error('USDC_SOURCE_C2R_CODE_HASH_MISSING');
};

export const readSourceC2RAuthority = (path: string): SourceC2RAuthority => {
  const row = requireBoundaryRecord(safeParse(readFileSync(path, 'utf8')), 'USDC_SOURCE_C2R_AUTHORITY_INVALID');
  requireExactBoundaryKeys(
    row,
    [
      'version',
      'operation',
      'approved',
      'candidateHead',
      'candidateDigest',
      'catalogDigest',
      'expiresAt',
      'apiBase',
      'chain',
      'hubEntity',
      'userEntity',
      'userSigner',
      'payer',
      'settlement',
    ],
    [],
    'USDC_SOURCE_C2R_AUTHORITY_FIELDS',
  );
  if (row['version'] !== 1 || row['operation'] !== 'source-c2r' || typeof row['approved'] !== 'boolean')
    throw new Error('USDC_SOURCE_C2R_AUTHORITY_OPERATION_INVALID');
  const binding = requireBoundaryRecord(row['chain'], 'USDC_SOURCE_C2R_BINDING_INVALID');
  requireExactBoundaryKeys(binding, chainBindingFields, [], 'USDC_SOURCE_C2R_BINDING_FIELDS');
  const authority: SourceC2RAuthority = {
    version: 1,
    operation: 'source-c2r',
    approved: row['approved'],
    candidateHead: text(row['candidateHead']),
    candidateDigest: text(row['candidateDigest']),
    catalogDigest: text(row['catalogDigest']),
    expiresAt: integer(row['expiresAt']),
    apiBase: text(row['apiBase']),
    chain: decodeChainBinding(binding),
    hubEntity: hex(row['hubEntity'], 32),
    userEntity: hex(row['userEntity'], 32),
    userSigner: address(row['userSigner']),
    payer: decodePayer(row['payer']),
    settlement: decodeSettlement(row['settlement']),
  };
  validateScope(authority);
  return authority;
};

export const requireSourceC2RAuthority = (authority: SourceC2RAuthority, catalogPath: string): void => {
  requireAuthorityRevision(authority, catalogPath);
  requireAuthorityCatalog([authority.chain], catalogPath);
};

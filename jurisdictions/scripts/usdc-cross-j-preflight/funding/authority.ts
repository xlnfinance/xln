import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateLazyEntityId } from '../../../../core/entity/factory';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../core/protocol/boundary-validation';
import { UINT256_MAX } from '../../../../core/protocol/boundary/integer-ranges';
import { safeParse, safeStringify } from '../../../../core/protocol/serialization';
import { requireAuthorityRevision, requireAuthorityCatalog } from '../execution/authority';
import { text, integer, hex, money, address, list } from '../execution/boundary';
import type { ChainBinding, NonceGrant } from '../execution/providers';

type OperatorStage = 'approval' | 'deposit' | 'native-topup';
type FundingStage = OperatorStage | 'user-principal-transfer' | 'user-native-topup';
type CallLimit = Readonly<{ gasLimit: bigint; maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint }>;
type UserFunding = Readonly<{
  signer: string;
  usdcAtoms: bigint;
  nativeTopupWei: bigint;
  principalTransfer: CallLimit | null;
  nativeTopup: CallLimit;
}>;
export type FundingLimit = Readonly<{
  chainId: number;
  amount: bigint;
  hubTopupWei: bigint;
  totalFeeLimitWei: bigint;
  totalNativeOutflowLimitWei: bigint;
  calls: Readonly<{ approval: CallLimit; deposit: CallLimit; 'native-topup'?: CallLimit }>;
  userFunding?: UserFunding;
}>;
export type FundingSlot = Readonly<{ stage: FundingStage; cap: CallLimit; valueWei: bigint }>;
export type FundingChain = ChainBinding &
  Readonly<{
    funder: NonceGrant;
    funderEntity: string;
    entityNonce: bigint;
    hubEntity: string;
    hubSigner: string;
    hubReserveBefore: bigint;
    limits: FundingLimit;
  }>;
export type FundingAuthority = Readonly<{
  version: 2;
  operation: 'operator-funding';
  approved: boolean;
  candidateHead: string;
  candidateDigest: string;
  catalogDigest: string;
  expiresAt: number;
  chains: readonly FundingChain[];
}>;

const decodeCallLimit = (value: unknown): CallLimit => {
  const row = requireBoundaryRecord(value, 'USDC_FUNDING_CALL_LIMIT_INVALID');
  requireExactBoundaryKeys(
    row,
    ['gasLimit', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei'],
    [],
    'USDC_FUNDING_CALL_LIMIT_FIELDS',
  );
  const result = {
    gasLimit: money(row['gasLimit']),
    maxFeePerGasWei: money(row['maxFeePerGasWei']),
    maxPriorityFeePerGasWei: money(row['maxPriorityFeePerGasWei']),
  };
  if (result.gasLimit <= 0n || result.maxFeePerGasWei <= 0n || result.maxPriorityFeePerGasWei > result.maxFeePerGasWei)
    throw new Error('USDC_FUNDING_FEE_LIMIT_INVALID');
  return result;
};

const decodeUserFunding = (value: unknown, chainId: number): UserFunding => {
  const row = requireBoundaryRecord(value, 'USDC_FUNDING_USER_INVALID');
  requireExactBoundaryKeys(
    row,
    ['signer', 'usdcAtoms', 'nativeTopupWei', 'principalTransfer', 'nativeTopup'],
    [],
    'USDC_FUNDING_USER_FIELDS',
  );
  const result = {
    signer: address(row['signer']),
    usdcAtoms: money(row['usdcAtoms']),
    nativeTopupWei: money(row['nativeTopupWei']),
    principalTransfer: row['principalTransfer'] === null ? null : decodeCallLimit(row['principalTransfer']),
    nativeTopup: decodeCallLimit(row['nativeTopup']),
  };
  const source = chainId === 11155111;
  if (
    result.usdcAtoms !== (source ? 1_000_000n : 0n) ||
    source !== (result.principalTransfer !== null) ||
    result.nativeTopupWei <= 0n
  )
    throw new Error('USDC_FUNDING_USER_SCOPE_INVALID');
  return result;
};

export const fundingSlots = (limits: FundingLimit): FundingSlot[] => {
  const slots: FundingSlot[] = [
    { stage: 'approval', cap: limits.calls.approval, valueWei: 0n },
    { stage: 'deposit', cap: limits.calls.deposit, valueWei: 0n },
  ];
  const topup = limits.calls['native-topup'];
  if (topup) slots.push({ stage: 'native-topup', cap: topup, valueWei: limits.hubTopupWei });
  const user = limits.userFunding;
  if (user) {
    if (user.principalTransfer)
      slots.push({ stage: 'user-principal-transfer', cap: user.principalTransfer, valueWei: 0n });
    slots.push({ stage: 'user-native-topup', cap: user.nativeTopup, valueWei: user.nativeTopupWei });
  }
  return slots;
};

export const fundingSlotBudget = (slots: readonly FundingSlot[]) => ({
  fees: slots.reduce((n, slot) => n + slot.cap.gasLimit * slot.cap.maxFeePerGasWei, 0n),
  value: slots.reduce((n, slot) => n + slot.valueWei, 0n),
});

const requireFundingLimit = (limit: FundingLimit): void => {
  const { chainId } = limit;
  const { fees, value } = fundingSlotBudget(fundingSlots(limit));
  if (
    (chainId !== 11155111 && chainId !== 421614) ||
    limit.amount === 0n ||
    Boolean(limit.calls['native-topup']) !== limit.hubTopupWei > 0n ||
    fees > limit.totalFeeLimitWei ||
    limit.totalFeeLimitWei + value > limit.totalNativeOutflowLimitWei
  )
    throw new Error('USDC_FUNDING_CUMULATIVE_LIMIT_INVALID');
};

export const decodeFundingLimit = (value: unknown): FundingLimit => {
  const row = requireBoundaryRecord(value, 'USDC_FUNDING_LIMIT_INVALID');
  requireExactBoundaryKeys(
    row,
    ['chainId', 'amount', 'hubTopupWei', 'totalFeeLimitWei', 'totalNativeOutflowLimitWei', 'calls'],
    ['userFunding'],
    'USDC_FUNDING_LIMIT_FIELDS',
  );
  const calls = requireBoundaryRecord(row['calls'], 'USDC_FUNDING_CALLS_INVALID');
  requireExactBoundaryKeys(calls, ['approval', 'deposit'], ['native-topup'], 'USDC_FUNDING_CALL_FIELDS');
  const chainId = integer(row['chainId']);
  const result = {
    chainId,
    amount: money(row['amount']),
    hubTopupWei: money(row['hubTopupWei']),
    totalFeeLimitWei: money(row['totalFeeLimitWei']),
    totalNativeOutflowLimitWei: money(row['totalNativeOutflowLimitWei']),
    calls: {
      approval: decodeCallLimit(calls['approval']),
      deposit: decodeCallLimit(calls['deposit']),
      ...(Object.hasOwn(calls, 'native-topup') ? { 'native-topup': decodeCallLimit(calls['native-topup']) } : {}),
    },
    ...(Object.hasOwn(row, 'userFunding') ? { userFunding: decodeUserFunding(row['userFunding'], chainId) } : {}),
  };
  requireFundingLimit(result);
  return result;
};

const decodeChain = (value: unknown): FundingChain => {
  const row = requireBoundaryRecord(value, 'USDC_FUNDING_CHAIN_INVALID');
  requireExactBoundaryKeys(
    row,
    [
      'chainId',
      'anchorNumber',
      'anchorHash',
      'depository',
      'entityProvider',
      'token',
      'codeHashes',
      'funder',
      'funderEntity',
      'entityNonce',
      'hubEntity',
      'hubSigner',
      'hubReserveBefore',
      'limits',
    ],
    [],
    'USDC_FUNDING_CHAIN_FIELDS',
  );
  const payer = requireBoundaryRecord(row['funder'], 'USDC_FUNDING_PAYER_INVALID');
  requireExactBoundaryKeys(payer, ['address', 'firstNonce'], [], 'USDC_FUNDING_PAYER_FIELDS');
  const hashes = requireBoundaryRecord(row['codeHashes'], 'USDC_FUNDING_CODE_HASHES_INVALID');
  return {
    chainId: integer(row['chainId']),
    anchorNumber: integer(row['anchorNumber']),
    anchorHash: hex(row['anchorHash'], 32),
    depository: address(row['depository']),
    entityProvider: address(row['entityProvider']),
    token: address(row['token']),
    codeHashes: Object.fromEntries(Object.entries(hashes).map(([key, hash]) => [address(key), hex(hash, 32)])),
    funder: { address: address(payer['address']), firstNonce: integer(payer['firstNonce']) },
    funderEntity: hex(row['funderEntity'], 32),
    entityNonce: money(row['entityNonce']),
    hubEntity: hex(row['hubEntity'], 32),
    hubSigner: address(row['hubSigner']),
    hubReserveBefore: money(row['hubReserveBefore']),
    limits: decodeFundingLimit(row['limits']),
  };
};

const requireReserveFundingLimit = (chain: FundingChain): void => {
  const { amount, hubTopupWei, userFunding } = chain.limits;
  if (chain.hubReserveBefore + amount > UINT256_MAX) throw new Error('USDC_FUNDING_RESERVE_OVERFLOW');
  if (chain.hubReserveBefore > 0n) return;
  const initialAmount =
    chain.chainId === 11155111 ? (userFunding ? 1n : 1_000_000n) : userFunding ? 1_000_000n : 5_000_000n;
  if (amount !== initialAmount || hubTopupWei === 0n) throw new Error('USDC_FUNDING_INITIAL_SCOPE_INVALID');
};

const validateChain = (chain: FundingChain): void => {
  if (
    chain.limits.chainId !== chain.chainId ||
    !Number.isSafeInteger(chain.funder.firstNonce + fundingSlots(chain.limits).length) ||
    chain.entityNonce >= BigInt(Number.MAX_SAFE_INTEGER) ||
    chain.funder.address === chain.hubSigner ||
    chain.limits.userFunding?.signer === chain.funder.address ||
    chain.limits.userFunding?.signer === chain.hubSigner ||
    generateLazyEntityId([chain.funder.address], 1n).toLowerCase() !== chain.funderEntity ||
    generateLazyEntityId([chain.hubSigner], 1n).toLowerCase() !== chain.hubEntity
  )
    throw new Error('USDC_FUNDING_IDENTITY_INVALID');
  for (const required of [chain.depository, chain.entityProvider, chain.token])
    if (!chain.codeHashes[required]) throw new Error('USDC_FUNDING_CODE_HASH_MISSING');
  requireReserveFundingLimit(chain);
};

const requireChainScope = (chains: readonly FundingChain[]): void => {
  const [source, target] = chains;
  if (chains.length === 1 && source && source.hubReserveBefore > 0n && !source.limits.userFunding) return;
  if (
    chains.length !== 2 ||
    !source ||
    !target ||
    source.chainId !== 11155111 ||
    target.chainId !== 421614 ||
    source.funder.address !== target.funder.address ||
    source.hubEntity === target.hubEntity ||
    Boolean(source.limits.userFunding) !== Boolean(target.limits.userFunding)
  )
    throw new Error('USDC_FUNDING_AUTHORITY_SCOPE_INVALID');
};

export const decodeFundingAuthority = (value: unknown): FundingAuthority => {
  const row = requireBoundaryRecord(value, 'USDC_FUNDING_AUTHORITY_INVALID');
  requireExactBoundaryKeys(
    row,
    ['version', 'operation', 'approved', 'candidateHead', 'candidateDigest', 'catalogDigest', 'expiresAt', 'chains'],
    [],
    'USDC_FUNDING_AUTHORITY_FIELDS',
  );
  if (row['version'] !== 2 || row['operation'] !== 'operator-funding' || typeof row['approved'] !== 'boolean')
    throw new Error('USDC_FUNDING_AUTHORITY_OPERATION_INVALID');
  const result: FundingAuthority = {
    version: 2,
    operation: 'operator-funding',
    approved: row['approved'],
    candidateHead: text(row['candidateHead']),
    candidateDigest: text(row['candidateDigest']),
    catalogDigest: text(row['catalogDigest']),
    expiresAt: integer(row['expiresAt']),
    chains: list(row['chains']).map(decodeChain),
  };
  if (
    !/^[a-f0-9]{40}$/.test(result.candidateHead) ||
    !/^[a-f0-9]{64}$/.test(result.candidateDigest) ||
    !/^[a-f0-9]{64}$/.test(result.catalogDigest)
  )
    throw new Error('USDC_FUNDING_AUTHORITY_SCOPE_INVALID');
  requireChainScope(result.chains);
  result.chains.forEach(validateChain);
  return result;
};

export const requireFundingAuthority = (authority: FundingAuthority, catalogPath: string): void => {
  requireAuthorityRevision(authority, catalogPath);
  requireAuthorityCatalog(authority.chains, catalogPath);
};

export const readFundingAuthority = (path: string): FundingAuthority =>
  decodeFundingAuthority(safeParse(readFileSync(path, 'utf8')));

export const fundingDigest = (authority: FundingAuthority): string =>
  createHash('sha256').update(safeStringify(authority)).digest('hex');

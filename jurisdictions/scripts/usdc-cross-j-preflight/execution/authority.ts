import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { candidateSources } from '../budget';
import { readExistingIdentities } from '../identities';
import { safeParse, safeStringify } from '../../../../core/protocol/serialization';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../core/protocol/boundary-validation';
import { requireRunId } from '../../../../core/scenarios/usdc-poc/journey/context';
import { generateLazyEntityId } from '../../../../core/entity/factory';
import { decodeJurisdictionsData } from '../../../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import { text, integer, hex, money, list, address } from './boundary';
import type { ChainBinding } from './providers';

type PayerRole = 'source-user' | 'target-user' | 'target-hub';
export type PayerGrant = Readonly<{
  role: PayerRole;
  address: string;
  firstNonce: number;
  gasLimit: bigint;
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  totalFeeLimitWei: bigint;
}>;
export type ChainAuthority = ChainBinding &
  Readonly<{
    userEntity: string;
    userSigner: string;
    hubEntity: string;
    hubSigner: string;
    payers: readonly PayerGrant[];
  }>;
export type ExecutionAuthority = Readonly<{
  version: 1;
  approved: boolean;
  candidateHead: string;
  candidateDigest: string;
  catalogDigest: string;
  expiresAt: number;
  apiBase: string;
  runIds: readonly string[];
  chains: readonly ChainAuthority[];
}>;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const candidateHead = (): string => {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
  const head = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(head)) throw new Error('USDC_EXECUTION_CANDIDATE_HEAD_MISSING');
  return head;
};
export const fingerprintCandidate = (head: string, sources: Readonly<Record<string, string>>): string =>
  digest(safeStringify({ head, sources }));
export const candidateDigest = (): string => fingerprintCandidate(candidateHead(), candidateSources());
export const catalogDigest = (path: string): string => digest(safeStringify(safeParse(readFileSync(path, 'utf8'))));
export const authorityDigest = (authority: unknown): string => digest(safeStringify(authority));

export const chainBindingFields = [
  'chainId',
  'anchorNumber',
  'anchorHash',
  'depository',
  'entityProvider',
  'token',
  'codeHashes',
] as const;

export const decodeChainBinding = (row: Record<string, unknown>): ChainBinding => {
  const hashes = requireBoundaryRecord(row['codeHashes'], 'USDC_AUTHORITY_CODE_HASHES_INVALID');
  return {
    chainId: integer(row['chainId']),
    anchorNumber: integer(row['anchorNumber']),
    anchorHash: hex(row['anchorHash'], 32),
    depository: address(row['depository']),
    entityProvider: address(row['entityProvider']),
    token: address(row['token']),
    codeHashes: Object.fromEntries(Object.entries(hashes).map(([key, hash]) => [address(key), hex(hash, 32)])),
  };
};

const decodePayer = (value: unknown): PayerGrant => {
  const row = requireBoundaryRecord(value, 'USDC_AUTHORITY_PAYER_INVALID');
  requireExactBoundaryKeys(
    row,
    ['role', 'address', 'firstNonce', 'gasLimit', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'totalFeeLimitWei'],
    [],
    'USDC_AUTHORITY_PAYER_FIELDS',
  );
  const role = row['role'];
  if (role !== 'source-user' && role !== 'target-user' && role !== 'target-hub')
    throw new Error('USDC_AUTHORITY_ROLE_INVALID');
  return {
    role,
    address: address(row['address']),
    firstNonce: integer(row['firstNonce']),
    gasLimit: money(row['gasLimit']),
    maxFeePerGasWei: money(row['maxFeePerGasWei']),
    maxPriorityFeePerGasWei: money(row['maxPriorityFeePerGasWei']),
    totalFeeLimitWei: money(row['totalFeeLimitWei']),
  };
};

const decodeChain = (value: unknown): ChainAuthority => {
  const row = requireBoundaryRecord(value, 'USDC_AUTHORITY_CHAIN_INVALID');
  requireExactBoundaryKeys(
    row,
    [...chainBindingFields, 'userEntity', 'userSigner', 'hubEntity', 'hubSigner', 'payers'],
    [],
    'USDC_AUTHORITY_CHAIN_FIELDS',
  );
  const { codeHashes, ...binding } = decodeChainBinding(row);
  return {
    ...binding,
    userEntity: hex(row['userEntity'], 32),
    userSigner: address(row['userSigner']),
    hubEntity: hex(row['hubEntity'], 32),
    hubSigner: address(row['hubSigner']),
    codeHashes,
    payers: list(row['payers']).map(decodePayer),
  };
};

export const decodeAuthority = (value: unknown): ExecutionAuthority => {
  const row = requireBoundaryRecord(value, 'USDC_AUTHORITY_INVALID');
  requireExactBoundaryKeys(
    row,
    [
      'version',
      'approved',
      'candidateHead',
      'candidateDigest',
      'catalogDigest',
      'expiresAt',
      'apiBase',
      'runIds',
      'chains',
    ],
    [],
    'USDC_AUTHORITY_FIELDS',
  );
  if (row['version'] !== 1 || typeof row['approved'] !== 'boolean') throw new Error('USDC_AUTHORITY_VERSION_INVALID');
  const result: ExecutionAuthority = {
    version: 1,
    approved: row['approved'],
    candidateHead: text(row['candidateHead']),
    candidateDigest: text(row['candidateDigest']),
    catalogDigest: text(row['catalogDigest']),
    expiresAt: integer(row['expiresAt']),
    apiBase: text(row['apiBase']),
    runIds: list(row['runIds']).map(value => requireRunId(text(value))),
    chains: list(row['chains']).map(decodeChain),
  };
  validateAuthority(result);
  return result;
};

export const payerSlots = (authority: ExecutionAuthority, payer: PayerGrant): number =>
  authority.runIds.length * (payer.role === 'source-user' ? 3 : 1);

const validateChain = (authority: ExecutionAuthority, chain: ChainAuthority): void => {
  if (generateLazyEntityId([chain.userSigner], 1n).toLowerCase() !== chain.userEntity)
    throw new Error('USDC_AUTHORITY_USER_IDENTITY_INVALID');
  const roles = chain.chainId === 11155111 ? ['source-user'] : ['target-user', 'target-hub'];
  if (chain.payers.length !== roles.length || new Set(chain.payers.map(p => p.role)).size !== roles.length)
    throw new Error('USDC_AUTHORITY_PAYERS_INVALID');
  for (const payer of chain.payers) {
    const expected = payer.role === 'target-hub' ? chain.hubSigner : chain.userSigner;
    if (
      !roles.includes(payer.role) ||
      payer.address !== expected ||
      payer.gasLimit <= 0n ||
      payer.maxFeePerGasWei <= 0n ||
      payer.maxPriorityFeePerGasWei > payer.maxFeePerGasWei ||
      payer.gasLimit * payer.maxFeePerGasWei * BigInt(payerSlots(authority, payer)) > payer.totalFeeLimitWei ||
      !Number.isSafeInteger(payer.firstNonce + payerSlots(authority, payer))
    )
      throw new Error('USDC_AUTHORITY_CUMULATIVE_LIMIT_INVALID');
  }
  for (const required of [chain.depository, chain.entityProvider, chain.token])
    if (!chain.codeHashes[required]) throw new Error('USDC_AUTHORITY_CODE_HASH_MISSING');
};

const validateAuthority = (authority: ExecutionAuthority): void => {
  if (
    !/^[a-f0-9]{40}$/.test(authority.candidateHead) ||
    !/^[a-f0-9]{64}$/.test(authority.candidateDigest) ||
    !/^[a-f0-9]{64}$/.test(authority.catalogDigest) ||
    authority.runIds.length < 1 ||
    authority.runIds.length > 5 ||
    new Set(authority.runIds).size !== authority.runIds.length ||
    authority.chains.length !== 2 ||
    authority.chains[0]!.chainId !== 11155111 ||
    authority.chains[1]!.chainId !== 421614
  )
    throw new Error('USDC_AUTHORITY_SCOPE_INVALID');
  const identities = authority.chains.flatMap(chain => [chain.userEntity, chain.hubEntity]);
  if (new Set(identities).size !== 4) throw new Error('USDC_AUTHORITY_IDENTITIES_NOT_DISTINCT');
  authority.chains.forEach(chain => validateChain(authority, chain));
};

export const requireAuthorityRevision = (
  authority: Pick<ExecutionAuthority, 'approved' | 'expiresAt' | 'candidateHead' | 'candidateDigest' | 'catalogDigest'>,
  catalogPath: string,
): void => {
  if (!authority.approved) throw new Error('USDC_EXECUTION_AUTHORITY_MISSING');
  if (Date.now() >= authority.expiresAt) throw new Error('USDC_EXECUTION_AUTHORITY_EXPIRED');
  if (
    authority.candidateHead !== candidateHead() ||
    authority.candidateDigest !== candidateDigest() ||
    authority.catalogDigest !== catalogDigest(catalogPath)
  )
    throw new Error('USDC_EXECUTION_AUTHORITY_CANDIDATE_CHANGED');
};

export const requireAuthorityCatalog = (chains: readonly ChainBinding[], catalogPath: string): void => {
  const catalog = Object.values(decodeJurisdictionsData(safeParse(readFileSync(catalogPath, 'utf8'))).jurisdictions);
  if (catalog.length !== 2) throw new Error('USDC_EXECUTION_CATALOG_BINDING_MISMATCH');
  for (const chain of chains) {
    const selected = catalog.find(value => value.chainId === chain.chainId);
    if (!selected) throw new Error('USDC_EXECUTION_CATALOG_BINDING_MISMATCH');
    const tokens = requireBoundaryRecord(selected.tokens, 'USDC_EXECUTION_CATALOG_TOKENS_INVALID');
    const token = requireBoundaryRecord(tokens['USDC'], 'USDC_EXECUTION_CATALOG_USDC_REQUIRED');
    if (
      Object.keys(tokens).length !== 1 ||
      selected.contracts.depository.toLowerCase() !== chain.depository ||
      selected.contracts.entityProvider.toLowerCase() !== chain.entityProvider ||
      token['tokenId'] !== 1 ||
      token['decimals'] !== 6 ||
      address(token['address']) !== chain.token
    )
      throw new Error('USDC_EXECUTION_CATALOG_BINDING_MISMATCH');
  }
};

export const requireCurrentAuthority = (authority: ExecutionAuthority, catalogPath: string): void => {
  requireAuthorityRevision(authority, catalogPath);
  requireAuthorityCatalog(authority.chains, catalogPath);
};

export const readAuthority = (path: string): ExecutionAuthority =>
  decodeAuthority(safeParse(readFileSync(path, 'utf8')));

export const verifyExecutionBindings = (directory: string, apiBase: string, authority: ExecutionAuthority): void => {
  const identities = readExistingIdentities(directory);
  if (authority.apiBase !== apiBase) throw new Error('USDC_EXECUTION_API_BINDING_MISMATCH');
  for (const chain of authority.chains)
    for (const role of ['user', 'hub'] as const) {
      const own = identities.find(value => value.role === role)?.chains.find(value => value.chainId === chain.chainId);
      const entity = role === 'user' ? chain.userEntity : chain.hubEntity;
      const signer = role === 'user' ? chain.userSigner : chain.hubSigner;
      if (own?.entityId !== entity || own.signerId !== signer)
        throw new Error('USDC_EXECUTION_IDENTITY_BINDING_MISMATCH');
    }
};

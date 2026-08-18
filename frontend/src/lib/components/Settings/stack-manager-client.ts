/**
 * Strict browser boundary for the universal jurisdiction Stack Manager.
 * Every daemon response is decoded before the Settings UI may trust it.
 * Importance: 86/100 — a malformed deployment response must never look successful.
 */
import type {
  DeployJurisdictionStackRequest,
  StackManagerProbe as RuntimeStackManagerProbe,
  StackManagerStatus as RuntimeStackManagerStatus,
} from '@xln/core/jurisdiction/adapter/stack-manager/types';
import { safeStringify } from '@xln/core/protocol/serialization';
import { DEV_CHAIN_IDS } from '@xln/core/jurisdiction/adapter/chain-ids';
import { requireExactKeys as exactKeys, requireUnknownRecord as record } from '$lib/utils/boundary';
import {
  decodeJurisdictionGossipAnnouncementStructure,
  type JurisdictionGossipAnnouncement,
} from '@xln/core/jurisdiction/gossip/announcement';
export const STACK_VERSION = 'V1' as const;
export type StackStablecoinKind = 'existing' | 'test';
export const defaultStackStablecoinKind = (chainId: number): StackStablecoinKind =>
  DEV_CHAIN_IDS.has(chainId) ? 'test' : 'existing';
export type StackPublicationRequest = DeployJurisdictionStackRequest['publication'];
export type StackManagerStatus = RuntimeStackManagerStatus;
export type StackManagerProbe = RuntimeStackManagerProbe;
export type StackManagerStatusResponse = Readonly<{
  ok: true;
  status: StackManagerStatus;
  signerIds: readonly string[];
  probe?: StackManagerProbe;
}>;
export type StackManagerDeployRequest = DeployJurisdictionStackRequest;
export type StackContractAddresses = Readonly<{
  account: string;
  depositoryBounds: string;
  hashLadderRegistry: string;
  nftCustody: string;
  hankoVerifier: string;
  entityProvider: string;
  depository: string;
  deltaTransformer: string;
}>;
export type StackPublicationResult =
  | Readonly<{ status: 'not_requested'; scope: 'local' }>
  | Readonly<{
      status: 'queued' | 'published';
      scope: 'community' | 'official';
      announcement: JurisdictionGossipAnnouncement;
    }>;
export type StackManagerDeployResult = Readonly<{
  manifest: Readonly<{
    stackVersion: typeof STACK_VERSION;
    network: string;
    chainId: number;
    deployer: string;
    foundationRecipient: string;
    entityProviderDeploymentBlock: number;
    contracts: StackContractAddresses;
    registeredTokens: Readonly<{
      USDT: Readonly<{ address: string; tokenId: 1; decimals: 6 }>;
    }>;
  }>;
  localJurisdiction: Readonly<{ key: string; name: string }>;
  publication: StackPublicationResult;
}>;
export type StackManagerDeployResponse = Readonly<{ ok: true; result: StackManagerDeployResult }>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const literal = <T extends string | number | boolean>(value: unknown, expected: T, code: string): T => {
  if (value !== expected) throw new Error(code);
  return expected;
};
const oneOf = <T extends string>(value: unknown, values: readonly T[], code: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(code);
  return value as T;
};
const nonEmpty = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) throw new Error(code);
  return value;
};
const positiveInteger = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(code);
  return Number(value);
};
const isoTimestamp = (value: unknown, code: string): string => {
  const result = nonEmpty(value, code);
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result) throw new Error(code);
  return result;
};
const address = (value: unknown, code: string): string => {
  const result = nonEmpty(value, code);
  if (!/^0x[0-9a-fA-F]{40}$/.test(result)) throw new Error(code);
  return result;
};
const canonicalSignerIds = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) throw new Error('STACK_MANAGER_SIGNER_IDS_INVALID');
  const signerIds = value.map((entry) => address(entry, 'STACK_MANAGER_SIGNER_ID_INVALID'));
  if (signerIds.some((signerId) => signerId !== signerId.toLowerCase())) {
    throw new Error('STACK_MANAGER_SIGNER_ID_NOT_CANONICAL');
  }
  if (new Set(signerIds).size !== signerIds.length || signerIds.some((value, index) => index > 0 && signerIds[index - 1]! > value)) {
    throw new Error('STACK_MANAGER_SIGNER_IDS_NOT_SORTED_UNIQUE');
  }
  return signerIds;
};
const transactionHash = (value: unknown, code: string): string => {
  const result = nonEmpty(value, code);
  if (!/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error(code);
  return result;
};
const wei = (value: unknown, code: string): string => {
  const result = nonEmpty(value, code);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error(code);
  return result;
};
const decodeStatus = (value: unknown): StackManagerStatus => {
  const raw = record(value, 'STACK_MANAGER_STATUS_INVALID');
  exactKeys(raw, ['phase', 'active', 'updatedAt'], ['error'], 'STACK_MANAGER_STATUS_KEYS_INVALID');
  const phase = oneOf(raw['phase'], ['idle', 'preflight', 'deploying', 'verifying', 'persisting', 'complete', 'failed'], 'STACK_MANAGER_PHASE_INVALID');
  if (typeof raw['active'] !== 'boolean') throw new Error('STACK_MANAGER_ACTIVE_INVALID');
  const error = raw['error'] === undefined ? undefined : nonEmpty(raw['error'], 'STACK_MANAGER_ERROR_INVALID');
  return { phase, active: raw['active'], updatedAt: isoTimestamp(raw['updatedAt'], 'STACK_MANAGER_UPDATED_AT_INVALID'), ...(error ? { error } : {}) };
};
const decodeProbe = (value: unknown): StackManagerProbe => {
  const raw = record(value, 'STACK_MANAGER_PROBE_INVALID');
  exactKeys(raw, ['rpcUrl', 'chainId', 'signerId', 'nativeBalanceWei'], [], 'STACK_MANAGER_PROBE_KEYS_INVALID');
  const signerId = address(raw['signerId'], 'STACK_MANAGER_PROBE_SIGNER_INVALID');
  const nativeBalanceWei = wei(raw['nativeBalanceWei'], 'STACK_MANAGER_PROBE_BALANCE_INVALID');
  return {
    rpcUrl: nonEmpty(raw['rpcUrl'], 'STACK_MANAGER_PROBE_RPC_INVALID'),
    chainId: positiveInteger(raw['chainId'], 'STACK_MANAGER_PROBE_CHAIN_INVALID'),
    signerId,
    nativeBalanceWei,
  };
};
export const decodeStackManagerStatusResponse = (value: unknown): StackManagerStatusResponse => {
  const raw = record(value, 'STACK_MANAGER_STATUS_RESPONSE_INVALID');
  exactKeys(raw, ['ok', 'status', 'signerIds'], ['probe'], 'STACK_MANAGER_STATUS_RESPONSE_KEYS_INVALID');
  literal(raw['ok'], true, 'STACK_MANAGER_STATUS_RESPONSE_NOT_OK');
  const probe = raw['probe'] === undefined ? undefined : decodeProbe(raw['probe']);
  return {
    ok: true,
    status: decodeStatus(raw['status']),
    signerIds: canonicalSignerIds(raw['signerIds']),
    ...(probe ? { probe } : {}),
  };
};
const decodeContracts = (value: unknown): StackContractAddresses => {
  const raw = record(value, 'STACK_MANAGER_CONTRACTS_INVALID');
  const keys = ['account', 'depositoryBounds', 'hashLadderRegistry', 'nftCustody', 'hankoVerifier', 'entityProvider', 'depository', 'deltaTransformer'] as const;
  exactKeys(raw, keys, [], 'STACK_MANAGER_CONTRACTS_KEYS_INVALID');
  return {
    account: address(raw['account'], 'STACK_MANAGER_ACCOUNT_INVALID'),
    depositoryBounds: address(raw['depositoryBounds'], 'STACK_MANAGER_DEPOSITORY_BOUNDS_INVALID'),
    hashLadderRegistry: address(raw['hashLadderRegistry'], 'STACK_MANAGER_HASH_LADDER_REGISTRY_INVALID'),
    nftCustody: address(raw['nftCustody'], 'STACK_MANAGER_NFT_CUSTODY_INVALID'),
    hankoVerifier: address(raw['hankoVerifier'], 'STACK_MANAGER_HANKO_VERIFIER_INVALID'),
    entityProvider: address(raw['entityProvider'], 'STACK_MANAGER_ENTITY_PROVIDER_INVALID'),
    depository: address(raw['depository'], 'STACK_MANAGER_DEPOSITORY_INVALID'),
    deltaTransformer: address(raw['deltaTransformer'], 'STACK_MANAGER_DELTA_TRANSFORMER_INVALID'),
  };
};
const decodeEvmContracts = (value: unknown): void => {
  const raw = record(value, 'STACK_MANAGER_EVM_CONTRACTS_INVALID');
  const deployments = ['account', 'depositoryBounds', 'hashLadderRegistry', 'nftCustody', 'hankoVerifier', 'entityProvider', 'depository', 'deltaTransformer'] as const;
  exactKeys(raw, [...deployments, 'stablecoinRegistration'], ['stablecoin'], 'STACK_MANAGER_EVM_CONTRACTS_KEYS_INVALID');
  for (const name of deployments) {
    const deployment = record(raw[name], `STACK_MANAGER_${name.toUpperCase()}_DEPLOYMENT_INVALID`);
    exactKeys(deployment, ['address', 'deploymentBlock', 'transactionHash'], [], `STACK_MANAGER_${name.toUpperCase()}_DEPLOYMENT_KEYS_INVALID`);
    address(deployment['address'], `STACK_MANAGER_${name.toUpperCase()}_DEPLOYMENT_ADDRESS_INVALID`);
    positiveInteger(deployment['deploymentBlock'], `STACK_MANAGER_${name.toUpperCase()}_DEPLOYMENT_BLOCK_INVALID`);
    transactionHash(deployment['transactionHash'], `STACK_MANAGER_${name.toUpperCase()}_DEPLOYMENT_TX_INVALID`);
  }
  if (raw['stablecoin'] !== undefined) {
    const stablecoin = record(raw['stablecoin'], 'STACK_MANAGER_STABLECOIN_DEPLOYMENT_INVALID');
    exactKeys(stablecoin, ['address', 'deploymentBlock', 'transactionHash'], [], 'STACK_MANAGER_STABLECOIN_DEPLOYMENT_KEYS_INVALID');
    address(stablecoin['address'], 'STACK_MANAGER_STABLECOIN_DEPLOYMENT_ADDRESS_INVALID');
    positiveInteger(stablecoin['deploymentBlock'], 'STACK_MANAGER_STABLECOIN_DEPLOYMENT_BLOCK_INVALID');
    transactionHash(stablecoin['transactionHash'], 'STACK_MANAGER_STABLECOIN_DEPLOYMENT_TX_INVALID');
  }
  const registration = record(raw['stablecoinRegistration'], 'STACK_MANAGER_STABLECOIN_REGISTRATION_INVALID');
  exactKeys(registration, ['transactionHash', 'blockNumber'], [], 'STACK_MANAGER_STABLECOIN_REGISTRATION_KEYS_INVALID');
  transactionHash(registration['transactionHash'], 'STACK_MANAGER_STABLECOIN_REGISTRATION_TX_INVALID');
  positiveInteger(registration['blockNumber'], 'STACK_MANAGER_STABLECOIN_REGISTRATION_BLOCK_INVALID');
};
const decodeDeployResult = (value: unknown): StackManagerDeployResult => {
  const raw = record(value, 'STACK_MANAGER_RESULT_INVALID');
  exactKeys(raw, ['manifest', 'localJurisdiction', 'publication'], [], 'STACK_MANAGER_RESULT_KEYS_INVALID');
  const manifest = record(raw['manifest'], 'STACK_MANAGER_MANIFEST_INVALID');
  exactKeys(manifest, ['stackVersion', 'network', 'chainId', 'deployer', 'foundationRecipient', 'entityProviderDeploymentBlock', 'contracts', 'evmContracts', 'registeredTokens'], [], 'STACK_MANAGER_MANIFEST_KEYS_INVALID');
  // Receipt evidence is decoded even though the compact UI only renders canonical addresses.
  decodeEvmContracts(manifest['evmContracts']);
  const tokens = record(manifest['registeredTokens'], 'STACK_MANAGER_TOKENS_INVALID');
  exactKeys(tokens, ['USDT'], [], 'STACK_MANAGER_TOKENS_KEYS_INVALID');
  const usdt = record(tokens['USDT'], 'STACK_MANAGER_USDT_INVALID');
  exactKeys(usdt, ['address', 'tokenId', 'decimals'], [], 'STACK_MANAGER_USDT_KEYS_INVALID');
  const local = record(raw['localJurisdiction'], 'STACK_MANAGER_LOCAL_JURISDICTION_INVALID');
  exactKeys(local, ['key', 'name'], [], 'STACK_MANAGER_LOCAL_JURISDICTION_KEYS_INVALID');
  const publication = record(raw['publication'], 'STACK_MANAGER_PUBLICATION_INVALID');
  const publicationStatus = oneOf(publication['status'], ['not_requested', 'queued', 'published'], 'STACK_MANAGER_PUBLICATION_STATUS_INVALID');
  const scope = oneOf(publication['scope'], ['local', 'community', 'official'], 'STACK_MANAGER_PUBLICATION_SCOPE_INVALID');
  exactKeys(
    publication,
    ['status', 'scope', ...(publicationStatus === 'not_requested' ? [] : ['announcement'])],
    [],
    'STACK_MANAGER_PUBLICATION_KEYS_INVALID',
  );
  if (publicationStatus === 'not_requested' && scope !== 'local') {
    throw new Error('STACK_MANAGER_LOCAL_PUBLICATION_INVALID');
  }
  let decodedPublication: StackPublicationResult;
  if (publicationStatus === 'not_requested') {
    decodedPublication = { status: 'not_requested', scope: 'local' };
  } else {
    if (scope === 'local') throw new Error('STACK_MANAGER_GOSSIP_PUBLICATION_INVALID');
    const announcement = decodeJurisdictionGossipAnnouncementStructure(publication['announcement']);
    if (
      announcement.scope !== scope ||
      announcement.chainId !== manifest['chainId'] ||
      announcement.deployer !== String(manifest['deployer']).toLowerCase() ||
      announcement.foundationRecipient !== String(manifest['foundationRecipient']).toLowerCase()
    ) throw new Error('STACK_MANAGER_GOSSIP_MANIFEST_MISMATCH');
    const decodedContracts = decodeContracts(manifest['contracts']);
    for (const [name, contractAddress] of Object.entries(decodedContracts)) {
      if (announcement.contracts[name as keyof StackContractAddresses] !== contractAddress.toLowerCase()) {
        throw new Error('STACK_MANAGER_GOSSIP_MANIFEST_MISMATCH');
      }
    }
    decodedPublication = { status: publicationStatus, scope, announcement };
  }
  return {
    manifest: {
      stackVersion: literal(manifest['stackVersion'], STACK_VERSION, 'STACK_MANAGER_VERSION_INVALID'),
      network: nonEmpty(manifest['network'], 'STACK_MANAGER_NETWORK_INVALID'),
      chainId: positiveInteger(manifest['chainId'], 'STACK_MANAGER_CHAIN_INVALID'),
      deployer: address(manifest['deployer'], 'STACK_MANAGER_DEPLOYER_INVALID'),
      foundationRecipient: address(manifest['foundationRecipient'], 'STACK_MANAGER_FOUNDATION_INVALID'),
      entityProviderDeploymentBlock: positiveInteger(manifest['entityProviderDeploymentBlock'], 'STACK_MANAGER_DEPLOYMENT_BLOCK_INVALID'),
      contracts: decodeContracts(manifest['contracts']),
      registeredTokens: { USDT: { address: address(usdt['address'], 'STACK_MANAGER_USDT_ADDRESS_INVALID'), tokenId: literal(usdt['tokenId'], 1, 'STACK_MANAGER_USDT_TOKEN_INVALID'), decimals: literal(usdt['decimals'], 6, 'STACK_MANAGER_USDT_DECIMALS_INVALID') } },
    },
    localJurisdiction: { key: nonEmpty(local['key'], 'STACK_MANAGER_LOCAL_KEY_INVALID'), name: nonEmpty(local['name'], 'STACK_MANAGER_LOCAL_NAME_INVALID') },
    publication: decodedPublication,
  };
};
export const decodeStackManagerDeployResponse = (value: unknown): StackManagerDeployResponse => {
  const raw = record(value, 'STACK_MANAGER_DEPLOY_RESPONSE_INVALID');
  exactKeys(raw, ['ok', 'result'], [], 'STACK_MANAGER_DEPLOY_RESPONSE_KEYS_INVALID');
  literal(raw['ok'], true, 'STACK_MANAGER_DEPLOY_RESPONSE_NOT_OK');
  return { ok: true, result: decodeDeployResult(raw['result']) };
};
const responseJson = async (response: Response, code: string): Promise<unknown> => {
  if (!response.ok) throw new Error(`${code}_HTTP_${response.status}`);
  const value: unknown = await response.json();
  return value;
};
export const fetchStackManagerStatus = async (
  runtimeApiOrigin: string,
  rpcUrl: string,
  signerId: string,
  adminCapability: string,
  fetcher: FetchLike = fetch,
): Promise<StackManagerStatusResponse> => {
  if (!adminCapability) throw new Error('STACK_MANAGER_ADMIN_CAPABILITY_REQUIRED');
  const query = new URLSearchParams();
  if (rpcUrl) query.set('rpcUrl', rpcUrl);
  if (signerId) query.set('signerId', signerId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const response = await fetcher(new URL(`/api/stack-manager/status${suffix}`, runtimeApiOrigin), {
    cache: 'no-store',
    headers: { authorization: `Bearer ${adminCapability}` },
  });
  return decodeStackManagerStatusResponse(await responseJson(response, 'STACK_MANAGER_STATUS'));
};
export const deployStack = async (
  runtimeApiOrigin: string,
  request: StackManagerDeployRequest,
  adminCapability: string,
  fetcher: FetchLike = fetch,
): Promise<StackManagerDeployResponse> => {
  if (!adminCapability) throw new Error('STACK_MANAGER_ADMIN_CAPABILITY_REQUIRED');
  const response = await fetcher(new URL('/api/control/stack-manager/deploy', runtimeApiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminCapability}` },
    body: safeStringify({ stackVersion: STACK_VERSION, ...request }),
  });
  return decodeStackManagerDeployResponse(await responseJson(response, 'STACK_MANAGER_DEPLOY'));
};

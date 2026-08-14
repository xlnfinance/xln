/**
 * Exact decoders for Stack Manager operator input and Hardhat deployment output.
 * They prevent untrusted HTTP/subprocess JSON from minting deployment authority
 * through a generic cast. [96/100]
 */

import { getAddress, isAddress } from 'ethers';
import { normalizeJurisdictionKey } from '../../../jurisdiction/machine/config/jurisdiction-key';
import {
  JURISDICTION_STACK_VERSION,
  type DeployJurisdictionStackRequest,
  type JurisdictionStackManifest,
  type StackContractDeployment,
  type StackContractName,
} from './types';

const CONTRACT_NAMES = [
  'account',
  'depositoryBounds',
  'hashLadderRegistry',
  'nftCustody',
  'hankoVerifier',
  'entityProvider',
  'depository',
  'deltaTransformer',
] as const satisfies readonly StackContractName[];

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(code);
  }
};

const nonEmpty = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const safePositiveInteger = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
};

const address = (value: unknown, code: string): string => {
  const raw = nonEmpty(value, code);
  if (!isAddress(raw)) throw new Error(code);
  return getAddress(raw);
};

const rpcUrl = (value: unknown): string => {
  const raw = nonEmpty(value, 'STACK_MANAGER_RPC_URL_REQUIRED');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('STACK_MANAGER_RPC_URL_PROTOCOL_INVALID');
  }
  if (parsed.username || parsed.password) {
    throw new Error('STACK_MANAGER_RPC_URL_CREDENTIALS_FORBIDDEN');
  }
  return raw;
};

export const decodeDeployJurisdictionStackRequest = (
  value: unknown,
): DeployJurisdictionStackRequest => {
  const input = record(value, 'STACK_MANAGER_REQUEST_INVALID');
  exactKeys(input, [
    'name', 'key', 'rpcUrl', 'expectedChainId', 'blockTimeMs', 'currency', 'explorer',
    'signerId', 'foundationRecipient', 'stablecoin', 'publication',
  ], ['confirmations', 'stackVersion', 'description'], 'STACK_MANAGER_REQUEST_KEYS_INVALID');
  if (input['stackVersion'] !== undefined && input['stackVersion'] !== JURISDICTION_STACK_VERSION) {
    throw new Error('STACK_MANAGER_VERSION_INVALID');
  }
  const name = nonEmpty(input['name'], 'STACK_MANAGER_NAME_REQUIRED');
  const rawKey = nonEmpty(input['key'], 'STACK_MANAGER_KEY_REQUIRED');
  const key = normalizeJurisdictionKey(rawKey, '');
  if (!key || key !== rawKey.trim().toLowerCase()) throw new Error('STACK_MANAGER_KEY_INVALID');
  const expectedChainId = safePositiveInteger(input['expectedChainId'], 'STACK_MANAGER_CHAIN_ID_INVALID');
  const blockTimeMs = safePositiveInteger(input['blockTimeMs'], 'STACK_MANAGER_BLOCK_TIME_INVALID');
  const currency = nonEmpty(input['currency'], 'STACK_MANAGER_CURRENCY_INVALID');
  const explorer = typeof input['explorer'] === 'string'
    ? input['explorer'].trim()
    : (() => { throw new Error('STACK_MANAGER_EXPLORER_INVALID'); })();
  if (explorer && !/^https?:\/\//.test(explorer)) throw new Error('STACK_MANAGER_EXPLORER_INVALID');
  const description = input['description'] === undefined
    ? undefined
    : nonEmpty(input['description'], 'STACK_MANAGER_DESCRIPTION_INVALID');
  const signerId = address(input['signerId'], 'STACK_MANAGER_SIGNER_ID_INVALID').toLowerCase();
  const foundationRecipient = address(
    input['foundationRecipient'],
    'STACK_MANAGER_FOUNDATION_RECIPIENT_INVALID',
  );
  const stablecoinInput = record(input['stablecoin'], 'STACK_MANAGER_STABLECOIN_INVALID');
  exactKeys(
    stablecoinInput,
    stablecoinInput['kind'] === 'existing' ? ['kind', 'address'] : ['kind'],
    [],
    'STACK_MANAGER_STABLECOIN_KEYS_INVALID',
  );
  const stablecoin = stablecoinInput['kind'] === 'test'
    ? { kind: 'test' as const }
    : stablecoinInput['kind'] === 'existing'
      ? { kind: 'existing' as const, address: address(stablecoinInput['address'], 'STACK_MANAGER_STABLECOIN_ADDRESS_INVALID') }
      : (() => { throw new Error('STACK_MANAGER_STABLECOIN_KIND_INVALID'); })();
  const publication = input['publication'];
  if (publication !== 'local' && publication !== 'community' && publication !== 'official') {
    throw new Error('STACK_MANAGER_PUBLICATION_INVALID');
  }
  const confirmations = input['confirmations'] === undefined
    ? (expectedChainId === 31_337 || expectedChainId === 1_337 ? 1 : 12)
    : safePositiveInteger(input['confirmations'], 'STACK_MANAGER_CONFIRMATIONS_INVALID');
  return {
    name,
    key,
    rpcUrl: rpcUrl(input['rpcUrl']),
    expectedChainId,
    blockTimeMs,
    currency,
    explorer,
    ...(description ? { description } : {}),
    signerId,
    foundationRecipient,
    stablecoin,
    publication,
    confirmations,
  };
};

const decodeDeployment = (value: unknown, name: string): StackContractDeployment => {
  const deployment = record(value, `STACK_MANAGER_${name.toUpperCase()}_DEPLOYMENT_INVALID`);
  exactKeys(deployment, ['address', 'deploymentBlock', 'transactionHash'], [], `STACK_MANAGER_${name.toUpperCase()}_DEPLOYMENT_KEYS_INVALID`);
  return {
    address: address(deployment['address'], `STACK_MANAGER_${name.toUpperCase()}_ADDRESS_INVALID`),
    deploymentBlock: safePositiveInteger(
      deployment['deploymentBlock'],
      `STACK_MANAGER_${name.toUpperCase()}_BLOCK_INVALID`,
    ),
    transactionHash: (() => {
      const transactionHash = nonEmpty(
      deployment['transactionHash'],
      `STACK_MANAGER_${name.toUpperCase()}_TX_INVALID`,
      ).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new Error(`STACK_MANAGER_${name.toUpperCase()}_TX_INVALID`);
      return transactionHash;
    })(),
  };
};

export const decodeJurisdictionStackManifest = (value: unknown): JurisdictionStackManifest => {
  const manifest = record(value, 'STACK_MANAGER_MANIFEST_INVALID');
  exactKeys(manifest, [
    'stackVersion', 'network', 'chainId', 'deployer', 'foundationRecipient',
    'entityProviderDeploymentBlock', 'contracts', 'evmContracts', 'registeredTokens',
  ], [], 'STACK_MANAGER_MANIFEST_KEYS_INVALID');
  if (manifest['stackVersion'] !== JURISDICTION_STACK_VERSION) {
    throw new Error('STACK_MANAGER_VERSION_INVALID');
  }
  const contractsInput = record(manifest['contracts'], 'STACK_MANAGER_CONTRACTS_INVALID');
  const deploymentsInput = record(manifest['evmContracts'], 'STACK_MANAGER_DEPLOYMENTS_INVALID');
  exactKeys(contractsInput, CONTRACT_NAMES, [], 'STACK_MANAGER_CONTRACT_KEYS_INVALID');
  exactKeys(
    deploymentsInput,
    [...CONTRACT_NAMES, 'stablecoinRegistration'],
    ['stablecoin'],
    'STACK_MANAGER_DEPLOYMENT_KEYS_INVALID',
  );
  const contracts = Object.fromEntries(CONTRACT_NAMES.map(name => [
    name,
    address(contractsInput[name], `STACK_MANAGER_${name.toUpperCase()}_ADDRESS_INVALID`),
  ])) as Record<StackContractName, string>;
  const deployments = Object.fromEntries(CONTRACT_NAMES.map(name => [
    name,
    decodeDeployment(deploymentsInput[name], name),
  ])) as Record<StackContractName, StackContractDeployment>;
  const registeredTokens = record(manifest['registeredTokens'], 'STACK_MANAGER_TOKENS_INVALID');
  exactKeys(registeredTokens, ['USDT'], [], 'STACK_MANAGER_TOKEN_KEYS_INVALID');
  const usdt = record(registeredTokens['USDT'], 'STACK_MANAGER_USDT_INVALID');
  exactKeys(usdt, ['address', 'tokenId', 'decimals'], [], 'STACK_MANAGER_USDT_KEYS_INVALID');
  const stablecoinRegistration = record(
    deploymentsInput['stablecoinRegistration'],
    'STACK_MANAGER_STABLECOIN_REGISTRATION_INVALID',
  );
  exactKeys(
    stablecoinRegistration,
    ['transactionHash', 'blockNumber'],
    [],
    'STACK_MANAGER_STABLECOIN_REGISTRATION_KEYS_INVALID',
  );
  const registrationTransactionHash = nonEmpty(
    stablecoinRegistration['transactionHash'],
    'STACK_MANAGER_STABLECOIN_REGISTRATION_TX_INVALID',
  ).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(registrationTransactionHash)) {
    throw new Error('STACK_MANAGER_STABLECOIN_REGISTRATION_TX_INVALID');
  }
  const stablecoinDeployment = deploymentsInput['stablecoin'] === undefined
    ? undefined
    : decodeDeployment(deploymentsInput['stablecoin'], 'stablecoin');
  if (usdt['tokenId'] !== 1 || usdt['decimals'] !== 6) throw new Error('STACK_MANAGER_USDT_CANONICAL_INVALID');
  return {
    stackVersion: JURISDICTION_STACK_VERSION,
    network: nonEmpty(manifest['network'], 'STACK_MANAGER_NETWORK_INVALID'),
    chainId: safePositiveInteger(manifest['chainId'], 'STACK_MANAGER_CHAIN_ID_INVALID'),
    deployer: address(manifest['deployer'], 'STACK_MANAGER_DEPLOYER_INVALID'),
    foundationRecipient: address(manifest['foundationRecipient'], 'STACK_MANAGER_FOUNDATION_RECIPIENT_INVALID'),
    entityProviderDeploymentBlock: safePositiveInteger(
      manifest['entityProviderDeploymentBlock'],
      'STACK_MANAGER_ENTITY_PROVIDER_BLOCK_INVALID',
    ),
    contracts,
    evmContracts: {
      ...deployments,
      stablecoinRegistration: {
        transactionHash: registrationTransactionHash,
        blockNumber: safePositiveInteger(
          stablecoinRegistration['blockNumber'],
          'STACK_MANAGER_STABLECOIN_REGISTRATION_BLOCK_INVALID',
        ),
      },
      ...(stablecoinDeployment ? { stablecoin: stablecoinDeployment } : {}),
    },
    registeredTokens: {
      USDT: {
        address: address(usdt['address'], 'STACK_MANAGER_USDT_ADDRESS_INVALID'),
        tokenId: 1,
        decimals: 6,
      },
    },
  };
};

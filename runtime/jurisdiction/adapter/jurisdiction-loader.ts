/**
 * Centralized jurisdiction loader
 * Single source of truth for loading jurisdictions.json
 * Caches the exact parsed result to avoid multiple file reads.
 * Missing or malformed canonical configuration is fatal: an I/O failure must
 * never masquerade as a deliberately empty network.
 */

// Browser-compatible: Use isBrowser check instead of fs
import { isBrowser } from '../../infra/platform-crypto';
import { resolveJurisdictionsJsonPath } from './jurisdictions-path';
import { createStructuredLogger } from '../../infra/logger';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireBoolean,
  requireExactBoundaryKeys,
  requireFiniteNumber,
  requireString,
  validateStorageSafeValue,
} from '../../protocol/boundary/boundary-primitives';

const jurisdictionLoaderLog = createStructuredLogger('runtime.jurisdiction_loader');

interface JurisdictionConfig {
  name: string;
  chainId: number;
  blockTimeMs: number;
  primary?: boolean;
  entityProviderDeploymentBlock?: number;
  rpc: string;
  rebalancePolicyUsd?: {
    r2cRequestSoftLimit: number;
    hardLimit: number;
    maxFee: number;
  };
  contracts: {
    entityProvider: string;
    depository: string;
    account?: string;
    deltaTransformer?: string;
    hankoVerifier?: string;
  };
  explorer: string;
  currency: string;
  status: string;
}

interface JurisdictionsData {
  version: string;
  lastUpdated: string;
  jurisdictions: Record<string, JurisdictionConfig>;
  defaults: {
    timeout: number;
    retryAttempts: number;
    gasLimit: number;
    rebalancePolicyUsd?: {
      r2cRequestSoftLimit: number;
      hardLimit: number;
      maxFee: number;
    };
  };
}

let cachedJurisdictions: JurisdictionsData | null = null;

const decodePolicy = (
  value: unknown,
  code: string,
): NonNullable<JurisdictionConfig['rebalancePolicyUsd']> => {
  const policy = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    policy,
    ['r2cRequestSoftLimit', 'hardLimit', 'maxFee'],
    [],
    `${code}_FIELDS`,
  );
  return {
    r2cRequestSoftLimit: requireFiniteNumber(
      policy['r2cRequestSoftLimit'],
      `${code}_SOFT_LIMIT`,
      0,
    ),
    hardLimit: requireFiniteNumber(policy['hardLimit'], `${code}_HARD_LIMIT`, 0),
    maxFee: requireFiniteNumber(policy['maxFee'], `${code}_MAX_FEE`, 0),
  };
};

const requireText = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const decodeJurisdiction = (
  value: unknown,
  code: string,
): JurisdictionConfig => {
  const entry = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(entry, [
    'name', 'chainId', 'blockTimeMs', 'rpc', 'contracts',
    'explorer', 'currency', 'status',
  ], [
    'description', 'rebalancePolicyUsd',
    'entityProviderDeploymentBlock', 'tokens', 'tronContracts', 'evmContracts',
    'primary',
  ], `${code}_FIELDS`);
  const contracts = requireBoundaryRecord(entry['contracts'], `${code}_CONTRACTS`);
  requireExactBoundaryKeys(
    contracts,
    ['entityProvider', 'depository'],
    ['account', 'deltaTransformer', 'hankoVerifier'],
    `${code}_CONTRACT_FIELDS`,
  );
  const decodedContracts: JurisdictionConfig['contracts'] = {
    entityProvider: requireString(
      contracts['entityProvider'],
      `${code}_ENTITY_PROVIDER`,
    ),
    depository: requireString(contracts['depository'], `${code}_DEPOSITORY`),
    ...(contracts['account'] === undefined
      ? {}
      : { account: requireString(contracts['account'], `${code}_ACCOUNT`) }),
    ...(contracts['deltaTransformer'] === undefined
      ? {}
      : {
          deltaTransformer: requireString(
            contracts['deltaTransformer'],
            `${code}_DELTA_TRANSFORMER`,
          ),
        }),
    ...(contracts['hankoVerifier'] === undefined
      ? {}
      : {
          hankoVerifier: requireString(
            contracts['hankoVerifier'],
            `${code}_HANKO_VERIFIER`,
          ),
        }),
  };
  for (const field of ['tokens', 'tronContracts', 'evmContracts'] as const) {
    if (entry[field] !== undefined) {
      validateStorageSafeValue(entry[field], `${code}_${field.toUpperCase()}`);
    }
  }
  return {
    name: requireString(entry['name'], `${code}_NAME`),
    chainId: requireBoundaryInteger(entry['chainId'], `${code}_CHAIN_ID`, 1),
    blockTimeMs: requireFiniteNumber(
      entry['blockTimeMs'],
      `${code}_BLOCK_TIME`,
      1,
    ),
    rpc: requireString(entry['rpc'], `${code}_RPC`),
    contracts: decodedContracts,
    explorer: requireText(entry['explorer'], `${code}_EXPLORER`),
    currency: requireString(entry['currency'], `${code}_CURRENCY`),
    status: requireString(entry['status'], `${code}_STATUS`),
    ...(entry['primary'] === undefined
      ? {}
      : { primary: requireBoolean(entry['primary'], `${code}_PRIMARY`) }),
    ...(entry['entityProviderDeploymentBlock'] === undefined
      ? {}
      : {
          entityProviderDeploymentBlock: requireBoundaryInteger(
            entry['entityProviderDeploymentBlock'],
            `${code}_DEPLOYMENT_BLOCK`,
            1,
          ),
        }),
    ...(entry['rebalancePolicyUsd'] === undefined
      ? {}
      : {
          rebalancePolicyUsd: decodePolicy(
            entry['rebalancePolicyUsd'],
            `${code}_REBALANCE`,
          ),
        }),
  };
};

const decodeJurisdictionsData = (value: unknown): JurisdictionsData => {
  const root = requireBoundaryRecord(value, 'JURISDICTIONS_ROOT_INVALID');
  requireExactBoundaryKeys(
    root,
    ['version', 'lastUpdated', 'jurisdictions', 'defaults'],
    ['deployVersion', 'networkVersion'],
    'JURISDICTIONS_ROOT_FIELDS',
  );
  for (const field of ['deployVersion', 'networkVersion'] as const) {
    if (root[field] !== undefined) {
      requireString(root[field], `JURISDICTIONS_${field.toUpperCase()}_INVALID`);
    }
  }
  const rawEntries = requireBoundaryRecord(
    root['jurisdictions'],
    'JURISDICTIONS_MAP_INVALID',
  );
  const defaults = requireBoundaryRecord(
    root['defaults'],
    'JURISDICTIONS_DEFAULTS_INVALID',
  );
  requireExactBoundaryKeys(
    defaults,
    ['timeout', 'retryAttempts', 'gasLimit'],
    ['rebalancePolicyUsd'],
    'JURISDICTIONS_DEFAULTS_FIELDS',
  );
  return {
    version: requireString(root['version'], 'JURISDICTIONS_VERSION_INVALID'),
    lastUpdated: requireString(
      root['lastUpdated'],
      'JURISDICTIONS_LAST_UPDATED_INVALID',
    ),
    jurisdictions: Object.fromEntries(
      Object.entries(rawEntries).map(([key, entry]) => [
        key,
        decodeJurisdiction(entry, `JURISDICTION_${key}`),
      ]),
    ),
    defaults: {
      timeout: requireBoundaryInteger(
        defaults['timeout'],
        'JURISDICTIONS_DEFAULT_TIMEOUT',
      ),
      retryAttempts: requireBoundaryInteger(
        defaults['retryAttempts'],
        'JURISDICTIONS_DEFAULT_RETRIES',
      ),
      gasLimit: requireBoundaryInteger(
        defaults['gasLimit'],
        'JURISDICTIONS_DEFAULT_GAS_LIMIT',
      ),
      ...(defaults['rebalancePolicyUsd'] === undefined
        ? {}
        : {
            rebalancePolicyUsd: decodePolicy(
              defaults['rebalancePolicyUsd'],
              'JURISDICTIONS_DEFAULT_REBALANCE',
            ),
          }),
    },
  };
};

const readNodeEnvFlag = (name: string): boolean =>
  typeof process !== 'undefined' && process.env?.[name] === '1';

const shouldLogJurisdictionLoaderDebug = (): boolean =>
  readNodeEnvFlag('XLN_JURISDICTIONS_DEBUG');

const logJurisdictionLoaderDebug = (message: string, fields: Record<string, unknown> = {}): void => {
  if (shouldLogJurisdictionLoaderDebug()) jurisdictionLoaderLog.info(message, fields);
};

/**
 * Load jurisdictions.json once and cache the result
 * All parts of the system should use this function
 */
export function loadJurisdictions(): JurisdictionsData {
  // Browser compatibility check
  if (isBrowser) {
    throw new Error('loadJurisdictions() not available in browser - use runtime/jurisdiction/adapter/config.ts instead');
  }

  // Return cached result if available (Node.js only)
  if (cachedJurisdictions) {
    return cachedJurisdictions;
  }

  let filePath = '';
  try {
    const fs = require('fs'); // Dynamic require for Node.js only
    const candidates = [resolveJurisdictionsJsonPath()];
    filePath = candidates.find((candidate: string) => fs.existsSync(candidate)) ?? '';

    if (!fs.existsSync(filePath)) {
      throw new Error(
        `JURISDICTIONS_CONFIG_MISSING:path=${resolveJurisdictionsJsonPath()}`,
      );
    }

    const jurisdictionsContent = fs.readFileSync(filePath, 'utf8');
    cachedJurisdictions = decodeJurisdictionsData(
      JSON.parse(jurisdictionsContent),
    );

    logJurisdictionLoaderDebug('config_loaded', {
      path: filePath,
      version: cachedJurisdictions?.version,
      lastUpdated: cachedJurisdictions?.lastUpdated,
      keys: Object.keys(cachedJurisdictions?.jurisdictions || {}),
    });

    return cachedJurisdictions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JURISDICTIONS_LOAD_FAILED:path=${filePath || 'unknown'}:${message}`);
  }
}

/**
 * Clear the cache (useful for testing or when file is updated)
 */
export function clearJurisdictionsCache(): void {
  cachedJurisdictions = null;
  logJurisdictionLoaderDebug('cache_cleared');
}

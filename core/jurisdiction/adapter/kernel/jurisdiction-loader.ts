/**
 * Centralized jurisdiction loader
 * Single source of truth for loading jurisdictions.json
 * Caches the exact parsed result to avoid multiple file reads.
 * Missing or malformed canonical configuration is fatal: an I/O failure must
 * never masquerade as a deliberately empty network.
 */

// Browser-compatible: Use isBrowser check instead of fs
import { resolveNativeTransportHost } from './native-host';
import { isBrowser } from '../../../support/platform-crypto';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { createStructuredLogger } from '../../../support/logger';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireBoolean,
  requireExactBoundaryKeys,
  requireFiniteNumber,
  requireString,
  validateStorageSafeValue,
} from '../../../protocol/boundary/boundary-primitives';
import {
  decodeJurisdictionGossipAnnouncement,
  type JurisdictionGossipAnnouncement,
} from '../../gossip/announcement';

const jurisdictionLoaderLog = createStructuredLogger('runtime.jurisdiction_loader');

export type JurisdictionTransport =
  | { mode?: never; tronFullHost?: never; tronSolidityHost?: never }
  | { mode: 'rpc'; tronFullHost?: never; tronSolidityHost?: never }
  | { mode: 'tron'; tronFullHost: string; tronSolidityHost?: string };

type JurisdictionConfig = {
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
} & JurisdictionTransport;

export interface JurisdictionsData {
  version: string;
  lastUpdated: string;
  ephemeralTestnet?: boolean;
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
  officialFoundationSignerId?: string;
  jurisdictionAnnouncements?: JurisdictionGossipAnnouncement[];
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

const requireNativeHost = (value: unknown, code: string): string => {
  const host = resolveNativeTransportHost(requireString(value, code), isBrowser ? window.location.origin : undefined);
  if (host !== host.trim() || !URL.canParse(host)) throw new Error(code);
  const url = new URL(host);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || host.includes('#')) {
    throw new Error(code);
  }
  return host;
};

/** Local transport selects real chain I/O; it never adds financial or WAL state. */
export const decodeJurisdictionTransport = (value: Record<string, unknown>, code: string): JurisdictionTransport => {
  const mode = value['mode'];
  if (mode !== undefined && mode !== 'rpc' && mode !== 'tron') throw new Error(`${code}_MODE_INVALID`);
  if (mode !== 'tron') {
    if (value['tronFullHost'] !== undefined || value['tronSolidityHost'] !== undefined) {
      throw new Error(`${code}_TRON_HOST_WITHOUT_TRON_MODE`);
    }
    return mode === 'rpc' ? { mode } : {};
  }
  return {
    mode,
    tronFullHost: requireNativeHost(value['tronFullHost'], `${code}_TRON_FULL_HOST_INVALID`),
    ...(value['tronSolidityHost'] === undefined
      ? {}
      : {
          tronSolidityHost: requireNativeHost(value['tronSolidityHost'], `${code}_TRON_SOLIDITY_HOST_INVALID`),
        }),
  };
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
    'entityProviderDeploymentBlock', 'tokens', 'tokenRegistry', 'tronContracts', 'evmContracts',
    'primary', 'stackVersion', 'deployer', 'foundationRecipient',
    'mode', 'tronFullHost', 'tronSolidityHost',
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
  for (const field of ['tokens', 'tokenRegistry', 'tronContracts', 'evmContracts'] as const) {
    if (entry[field] !== undefined) {
      validateStorageSafeValue(entry[field], `${code}_${field.toUpperCase()}`);
    }
  }
  if (entry['stackVersion'] !== undefined && entry['stackVersion'] !== 'V1') {
    throw new Error(`${code}_STACK_VERSION_INVALID`);
  }
  for (const field of ['deployer', 'foundationRecipient'] as const) {
    if (entry[field] !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(requireString(entry[field], `${code}_${field}`))) {
      throw new Error(`${code}_${field.toUpperCase()}_INVALID`);
    }
  }
  return {
    ...decodeJurisdictionTransport(entry, code),
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

export const decodeJurisdictionsData = (value: unknown): JurisdictionsData => {
  const root = requireBoundaryRecord(value, 'JURISDICTIONS_ROOT_INVALID');
  requireExactBoundaryKeys(
    root,
    ['version', 'lastUpdated', 'jurisdictions', 'defaults'],
    ['deployVersion', 'networkVersion', 'officialFoundationSignerId', 'jurisdictionAnnouncements', 'ephemeralTestnet'],
    'JURISDICTIONS_ROOT_FIELDS',
  );
  for (const field of ['deployVersion', 'networkVersion'] as const) {
    if (root[field] !== undefined) {
      requireString(root[field], `JURISDICTIONS_${field.toUpperCase()}_INVALID`);
    }
  }
  let officialFoundationSignerId: string | undefined;
  if (root['officialFoundationSignerId'] !== undefined) {
    const decoded = requireString(
      root['officialFoundationSignerId'],
      'JURISDICTIONS_OFFICIAL_FOUNDATION_SIGNER_INVALID',
    );
    if (!/^0x[0-9a-f]{40}$/.test(decoded)) {
      throw new Error('JURISDICTIONS_OFFICIAL_FOUNDATION_SIGNER_INVALID');
    }
    officialFoundationSignerId = decoded;
  }
  const announcementValues = root['jurisdictionAnnouncements'];
  if (announcementValues !== undefined && !Array.isArray(announcementValues)) {
    throw new Error('JURISDICTIONS_GOSSIP_ANNOUNCEMENTS_INVALID');
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
    ...(root['ephemeralTestnet'] === undefined ? {} : {
      ephemeralTestnet: requireBoolean(root['ephemeralTestnet'], 'JURISDICTIONS_EPHEMERAL_TESTNET_INVALID'),
    }),
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
    ...(officialFoundationSignerId === undefined ? {} : { officialFoundationSignerId }),
    ...(announcementValues === undefined ? {} : {
      jurisdictionAnnouncements: announcementValues.map((announcement) =>
        decodeJurisdictionGossipAnnouncement(announcement, officialFoundationSignerId),
      ),
    }),
  };
};

export const validateJurisdictionsDataValue = (value: unknown): Record<string, unknown> => {
  decodeJurisdictionsData(value);
  return requireBoundaryRecord(value, 'JURISDICTIONS_ROOT_INVALID');
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
    throw new Error('loadJurisdictions() not available in browser - use loadJurisdictionsAsync() instead');
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

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const fetchBrowserJurisdictions = async (signal: AbortSignal): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(`/api/jurisdictions?ts=${Date.now()}`, {
      signal,
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
    });
  } catch (error: unknown) {
    throw new Error(`JURISDICTIONS_BROWSER_FETCH_FAILED:${signal.aborted ? 'timeout' : errorMessage(error)}`);
  }
  if (!response.ok) throw new Error(`JURISDICTIONS_BROWSER_HTTP_STATUS:${response.status}`);
  return response;
};

/** Both environments decode the same canonical source; browser I/O never reads Node files. */
export const loadJurisdictionsAsync = async (): Promise<JurisdictionsData> => {
  if (!isBrowser) return loadJurisdictions();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetchBrowserJurisdictions(controller.signal);
    try {
      return decodeJurisdictionsData(await response.json());
    } catch (error: unknown) {
      jurisdictionLoaderLog.error('browser_config_invalid', { error: errorMessage(error) });
      throw new Error(`JURISDICTIONS_BROWSER_CONFIG_INVALID:${errorMessage(error)}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
};

/** Resolve only the configured chain/contract identity, never a display name or RPC alias. */
export const resolveJurisdictionTransport = async (
  chainId: number,
  depository: string,
): Promise<JurisdictionTransport | undefined> => {
  const data = await loadJurisdictionsAsync();
  const normalizedDepository = depository.toLowerCase();
  const matches = Object.values(data.jurisdictions).filter(jurisdiction =>
    jurisdiction.chainId === chainId && jurisdiction.contracts.depository.toLowerCase() === normalizedDepository);
  if (matches.length > 1) {
    throw new Error(`JURISDICTION_TRANSPORT_BINDING_AMBIGUOUS:${chainId}:${normalizedDepository}`);
  }
  const jurisdiction = matches[0];
  return jurisdiction === undefined ? undefined : decodeJurisdictionTransport(jurisdiction, 'JURISDICTION_TRANSPORT');
};

export const getConfiguredOfficialFoundationSignerId = (): string | undefined => {
  const configured = typeof process === 'undefined'
    ? undefined
    : process.env?.['XLN_OFFICIAL_FOUNDATION_SIGNER_ID'];
  if (configured !== undefined) {
    const normalized = configured.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
      throw new Error('JURISDICTIONS_OFFICIAL_FOUNDATION_SIGNER_INVALID');
    }
    return normalized;
  }
  if (isBrowser) return undefined;
  const fs = require('fs') as { existsSync(path: string): boolean };
  if (!fs.existsSync(resolveJurisdictionsJsonPath())) return undefined;
  return loadJurisdictions().officialFoundationSignerId;
};

/**
 * Clear the cache (useful for testing or when file is updated)
 */
export function clearJurisdictionsCache(): void {
  cachedJurisdictions = null;
  logJurisdictionLoaderDebug('cache_cleared');
}

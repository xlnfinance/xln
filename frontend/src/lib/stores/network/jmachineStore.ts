/**
 * J-Machine Configuration Store
 * Persists J-Machine configs to localStorage for reconnection on reload
 *
 * @license AGPL-3.0
 */

import { ethers } from 'ethers';
import { compareStableText } from '$lib/utils/stableSort';
import { isUnknownRecord as isRecord, parseJsonUnknown, rejectExtraKeys, requireUnknownRecord } from '$lib/utils/boundary';
import { createObservableStore } from '$lib/utils/observableStore';
import { errorLog } from '../errorLogStore';

export interface JMachineConfig {
  name: string;
  mode: 'browservm' | 'rpc';
  chainId: number;
  ticker: string;
  rpcs: string[];
  blockTimeMs: number;
  entityProviderDeploymentBlock?: number;
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };
  createdAt: number;
}

export type JMachineCreatedAtSeed = Pick<JMachineConfig, 'name' | 'mode' | 'chainId' | 'ticker' | 'rpcs' | 'blockTimeMs'>;

interface JMachineStoreState {
  configs: JMachineConfig[];
  activeJMachine: string | null;
}

const STORAGE_KEY = 'xln-jmachines';

const defaultState: JMachineStoreState = {
  configs: [],
  activeJMachine: null,
};

const normalizeAddress = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return ethers.isAddress(trimmed) ? ethers.getAddress(trimmed) : undefined;
};

const normalizeRpcList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.startsWith('http://') || entry.startsWith('https://'));
};

const normalizeMode = (value: unknown): JMachineConfig['mode'] =>
  value === 'browservm' ? 'browservm' : 'rpc';

const normalizeChainId = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return null;
  return Math.floor(numeric);
};

const normalizeBlockTimeMs = (value: unknown, chainId: number): number => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  if (chainId === 1 || chainId === 11155111) return 12_000;
  if (chainId === 8453 || chainId === 84532) return 2_000;
  if (chainId === 31337 || chainId === 31338) return 1_000;
  throw new Error(`J_MACHINE_BLOCK_TIME_REQUIRED:${chainId}`);
};

export const deriveJMachineCreatedAt = (config: JMachineCreatedAtSeed): number => {
  const text = [
    config.name.trim().toLowerCase(),
    config.mode,
    Math.floor(Number(config.chainId) || 0),
    config.ticker.trim().toUpperCase(),
    (config.rpcs || []).join('|'),
    Math.floor(Number(config.blockTimeMs) || 0),
  ].join('\n');
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash || 1;
};

const normalizeContracts = (value: unknown): JMachineConfig['contracts'] | undefined => {
  if (!isRecord(value)) return undefined;
  const depository = normalizeAddress(value['depository']);
  const entityProvider = normalizeAddress(value['entityProvider']);
  const account = normalizeAddress(value['account']);
  const deltaTransformer = normalizeAddress(value['deltaTransformer']);
  if (!depository && !entityProvider && !account && !deltaTransformer) return undefined;
  return {
    ...(depository ? { depository } : {}),
    ...(entityProvider ? { entityProvider } : {}),
    ...(account ? { account } : {}),
    ...(deltaTransformer ? { deltaTransformer } : {}),
  };
};

export function normalizeJMachineConfig(raw: unknown): JMachineConfig | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  const ticker = typeof raw['ticker'] === 'string' ? raw['ticker'].trim() : '';
  const mode = normalizeMode(raw['mode']);
  const chainId = normalizeChainId(raw['chainId']);
  const rpcs = normalizeRpcList(raw['rpcs']);
  const contracts = normalizeContracts(raw['contracts']);
  const entityProviderDeploymentBlockRaw = raw['entityProviderDeploymentBlock'];
  const entityProviderDeploymentBlock = Number(entityProviderDeploymentBlockRaw);
  const createdAtRaw = Number(raw['createdAt']);
  if (!name || !ticker || chainId === null) return null;
  if (mode === 'rpc' && rpcs.length !== 1) return null;
  if (
    entityProviderDeploymentBlockRaw !== undefined &&
    (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1)
  ) return null;
  const blockTimeMs = normalizeBlockTimeMs(raw['blockTimeMs'], chainId);
  return {
    name,
    mode,
    chainId,
    ticker,
    rpcs: mode === 'browservm' ? [] : rpcs,
    blockTimeMs,
    ...(entityProviderDeploymentBlockRaw !== undefined ? { entityProviderDeploymentBlock } : {}),
    ...(contracts ? { contracts } : {}),
    createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0
      ? Math.floor(createdAtRaw)
      : deriveJMachineCreatedAt({ name, mode, chainId, ticker, rpcs, blockTimeMs }),
  };
}

export function normalizeJMachineConfigList(raw: unknown): JMachineConfig[] {
  if (!Array.isArray(raw)) return [];
  const configs = raw
    .map((entry) => normalizeJMachineConfig(entry))
    .filter((entry): entry is JMachineConfig => !!entry);
  const deduped = new Map<string, JMachineConfig>();
  for (const config of configs) {
    deduped.set(config.name.toLowerCase(), config);
  }
  return Array.from(deduped.values()).sort((a, b) => compareStableText(a.name, b.name));
}

export function parseJMachineConfigJson(raw: string): JMachineConfig {
  const parsed = normalizeJMachineConfig(parseJsonUnknown(raw, 'J_MACHINE_JSON_INVALID'));
  if (!parsed) {
    throw new Error('Invalid jurisdiction JSON');
  }
  return parsed;
}

const decodePersistedJMachineConfig = (value: unknown): JMachineConfig => {
  const record = requireUnknownRecord(value, 'J_MACHINE_STORAGE_CONFIG_INVALID');
  rejectExtraKeys(record, [
    'name', 'mode', 'chainId', 'ticker', 'rpcs', 'blockTimeMs',
    'entityProviderDeploymentBlock', 'contracts', 'createdAt',
  ], 'J_MACHINE_STORAGE_CONFIG_EXTRA_FIELD');
  if (
    typeof record['name'] !== 'string' ||
    (record['mode'] !== 'browservm' && record['mode'] !== 'rpc') ||
    typeof record['chainId'] !== 'number' || !Number.isSafeInteger(record['chainId']) ||
    typeof record['ticker'] !== 'string' ||
    !Array.isArray(record['rpcs']) || !record['rpcs'].every((entry) => typeof entry === 'string') ||
    typeof record['blockTimeMs'] !== 'number' || !Number.isSafeInteger(record['blockTimeMs']) ||
    typeof record['createdAt'] !== 'number' || !Number.isSafeInteger(record['createdAt'])
  ) throw new Error('J_MACHINE_STORAGE_CONFIG_FIELD_INVALID');
  if (record['entityProviderDeploymentBlock'] !== undefined && (
    typeof record['entityProviderDeploymentBlock'] !== 'number' || !Number.isSafeInteger(record['entityProviderDeploymentBlock'])
  )) throw new Error('J_MACHINE_STORAGE_DEPLOYMENT_BLOCK_INVALID');
  if (record['contracts'] !== undefined) {
    const contracts = requireUnknownRecord(record['contracts'], 'J_MACHINE_STORAGE_CONTRACTS_INVALID');
    rejectExtraKeys(contracts, ['depository', 'entityProvider', 'account', 'deltaTransformer'], 'J_MACHINE_STORAGE_CONTRACTS_EXTRA_FIELD');
    if (Object.values(contracts).some((address) => address !== undefined && typeof address !== 'string')) {
      throw new Error('J_MACHINE_STORAGE_CONTRACTS_FIELD_INVALID');
    }
  }
  const normalized = normalizeJMachineConfig(record);
  if (!normalized) throw new Error('J_MACHINE_STORAGE_CONFIG_SEMANTIC_INVALID');
  return normalized;
};

const decodePersistedJMachineState = (value: unknown): JMachineStoreState => {
  const record = requireUnknownRecord(value, 'J_MACHINE_STORAGE_INVALID');
  rejectExtraKeys(record, ['configs', 'activeJMachine'], 'J_MACHINE_STORAGE_EXTRA_FIELD');
  if (!Array.isArray(record['configs'])) throw new Error('J_MACHINE_STORAGE_CONFIGS_INVALID');
  const configs = record['configs'].map(decodePersistedJMachineConfig);
  const activeJMachine = record['activeJMachine'];
  if (activeJMachine !== null && typeof activeJMachine !== 'string') throw new Error('J_MACHINE_STORAGE_ACTIVE_INVALID');
  if (activeJMachine !== null && !configs.some((config) => config.name.toLowerCase() === activeJMachine.toLowerCase())) {
    throw new Error('J_MACHINE_STORAGE_ACTIVE_UNKNOWN');
  }
  return { configs, activeJMachine };
};

// Main store
export const jmachineState = createObservableStore<JMachineStoreState>(defaultState);

// Derived stores
export const activeJMachine = {
  subscribe: (fn: (value: string | null) => void) => {
    return jmachineState.subscribe(state => fn(state.activeJMachine));
  }
};

// Operations
export const jmachineOperations = {
  /**
   * Add or update a J-Machine config
   */
  upsert(config: JMachineConfig) {
    const normalized = normalizeJMachineConfig(config);
    if (!normalized) {
      throw new Error('Invalid J-Machine config');
    }
    jmachineState.update(state => {
      const existing = state.configs.findIndex(c => c.name.toLowerCase() === normalized.name.toLowerCase());
      if (existing >= 0) {
        state.configs[existing] = normalized;
      } else {
        state.configs.push(normalized);
      }
      // Set as active if first
      if (!state.activeJMachine) {
        state.activeJMachine = normalized.name;
      }
      return state;
    });
    this.saveToStorage();
  },

  /**
   * Remove a J-Machine config
   */
  remove(name: string) {
    jmachineState.update(state => {
      state.configs = state.configs.filter(c => c.name !== name);
      if (state.activeJMachine === name) {
        state.activeJMachine = state.configs[0]?.name ?? null;
      }
      return state;
    });
    this.saveToStorage();
  },

  /**
   * Set active J-Machine
   */
  setActive(name: string | null) {
    jmachineState.update(state => ({
      ...state,
      activeJMachine: name,
    }));
    this.saveToStorage();
  },

  /**
   * Update contract addresses after deployment
   */
  updateContracts(name: string, contracts: NonNullable<JMachineConfig['contracts']>) {
    jmachineState.update(state => {
      const config = state.configs.find(c => c.name === name);
      if (config) {
        config.contracts = contracts;
      }
      return state;
    });
    this.saveToStorage();
  },

  /**
   * Get config by name
   */
  getByName(name: string): JMachineConfig | undefined {
    return jmachineState.get().configs.find(c => c.name === name);
  },

  /**
   * Load from localStorage
   */
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        jmachineState.set(decodePersistedJMachineState(parseJsonUnknown(saved, 'J_MACHINE_STORAGE_JSON_INVALID')));
      }
    } catch (error) {
      errorLog.log('Failed to load J-Machine configs; clearing corrupted storage', 'J-Machine Store', error);
      localStorage.removeItem(STORAGE_KEY);
      jmachineState.set(defaultState);
    }
  },

  /**
   * Save to localStorage
   */
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const current = jmachineState.get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (error) {
      errorLog.log('Failed to save J-Machine configs', 'J-Machine Store', error);
    }
  },

  /**
   * Clear all configs
   */
  clearAll() {
    jmachineState.set(defaultState);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  },
};

// Auto-load on import (browser only)
if (typeof window !== 'undefined') {
  jmachineOperations.loadFromStorage();
}

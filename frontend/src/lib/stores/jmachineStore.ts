/**
 * J-Machine Configuration Store
 * Persists J-Machine configs to localStorage for reconnection on reload
 *
 * @license AGPL-3.0
 */

import { writable, get } from 'svelte/store';
import { ethers } from 'ethers';

export interface JMachineConfig {
  name: string;
  mode: 'browservm' | 'rpc';
  chainId: number;
  ticker: string;
  rpcs: string[];
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };
  createdAt: number;
}

interface JMachineStoreState {
  configs: JMachineConfig[];
  activeJMachine: string | null;
}

const STORAGE_KEY = 'xln-jmachines';

const defaultState: JMachineStoreState = {
  configs: [],
  activeJMachine: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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

const normalizeContracts = (value: unknown): JMachineConfig['contracts'] | undefined => {
  if (!isRecord(value)) return undefined;
  const depository = normalizeAddress(value.depository);
  const entityProvider = normalizeAddress(value.entityProvider);
  const account = normalizeAddress(value.account);
  const deltaTransformer = normalizeAddress(value.deltaTransformer);
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
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const ticker = typeof raw.ticker === 'string' ? raw.ticker.trim() : '';
  const mode = normalizeMode(raw.mode);
  const chainId = normalizeChainId(raw.chainId);
  const rpcs = normalizeRpcList(raw.rpcs);
  const contracts = normalizeContracts(raw.contracts);
  const createdAtRaw = Number(raw.createdAt);
  if (!name || !ticker || chainId === null) return null;
  if (mode === 'rpc' && rpcs.length === 0) return null;
  return {
    name,
    mode,
    chainId,
    ticker,
    rpcs: mode === 'browservm' ? [] : rpcs,
    ...(contracts ? { contracts } : {}),
    createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : Date.now(),
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
  return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function stringifyJMachineConfig(config: JMachineConfig): string {
  return JSON.stringify(config, null, 2);
}

export function parseJMachineConfigJson(raw: string): JMachineConfig {
  const parsed = normalizeJMachineConfig(JSON.parse(raw));
  if (!parsed) {
    throw new Error('Invalid jurisdiction JSON');
  }
  return parsed;
}

// Main store
export const jmachineState = writable<JMachineStoreState>(defaultState);

// Derived stores
export const jmachineConfigs = {
  subscribe: (fn: (value: JMachineConfig[]) => void) => {
    return jmachineState.subscribe(state => fn(state.configs));
  }
};

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
    return get(jmachineState).configs.find(c => c.name === name);
  },

  /**
   * Load from localStorage
   */
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<JMachineStoreState>;
        const configs = normalizeJMachineConfigList(parsed.configs);
        const activeName = typeof parsed.activeJMachine === 'string' ? parsed.activeJMachine : null;
        const activeExists = activeName
          ? configs.some((config) => config.name.toLowerCase() === activeName.toLowerCase())
          : false;
        jmachineState.set({
          configs,
          activeJMachine: activeExists ? activeName : configs[0]?.name ?? null,
        });
        console.log('⚖️ J-Machine configs loaded from localStorage');
      }
    } catch (error) {
      console.error('❌ Failed to load J-Machine configs (clearing corrupted storage):', error);
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

      const current = get(jmachineState);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (error) {
      console.error('❌ Failed to save J-Machine configs:', error);
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

/**
 * J-Machine Configuration Store
 * Persists J-Machine configs to localStorage for reconnection on reload
 *
 * @license AGPL-3.0
 */

import { writable, get } from 'svelte/store';

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
    jmachineState.update(state => {
      const existing = state.configs.findIndex(c => c.name === config.name);
      if (existing >= 0) {
        state.configs[existing] = config;
      } else {
        state.configs.push(config);
      }
      // Set as active if first
      if (!state.activeJMachine) {
        state.activeJMachine = config.name;
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
        const parsed = JSON.parse(saved);
        jmachineState.set(parsed);
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

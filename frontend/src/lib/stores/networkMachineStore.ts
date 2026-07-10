import { get, writable } from 'svelte/store';
import {
  DEFAULT_NETWORK_MACHINE_CONFIG,
  NETWORK_MACHINE_CONFIG_KEY,
  normalizeNetworkMachineConfig,
  parseNetworkMachineConfig,
  type NetworkMachineConfig,
  type NetworkMachineTimelineMode,
} from '$lib/network3d/networkMachine';

export const networkMachineConfig = writable<NetworkMachineConfig>(DEFAULT_NETWORK_MACHINE_CONFIG);

const persist = (config: NetworkMachineConfig): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(NETWORK_MACHINE_CONFIG_KEY, JSON.stringify(config));
};

export const networkMachineOperations = {
  load(): NetworkMachineConfig {
    if (typeof localStorage === 'undefined') return get(networkMachineConfig);
    const stored = localStorage.getItem(NETWORK_MACHINE_CONFIG_KEY);
    const config = stored ? parseNetworkMachineConfig(stored) : DEFAULT_NETWORK_MACHINE_CONFIG;
    networkMachineConfig.set(config);
    return config;
  },

  replace(input: NetworkMachineConfig): NetworkMachineConfig {
    const config = normalizeNetworkMachineConfig(input);
    networkMachineConfig.set(config);
    persist(config);
    return config;
  },

  importJson(value: string): NetworkMachineConfig {
    return this.replace(parseNetworkMachineConfig(value));
  },

  exportJson(): string {
    return JSON.stringify(get(networkMachineConfig), null, 2);
  },

  setTimelineMode(timelineMode: NetworkMachineTimelineMode): NetworkMachineConfig {
    return this.replace({ ...get(networkMachineConfig), timelineMode });
  },
};

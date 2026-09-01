import {
  DEFAULT_NETWORK_MACHINE_CONFIG,
  NETWORK_MACHINE_CONFIG_KEY,
  normalizeNetworkMachineConfig,
  parseNetworkMachineConfig,
  type NetworkMachineConfig,
  type NetworkMachineTimelineMode,
} from '$lib/network3d/networkMachine';
import { createObservableStore } from '$lib/utils/observableStore';

export const networkMachineConfig = createObservableStore<NetworkMachineConfig>(DEFAULT_NETWORK_MACHINE_CONFIG);

const persist = (config: NetworkMachineConfig): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(NETWORK_MACHINE_CONFIG_KEY, JSON.stringify(config));
};

export const networkMachineOperations = {
  load(): NetworkMachineConfig {
    if (typeof localStorage === 'undefined') return networkMachineConfig.get();
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
    return JSON.stringify(networkMachineConfig.get(), null, 2);
  },

  setTimelineMode(timelineMode: NetworkMachineTimelineMode): NetworkMachineConfig {
    return this.replace({ ...networkMachineConfig.get(), timelineMode });
  },
};

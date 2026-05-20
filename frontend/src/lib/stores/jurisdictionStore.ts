import { writable } from 'svelte/store';
import { getXLN } from './xlnStore';
import type { JurisdictionConfig as RuntimeJurisdictionConfig } from '@xln/runtime/xln-api';

interface JurisdictionConfig {
  name: string;
  chainId: number;
  rpc: string;
  contracts: {
    entityProvider: string;
    depository: string;
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
  };
}

export const jurisdictions = writable<JurisdictionsData | null>(null);
export const jurisdictionsLoaded = writable(false);

let loadPromise: Promise<JurisdictionsData> | null = null;
let cachedData: JurisdictionsData | null = null;

export async function loadJurisdictions(): Promise<JurisdictionsData> {
  if (cachedData) {
    return cachedData;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    try {
      const xln = await getXLN();
      const jurisdictionsList = await xln.getAvailableJurisdictions();

      const data: JurisdictionsData = {
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        jurisdictions: {},
        defaults: {
          timeout: 30000,
          retryAttempts: 3,
          gasLimit: 1000000
        }
      };

      jurisdictionsList.forEach((j: RuntimeJurisdictionConfig) => {
        data.jurisdictions[j.name.toLowerCase()] = {
          name: j.name,
          chainId: j.chainId ?? 31337,
          rpc: j.address,
          contracts: {
            entityProvider: j.entityProviderAddress,
            depository: j.depositoryAddress
          },
          explorer: j.address,
          currency: j.name === 'Ethereum' ? 'ETH' : 'TOKEN',
          status: 'active'
        };
      });

      cachedData = data;
      jurisdictions.set(data);
      jurisdictionsLoaded.set(true);
      return data;
    } catch (error) {
      console.error('❌ Failed to load jurisdictions from server:', error);
      throw error;
    }
  })();

  return loadPromise;
}

export function clearJurisdictionsCache(): void {
  cachedData = null;
  loadPromise = null;
  jurisdictions.set(null);
  jurisdictionsLoaded.set(false);
}

export async function getAvailableJurisdictions(): Promise<JurisdictionConfig[]> {
  const data = await loadJurisdictions();
  return Object.values(data.jurisdictions);
}

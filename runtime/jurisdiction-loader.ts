/**
 * Centralized jurisdiction loader
 * Single source of truth for loading jurisdictions.json
 * Caches the result to avoid multiple file reads
 */

// Browser-compatible: Use isBrowser check instead of fs
import { isBrowser } from './utils';
import { resolveJurisdictionsJsonPath } from './jurisdictions-path';

interface JurisdictionConfig {
  name: string;
  chainId: number;
  rpc: string;
  rebalancePolicyUsd?: {
    r2cRequestSoftLimit: number;
    hardLimit: number;
    maxFee: number;
  };
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
    rebalancePolicyUsd?: {
      r2cRequestSoftLimit: number;
      hardLimit: number;
      maxFee: number;
    };
  };
}

let cachedJurisdictions: JurisdictionsData | null = null;

/**
 * Load jurisdictions.json once and cache the result
 * All parts of the system should use this function
 */
export function loadJurisdictions(): JurisdictionsData {
  // Browser compatibility check
  if (isBrowser) {
    throw new Error('loadJurisdictions() not available in browser - use runtime/jurisdiction-config.ts instead');
  }

  // Return cached result if available (Node.js only)
  if (cachedJurisdictions) {
    return cachedJurisdictions;
  }

  const defaultJurisdictions: JurisdictionsData = {
    version: '1',
    lastUpdated: new Date().toISOString(),
    jurisdictions: {},
    defaults: {
      timeout: 30000,
      retryAttempts: 3,
      gasLimit: 1000000,
      rebalancePolicyUsd: {
        r2cRequestSoftLimit: 500,
        hardLimit: 10_000,
        maxFee: 15,
      },
    },
  };

  try {
    const fs = require('fs'); // Dynamic require for Node.js only
    const candidates = [resolveJurisdictionsJsonPath()];
    const filePath = candidates.find((candidate: string) => fs.existsSync(candidate)) ?? '';

    if (!fs.existsSync(filePath)) {
      console.warn('INFO: jurisdictions.json not found at canonical path; using defaults');
      cachedJurisdictions = defaultJurisdictions;
      return cachedJurisdictions;
    }

    const jurisdictionsContent = fs.readFileSync(filePath, 'utf8');
    cachedJurisdictions = JSON.parse(jurisdictionsContent);

    console.log('📋 Jurisdictions loaded from file (cached for future use)');
    console.log(`  ├─ Version: ${cachedJurisdictions?.version}`);
    console.log(`  ├─ Last updated: ${cachedJurisdictions?.lastUpdated}`);
    console.log(`  └─ Jurisdictions: ${Object.keys(cachedJurisdictions?.jurisdictions || {}).join(', ')}`);

    return cachedJurisdictions!;
  } catch (error) {
    console.error('ERROR: Failed to load jurisdictions.json:', error);
    cachedJurisdictions = defaultJurisdictions;
    return cachedJurisdictions;
  }
}

/**
 * Clear the cache (useful for testing or when file is updated)
 */
export function clearJurisdictionsCache(): void {
  cachedJurisdictions = null;
  console.log('🔄 Jurisdictions cache cleared');
}

/**
 * Get cached jurisdictions without loading
 * Returns null if not loaded yet
 */
export function getCachedJurisdictions(): JurisdictionsData | null {
  return cachedJurisdictions;
}

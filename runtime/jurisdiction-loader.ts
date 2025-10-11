/**
 * Centralized jurisdiction loader
 * Single source of truth for loading jurisdictions.json
 * Caches the result to avoid multiple file reads
 */

// Browser-compatible: Use isBrowser check instead of fs
import { isBrowser } from './utils';

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

let cachedJurisdictions: JurisdictionsData | null = null;

/**
 * Load jurisdictions.json once and cache the result
 * All parts of the system should use this function
 */
export function loadJurisdictions(): JurisdictionsData {
  // Browser compatibility check
  if (isBrowser) {
    throw new Error('loadJurisdictions() not available in browser - use evm.ts generateJurisdictions() instead');
  }

  // Return cached result if available (Node.js only)
  if (cachedJurisdictions) {
    return cachedJurisdictions;
  }

  try {
    const fs = require('fs'); // Dynamic require for Node.js only
    const jurisdictionsContent = fs.readFileSync('./jurisdictions.json', 'utf8');
    cachedJurisdictions = JSON.parse(jurisdictionsContent);

    console.log('📋 Jurisdictions loaded from file (cached for future use)');
    console.log(`  ├─ Version: ${cachedJurisdictions?.version}`);
    console.log(`  ├─ Last updated: ${cachedJurisdictions?.lastUpdated}`);
    console.log(`  └─ Jurisdictions: ${Object.keys(cachedJurisdictions?.jurisdictions || {}).join(', ')}`);

    return cachedJurisdictions!;
  } catch (error) {
    console.error('❌ Failed to load jurisdictions.json:', error);
    // Return a default structure if file doesn't exist
    cachedJurisdictions = {
      version: "1.0.0",
      lastUpdated: new Date().toISOString(),
      jurisdictions: {},
      defaults: {
        timeout: 30000,
        retryAttempts: 3,
        gasLimit: 1000000
      }
    };
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
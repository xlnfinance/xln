/**
 * Jurisdiction Configuration Loader
 *
 * Pure functions for loading jurisdiction configs from jurisdictions.json.
 * NO global state. NO singletons. NO mocks.
 *
 * For contract operations, use JAdapter directly on JReplica.
 *
 * @license AGPL-3.0
 */

import type { JurisdictionConfig } from './types';
import { loadJurisdictions } from './jurisdiction-loader';
import { parseRebalancePolicyUsd } from './rebalance-policy-usd';
import { isBrowser } from './utils';

/**
 * Load available jurisdictions from config
 * Returns empty array if config not found (BrowserVM mode)
 */
export async function getAvailableJurisdictions(): Promise<JurisdictionConfig[]> {
  const jurisdictions = await loadJurisdictionConfigs();
  return Array.from(jurisdictions.values());
}

/**
 * Get jurisdiction by name
 */
export async function getJurisdictionByName(name: string): Promise<JurisdictionConfig | undefined> {
  const jurisdictions = await loadJurisdictionConfigs();
  return jurisdictions.get(name.toLowerCase());
}

/**
 * Load all jurisdiction configs
 * Handles both browser (fetch) and Node.js (file read) environments
 */
async function loadJurisdictionConfigs(): Promise<Map<string, JurisdictionConfig>> {
  const jurisdictions = new Map<string, JurisdictionConfig>();

  try {
    let config: Record<string, unknown>;

    if (!isBrowser && typeof process !== 'undefined') {
      // Node.js: use centralized loader
      config = loadJurisdictions() as unknown as Record<string, unknown>;
    } else {
      // Browser: fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      try {
        const response = await fetch('./jurisdictions.json', { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) {
          console.log('⚠️ jurisdictions.json not found - using BrowserVM mode');
          return jurisdictions;
        }
        config = await response.json();
      } catch (fetchError: unknown) {
        clearTimeout(timeoutId);
        const err = fetchError as { name?: string };
        if (err.name === 'AbortError') {
          console.log('⏱️ jurisdictions.json fetch timed out - using BrowserVM mode');
        }
        return jurisdictions;
      }
    }

    const jurisdictionData = (config as { jurisdictions?: Record<string, unknown> }).jurisdictions;
    const globalRebalancePolicyUsd = parseRebalancePolicyUsd(
      (config as { defaults?: { rebalancePolicyUsd?: unknown } }).defaults?.rebalancePolicyUsd,
    );
    if (!jurisdictionData) return jurisdictions;

    for (const [key, data] of Object.entries(jurisdictionData)) {
      if (!data || typeof data !== 'object') continue;

      const jData = data as Record<string, unknown>;
      const contracts = jData['contracts'] as Record<string, string> | undefined;

      let rpcUrl = jData['rpc'] as string;

      // Handle relative URLs in browser
      if (isBrowser && rpcUrl?.startsWith('/')) {
        rpcUrl = `${window.location.origin}${rpcUrl}`;
      } else if (isBrowser && rpcUrl?.startsWith(':')) {
        const port = parseInt(rpcUrl.slice(1));
        const isLocalhost = window.location.hostname.match(/localhost|127\.0\.0\.1/);
        const actualPort = isLocalhost ? port : port + 10000;
        rpcUrl = `${window.location.protocol}//${window.location.hostname}:${actualPort}`;
      } else if (!isBrowser && rpcUrl?.startsWith(':')) {
        rpcUrl = `http://localhost${rpcUrl}`;
      }

      const rebalancePolicyUsd = parseRebalancePolicyUsd(jData['rebalancePolicyUsd']) ?? globalRebalancePolicyUsd;
      jurisdictions.set(key, {
        name: jData['name'] as string,
        chainId: jData['chainId'] as number,
        address: rpcUrl,
        entityProviderAddress: contracts?.['entityProvider'] ?? '',
        depositoryAddress: contracts?.['depository'] ?? '',
        ...(rebalancePolicyUsd ? { rebalancePolicyUsd } : {}),
      });
    }
  } catch (error) {
    console.error('❌ Failed to load jurisdictions:', error);
  }

  return jurisdictions;
}

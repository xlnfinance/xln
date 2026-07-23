/**
 * Jurisdiction Configuration Loader
 *
 * Pure functions for loading jurisdiction configs from the canonical jurisdictions source.
 * NO global state. NO singletons. NO mocks.
 *
 * For contract operations, use JAdapter directly on JReplica.
 *
 * @license AGPL-3.0
 */

import type { JurisdictionConfig } from '../types';
import { isUsableContractAddress } from './contract-address';
import { loadJurisdictions } from './jurisdiction-loader';
import { createStructuredLogger } from '../infra/logger';
import { parseRebalancePolicyUsd } from '../extensions/rebalance/usd';
import { isBrowser } from '../utils';

const jurisdictionConfigLog = createStructuredLogger('runtime.jurisdiction_config');

export const isActiveJurisdictionStatus = (value: unknown): boolean =>
  String(value ?? 'active').trim().toLowerCase() === 'active';

function getBrowserJurisdictionsUrl(): string {
  const suffix = `ts=${Date.now()}`;
  return `./api/jurisdictions?${suffix}`;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

  let config: Record<string, unknown>;

  if (!isBrowser && typeof process !== 'undefined') {
    // Node.js: use centralized loader
    config = loadJurisdictions() as unknown as Record<string, unknown>;
  } else {
    // Browser: fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    let response: Response;

    try {
      response = await fetch(getBrowserJurisdictionsUrl(), {
        signal: controller.signal,
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache' },
      });
    } catch (fetchError: unknown) {
      const err = fetchError as { name?: string };
      jurisdictionConfigLog.debug('browser_api_unavailable', {
        reason: err.name === 'AbortError' ? 'timeout' : 'fetch_failed',
        error: errorMessage(fetchError),
      });
      return jurisdictions;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      jurisdictionConfigLog.debug('browser_api_unavailable', {
        reason: 'http_status',
        status: response.status,
      });
      return jurisdictions;
    }

    try {
      config = await response.json() as Record<string, unknown>;
    } catch (parseError: unknown) {
      jurisdictionConfigLog.error('browser_config_invalid', { error: errorMessage(parseError) });
      throw new Error(`JURISDICTIONS_BROWSER_CONFIG_INVALID:${errorMessage(parseError)}`);
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
    const status = String(jData['status'] ?? 'active').trim().toLowerCase();
    if (!isActiveJurisdictionStatus(status)) {
      jurisdictionConfigLog.debug('entry_skipped_inactive', { key, status });
      continue;
    }

    let rpcUrl = jData['rpc'] as string;

    // Handle relative URLs in browser
    if (isBrowser && rpcUrl?.startsWith('/')) {
      rpcUrl = `${window.location.origin}${rpcUrl}`;
    } else if (isBrowser && rpcUrl?.startsWith(':')) {
      const port = parseInt(rpcUrl.slice(1));
      const isLocalhost = window.location.hostname === 'localhost';
      if (isLocalhost) {
        rpcUrl = new URL('/rpc', window.location.origin).toString();
      } else {
        const actualPort = port + 10000;
        rpcUrl = `${window.location.protocol}//${window.location.hostname}:${actualPort}`;
      }
    } else if (!isBrowser && rpcUrl?.startsWith(':')) {
      rpcUrl = `http://localhost${rpcUrl}`;
    }

    const rebalancePolicyUsd = parseRebalancePolicyUsd(jData['rebalancePolicyUsd']) ?? globalRebalancePolicyUsd;
    const entityProviderAddress = contracts?.['entityProvider'];
    const depositoryAddress = contracts?.['depository'];
    if (!isUsableContractAddress(entityProviderAddress) || !isUsableContractAddress(depositoryAddress)) {
      jurisdictionConfigLog.debug('entry_skipped_incomplete_contracts', {
        key,
        hasEntityProvider: Boolean(entityProviderAddress),
        hasDepository: Boolean(depositoryAddress),
      });
      continue;
    }

    jurisdictions.set(key, {
      name: jData['name'] as string,
      chainId: jData['chainId'] as number,
      blockTimeMs: Number(jData['blockTimeMs']),
      address: rpcUrl,
      entityProviderAddress,
      depositoryAddress,
      ...(rebalancePolicyUsd ? { rebalancePolicyUsd } : {}),
    });
  }

  return jurisdictions;
}

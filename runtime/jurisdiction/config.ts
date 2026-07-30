/**
 * Jurisdiction Configuration Loader
 *
 * External-I/O boundary for the canonical jurisdictions source.
 *
 * For contract operations, use JAdapter directly on JReplica.
 *
 * @license AGPL-3.0
 */

import type { JurisdictionConfig } from '../entity/types';
import { isUsableContractAddress } from './contract-address';
import { loadJurisdictions } from './jurisdiction-loader';
import { createStructuredLogger } from '../infra/logger';
import { parseRebalancePolicyUsd } from '../extensions/rebalance/usd';
import { isBrowser } from '../infra/platform-crypto';

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
 * Missing or malformed configuration rejects. An empty array is valid only
 * when the canonical source explicitly contains no active jurisdictions.
 */
export async function getAvailableJurisdictions(): Promise<JurisdictionConfig[]> {
  const jurisdictions = await loadJurisdictionConfigs();
  return Array.from(jurisdictions.values());
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
    config = { ...loadJurisdictions() };
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
      throw new Error(
        `JURISDICTIONS_BROWSER_FETCH_FAILED:` +
        `${err.name === 'AbortError' ? 'timeout' : errorMessage(fetchError)}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`JURISDICTIONS_BROWSER_HTTP_STATUS:${response.status}`);
    }

    try {
      config = await response.json() as Record<string, unknown>;
    } catch (parseError: unknown) {
      jurisdictionConfigLog.error('browser_config_invalid', { error: errorMessage(parseError) });
      throw new Error(`JURISDICTIONS_BROWSER_CONFIG_INVALID:${errorMessage(parseError)}`);
    }
  }

  const jurisdictionData = (config as { jurisdictions?: unknown }).jurisdictions;
  const globalRebalancePolicyUsd = parseRebalancePolicyUsd(
    (config as { defaults?: { rebalancePolicyUsd?: unknown } }).defaults?.rebalancePolicyUsd,
  );
  if (
    !jurisdictionData
    || typeof jurisdictionData !== 'object'
    || Array.isArray(jurisdictionData)
  ) {
    throw new Error('JURISDICTIONS_ENTRIES_INVALID');
  }

  for (const [key, data] of Object.entries(jurisdictionData)) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`JURISDICTION_ENTRY_INVALID:${key}`);
    }

    const jData = data as Record<string, unknown>;
    const contracts = jData['contracts'];
    const status = String(jData['status'] ?? 'active').trim().toLowerCase();
    if (!isActiveJurisdictionStatus(status)) {
      jurisdictionConfigLog.debug('entry_skipped_inactive', { key, status });
      continue;
    }

    if (typeof jData['rpc'] !== 'string' || !jData['rpc'].trim()) {
      throw new Error(`JURISDICTION_RPC_INVALID:${key}`);
    }
    let rpcUrl = jData['rpc'];

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
    if (!contracts || typeof contracts !== 'object' || Array.isArray(contracts)) {
      throw new Error(`JURISDICTION_CONTRACTS_INVALID:${key}`);
    }
    const contractRecord = contracts as Record<string, unknown>;
    const entityProviderAddress = contractRecord['entityProvider'];
    const depositoryAddress = contractRecord['depository'];
    if (!isUsableContractAddress(entityProviderAddress) || !isUsableContractAddress(depositoryAddress)) {
      throw new Error(`JURISDICTION_CONTRACTS_INCOMPLETE:${key}`);
    }
    if (typeof jData['name'] !== 'string' || !jData['name'].trim()) {
      throw new Error(`JURISDICTION_NAME_INVALID:${key}`);
    }
    if (!Number.isSafeInteger(jData['chainId']) || Number(jData['chainId']) <= 0) {
      throw new Error(`JURISDICTION_CHAIN_ID_INVALID:${key}`);
    }
    if (
      typeof jData['blockTimeMs'] !== 'number'
      || !Number.isFinite(jData['blockTimeMs'])
      || jData['blockTimeMs'] <= 0
    ) {
      throw new Error(`JURISDICTION_BLOCK_TIME_INVALID:${key}`);
    }

    jurisdictions.set(key, {
      name: jData['name'],
      chainId: Number(jData['chainId']),
      blockTimeMs: jData['blockTimeMs'],
      address: rpcUrl,
      entityProviderAddress,
      depositoryAddress,
      ...(rebalancePolicyUsd ? { rebalancePolicyUsd } : {}),
    });
  }

  return jurisdictions;
}

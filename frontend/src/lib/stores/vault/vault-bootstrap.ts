import type { JurisdictionConfig } from '@xln/core/api/public/runtime-module';
import { isUnknownRecord, readJsonUnknown } from '$lib/utils/boundary';
import {
  type HealthMachine,
  type HealthPayload,
  type JurisdictionsPayload,
} from './vault-recovery';

const isJurisdictionsPayload = (value: unknown): value is JurisdictionsPayload =>
  isUnknownRecord(value) && isUnknownRecord(value['jurisdictions']) &&
  (value['version'] === undefined || typeof value['version'] === 'string') &&
  Object.values(value['jurisdictions']).every(isUnknownRecord);

export const summarizeHealth = (payload: HealthPayload | null): Record<string, unknown> => {
  if (!payload) return {};
  return {
    timestamp: payload.timestamp,
    resetInProgress: payload?.reset?.inProgress ?? null,
    resetError: payload?.reset?.lastError ?? null,
    system: payload?.system ?? null,
    jMachines: Array.isArray(payload?.jMachines)
      ? payload.jMachines.map((j: HealthMachine) => ({
          name: j?.name,
          status: j?.status,
          chainId: j?.chainId,
          lastBlock: j?.lastBlock,
        }))
      : [],
  };
};

export const resolveJurisdictionChainId = (config: JurisdictionConfig, context: string): number => {
  const chainId = Number(config.chainId || 31337);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`[${context}] CHAIN_ID_INVALID: ${String(config.chainId)}`);
  }
  return Math.floor(chainId);
};

export const fetchJurisdictions = async (baseOrigin?: string): Promise<JurisdictionsPayload> => {
  const primaryOrigin = baseOrigin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance');
  const configuredApiBase =
    typeof window !== 'undefined'
      ? (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__?.trim() || null
      : null;
  const bust = `ts=${Date.now()}`;
  const candidates = configuredApiBase
    ? Array.from(
        new Set([`${configuredApiBase}/api/jurisdictions?${bust}`, `${primaryOrigin}/api/jurisdictions?${bust}`]),
      )
    : [`${primaryOrigin}/api/jurisdictions?${bust}`];

  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        cache: 'no-store',
        headers: {
          'cache-control': 'no-cache, no-store, must-revalidate',
          pragma: 'no-cache',
        },
      });
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status}`);
        continue;
      }
      const payload = await readJsonUnknown(resp);
      if (!isJurisdictionsPayload(payload)) throw new Error('JURISDICTIONS_RESPONSE_INVALID');
      // Each jurisdiction is decoded again before use by the runtime bootstrap.
      return payload;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Failed to fetch /api/jurisdictions');
};

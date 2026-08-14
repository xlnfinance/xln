export type HubJoinPreference = 'manual' | '1' | '2' | '3';

export interface SavedCollateralPolicy {
  mode: 'autopilot' | 'manual';
  softLimitUsd: number;
  hardLimitUsd: number;
  maxFeeUsd: number;
  timestamp: number;
}

type PolicyDefaults = {
  softLimitUsd: number;
  hardLimitUsd: number;
  maxFeeUsd: number;
};

const COLLATERAL_POLICY_KEY = 'xln-collateral-policy';
const HUB_JOIN_PREF_KEY = 'xln-hub-join-preference';

const DEFAULT_POLICY: PolicyDefaults = {
  softLimitUsd: 500,
  hardLimitUsd: 10_000,
  maxFeeUsd: 15,
};

let cachedPolicyDefaultsByJurisdiction: Map<string, PolicyDefaults> | null = null;
let policyDefaultsLoadPromise: Promise<Map<string, PolicyDefaults>> | null = null;
let runtimePolicyDefaults: PolicyDefaults = { ...DEFAULT_POLICY };

const toUsdInt = (value: unknown, defaultValue: number): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.max(0, Math.floor(raw));
};

const usdToRawTokenAmount = (value: number, tokenDecimals: number): bigint => {
  if (!Number.isSafeInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) {
    throw new Error(`ONBOARDING_TOKEN_DECIMALS_INVALID:${String(tokenDecimals)}`);
  }
  return BigInt(toUsdInt(value, 0)) * 10n ** BigInt(tokenDecimals);
};

const normalizeHubJoinPreference = (value: unknown): HubJoinPreference => {
  const normalized = String(value || '').trim();
  if (normalized === '1' || normalized === '2' || normalized === '3') return normalized;
  return 'manual';
};

const normalizePolicyDefaults = (value: unknown): PolicyDefaults | null => {
  if (!isUnknownRecord(value)) return null;
  const raw = value;
  const softLimitUsd = toUsdInt(raw['r2cRequestSoftLimit'], DEFAULT_POLICY.softLimitUsd);
  const hardLimitUsd = toUsdInt(raw['hardLimit'], DEFAULT_POLICY.hardLimitUsd);
  const maxFeeUsd = toUsdInt(raw['maxFee'], DEFAULT_POLICY.maxFeeUsd);
  if (softLimitUsd <= 0 || hardLimitUsd < softLimitUsd) return null;
  return { softLimitUsd, hardLimitUsd, maxFeeUsd };
};

const loadPolicyDefaultsFromJurisdictions = async (): Promise<Map<string, PolicyDefaults>> => {
  if (cachedPolicyDefaultsByJurisdiction) return cachedPolicyDefaultsByJurisdiction;
  if (policyDefaultsLoadPromise) return policyDefaultsLoadPromise;

  policyDefaultsLoadPromise = (async () => {
    const result = new Map<string, PolicyDefaults>();
    result.set('default', { ...DEFAULT_POLICY });

    if (typeof window === 'undefined') {
      cachedPolicyDefaultsByJurisdiction = result;
      return result;
    }

    try {
      const response = await fetch('/api/jurisdictions', { cache: 'no-store' });
      if (!response.ok) {
        cachedPolicyDefaultsByJurisdiction = result;
        return result;
      }
      const payload = await readJsonUnknown(response);
      if (!isUnknownRecord(payload)) throw new Error('ONBOARDING_POLICY_PAYLOAD_INVALID');
      const defaults = payload['defaults'];
      const jurisdictionsValue = payload['jurisdictions'];
      if (defaults !== undefined && !isUnknownRecord(defaults)) throw new Error('ONBOARDING_POLICY_DEFAULTS_INVALID');
      if (jurisdictionsValue !== undefined && !isUnknownRecord(jurisdictionsValue)) throw new Error('ONBOARDING_POLICY_JURISDICTIONS_INVALID');
      const globalDefaults = normalizePolicyDefaults(defaults?.['rebalancePolicyUsd']) ?? DEFAULT_POLICY;
      result.set('default', globalDefaults);

      const jurisdictions = jurisdictionsValue ?? {};
      for (const [key, value] of Object.entries(jurisdictions)) {
        if (!isUnknownRecord(value)) throw new Error(`ONBOARDING_POLICY_JURISDICTION_INVALID:${key}`);
        const jurisdictionDefaults = normalizePolicyDefaults(value['rebalancePolicyUsd']) ?? globalDefaults;
        result.set(String(key).trim().toLowerCase(), jurisdictionDefaults);
        const nameKey = typeof value['name'] === 'string' ? value['name'].trim().toLowerCase() : '';
        if (nameKey) result.set(nameKey, jurisdictionDefaults);
      }
    } catch {
      // Keep the canonical policy defaults when the optional endpoint is unavailable.
    }

    cachedPolicyDefaultsByJurisdiction = result;
    return result;
  })();

  return policyDefaultsLoadPromise;
};

export const hydrateJurisdictionPolicyDefaults = async (jurisdictionName?: string): Promise<PolicyDefaults> => {
  const defaultsByJurisdiction = await loadPolicyDefaultsFromJurisdictions();
  const key = String(jurisdictionName || '').trim().toLowerCase();
  runtimePolicyDefaults =
    (key ? defaultsByJurisdiction.get(key) : undefined) ??
    defaultsByJurisdiction.get('default') ??
    DEFAULT_POLICY;
  return runtimePolicyDefaults;
};

export const readSavedCollateralPolicy = (): SavedCollateralPolicy => {
  const defaults = runtimePolicyDefaults;
  if (typeof localStorage === 'undefined') return { mode: 'autopilot', ...defaults, timestamp: 0 };
  try {
    const raw = localStorage.getItem(COLLATERAL_POLICY_KEY);
    if (!raw) return { mode: 'autopilot', ...defaults, timestamp: 0 };
    const parsed = parseJsonUnknown(raw, 'COLLATERAL_POLICY_JSON_INVALID');
    if (!isUnknownRecord(parsed)) throw new Error('COLLATERAL_POLICY_INVALID');

    const softLimitUsd = toUsdInt(parsed['softLimitUsd'], defaults.softLimitUsd);
    const hardLimitUsd = toUsdInt(parsed['hardLimitUsd'], defaults.hardLimitUsd);
    const maxFeeUsd = toUsdInt(parsed['maxFeeUsd'], defaults.maxFeeUsd);
    const mode = parsed['mode'] === 'manual' ? 'manual' : 'autopilot';
    const timestamp = Number(parsed['timestamp'] || 0);

    return {
      mode,
      softLimitUsd,
      hardLimitUsd,
      maxFeeUsd,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    };
  } catch {
    return { mode: 'autopilot', ...defaults, timestamp: 0 };
  }
};

export const writeSavedCollateralPolicy = (
  policy: Pick<SavedCollateralPolicy, 'mode' | 'softLimitUsd' | 'hardLimitUsd' | 'maxFeeUsd'>,
): SavedCollateralPolicy => {
  const defaults = runtimePolicyDefaults;
  const softLimitUsd = toUsdInt(policy.softLimitUsd, defaults.softLimitUsd);
  const hardLimitUsd = toUsdInt(policy.hardLimitUsd, defaults.hardLimitUsd);
  const maxFeeUsd = toUsdInt(policy.maxFeeUsd, defaults.maxFeeUsd);
  const mode = policy.mode === 'manual' ? 'manual' : 'autopilot';

  const saved: SavedCollateralPolicy = {
    mode,
    softLimitUsd,
    hardLimitUsd,
    maxFeeUsd,
    timestamp: Date.now(),
  };

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(COLLATERAL_POLICY_KEY, JSON.stringify(saved));
  }

  return saved;
};

export const readHubJoinPreference = (): HubJoinPreference => {
  if (typeof localStorage === 'undefined') return 'manual';
  return normalizeHubJoinPreference(localStorage.getItem(HUB_JOIN_PREF_KEY));
};

export const writeHubJoinPreference = (value: HubJoinPreference): HubJoinPreference => {
  const normalized = normalizeHubJoinPreference(value);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(HUB_JOIN_PREF_KEY, normalized);
  }
  return normalized;
};

export const getOpenAccountRebalancePolicyData = (tokenDecimals: number): {
  r2cRequestSoftLimit: bigint;
  hardLimit: bigint;
  maxAcceptableFee: bigint;
} | null => {
  const policy = readSavedCollateralPolicy();
  if (policy.mode === 'manual') return null;
  const r2cRequestSoftLimit = usdToRawTokenAmount(policy.softLimitUsd, tokenDecimals);
  const hardLimit = usdToRawTokenAmount(policy.hardLimitUsd, tokenDecimals);
  const maxAcceptableFee = usdToRawTokenAmount(policy.maxFeeUsd, tokenDecimals);
  if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit || maxAcceptableFee < 0n) return null;
  return { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
};
import { isUnknownRecord, parseJsonUnknown, readJsonUnknown } from '$lib/utils/boundary';

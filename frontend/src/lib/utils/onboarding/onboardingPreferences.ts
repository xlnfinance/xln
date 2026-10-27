import type { TokenId } from '@xln/core/account/tx/units';
import { wholeUsdToTokenAmount } from '@xln/core/jurisdiction/machine/config/usd-reference-rate';

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

const usdToRawTokenAmount = (value: number, tokenId: TokenId): bigint =>
  wholeUsdToTokenAmount(tokenId, BigInt(toUsdInt(value, 0)));

const normalizeHubJoinPreference = (value: unknown): HubJoinPreference => {
  const normalized = String(value || '').trim();
  if (normalized === '1' || normalized === '2' || normalized === '3') return normalized;
  return 'manual';
};

const normalizePolicyDefaults = (value: unknown): PolicyDefaults | null => {
  if (value === undefined) return null;
  if (!isUnknownRecord(value)) throw new Error('COLLATERAL_POLICY_INVALID');
  const raw = value;
  for (const key of ['r2cRequestSoftLimit', 'hardLimit', 'maxFee']) {
    const amount = raw[key];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)
      throw new Error(`COLLATERAL_POLICY_INVALID:${key}`);
  }
  const softLimitUsd = toUsdInt(raw['r2cRequestSoftLimit'], DEFAULT_POLICY.softLimitUsd);
  const hardLimitUsd = toUsdInt(raw['hardLimit'], DEFAULT_POLICY.hardLimitUsd);
  const maxFeeUsd = toUsdInt(raw['maxFee'], DEFAULT_POLICY.maxFeeUsd);
  if (softLimitUsd <= 0 || hardLimitUsd < softLimitUsd) throw new Error('COLLATERAL_POLICY_LIMITS_INVALID');
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
      if (!response.ok) throw new Error(`ONBOARDING_POLICY_HTTP_ERROR:${response.status}`);
      const payload = await readJsonUnknown(response);
      if (!isUnknownRecord(payload)) throw new Error('ONBOARDING_POLICY_PAYLOAD_INVALID');
      const defaults = payload['defaults'];
      const jurisdictionsValue = payload['jurisdictions'];
      if (!isUnknownRecord(defaults)) throw new Error('ONBOARDING_POLICY_DEFAULTS_INVALID');
      if (!isUnknownRecord(jurisdictionsValue)) throw new Error('ONBOARDING_POLICY_JURISDICTIONS_INVALID');
      const globalDefaults = normalizePolicyDefaults(defaults['rebalancePolicyUsd']);
      if (!globalDefaults) throw new Error('ONBOARDING_POLICY_DEFAULTS_MISSING');
      result.set('default', globalDefaults);

      const jurisdictions = jurisdictionsValue;
      for (const [key, value] of Object.entries(jurisdictions)) {
        if (!isUnknownRecord(value)) throw new Error(`ONBOARDING_POLICY_JURISDICTION_INVALID:${key}`);
        const jurisdictionDefaults = normalizePolicyDefaults(value['rebalancePolicyUsd']) ?? globalDefaults;
        result.set(String(key).trim().toLowerCase(), jurisdictionDefaults);
        const nameKey = typeof value['name'] === 'string' ? value['name'].trim().toLowerCase() : '';
        if (nameKey) result.set(nameKey, jurisdictionDefaults);
      }
    } catch (error) {
      policyDefaultsLoadPromise = null;
      throw error;
    }

    cachedPolicyDefaultsByJurisdiction = result;
    return result;
  })();

  return policyDefaultsLoadPromise;
};

/** beforeApply runs after loading and before the global defaults change, so a caller whose
 * session ended during the load can refuse without mutating the next session's defaults. */
export const hydrateJurisdictionPolicyDefaults = async (
  jurisdictionName?: string,
  beforeApply?: () => void,
): Promise<PolicyDefaults> => {
  const defaultsByJurisdiction = await loadPolicyDefaultsFromJurisdictions();
  beforeApply?.();
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
    if (!isUnknownRecord(parsed) || (parsed['mode'] !== 'manual' && parsed['mode'] !== 'autopilot'))
      throw new Error('COLLATERAL_POLICY_INVALID');
    for (const key of ['softLimitUsd', 'hardLimitUsd', 'maxFeeUsd', 'timestamp']) {
      const value = parsed[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`COLLATERAL_POLICY_INVALID:${key}`);
    }

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
  } catch (cause) {
    throw new Error('COLLATERAL_POLICY_INVALID', { cause });
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

export const getOpenAccountRebalancePolicyData = (tokenId: TokenId): {
  r2cRequestSoftLimit: bigint;
  hardLimit: bigint;
  maxAcceptableFee: bigint;
} | null => {
  const policy = readSavedCollateralPolicy();
  if (policy.mode === 'manual') return null;
  const r2cRequestSoftLimit = usdToRawTokenAmount(policy.softLimitUsd, tokenId);
  const hardLimit = usdToRawTokenAmount(policy.hardLimitUsd, tokenId);
  const maxAcceptableFee = usdToRawTokenAmount(policy.maxFeeUsd, tokenId);
  if (r2cRequestSoftLimit <= 0n || hardLimit < r2cRequestSoftLimit || maxAcceptableFee < 0n) return null;
  return { r2cRequestSoftLimit, hardLimit, maxAcceptableFee };
};
import { isUnknownRecord, parseJsonUnknown, readJsonUnknown } from '../boundary/index.ts';

export const getHubOpeningCredit = (tokenId: TokenId): bigint => usdToRawTokenAmount(10_000, tokenId);

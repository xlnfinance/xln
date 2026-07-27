import {
  normalizeJurisdictionKey,
  type ApiJurisdictionConfig,
  type JurisdictionsPayload,
  type Runtime,
} from './vault-recovery';

export const findRuntimeByIdCaseInsensitive = (
  runtimeMap: Record<string, Runtime>,
  requestedId: string | null | undefined,
): { key: string; runtime: Runtime } | null => {
  if (!requestedId) return null;
  const direct = runtimeMap[requestedId];
  if (direct) return { key: requestedId, runtime: direct };
  const requestedLower = requestedId.toLowerCase();
  for (const [key, runtime] of Object.entries(runtimeMap)) {
    if (key.toLowerCase() === requestedLower || runtime.id.toLowerCase() === requestedLower) {
      return { key, runtime };
    }
  }
  return null;
};

export async function waitForCondition(
  check: () => boolean,
  label: string,
  timeoutMs = 30_000,
  intervalMs = 50,
  describeTimeout?: () => string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = check();
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const details = describeTimeout?.();
  throw new Error(`[VaultStore] Timeout waiting for condition: ${label}${details ? `\n${details}` : ''}`);
}

export const hasRuntimeJurisdictionAddresses = (replica: unknown): boolean => {
  const candidate = replica as {
    depositoryAddress?: unknown;
    entityProviderAddress?: unknown;
    contracts?: {
      account?: unknown;
      depository?: unknown;
      entityProvider?: unknown;
      deltaTransformer?: unknown;
    };
  } | null;
  const depository =
    typeof candidate?.depositoryAddress === 'string' && candidate.depositoryAddress.length > 0
      ? candidate.depositoryAddress
      : typeof candidate?.contracts?.depository === 'string'
        ? candidate.contracts.depository
        : '';
  const entityProvider =
    typeof candidate?.entityProviderAddress === 'string' && candidate.entityProviderAddress.length > 0
      ? candidate.entityProviderAddress
      : typeof candidate?.contracts?.entityProvider === 'string'
        ? candidate.contracts.entityProvider
        : '';
  const account = typeof candidate?.contracts?.account === 'string' ? candidate.contracts.account : '';
  const deltaTransformer =
    typeof candidate?.contracts?.deltaTransformer === 'string' ? candidate.contracts.deltaTransformer : '';
  return Boolean(depository && entityProvider && account && deltaTransformer);
};

export const hasConnectedJurisdictionAdapter = (replica: unknown): boolean => {
  const candidate = replica as {
    jadapter?: {
      addresses?: { depository?: string; entityProvider?: string };
      depository?: unknown;
      entityProvider?: unknown;
    };
  } | null;
  return Boolean(
    candidate?.jadapter?.addresses?.depository &&
    candidate?.jadapter?.addresses?.entityProvider &&
    candidate?.jadapter?.depository &&
    candidate?.jadapter?.entityProvider,
  );
};

export const resolveJurisdictionConfig = (jurisdictions: JurisdictionsPayload): ApiJurisdictionConfig => {
  const usable = Object.values(jurisdictions.jurisdictions || {}).filter(hasUsableJurisdictionConfig);
  const selected = usable.find(isPrimaryJurisdictionConfig) ?? usable[0];
  if (!selected) {
    throw new Error('No jurisdictions found in /api/jurisdictions');
  }
  return selected;
};

export const isPrimaryJurisdictionConfig = (config: ApiJurisdictionConfig): boolean => config.primary === true;

export const hasUsableJurisdictionConfig = (config: ApiJurisdictionConfig): boolean => {
  const status = String((config as { status?: unknown })?.status || 'active')
    .trim()
    .toLowerCase();
  return (
    status === 'active' &&
    Boolean(config?.contracts?.depository && config?.contracts?.entityProvider && resolveJurisdictionRpc(config))
  );
};

export const resolveDefaultJurisdictionImportName = (
  key: string,
  config: ApiJurisdictionConfig,
  index: number,
): string => {
  const rawName = String(config.name || key).trim();
  return rawName || (index === 0 ? 'primary' : `Jurisdiction ${index + 1}`);
};

export const listDefaultJurisdictionImports = (
  jurisdictions: JurisdictionsPayload,
): Array<{ key: string; name: string; config: ApiJurisdictionConfig }> => {
  const entries = Object.entries(jurisdictions.jurisdictions || {}).filter(([, config]) =>
    hasUsableJurisdictionConfig(config),
  );
  if (entries.length === 0) return [];
  const primary = resolveJurisdictionConfig(jurisdictions);
  const primaryKey = entries.find(([, config]) => config === primary)?.[0] || 'primary';
  const ordered = [
    [primaryKey, primary] as const,
    ...entries.filter(([key, config]) => key !== primaryKey && config !== primary),
  ];
  const seen = new Set<string>();
  return ordered.flatMap(([key, config], index) => {
    const name = resolveDefaultJurisdictionImportName(key, config, index);
    const normalized = normalizeJurisdictionKey(name);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [{ key, name, config }];
  });
};

export const resolveJurisdictionRpc = (config: ApiJurisdictionConfig): string => config.rpc ?? config.rpcs?.[0] ?? '';

export const resolveRpcUrl = (rpc: string, baseOrigin?: string): string => {
  if (!rpc) throw new Error('Missing RPC URL in /api/jurisdictions');
  if (typeof window !== 'undefined' && rpc.startsWith('/rpc/')) {
    const origin = baseOrigin ?? window.location.origin;
    return new URL('/rpc', origin).toString();
  }
  if (typeof window !== 'undefined' && rpc.startsWith('http')) {
    try {
      const parsed = new URL(rpc);
      if (parsed.pathname.startsWith('/rpc/')) {
        return `${parsed.origin}/rpc`;
      }
      const isLocal = parsed.hostname === 'localhost';
      if (isLocal) {
        // Route localhost RPC through same-origin RPC bridge.
        const origin = baseOrigin ?? window.location.origin;
        return new URL('/rpc', origin).toString();
      }
    } catch {
      // fall through
    }
  }
  if (rpc.startsWith('http')) return rpc;
  if (typeof window !== 'undefined') {
    const origin = baseOrigin ?? window.location.origin;
    return new URL(rpc, origin).toString();
  }
  return rpc;
};

export // Tower remedies carry dispute proof bodies, which still contain bigint deltas.
// JSON.stringify would throw here and silently break last-resort tower coverage,
// so we normalize bigint leaves into decimal strings before upload.
const stringifyTowerPayload = (value: unknown): string =>
  JSON.stringify(value, (_key, candidate) => (typeof candidate === 'bigint' ? candidate.toString() : candidate));

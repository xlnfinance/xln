import type { JurisdictionConfig } from '../entity/types';
import type { RuntimeState } from '../runtime/types';
import type { JReplica } from '../types/jurisdiction-runtime';
import { getValidatorJContiguousThroughHeight } from '../jurisdiction/local-history';

const normalizedLabel = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const depositoryOf = (replica: JReplica | null | undefined): string =>
  normalizedLabel(replica?.depositoryAddress || replica?.contracts?.depository);

const entityProviderOf = (replica: JReplica | null | undefined): string =>
  normalizedLabel(replica?.entityProviderAddress || replica?.contracts?.entityProvider);

export const watcherChainIdOf = (
  replica: JReplica | null | undefined,
): number | null => {
  const chainId = Number(replica?.chainId);
  return Number.isFinite(chainId) && chainId > 0 ? Math.floor(chainId) : null;
};

export const findWatcherJurisdictionReplica = (
  env: RuntimeState,
  depositoryAddress?: string,
  chainId?: number,
): JReplica | null => {
  const replicas = [...(env.jReplicas?.values() || [])];
  if (replicas.length === 0) return null;

  const depository = normalizedLabel(depositoryAddress);
  const normalizedChainId =
    Number.isFinite(chainId) && Number(chainId) > 0
      ? Math.floor(Number(chainId))
      : null;
  if (depository || normalizedChainId !== null) {
    const addressMatches = replicas.filter(replica =>
      !depository || depositoryOf(replica) === depository);
    const exact = normalizedChainId === null
      ? addressMatches
      : addressMatches.filter(replica => watcherChainIdOf(replica) === normalizedChainId);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) {
      throw new Error(
        `J_WATCHER_JURISDICTION_AMBIGUOUS:${normalizedChainId ?? 'any'}:${depository || 'any'}`,
      );
    }

    // Old scenario fixtures can omit chainId. A unique Depository address
    // remains an unambiguous selector; duplicate addresses still fail closed.
    if (
      normalizedChainId !== null &&
      depository &&
      addressMatches.length === 1 &&
      watcherChainIdOf(addressMatches[0]) === null
    ) {
      return addressMatches[0]!;
    }
    return null;
  }

  const active = env.activeJurisdiction
    ? env.jReplicas?.get(env.activeJurisdiction)
    : undefined;
  return active ?? replicas[0] ?? null;
};

export const requireWatcherJurisdictionReplica = (
  env: RuntimeState,
  depositoryAddress: string | undefined,
  chainId: number | undefined,
  context: string,
): JReplica => {
  const replica = findWatcherJurisdictionReplica(env, depositoryAddress, chainId);
  if (replica) return replica;
  const available = [...(env.jReplicas?.values() || [])]
    .map(candidate => {
      const address = normalizedLabel(
        candidate.depositoryAddress || candidate.contracts?.depository,
      );
      return `${candidate.name || 'unnamed'}/${String(candidate.chainId ?? 'missing')}/${address || 'missing'}`;
    })
    .join(',');
  throw new Error(
    `J_WATCHER_JURISDICTION_NOT_FOUND:${context}` +
    `:chain=${String(chainId ?? 'any')}` +
    `:depository=${normalizedLabel(depositoryAddress) || 'any'}` +
    `:available=${available || 'none'}`,
  );
};

export const isEntityReplicaRelevantToWatcher = (
  env: RuntimeState,
  replica: { state?: { config?: { jurisdiction?: JurisdictionConfig } } },
  watcher: JReplica,
): boolean => {
  const jurisdiction = replica.state?.config?.jurisdiction;
  if (!jurisdiction) return (env.jReplicas?.size ?? 0) <= 1;

  const watcherChainId = watcherChainIdOf(watcher);
  const entityChainId = Number(jurisdiction.chainId);
  const chainMatches =
    !watcherChainId ||
    !Number.isFinite(entityChainId) ||
    watcherChainId === Math.floor(entityChainId);
  if (!chainMatches) return false;

  const watcherProvider = entityProviderOf(watcher);
  const entityProvider = normalizedLabel(jurisdiction.entityProviderAddress);
  if (
    (watcherProvider || entityProvider) &&
    (!watcherProvider || !entityProvider || watcherProvider !== entityProvider)
  ) return false;

  const watcherDepository = depositoryOf(watcher);
  const entityDepository = normalizedLabel(jurisdiction.depositoryAddress);
  if (watcherDepository && entityDepository) {
    return watcherDepository === entityDepository;
  }
  return Boolean(
    normalizedLabel(watcher.name) &&
    normalizedLabel(watcher.name) === normalizedLabel(jurisdiction.name),
  );
};

export const getMinimumCommittedSignerJHeight = (
  env: RuntimeState,
  watcher?: JReplica,
): number | null => {
  let minimum: number | null = null;
  for (const replica of env.eReplicas?.values() || []) {
    if (watcher && !isEntityReplicaRelevantToWatcher(env, replica, watcher)) continue;
    const height = Number(replica.state?.lastFinalizedJHeight ?? 0);
    if (!Number.isFinite(height) || height < 0) continue;
    minimum = minimum === null ? Math.floor(height) : Math.min(minimum, Math.floor(height));
  }
  return minimum;
};

export const getMinimumScannedSignerJHeight = (
  env: RuntimeState,
  watcher?: JReplica,
): number | null => {
  let minimum: number | null = null;
  for (const replica of env.eReplicas?.values() || []) {
    if (watcher && !isEntityReplicaRelevantToWatcher(env, replica, watcher)) continue;
    const height = Number(
      replica.jHistory
        ? getValidatorJContiguousThroughHeight(replica.state, replica.jHistory)
        : replica.state?.lastFinalizedJHeight ?? 0,
    );
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new Error(`J_WATCHER_LOCAL_SCAN_HEIGHT_INVALID:${String(height)}`);
    }
    minimum = minimum === null ? height : Math.min(minimum, height);
  }
  return minimum;
};

import type { Env, RoutedEntityInput } from '@xln/runtime/xln-api';

const DEFAULT_PROFILE_PREFETCH_TIMEOUT_MS = 1_200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeEntityId = (value: string): string => String(value || '').trim().toLowerCase();

type JurisdictionLike = {
  name?: unknown;
  chainId?: unknown;
  depositoryAddress?: unknown;
};

type OpenAccountProfileOptions = {
  requireHub?: boolean;
};

const normalizeJurisdiction = (value: unknown): string => String(value || '').trim().toLowerCase();

const jurisdictionKey = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const jurisdiction = value as JurisdictionLike;
    const chainId = String(jurisdiction.chainId ?? '').trim();
    const depository = String(jurisdiction.depositoryAddress ?? '').trim().toLowerCase();
    if (chainId && depository) return `dep:${chainId}:${depository}`;
    if (chainId) return '';
    return normalizeJurisdiction(jurisdiction.name);
  }
  return normalizeJurisdiction(value);
};

const getReplicaEntityId = (replicaKey: unknown, replica: unknown): string => {
  const candidate = replica as { state?: { entityId?: unknown }; entityId?: unknown } | null | undefined;
  return normalizeEntityId(String(candidate?.state?.entityId || candidate?.entityId || replicaKey || ''));
};

function getLocalEntityJurisdiction(currentEnv: Env | null | undefined, targetEntityId: string): { found: boolean; key: string } {
  const target = normalizeEntityId(targetEntityId);
  if (!target || !currentEnv?.eReplicas) return { found: false, key: '' };
  for (const [replicaKey, replica] of currentEnv.eReplicas.entries()) {
    if (getReplicaEntityId(replicaKey, replica) !== target) continue;
    return {
      found: true,
      key: jurisdictionKey(replica?.state?.config?.jurisdiction)
        || jurisdictionKey(replica?.position?.jurisdiction),
    };
  }
  return { found: false, key: '' };
}

function getProfile(currentEnv: Env | null | undefined, targetEntityId: string): {
  entityId?: string;
  runtimeId?: string;
  metadata?: { isHub?: boolean; jurisdiction?: unknown };
} | null {
  const target = normalizeEntityId(targetEntityId);
  if (!target) return null;
  const profiles = currentEnv?.gossip?.getProfiles?.() || [];
  return profiles.find((profile: { entityId?: string }) =>
    normalizeEntityId(profile?.entityId || '') === target,
  ) || null;
}

/**
 * Best-effort profile warmup before user-facing actions that route to a remote
 * entity. Without this, the first action can sit in the local P2P pending
 * queue until gossip eventually delivers the target runtime encryption key.
 */
export async function prewarmCounterpartyProfiles(
  env: Env | null | undefined,
  entityIds: readonly string[],
  timeoutMs = DEFAULT_PROFILE_PREFETCH_TIMEOUT_MS,
): Promise<boolean> {
  const p2p = env?.runtimeState?.p2p;
  if (!p2p?.ensureProfiles) return false;

  const targets = Array.from(new Set(entityIds.map(normalizeEntityId).filter(Boolean)));
  if (targets.length === 0) return false;

  let timedOut = false;
  const boundedTimeoutMs = Math.max(100, Math.floor(Number(timeoutMs) || DEFAULT_PROFILE_PREFETCH_TIMEOUT_MS));

  const timeout = (async (): Promise<boolean> => {
    await sleep(boundedTimeoutMs);
    timedOut = true;
    return false;
  })();

  const warmup = p2p.ensureProfiles(targets).catch(() => false);
  const resolved = await Promise.race([warmup, timeout]);
  return resolved === true && !timedOut;
}

export function hasCounterpartyRuntimeRoute(env: Env | null | undefined, entityId: string): boolean {
  const target = normalizeEntityId(entityId);
  if (!target) return false;
  const profile = getProfile(env, target);
  return String(profile?.runtimeId || '').trim().length > 0;
}

export function hasUsableOpenAccountCounterpartyProfile(
  env: Env | null | undefined,
  sourceEntityId: string,
  counterpartyEntityId: string,
  options: OpenAccountProfileOptions = {},
): boolean {
  const sourceJurisdiction = getLocalEntityJurisdiction(env, sourceEntityId);
  if (!sourceJurisdiction.key) return false;

  const counterparty = normalizeEntityId(counterpartyEntityId);
  if (!counterparty) return false;

  const localCounterpartyJurisdiction = getLocalEntityJurisdiction(env, counterparty);
  if (localCounterpartyJurisdiction.found) {
    return Boolean(localCounterpartyJurisdiction.key && localCounterpartyJurisdiction.key === sourceJurisdiction.key);
  }

  const profile = getProfile(env, counterparty);
  if (!profile) return false;
  if (options.requireHub && profile.metadata?.isHub !== true) return false;
  if (!String(profile.runtimeId || '').trim()) return false;
  return jurisdictionKey(profile.metadata?.jurisdiction) === sourceJurisdiction.key;
}

function collectOpenAccountCounterparties(entityInputs: readonly RoutedEntityInput[]): Array<{
  sourceEntityId: string;
  counterpartyEntityId: string;
}> {
  const pairs = new Map<string, { sourceEntityId: string; counterpartyEntityId: string }>();
  for (const input of entityInputs) {
    const sourceEntityId = normalizeEntityId(String(input?.entityId || ''));
    if (!sourceEntityId) continue;
    for (const tx of input.entityTxs || []) {
      if (tx?.type !== 'openAccount') continue;
      const counterpartyEntityId = normalizeEntityId(String(tx.data?.targetEntityId || ''));
      if (!counterpartyEntityId) continue;
      pairs.set(`${sourceEntityId}:${counterpartyEntityId}`, { sourceEntityId, counterpartyEntityId });
    }
  }
  return Array.from(pairs.values());
}

export async function waitForOpenAccountCounterpartyProfiles(
  env: Env | null | undefined,
  entityInputs: readonly RoutedEntityInput[],
  timeoutMs = 5_000,
): Promise<boolean> {
  const pairs = collectOpenAccountCounterparties(entityInputs);
  if (pairs.length === 0) return true;
  if (!env) return false;

  const boundedTimeoutMs = Math.max(100, Math.floor(Number(timeoutMs) || 5_000));
  const deadline = Date.now() + boundedTimeoutMs;

  await prewarmCounterpartyProfiles(
    env,
    pairs.map((pair) => pair.counterpartyEntityId),
    Math.min(boundedTimeoutMs, 5_000),
  );
  while (Date.now() < deadline) {
    const missing = pairs.filter((pair) =>
      !hasUsableOpenAccountCounterpartyProfile(env, pair.sourceEntityId, pair.counterpartyEntityId),
    );
    if (missing.length === 0) return true;
    await prewarmCounterpartyProfiles(
      env,
      missing.map((pair) => pair.counterpartyEntityId),
      Math.min(500, Math.max(100, deadline - Date.now())),
    );
    await sleep(100);
  }

  return pairs.every((pair) =>
    hasUsableOpenAccountCounterpartyProfile(env, pair.sourceEntityId, pair.counterpartyEntityId),
  );
}

export async function waitForCounterpartyRuntimeRoutes(
  env: Env | null | undefined,
  entityIds: readonly string[],
  timeoutMs = 5_000,
): Promise<boolean> {
  const targets = Array.from(new Set(entityIds.map(normalizeEntityId).filter(Boolean)));
  if (!env || targets.length === 0) return false;

  const boundedTimeoutMs = Math.max(100, Math.floor(Number(timeoutMs) || 5_000));
  const deadline = Date.now() + boundedTimeoutMs;

  await prewarmCounterpartyProfiles(env, targets, Math.min(boundedTimeoutMs, 5_000));
  while (Date.now() < deadline) {
    const missing = targets.filter((entityId) => !hasCounterpartyRuntimeRoute(env, entityId));
    if (missing.length === 0) return true;
    await prewarmCounterpartyProfiles(env, missing, Math.min(500, Math.max(100, deadline - Date.now())));
    await sleep(100);
  }

  return targets.every((entityId) => hasCounterpartyRuntimeRoute(env, entityId));
}

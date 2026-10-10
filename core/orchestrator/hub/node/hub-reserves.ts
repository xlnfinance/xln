import { applyJEventsToEnv } from '../../../jurisdiction/adapter/watcher';
import type { JAdapter, JTokenInfo } from '../../../jurisdiction/adapter/types';
import { getEntityJAdapter } from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';
import { getBootstrapTokenAmount, getEntityReplicaById, settleRuntimeFor } from '../../mesh/mesh-common';
import { normalizeJurisdictionDisplayName } from '../hub-visible-profiles';
import type {
  BootstrapReserveEntityHealth,
  BootstrapReserveHealth,
  HubBootstrapEntry,
  LocalHealthResponse,
} from './hub-node-types';
import {
  canDeployHubDefaultTokens,
  ensureTokenCatalog,
  requiredHubTokenCount,
  tokenCatalogForHubJurisdiction,
  waitForTokenCatalog,
} from './token-catalog';

/** Hub process state the reserve bootstrap reads; hub-node owns every field. */
export type HubReserveDeps = Readonly<{
  hubName: string;
  deployTokens: boolean;
  tokenCatalogsByEntityId: Map<string, JTokenInfo[]>;
  startTiming: (stage: 'reserve_funding') => number;
  finishTiming: (stage: 'reserve_funding', startedAt: number) => void;
}>;


export const normalizeEntityId = (entityId: string): string => String(entityId || '').trim().toLowerCase();

const requireJAdapterForEntity = (env: RuntimeReplica, entityId: string, purpose: string): JAdapter => {
  const adapter = getEntityJAdapter(env, entityId);
  if (!adapter) {
    throw new Error(`${purpose}_JADAPTER_MISSING: entity=${entityId}`);
  }
  return adapter;
};

const getReserveHealth = (env: RuntimeReplica, entityId: string, tokenCatalog: JTokenInfo[]): LocalHealthResponse['bootstrapReserves'] => {
  const replica = getEntityReplicaById(env, entityId);
  const tokens = tokenCatalogForHubJurisdiction(tokenCatalog, {
    jurisdictionName: getEntityJurisdictionName(env, entityId),
    chainId: requireJAdapterForEntity(env, entityId, 'RESERVE_HEALTH').chainId,
  }).map(token => {
    const tokenId = Number(token.tokenId);
    const decimals = Number(token.decimals);
    const current = replica?.state?.reserves?.get(tokenId) ?? 0n;
    const expectedMin = getBootstrapTokenAmount(tokenId, decimals);
    return {
      tokenId,
      symbol: String(token.symbol || `token-${tokenId}`),
      decimals,
      current: current.toString(),
      expectedMin: expectedMin.toString(),
      ready: current > 0n,
      operational: current > 0n,
      targetMet: current >= expectedMin,
    };
  });
  return {
    ok: tokens.length >= requiredHubTokenCount(requireJAdapterForEntity(env, entityId, 'RESERVE_HEALTH').chainId) && tokens.every(token => token.operational === true),
    targetMet: tokens.length >= requiredHubTokenCount(requireJAdapterForEntity(env, entityId, 'RESERVE_HEALTH').chainId) && tokens.every(token => token.targetMet === true),
    tokens,
  };
};

const refreshReserveStateFromWatcher = async (
  env: RuntimeReplica,
  entityId: string,
  tokenCatalog: JTokenInfo[],
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const jadapter = requireJAdapterForEntity(env, entityId, 'RESERVE_SYNC');
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state) {
    throw new Error(`HUB_REPLICA_MISSING_FOR_RESERVE_SYNC: ${entityId}`);
  }
  if (jadapter.isWatching()) {
    await jadapter.pollNow?.();
    await settleRuntimeFor(env, 10);
  }
  return getReserveHealth(env, entityId, tokenCatalog);
};

const ensureBootstrapReserves = async (
  deps: HubReserveDeps,
  env: RuntimeReplica,
  entityId: string,
  tokenCatalog: JTokenInfo[],
  reportProgress: (step: string) => void,
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const startedAt = deps.startTiming('reserve_funding');
  const jadapter = requireJAdapterForEntity(env, entityId, 'RESERVE_FUNDING');

  const bootstrapTokens = tokenCatalogForHubJurisdiction(tokenCatalog, {
    jurisdictionName: getEntityJurisdictionName(env, entityId),
    chainId: jadapter.chainId,
  });
  reportProgress('watcher-refresh:start');
  await refreshReserveStateFromWatcher(env, entityId, tokenCatalog);
  reportProgress('watcher-refresh:done');
  if (!deps.deployTokens || !canDeployHubDefaultTokens(jadapter.chainId)) {
    const reserveHealth = getReserveHealth(env, entityId, tokenCatalog);
    deps.finishTiming('reserve_funding', startedAt);
    return reserveHealth;
  }
  const replica = getEntityReplicaById(env, entityId);

  const mints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
  const reserveMismatches: string[] = [];
  for (const token of bootstrapTokens) {
    const tokenId = Number(token.tokenId);
    const decimals = Number(token.decimals);
    const target = getBootstrapTokenAmount(tokenId, decimals);
    const localCurrent = replica?.state?.reserves?.get(tokenId) ?? 0n;
    reportProgress(`chain-reserve:${tokenId}:start`);
    const chainCurrent = await jadapter.getReserves(entityId, tokenId);
    reportProgress(`chain-reserve:${tokenId}:done`);
    if (chainCurrent !== localCurrent) {
      reserveMismatches.push(`token=${tokenId} local=${localCurrent.toString()} chain=${chainCurrent.toString()}`);
      continue;
    }
    if (localCurrent >= target) continue;
    mints.push({
      entityId,
      tokenId,
      amount: target - localCurrent,
    });
  }
  if (reserveMismatches.length > 0) {
    throw new Error(
      `HUB_RESERVE_STATE_MISMATCH: entity=${entityId} ${reserveMismatches.join('; ')}; ` +
      'runtime reserve state must be replayed from canonical J-events before bootstrap funding',
    );
  }

  if (mints.length > 0) {
    reportProgress('fund-batch:start');
    const events = await jadapter.debugFundReservesBatch(mints);
    reportProgress('fund-batch:done');
    await applyJEventsToEnv(env, events, `${deps.hubName}-reserve-fund`, jadapter);
    reportProgress('fund-events:applied');
    await settleRuntimeFor(env, 30);
    reportProgress('fund-runtime:settled');
  }
  reportProgress('final-watcher-refresh:start');
  const reserveHealth = await refreshReserveStateFromWatcher(env, entityId, tokenCatalog);
  reportProgress('complete');

  deps.finishTiming('reserve_funding', startedAt);
  return reserveHealth;
};

export const getEntityJurisdictionName = (env: RuntimeReplica, entityId: string | null): string => {
  if (!entityId) return '';
  const replica = getEntityReplicaById(env, entityId);
  return normalizeJurisdictionDisplayName(replica?.state?.config?.jurisdiction?.name || '');
};

const resolveEntityTokenCatalog = async (
  deps: HubReserveDeps,
  env: RuntimeReplica,
  entityId: string,
): Promise<JTokenInfo[]> => {
  const normalizedEntityId = normalizeEntityId(entityId);
  const cached = deps.tokenCatalogsByEntityId.get(normalizedEntityId);
  const jadapter = requireJAdapterForEntity(env, entityId, 'TOKEN_CATALOG');
  if (cached && cached.length >= requiredHubTokenCount(jadapter.chainId)) return cached;
  const jurisdictionName = getEntityJurisdictionName(env, entityId);
  const catalog = deps.deployTokens
    ? await ensureTokenCatalog(jadapter, true, jurisdictionName)
    : await waitForTokenCatalog(jadapter);
  if (catalog.length < requiredHubTokenCount(jadapter.chainId)) {
    throw new Error(
      `TOKEN_CATALOG_INCOMPLETE_FOR_ENTITY: entity=${entityId} jurisdiction=${jurisdictionName || 'unknown'} ` +
        `count=${catalog.length} required=${requiredHubTokenCount(jadapter.chainId)}`,
    );
  }
  deps.tokenCatalogsByEntityId.set(normalizedEntityId, catalog);
  return catalog;
};

const buildAggregateReserveHealth = (
  primaryHealth: BootstrapReserveHealth | null,
  entities: BootstrapReserveEntityHealth[],
): BootstrapReserveHealth => ({
  ok: entities.length > 0 && entities.every(entity => entity.ready),
  targetMet: entities.length > 0 && entities.every(entity => entity.targetMet),
  tokens: primaryHealth?.tokens ?? entities[0]?.tokens ?? [],
  entities,
});

export const buildHubBootstrapReserveHealth = (
  deps: HubReserveDeps,
  env: RuntimeReplica,
  primaryEntityId: string | null,
  defaultCatalog: JTokenInfo[],
  hubEntities: HubBootstrapEntry[] = [],
): BootstrapReserveHealth => {
  const entries = hubEntities.length > 0
    ? hubEntities
    : primaryEntityId
      ? [{
          entityId: primaryEntityId,
          signerId: '',
          name: deps.hubName,
          jurisdictionName: getEntityJurisdictionName(env, primaryEntityId),
          primary: true,
        }]
      : [];
  const entities = entries.map((entry) => {
    const catalog = deps.tokenCatalogsByEntityId.get(normalizeEntityId(entry.entityId)) ?? defaultCatalog;
    const health = getReserveHealth(env, entry.entityId, catalog);
    return {
      entityId: entry.entityId,
      jurisdictionName: entry.jurisdictionName,
      primary: entry.primary,
      ready: health.ok === true,
      targetMet: health.targetMet === true,
      tokens: health.tokens,
    };
  });
  const primary = entries.findIndex(entry => entry.primary);
  const primaryHealth = primary >= 0 && entities[primary]
    ? { ok: entities[primary]!.ready, targetMet: entities[primary]!.targetMet, tokens: entities[primary]!.tokens }
    : null;
  return buildAggregateReserveHealth(primaryHealth, entities);
};

export const ensureHubBootstrapReserves = async (
  deps: HubReserveDeps,
  env: RuntimeReplica,
  hubEntities: HubBootstrapEntry[],
  reportProgress: (step: string) => void,
): Promise<BootstrapReserveHealth> => {
  const entities: BootstrapReserveEntityHealth[] = [];
  let primaryHealth: BootstrapReserveHealth | null = null;

  for (const entry of hubEntities) {
    reportProgress(`${entry.name}:catalog:start`);
    const catalog = await resolveEntityTokenCatalog(deps, env, entry.entityId);
    reportProgress(`${entry.name}:catalog:done`);
    const health = await ensureBootstrapReserves(
      deps,
      env,
      entry.entityId,
      catalog,
      (step) => reportProgress(`${entry.name}:${step}`),
    );
    const entityHealth: BootstrapReserveEntityHealth = {
      entityId: entry.entityId,
      jurisdictionName: entry.jurisdictionName,
      primary: entry.primary,
      ready: health.ok === true,
      targetMet: health.targetMet === true,
      tokens: health.tokens,
    };
    entities.push(entityHealth);
    if (entry.primary) primaryHealth = health;
  }

  return buildAggregateReserveHealth(primaryHealth, entities);
};

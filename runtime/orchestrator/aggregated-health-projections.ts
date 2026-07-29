import { normalizeRuntimeKey } from '../relay/store';
import { compareStableText } from '../protocol/serialization';
import { deriveHubRuntimeHealth } from './health-model';
import type {
  AggregatedHealth,
  HubChild,
  MarketMakerChild,
  MarketMakerHealthPayload,
} from './orchestrator-types';

export const collectManagedRelayClients = (
  hubChildren: readonly HubChild[],
  marketMakerChild: MarketMakerChild,
  marketMakerHealth: MarketMakerHealthPayload | null,
  relayClientIds: string[],
): {
  managedRuntimeIds: Set<string>;
  relayClientIds: string[];
  externalClientIds: string[];
} => {
  const managedRuntimeIds = new Set<string>();
  for (const child of hubChildren) {
    const runtimeId = normalizeRuntimeKey(
      String(child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || ''),
    );
    if (runtimeId) managedRuntimeIds.add(runtimeId);
  }
  const marketMakerRuntimeId = normalizeRuntimeKey(
    String(
      marketMakerChild.lastInfo?.runtimeId ||
        marketMakerHealth?.runtimeId ||
        '',
    ),
  );
  if (marketMakerRuntimeId) managedRuntimeIds.add(marketMakerRuntimeId);
  return {
    managedRuntimeIds,
    relayClientIds,
    externalClientIds: relayClientIds.filter(
      runtimeId => !managedRuntimeIds.has(runtimeId),
    ),
  };
};

export const buildAggregatedHubHealth = (
  hubChildren: readonly HubChild[],
  relayClientIds: ReadonlySet<string>,
  host: string,
): AggregatedHealth['hubs'] =>
  hubChildren.map(child => {
    const entityId = String(
      child.lastInfo?.entityId || child.lastHealth?.entityId || '',
    );
    const runtimeId = String(
      child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '',
    );
    const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
    const relayOnline = normalizedRuntimeId
      ? relayClientIds.has(normalizedRuntimeId)
      : false;
    const runtimeHealth = deriveHubRuntimeHealth({
      processExitCode:
        child.exitSignal !== null ? 1 : child.proc?.exitCode,
      hasHealth: Boolean(child.lastHealth),
      hasSelfRelayPresence: relayOnline,
      runtimeHalted: child.lastHealth?.runtime?.halted === true,
    });
    return {
      entityId,
      name: child.name,
      online: runtimeHealth.online,
      runtimeId,
      selfRelayPresence: runtimeHealth.selfRelayPresence,
      pid: child.proc?.pid ?? null,
      apiPort: child.apiPort,
      apiUrl: String(
        child.lastInfo?.apiUrl || `http://${host}:${child.apiPort}`,
      ),
      dbPath: child.dbPath,
      startedAt: child.startedAt,
      exitedAt: child.exitedAt,
      exitCode: child.exitCode,
      exitSignal: child.exitSignal,
      recoveryInProgress: child.recoveryInProgress,
      restartCount: child.restartCount,
      lastErrorLine: child.recentStderr.at(-1) ?? null,
      quiescence: child.lastHealth?.quiescence ?? null,
      bootstrapProgress: child.lastHealth?.bootstrapProgress ?? null,
    };
  });

export type AggregatedHubMeshDetails = {
  pairs: Map<
    string,
    {
      left: string;
      right: string;
      ok: boolean;
      expectedCreditAmount: string;
    }
  >;
  directLinks: Map<
    string,
    { fromRuntimeId: string; toRuntimeId: string; endpoint: string }
  >;
};

export const collectAggregatedHubMesh = (
  hubChildren: readonly HubChild[],
  expectedCreditAmount: bigint,
): AggregatedHubMeshDetails => {
  const pairs: AggregatedHubMeshDetails['pairs'] = new Map();
  const directLinks: AggregatedHubMeshDetails['directLinks'] = new Map();
  for (const child of hubChildren) {
    const left = String(
      child.lastInfo?.entityId || child.lastHealth?.entityId || '',
    ).toLowerCase();
    for (const pair of child.lastHealth?.mesh?.pairs ?? []) {
      const right = String(pair.counterpartyId || '').toLowerCase();
      if (!left || !right) continue;
      const [pairLeft, pairRight] = [left, right].sort();
      pairs.set(`${pairLeft}:${pairRight}`, {
        left: pairLeft!,
        right: pairRight!,
        ok: pair.ready === true,
        expectedCreditAmount: expectedCreditAmount.toString(),
      });
    }
    const fromRuntimeId = String(
      child.lastInfo?.runtimeId || child.lastHealth?.runtimeId || '',
    ).toLowerCase();
    for (const peer of child.lastHealth?.p2p?.directPeers ?? []) {
      const toRuntimeId = String(peer.runtimeId || '').toLowerCase();
      const endpoint = String(peer.endpoint || '');
      if (!fromRuntimeId || !toRuntimeId || !endpoint || peer.open !== true) {
        continue;
      }
      directLinks.set(`${fromRuntimeId}->${toRuntimeId}`, {
        fromRuntimeId,
        toRuntimeId,
        endpoint,
      });
    }
  }
  return { pairs, directLinks };
};

export const collectBootstrapReserveEntities = (
  hubChildren: readonly HubChild[],
): AggregatedHealth['bootstrapReserves']['entities'] =>
  hubChildren.flatMap(child => {
    const nestedEntities = child.lastHealth?.bootstrapReserves?.entities;
    if (Array.isArray(nestedEntities) && nestedEntities.length > 0) {
      return nestedEntities
        .map(entity => {
          const entityId = String(entity.entityId || '').trim().toLowerCase();
          return entityId
            ? {
                entityId,
                role: 'hub' as const,
                ready: entity.ready === true,
                targetMet: entity.targetMet === true,
                tokens: entity.tokens ?? [],
              }
            : null;
        })
        .filter((value): value is NonNullable<typeof value> => value !== null);
    }
    const entityId = String(
      child.lastInfo?.entityId || child.lastHealth?.entityId || '',
    );
    return entityId
      ? [{
          entityId,
          role: 'hub' as const,
          ready: child.lastHealth?.bootstrapReserves?.ok === true,
          targetMet: child.lastHealth?.bootstrapReserves?.targetMet === true,
          tokens: child.lastHealth?.bootstrapReserves?.tokens ?? [],
        }]
      : [];
  });

export const buildAggregatedRelayHealth = (
  clientIds: string[],
  managedRuntimeIds: Set<string>,
  externalClientIds: string[],
  marketSubscriptions: AggregatedHealth['relay']['marketSubscriptions'],
): AggregatedHealth['relay'] => ({
  clientCount: clientIds.length,
  managedRuntimeIds: Array.from(managedRuntimeIds).sort(),
  externalClientIds: externalClientIds.sort(),
  marketSubscriptions,
});

export const buildAggregatedHubMeshHealth = (
  ok: boolean,
  hubIds: string[],
  details: AggregatedHubMeshDetails,
): AggregatedHealth['hubMesh'] => ({
  ok,
  hubIds,
  pairs: Array.from(details.pairs.values()).sort((left, right) =>
    compareStableText(
      `${left.left}:${left.right}`,
      `${right.left}:${right.right}`,
    ),
  ),
  direct: {
    openLinkCount: details.directLinks.size,
    links: Array.from(details.directLinks.values()).sort((left, right) =>
      compareStableText(
        `${left.fromRuntimeId}:${left.toRuntimeId}`,
        `${right.fromRuntimeId}:${right.toRuntimeId}`,
      ),
    ),
  },
});

export const buildAggregatedCustodyHealth = (
  enabled: boolean,
  ok: boolean,
  entityId: string | null,
  daemonPort: number,
  servicePort: number,
): AggregatedHealth['custody'] => ({
  enabled,
  ok,
  entityId,
  daemonPort: enabled ? daemonPort : null,
  servicePort: enabled ? servicePort : null,
});

export const buildAggregatedBootstrapReserveHealth = (
  ok: boolean,
  targetMet: boolean,
  requiredTokenCount: number,
  entities: AggregatedHealth['bootstrapReserves']['entities'],
): AggregatedHealth['bootstrapReserves'] => ({
  ok,
  targetMet,
  requiredTokenCount,
  entityCount: entities.length,
  entities,
});

export const deriveAggregatedSystemStatus = (input: {
  storageOk: boolean;
  hubsOnline: boolean;
  hubMeshOk: boolean;
  resetOk: boolean;
  marketMakerOk: boolean;
  custodyOk: boolean;
  bootstrapReservesOk: boolean;
  bootstrapReserveTargetsMet: boolean;
}): Pick<AggregatedHealth, 'coreOk' | 'systemOk' | 'degraded'> => {
  const coreOk = input.storageOk && input.hubsOnline && input.hubMeshOk;
  const systemOk =
    coreOk &&
    input.resetOk &&
    input.marketMakerOk &&
    input.custodyOk &&
    input.bootstrapReservesOk;
  const degraded = [
    input.storageOk ? null : 'storage',
    input.hubsOnline ? null : 'hubs',
    input.hubMeshOk ? null : 'hubMesh',
    input.resetOk ? null : 'reset',
    input.marketMakerOk ? null : 'marketMaker',
    input.custodyOk ? null : 'custody',
    input.bootstrapReservesOk ? null : 'bootstrapReserves',
    input.bootstrapReserveTargetsMet ? null : 'bootstrapReserveTargets',
  ].filter((value): value is string => Boolean(value));
  return { coreOk, systemOk, degraded };
};

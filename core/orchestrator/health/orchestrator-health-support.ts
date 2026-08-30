import { buildRuntimeHealthFailures } from '../../protocol/errors/failure-taxonomy';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import type {
  AggregatedHealth,
  CustodySupportState,
  MarketMakerChild,
} from '../orchestrator-types';
import { deriveResetHealthOk } from './health-model';
import {
  resolveHealthResetOptions,
  resolveResetCapabilityHealth,
  type OrchestratorResetOptions,
} from '../process/reset-coordinator';

export const resolveCurrentCapabilityHealth = (
  marketMakerChild: MarketMakerChild,
  custodySupport: CustodySupportState | null,
  activeResetOptions: OrchestratorResetOptions,
  pendingResetOptions: OrchestratorResetOptions | null,
  resetInProgress: boolean,
): ReturnType<typeof resolveResetCapabilityHealth> => {
  const marketMakerOnline =
    marketMakerChild.proc?.exitCode === null &&
    marketMakerChild.proc?.signalCode === null &&
    marketMakerChild.exitCode === null &&
    marketMakerChild.exitSignal === null &&
    marketMakerChild.lastHealth?.runtime?.halted !== true;
  const custodyOnline = Boolean(
    custodySupport?.identity.entityId &&
    custodySupport.daemonChild.proc.exitCode === null &&
    custodySupport.custodyChild.proc.exitCode === null,
  );
  const resetOptions = resolveHealthResetOptions(
    activeResetOptions,
    pendingResetOptions,
    resetInProgress,
  );
  return resolveResetCapabilityHealth(resetOptions, { marketMakerOnline, custodyOnline });
};

export const createHealthRecomputer = (
  warnCrossOnly: (details: Record<string, unknown>) => void,
) => (
  health: AggregatedHealth,
  marketMaker: AggregatedHealth['marketMaker'],
): AggregatedHealth => {
  const resetOk = deriveResetHealthOk(health.reset);
  const systemOk = health.coreOk &&
    resetOk &&
    marketMaker.ok === true &&
    health.custody.ok === true &&
    health.bootstrapReserves.ok === true;
  const sameChainOk = marketMaker.hubs.length > 0 &&
    marketMaker.hubs.every(hub => hub.depthReady === true);
  const crossOk = marketMaker.cross.applicable !== true || marketMaker.cross.ok === true;
  const degraded = [
    health.storage.ok ? null : 'storage',
    health.hubs.every(hub => hub.online) ? null : 'hubs',
    health.hubMesh.ok ? null : 'hubMesh',
    resetOk ? null : 'reset',
    marketMaker.ok ? null : 'marketMaker',
    sameChainOk ? null : 'marketMakerSameChain',
    crossOk ? null : 'marketMakerCross',
    health.custody.ok ? null : 'custody',
    health.bootstrapReserves.ok ? null : 'bootstrapReserves',
    health.bootstrapReserves.targetMet ? null : 'bootstrapReserveTargets',
  ].filter((value): value is string => Boolean(value));
  if (!marketMaker.ok && sameChainOk && !crossOk) {
    warnCrossOnly({
      detail: 'same-chain market-maker depth is ready; systemOk is held back solely by cross-jurisdiction route convergence',
      expectedRoutes: marketMaker.cross.expectedRoutes,
      routesReady: marketMaker.cross.routes.filter(route => route.depthReady === true).length,
      routesTotal: marketMaker.cross.routes.length,
    });
  }
  return {
    ...health,
    systemOk,
    degraded,
    failures: buildRuntimeHealthFailures(degraded),
    marketMaker,
  };
};

export const createBaselineWaitReporter = (reportIntervalMs: number) => (
  startedAt: number,
  lastReportedAt: number,
  now: number,
  status: Record<string, unknown>,
): number => {
    if (now - lastReportedAt < reportIntervalMs) return lastReportedAt;
    console.warn(
      `[MESH] baseline still waiting: waitedMs=${now - startedAt} status=${safeStringify(status)}`,
    );
    return now;
  };

export const openDirectHubPairCount = (health: AggregatedHealth): number => new Set(
  health.hubMesh.direct.links.map(link =>
    [link.fromRuntimeId, link.toRuntimeId].sort(compareStableText).join(':')),
).size;

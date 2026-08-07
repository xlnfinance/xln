import type { AggregatedHealth, MarketMakerChild, ResetState, TimingMap } from './orchestrator-types';
import {
  emptyBootstrapBacklog,
  readLastMarketMakerBootstrapEvent,
  resolveBootstrapEventsPath,
  summarizeBootstrapBacklog,
} from './bootstrap-timeline-events';
import { buildBootstrapStages, timingFor, type BootstrapTimelineParams } from './bootstrap-timeline-stages';
import { HEALTH_RESPONSE_REFRESH_TIMEOUT_MS } from './orchestrator-config';

type BootstrapTimelineDeps = {
  getLastHealthResponseRefreshMs(): number | null;
  isRecord(value: unknown): value is Record<string, unknown>;
  marketMakerChild: MarketMakerChild;
  resetState: ResetState;
  timings: TimingMap;
  toFiniteNumber(value: unknown): number | null;
  warnTailRead(message: string, path: string, error: unknown): void;
};

const buildBootstrapTimeline = (
  deps: BootstrapTimelineDeps,
  bootstrapEventsPath: string,
  params: BootstrapTimelineParams,
): AggregatedHealth['bootstrapTimeline'] => {
  const { marketMakerChild, resetState, timings, toFiniteNumber } = deps;
  const lastHealthResponseRefreshMs = deps.getLastHealthResponseRefreshMs();
  const lastEvent = readLastMarketMakerBootstrapEvent(deps, bootstrapEventsPath);
  const mmBootstrap = marketMakerChild.lastHealth?.bootstrap ?? marketMakerChild.lastInfo?.bootstrap ?? null;
  const readyHash = String(mmBootstrap?.readyHash || '').trim() || lastEvent?.readyHash || null;
  const runtimeStateHash = String(mmBootstrap?.runtimeStateHash || '').trim() || lastEvent?.runtimeStateHash || null;
  const entityStateHash = String(mmBootstrap?.entityStateHash || '').trim() || lastEvent?.entityStateHash || null;
  const eventReadyAt = lastEvent?.event === 'ready-hash' && lastEvent.at ? Date.parse(lastEvent.at) : null;
  const readyAt = toFiniteNumber(mmBootstrap?.readyAt) ?? (Number.isFinite(eventReadyAt) ? eventReadyAt : null);
  const infoBacklog = (marketMakerChild.lastInfo as { runtimeBacklog?: unknown } | null)?.runtimeBacklog;
  const backlog = summarizeBootstrapBacklog(deps.isRecord, lastEvent?.backlog ?? infoBacklog);
  const resetTotal = timingFor(timings, 'reset_total');
  const fallbackLastEvent = resetTotal.completedAt
    ? {
        event: resetState.lastError ? 'reset-failed' : 'reset-complete',
        stage: 'orchestrator',
        at: new Date(resetTotal.completedAt).toISOString(),
        height: null,
      }
    : null;

  return {
    readyHash,
    runtimeStateHash,
    entityStateHash,
    readyAt,
    healthPoll: {
      actualMs: lastHealthResponseRefreshMs,
      budgetMs: HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
    },
    backlog: backlog ?? emptyBootstrapBacklog(),
    lastEvent: lastEvent
      ? {
          event: lastEvent.event,
          stage: lastEvent.stage,
          at: lastEvent.at,
          height: lastEvent.height,
        }
      : fallbackLastEvent,
    stages: buildBootstrapStages({
      params,
      resetState,
      lastHealthResponseRefreshMs,
      readyHash,
      readyAt,
      resetClear: timingFor(timings, 'reset_clear_state'),
      resetHubs: timingFor(timings, 'reset_wait_hubs'),
      resetMarketMaker: timingFor(timings, 'reset_market_maker'),
      resetCustody: timingFor(timings, 'reset_custody'),
    }),
  };
};

export const createBootstrapTimelineTools = (deps: BootstrapTimelineDeps) => {
  const bootstrapEventsPath = resolveBootstrapEventsPath(deps.marketMakerChild);
  return {
    buildBootstrapTimeline: (params: BootstrapTimelineParams) =>
      buildBootstrapTimeline(deps, bootstrapEventsPath, params),
    readLastMarketMakerBootstrapEvent: () => readLastMarketMakerBootstrapEvent(deps, bootstrapEventsPath),
  };
};

export type CurrentBootstrapTimelineInput = {
  storageOk: boolean;
  resetOk: boolean;
  hubs: AggregatedHealth['hubs'];
  hubsOnline: boolean;
  hubMeshOk: boolean;
  directOpenLinks: number;
  marketMakerEnabled: boolean;
  marketMakerActive: boolean;
  marketMaker: AggregatedHealth['marketMaker'];
  marketMakerStartupPhase: string | null;
  hubNameCount: number;
  custodyEnabled: boolean;
  custodyOk: boolean;
  bootstrapReservesOk: boolean;
  bootstrapReserveTargetsMet: boolean;
  reserveEntityCount: number;
};

/** Project AggregatedHealth-ish fields into the stage timeline params. */
export const projectCurrentBootstrapTimelineParams = (
  input: CurrentBootstrapTimelineInput,
): BootstrapTimelineParams => {
  const mmHubs = input.marketMaker.hubs;
  const mmCross = input.marketMaker.cross;
  const mmOfferTotal = mmHubs.reduce(
    (sum, hub) => sum + Number(hub.offers || 0),
    0,
  );
  const mmExpectedTotal =
    input.marketMaker.expectedOffersPerHub *
    Math.max(1, mmHubs.length || input.hubNameCount);
  const sameChainOk =
    !input.marketMakerEnabled ||
    (mmHubs.length === input.hubNameCount &&
      mmHubs.every(hub => hub.depthReady === true));
  const crossOk =
    !input.marketMakerEnabled ||
    !mmCross.applicable ||
    mmCross.ok === true;
  return {
    storageOk: input.storageOk,
    resetOk: input.resetOk,
    hubsOnline: input.hubsOnline,
    onlineHubs: input.hubs.filter(hub => hub.online).length,
    totalHubs: input.hubs.length,
    hubMeshOk: input.hubMeshOk,
    directOpenLinks: input.directOpenLinks,
    mmEnabled: input.marketMakerEnabled,
    marketMakerActive: input.marketMakerActive,
    sameChainOk,
    crossOk,
    mmOk: input.marketMaker.ok,
    mmStartupPhase: input.marketMakerStartupPhase,
    mmOfferTotal,
    mmExpectedTotal,
    crossRouteCount: Number(mmCross.routeCount || 0),
    expectedCrossRoutes: mmCross.expectedRoutes,
    custodyEnabled: input.custodyEnabled,
    custodyOk: input.custodyOk,
    bootstrapReservesOk: input.bootstrapReservesOk,
    bootstrapReserveTargetsMet: input.bootstrapReserveTargetsMet,
    reserveEntityCount: input.reserveEntityCount,
  };
};

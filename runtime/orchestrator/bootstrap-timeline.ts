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

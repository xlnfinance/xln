import { classifyRuntimeBootstrapStageFailure } from '../protocol/errors/failure-taxonomy';
import {
  HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
  HUB_BASELINE_TIMEOUT_MS,
  MARKET_MAKER_READY_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
} from './orchestrator-config';
import type { AggregatedHealth, ResetState, TimingMap } from './orchestrator-types';

type BootstrapStage = AggregatedHealth['bootstrapTimeline']['stages'][number];
type StageTiming = TimingMap[string];

export type BootstrapTimelineParams = {
  storageOk: boolean;
  resetOk: boolean;
  hubsOnline: boolean;
  onlineHubs: number;
  totalHubs: number;
  hubMeshOk: boolean;
  directOpenLinks: number;
  mmEnabled: boolean;
  marketMakerActive: boolean;
  sameChainOk: boolean;
  crossOk: boolean;
  mmOk: boolean;
  mmStartupPhase: string | null;
  mmOfferTotal: number;
  mmExpectedTotal: number;
  crossRouteCount: number;
  expectedCrossRoutes: number;
  custodyEnabled: boolean;
  custodyOk: boolean;
  bootstrapReservesOk: boolean;
  bootstrapReserveTargetsMet: boolean;
  reserveEntityCount: number;
};

export type BootstrapStageContext = {
  params: BootstrapTimelineParams;
  resetState: ResetState;
  lastHealthResponseRefreshMs: number | null;
  readyHash: string | null;
  readyAt: number | null;
  resetClear: StageTiming;
  resetHubs: StageTiming;
  resetMarketMaker: StageTiming;
  resetCustody: StageTiming;
};

const stageStatus = (
  ok: boolean | null,
  options: { active?: boolean; disabled?: boolean } = {},
): BootstrapStage['status'] => {
  if (options.disabled) return 'disabled';
  if (ok === true) return 'done';
  if (options.active) return 'active';
  if (ok === false) return 'blocked';
  return 'pending';
};

const withBootstrapStageFailure = (stage: Omit<BootstrapStage, 'failure'>): BootstrapStage => ({
  ...stage,
  failure: classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason),
});

const buildPreflightStages = (context: BootstrapStageContext): Array<Omit<BootstrapStage, 'failure'>> => {
  const { params, resetClear, resetHubs, resetState } = context;
  const preflightComplete = resetClear.completedAt !== null && params.storageOk;
  const preflightActive = resetClear.startedAt !== null && resetClear.completedAt === null && params.storageOk;
  const preflightState = preflightComplete ? true : params.storageOk ? null : false;
  return [
    {
      key: 'preflight',
      label: 'Preflight',
      status: stageStatus(preflightState, { active: preflightActive }),
      reason: resetState.lastError || (params.storageOk ? 'Reset and storage preflight clear' : 'Storage gate blocked'),
      budgetMs: STARTUP_TIMEOUT_MS,
      actualMs: resetClear.ms,
      startedAt: resetClear.startedAt,
      completedAt: resetClear.completedAt,
      evidence: [
        { label: 'storage ok', value: params.storageOk },
        { label: 'reset state cleared', value: resetClear.completedAt !== null },
      ],
    },
    {
      key: 'hub-mesh',
      label: 'Hub Mesh',
      status: stageStatus(params.hubMeshOk, { active: params.hubsOnline && !params.hubMeshOk }),
      reason: params.hubMeshOk ? 'All hub mesh accounts and credits are ready' : 'Hub mesh is still converging',
      budgetMs: HUB_BASELINE_TIMEOUT_MS,
      actualMs: resetHubs.ms,
      startedAt: resetHubs.startedAt,
      completedAt: resetHubs.completedAt,
      evidence: [
        { label: 'online hubs', value: params.onlineHubs },
        { label: 'total hubs', value: params.totalHubs },
        { label: 'direct links', value: params.directOpenLinks },
      ],
    },
  ];
};

const buildMarketStages = (context: BootstrapStageContext): Array<Omit<BootstrapStage, 'failure'>> => {
  const { params, readyHash, resetMarketMaker } = context;
  const active = params.marketMakerActive;
  const disabled = !params.mmEnabled;
  return [
    {
      key: 'same-chain',
      label: 'Same-Chain Books',
      status: stageStatus(params.sameChainOk, { active: active && !params.sameChainOk, disabled }),
      reason: params.mmEnabled
        ? 'Market maker same-chain orderbooks have full configured depth'
        : 'Market maker disabled',
      budgetMs: MARKET_MAKER_READY_TIMEOUT_MS,
      actualMs: null,
      startedAt: resetMarketMaker.startedAt,
      completedAt: null,
      evidence: [
        { label: 'offers', value: params.mmOfferTotal },
        { label: 'expected', value: params.mmExpectedTotal },
      ],
    },
    {
      key: 'cross-chain',
      label: 'Cross-Chain Routes',
      status: stageStatus(params.crossOk, { active: active && !params.crossOk, disabled }),
      reason: params.mmEnabled ? 'Cross-jurisdiction routes have full configured depth' : 'Market maker disabled',
      budgetMs: MARKET_MAKER_READY_TIMEOUT_MS,
      actualMs: null,
      startedAt: resetMarketMaker.startedAt,
      completedAt: null,
      evidence: [
        { label: 'routes', value: params.crossRouteCount },
        { label: 'expected', value: params.expectedCrossRoutes },
      ],
    },
    {
      key: 'market-maker',
      label: 'Market Maker',
      status: stageStatus(params.mmOk, { active: active && !params.mmOk, disabled }),
      reason: params.mmEnabled ? `Market maker phase ${params.mmStartupPhase || 'unknown'}` : 'Market maker disabled',
      budgetMs: MARKET_MAKER_READY_TIMEOUT_MS,
      actualMs: resetMarketMaker.ms,
      startedAt: resetMarketMaker.startedAt,
      completedAt: resetMarketMaker.completedAt,
      evidence: [
        { label: 'phase', value: params.mmStartupPhase || 'unknown' },
        { label: 'ready hash', value: readyHash ? 'present' : 'missing' },
      ],
    },
  ];
};

const buildCompletionStages = (context: BootstrapStageContext): Array<Omit<BootstrapStage, 'failure'>> => {
  const { params, lastHealthResponseRefreshMs, readyHash, readyAt, resetCustody } = context;
  const custodyStarted = resetCustody.startedAt !== null;
  const custodyState = params.custodyOk ? true : custodyStarted ? false : null;
  return [
    {
      key: 'custody',
      label: 'Custody',
      status: stageStatus(custodyState, {
        active: params.custodyEnabled && custodyStarted && resetCustody.completedAt === null && !params.custodyOk,
        disabled: !params.custodyEnabled,
      }),
      reason: params.custodyEnabled ? 'Custody daemon and service health' : 'Custody disabled for this boot',
      budgetMs: null,
      actualMs: resetCustody.ms,
      startedAt: resetCustody.startedAt,
      completedAt: resetCustody.completedAt,
      evidence: [{ label: 'enabled', value: params.custodyEnabled }],
    },
    {
      key: 'health-poll',
      label: 'Health Poll',
      status: stageStatus(lastHealthResponseRefreshMs !== null, { active: lastHealthResponseRefreshMs === null }),
      reason: 'Latest /api/health child refresh window',
      budgetMs: HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
      actualMs: lastHealthResponseRefreshMs,
      startedAt: null,
      completedAt: null,
      evidence: [
        { label: 'budget', value: HEALTH_RESPONSE_REFRESH_TIMEOUT_MS, unit: 'ms' },
        { label: 'actual', value: lastHealthResponseRefreshMs, unit: 'ms' },
      ],
    },
    {
      key: 'ready-hash',
      label: 'Ready Hash',
      status: stageStatus(Boolean(readyHash), {
        active: params.mmEnabled && params.mmOk && !readyHash,
        disabled: !params.mmEnabled,
      }),
      reason: readyHash ? 'Market maker persisted bootstrap-ready fingerprint' : 'Ready hash is not available yet',
      budgetMs: null,
      actualMs: null,
      startedAt: null,
      completedAt: readyAt,
      evidence: [
        { label: 'ready at', value: readyAt },
        { label: 'reserve entities', value: params.reserveEntityCount },
        { label: 'reserve targets', value: params.bootstrapReservesOk && params.bootstrapReserveTargetsMet },
      ],
    },
  ];
};

export const buildBootstrapStages = (context: BootstrapStageContext): BootstrapStage[] =>
  [...buildPreflightStages(context), ...buildMarketStages(context), ...buildCompletionStages(context)].map(
    withBootstrapStageFailure,
  );

export const timingFor = (timings: TimingMap, stage: keyof TimingMap): StageTiming =>
  timings[stage] ?? { startedAt: null, completedAt: null, ms: null };

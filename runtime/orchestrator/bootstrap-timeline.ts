import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRuntimeBootstrapStageFailure } from '../protocol/failure-taxonomy';
import {
  HEALTH_RESPONSE_REFRESH_TIMEOUT_MS,
  HUB_BASELINE_TIMEOUT_MS,
  MARKET_MAKER_READY_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
} from './orchestrator-config';
import type { AggregatedHealth, MarketMakerChild, ResetState, TimingMap } from './orchestrator-types';

type BootstrapTimelineDeps = {
  getLastHealthResponseRefreshMs(): number | null;
  isRecord(value: unknown): value is Record<string, unknown>;
  marketMakerChild: MarketMakerChild;
  resetState: ResetState;
  timings: TimingMap;
  toFiniteNumber(value: unknown): number | null;
  warnTailRead(message: string, path: string, error: unknown): void;
};

export const createBootstrapTimelineTools = (deps: BootstrapTimelineDeps) => {
  const { isRecord, marketMakerChild, resetState, timings, toFiniteNumber } = deps;
  const bootstrapEventsPath =
    String(process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] || '').trim() ||
    join(marketMakerChild.dbPath, 'bootstrap-events.jsonl');

  const readTailText = (path: string, maxBytes: number): string | null => {
    if (!path || !existsSync(path)) return null;
    let fd: number | null = null;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size <= 0) return null;
      const length = Math.min(stat.size, Math.max(1, maxBytes));
      const buffer = Buffer.alloc(length);
      fd = openSync(path, 'r');
      const bytesRead = readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
      return buffer.toString('utf8', 0, bytesRead);
    } catch (error) {
      deps.warnTailRead('bootstrap_events_tail_read_failed', path, error);
      return null;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch (error) {
          deps.warnTailRead('bootstrap_events_tail_close_failed', path, error);
        }
      }
    }
  };

  type LastBootstrapEvent = {
    event: string;
    stage: string | null;
    at: string | null;
    height: number | null;
    backlog: unknown;
    readyHash: string | null;
    runtimeStateHash: string | null;
    entityStateHash: string | null;
  };

  const readLastMarketMakerBootstrapEvent = (): LastBootstrapEvent | null => {
    // This is append-only JSONL. A bounded tail keeps health checks cheap even
    // when the market maker has been running for months.
    const tail = readTailText(bootstrapEventsPath, 64 * 1024);
    if (!tail) return null;
    const lines = tail
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]!) as unknown;
        if (!isRecord(parsed)) continue;
        const event = String(parsed['event'] || '').trim();
        if (!event) continue;
        return {
          event,
          stage: String(parsed['stage'] || '').trim() || null,
          at: String(parsed['at'] || '').trim() || null,
          height: toFiniteNumber(parsed['height']),
          backlog: parsed['backlog'],
          readyHash: String(parsed['hash'] || '').trim() || null,
          runtimeStateHash: String(parsed['runtimeStateHash'] || '').trim() || null,
          entityStateHash: String(parsed['entityStateHash'] || '').trim() || null,
        };
      } catch {
        // The bounded tail can start mid-line; keep scanning older complete lines.
      }
    }
    return null;
  };

  const summarizeBootstrapBacklog = (value: unknown): AggregatedHealth['bootstrapTimeline']['backlog'] => {
    if (!isRecord(value)) return null;
    const queuedInputs = Array.isArray(value['queuedEntityInputs']) ? value['queuedEntityInputs'] : [];
    const queuedEntityTxCount = queuedInputs.reduce((sum, entry) => {
      if (!isRecord(entry)) return sum;
      return sum + Math.max(0, Math.floor(Number(entry['txCount'] || 0)));
    }, 0);
    const runtimeTxs = Math.max(0, Math.floor(Number(value['runtimeTxs'] || 0)));
    const entityInputs = Math.max(0, Math.floor(Number(value['entityInputs'] || 0)));
    const jInputs = Math.max(0, Math.floor(Number(value['jInputs'] || 0)));
    const processing = value['processing'] === true;
    return {
      processing,
      runtimeTxs,
      entityInputs,
      jInputs,
      queuedEntityInputCount: queuedInputs.length,
      queuedEntityTxCount,
      total: runtimeTxs + entityInputs + jInputs + (processing ? 1 : 0),
    };
  };

  const emptyBootstrapBacklog = (): NonNullable<AggregatedHealth['bootstrapTimeline']['backlog']> => ({
    processing: false,
    runtimeTxs: 0,
    entityInputs: 0,
    jInputs: 0,
    queuedEntityInputCount: 0,
    queuedEntityTxCount: 0,
    total: 0,
  });

  const timingFor = (stage: keyof typeof timings): TimingMap[string] =>
    timings[stage] ?? { startedAt: null, completedAt: null, ms: null };

  const stageStatus = (
    ok: boolean | null,
    options: { active?: boolean; disabled?: boolean } = {},
  ): AggregatedHealth['bootstrapTimeline']['stages'][number]['status'] => {
    if (options.disabled) return 'disabled';
    if (ok === true) return 'done';
    if (options.active) return 'active';
    if (ok === false) return 'blocked';
    return 'pending';
  };

  const withBootstrapStageFailure = (
    stage: Omit<AggregatedHealth['bootstrapTimeline']['stages'][number], 'failure'>,
  ): AggregatedHealth['bootstrapTimeline']['stages'][number] => ({
    ...stage,
    failure: classifyRuntimeBootstrapStageFailure(stage.key, stage.status, stage.reason),
  });

  const buildBootstrapTimeline = (params: {
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
  }): AggregatedHealth['bootstrapTimeline'] => {
    const lastHealthResponseRefreshMs = deps.getLastHealthResponseRefreshMs();
    const lastEvent = readLastMarketMakerBootstrapEvent();
    const mmBootstrap = marketMakerChild.lastHealth?.bootstrap ?? marketMakerChild.lastInfo?.bootstrap ?? null;
    const readyHash = String(mmBootstrap?.readyHash || '').trim() || lastEvent?.readyHash || null;
    const runtimeStateHash = String(mmBootstrap?.runtimeStateHash || '').trim() || lastEvent?.runtimeStateHash || null;
    const entityStateHash = String(mmBootstrap?.entityStateHash || '').trim() || lastEvent?.entityStateHash || null;
    const eventReadyAt = lastEvent?.event === 'ready-hash' && lastEvent.at ? Date.parse(lastEvent.at) : null;
    const readyAt = toFiniteNumber(mmBootstrap?.readyAt) ?? (Number.isFinite(eventReadyAt) ? eventReadyAt : null);
    const infoBacklog = (marketMakerChild.lastInfo as { runtimeBacklog?: unknown } | null)?.runtimeBacklog;
    const backlog = summarizeBootstrapBacklog(lastEvent?.backlog ?? infoBacklog);
    const resetClear = timingFor('reset_clear_state');
    const resetTotal = timingFor('reset_total');
    const resetHubs = timingFor('reset_wait_hubs');
    const resetMarketMaker = timingFor('reset_market_maker');
    const resetCustody = timingFor('reset_custody');
    const preflightComplete = resetClear.completedAt !== null && params.storageOk;
    const preflightActive = resetClear.startedAt !== null && resetClear.completedAt === null && params.storageOk;
    const preflightState = preflightComplete ? true : params.storageOk ? null : false;
    const custodyStarted = resetCustody.startedAt !== null;
    const custodyState = params.custodyOk ? true : custodyStarted ? false : null;
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
      stages: [
        {
          key: 'preflight',
          label: 'Preflight',
          status: stageStatus(preflightState, { active: preflightActive }),
          reason:
            resetState.lastError || (params.storageOk ? 'Reset and storage preflight clear' : 'Storage gate blocked'),
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
        {
          key: 'same-chain',
          label: 'Same-Chain Books',
          status: stageStatus(params.sameChainOk, {
            active: params.marketMakerActive && !params.sameChainOk,
            disabled: !params.mmEnabled,
          }),
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
          status: stageStatus(params.crossOk, {
            active: params.marketMakerActive && !params.crossOk,
            disabled: !params.mmEnabled,
          }),
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
          status: stageStatus(params.mmOk, {
            active: params.marketMakerActive && !params.mmOk,
            disabled: !params.mmEnabled,
          }),
          reason: params.mmEnabled
            ? `Market maker phase ${params.mmStartupPhase || 'unknown'}`
            : 'Market maker disabled',
          budgetMs: MARKET_MAKER_READY_TIMEOUT_MS,
          actualMs: resetMarketMaker.ms,
          startedAt: resetMarketMaker.startedAt,
          completedAt: resetMarketMaker.completedAt,
          evidence: [
            { label: 'phase', value: params.mmStartupPhase || 'unknown' },
            { label: 'ready hash', value: readyHash ? 'present' : 'missing' },
          ],
        },
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
      ].map(withBootstrapStageFailure),
    };
  };

  return {
    buildBootstrapTimeline,
    readLastMarketMakerBootstrapEvent,
  };
};

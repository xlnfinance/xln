import { scheduler } from 'node:timers/promises';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import type { AggregatedHealth, Args, HubChild, MarketMakerChild, ResetState } from '../orchestrator-types';
import {
  HUB_BASELINE_TIMEOUT_MS,
  HUB_BASELINE_STALL_TIMEOUT_MS,
  HUB_BASELINE_STATUS_LOG_INTERVAL_MS,
  HUB_NAMES,
  MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
} from '../orchestrator-config';
import { evaluateBootstrapProgressDeadline } from './bootstrap-progress-deadline';
import { findMissingRpcContractCode, type RpcContractAddresses } from './contract-readiness';
import {
  hasShardRpc2Jurisdiction,
  readShardJurisdictions,
  resolvePrimaryHubJurisdiction,
  type OrchestratorJurisdictionsConfig,
} from '../j-select/jurisdictions';
import { shouldAbortMarketMakerSpawn } from '../market-maker/node/mm-recovery-spawn';
import { evaluateHubBaselineDeadlines, type HubBaselineProgressState } from '../hub/hub-baseline-progress';
import { createBaselineWaitReporter, openDirectHubPairCount } from '../health/orchestrator-health-support';

type ReadinessWaitDeps = Readonly<{
  args: Pick<Args, 'mmEnabled' | 'rpcUrl' | 'rpc2Url'>;
  jurisdictionsConfig: OrchestratorJurisdictionsConfig;
  hubChildren: readonly HubChild[];
  marketMakerChild: MarketMakerChild;
  resetState: Pick<ResetState, 'inProgress'>;
  marketMakerReadyRestartLimit: number;
  marketMakerRestartFencingGraceMs: number;
  pollHubHealth(child: HubChild): Promise<void>;
  pollAllHubHealth(): Promise<void>;
  pollMarketMakerHealth(): Promise<void>;
  computeAggregatedHealth(): AggregatedHealth;
  enrichMarketMakerFromHubSnapshots(health: AggregatedHealth): Promise<AggregatedHealth>;
  getExitedHubChild(): HubChild | null;
  spawnMarketMaker(): Promise<void>;
  isFatalOrchestratorShutdownStarted(): boolean;
  isOrchestratorShutdownStarted(): boolean;
}>;

const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const reportBaselineWait = createBaselineWaitReporter(HUB_BASELINE_STATUS_LOG_INTERVAL_MS);

const waitForMarketMakerSelfReady = async (deps: ReadinessWaitDeps): Promise<void> => {
  const { marketMakerChild, pollMarketMakerHealth } = deps;
  const startedAt = Date.now();
  while (true) {
    await pollMarketMakerHealth();
    if (marketMakerChild.lastInfo !== null || marketMakerChild.lastHealth !== null) {
      return;
    }
    if (marketMakerChild.proc?.exitCode !== null || marketMakerChild.proc?.signalCode !== null) {
      throw new Error(
        `MM_SELF_READY_EXITED_EARLY code=${String(marketMakerChild.proc?.exitCode)} ` +
        `stderr=${safeStringify(marketMakerChild.recentStderr.slice(-8))}`,
      );
    }
    if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
      throw new Error('MM_SELF_READY_TIMEOUT');
    }
    await scheduler.wait(250);
  }
};

/**
 * A direct link is one WebSocket, and only the dialing side registers it: a
 * peer this runtime never dialed is served over its inbound socket and never
 * appears in `directPeers`. Mesh bootstrap dials from the left side of each
 * account pair, so a fully connected mesh of n hubs settles at n*(n-1)/2 open
 * links, not n*(n-1). Counting directed edges makes the requirement unreachable.
 * Count unordered pairs so the gate asks for connectivity, not for both sides
 * to have happened to dial.
 */

const waitForHubBaseline = async (deps: ReadinessWaitDeps): Promise<void> => {
  const { hubChildren, pollAllHubHealth, computeAggregatedHealth } = deps;
  const hubCount = HUB_NAMES.length;
  const directRequired = (hubCount * Math.max(0, hubCount - 1)) / 2;
  const baselineStartedAt = Date.now();
  let lastReportedAt = baselineStartedAt;
  let lastStatus: Record<string, unknown> | null = null;
  let progressState: HubBaselineProgressState = {};
  while (true) {
    await pollAllHubHealth();
    const now = Date.now();
    const progress = evaluateHubBaselineDeadlines(hubChildren.map(child => ({
      name: child.name,
      health: child.lastHealth,
    })), progressState, now, HUB_BASELINE_STALL_TIMEOUT_MS);
    progressState = progress.state;
    const health = computeAggregatedHealth();
    const coreReady =
      health.hubMesh.ok &&
      health.bootstrapReserves.ok &&
      health.hubs.every(hub => hub.online);
    const directOpen = openDirectHubPairCount(health);
    const directReady = directOpen >= directRequired;
    lastStatus = {
      coreReady,
      directReady,
      directOpen,
      directRequired,
      bootstrapReserves: health.bootstrapReserves.ok,
      hubsOnline: health.hubs.map(hub => ({ name: hub.name, online: hub.online, selfRelayPresence: hub.selfRelayPresence })),
      degraded: health.degraded,
    };
    lastReportedAt = reportBaselineWait(baselineStartedAt, lastReportedAt, now, lastStatus);
    if (coreReady && directReady) {
      console.log(
        `[MESH] baseline ready: direct=${directOpen}/${directRequired} elapsedMs=${Date.now() - baselineStartedAt}`,
      );
      return;
    }
    if (progress.stalledNames.length > 0) {
      const stalled = Object.fromEntries(progress.stalledNames.map(name => [
        name,
        progress.evaluations[name],
      ]));
      throw new Error(
        `HUB_BASELINE_STALLED hubs=${progress.stalledNames.join(',')} ` +
        `timeoutMs=${HUB_BASELINE_STALL_TIMEOUT_MS} progress=${safeStringify(stalled)} ` +
        `status=${safeStringify(lastStatus)} health=${safeStringify(health)}`,
      );
    }
    await scheduler.wait(250);
  }
};

const waitForMarketMakerReady = async (deps: ReadinessWaitDeps): Promise<void> => {
  const {
    args,
    marketMakerChild,
    resetState,
    marketMakerReadyRestartLimit,
    marketMakerRestartFencingGraceMs,
    pollMarketMakerHealth,
    computeAggregatedHealth,
    enrichMarketMakerFromHubSnapshots,
    getExitedHubChild,
    spawnMarketMaker,
    isFatalOrchestratorShutdownStarted,
    isOrchestratorShutdownStarted,
  } = deps;
  let restartAttempts = 0;
  let publicDepthSignature = '';
  let publicDepthLastProgressAt = Date.now();
  // The MM child owns the progress-aware bootstrap watchdog. A second absolute
  // deadline here used to kill healthy bootstraps that were still advancing,
  // discard their in-memory work, and restart the same phase from zero.
  while (true) {
    await pollMarketMakerHealth();
    const internalHealth = computeAggregatedHealth();
    const health = internalHealth.marketMaker.ok
      ? await enrichMarketMakerFromHubSnapshots(internalHealth)
      : internalHealth;
    const exitedHub = getExitedHubChild();
    if (exitedHub) {
      throw new Error(
        `HUB_EXITED_DURING_MM_READY name=${exitedHub.name} code=${String(exitedHub.exitCode ?? exitedHub.proc?.exitCode)} ` +
        `stderr=${safeStringify(exitedHub.recentStderr.slice(-8))}`,
      );
    }
    if (marketMakerChild.exitCode !== null || marketMakerChild.exitSignal !== null) {
      // Supervised recovery already owns the respawn; do not race a second spawn.
      if (marketMakerChild.recoveryInProgress) {
        await scheduler.wait(250);
        continue;
      }
      if (restartAttempts < marketMakerReadyRestartLimit) {
        restartAttempts += 1;
        console.warn(
          `[MESH] restarting MM during readiness attempt=${restartAttempts}/${marketMakerReadyRestartLimit} ` +
          `code=${String(marketMakerChild.exitCode)} signal=${String(marketMakerChild.exitSignal)} ` +
          `phase=${String(marketMakerChild.lastStartupPhase)}`,
        );
        // A crashed writer may leave a valid lease behind until its fencing TTL
        // expires. Reusing the namespace sooner would correctly fail closed and
        // waste the retry, so wait out the lease before spawning its successor.
        await scheduler.wait(marketMakerRestartFencingGraceMs);
        if (shouldAbortMarketMakerSpawn({
          fatalShutdown: isFatalOrchestratorShutdownStarted(),
          orchestratorShutdown: isOrchestratorShutdownStarted(),
          resetInProgress: resetState.inProgress,
        })) {
          return;
        }
        await spawnMarketMaker();
        await scheduler.wait(500);
        continue;
      }
      throw new Error(
        `MM_EXITED_EARLY code=${String(marketMakerChild.exitCode)} signal=${String(marketMakerChild.exitSignal)} phase=${String(marketMakerChild.lastStartupPhase)} marketMaker=${safeStringify(health.marketMaker)}`,
      );
    }
    if (
      !args.mmEnabled ||
      health.marketMaker.ok
    ) {
      return;
    }
    if (internalHealth.marketMaker.ok) {
      const publicDepth = {
        hubs: health.marketMaker.hubs.map(hub => ({
          hubEntityId: hub.hubEntityId,
          pairs: hub.pairs.map(pair => ({
            pairId: pair.pairId,
            bids: pair.bidOffers ?? 0,
            asks: pair.askOffers ?? 0,
          })),
        })),
        cross: health.marketMaker.cross.routes.map(route => ({
          sourceHubEntityId: route.sourceHubEntityId,
          targetHubEntityId: route.targetHubEntityId,
          pairs: (route.pairs ?? []).map(pair => ({
            pairId: pair.pairId,
            bids: pair.bidOffers ?? 0,
            asks: pair.askOffers ?? 0,
          })),
        })),
      };
      const nextSignature = safeStringify(publicDepth);
      const now = Date.now();
      if (nextSignature !== publicDepthSignature) {
        publicDepthSignature = nextSignature;
        publicDepthLastProgressAt = now;
      } else if (now - publicDepthLastProgressAt >= MARKET_MAKER_BOOTSTRAP_STALL_TIMEOUT_MS) {
        throw new Error(
          `MARKET_MAKER_PUBLICATION_STALLED:idleMs=${now - publicDepthLastProgressAt}:` +
          `depth=${nextSignature}:health=${safeStringify(health.marketMaker)}`,
        );
      }
    }
    await scheduler.wait(250);
  }
};

const waitForHubSelfReady = async (deps: ReadinessWaitDeps, child: HubChild): Promise<void> => {
  const { pollHubHealth } = deps;
  const startedAt = Date.now();
  while (true) {
    await pollHubHealth(child);
    const identityReady = child.lastInfo?.entityId || child.lastInfo?.hubEntities?.some(entity => entity.entityId);
    if (identityReady) {
      return;
    }
    if (child.proc?.exitCode !== null || child.proc?.signalCode !== null) {
      throw new Error(`${child.name}_SELF_READY_EXITED_EARLY code=${String(child.proc?.exitCode)} stderr=${safeStringify(child.recentStderr.slice(-8))}`);
    }
    const idleMs = Date.now() - startedAt;
    if (idleMs >= HUB_BASELINE_TIMEOUT_MS) {
      throw new Error(
        `${child.name}_SELF_READY_TIMEOUT idleMs=${idleMs} ` +
        `timeoutMs=${HUB_BASELINE_TIMEOUT_MS} stderr=${safeStringify(child.recentStderr.slice(-8))}`,
      );
    }
    await scheduler.wait(250);
  }
};

const waitForShardJurisdictions = async (deps: ReadinessWaitDeps, child: HubChild): Promise<void> => {
  const { args, jurisdictionsConfig } = deps;
  let progress = { signature: '', lastProgressAt: Date.now() };
  let lastStatus: Record<string, unknown> = {};
  while (true) {
    const hasRpc2 = !args.rpc2Url || hasShardRpc2Jurisdiction(jurisdictionsConfig);
    const primary = resolvePrimaryHubJurisdiction(jurisdictionsConfig);
    let contracts: RpcContractAddresses | null = null;
    if (primary) {
      const payload = requireBoundaryRecord(
        JSON.parse(readShardJurisdictions(jurisdictionsConfig)),
        'SHARD_JURISDICTIONS_INVALID',
      );
      const jurisdictions = requireBoundaryRecord(payload['jurisdictions'], 'SHARD_JURISDICTIONS_ENTRIES_INVALID');
      const entryRaw = jurisdictions[primary.key];
      if (entryRaw !== undefined) {
        const entry = requireBoundaryRecord(entryRaw, `SHARD_JURISDICTION_INVALID:${primary.key}`);
        const rawContracts = entry['contracts'];
        if (rawContracts !== undefined) {
          const record = requireBoundaryRecord(rawContracts, `SHARD_JURISDICTION_CONTRACTS_INVALID:${primary.key}`);
          const allowed = ['account', 'depository', 'entityProvider', 'deltaTransformer'] as const;
          if (Object.keys(record).some(key => !allowed.some(allowedKey => allowedKey === key)) ||
              Object.values(record).some(value => typeof value !== 'string')) {
            throw new Error(`SHARD_JURISDICTION_CONTRACTS_INVALID:${primary.key}`);
          }
          contracts = Object.fromEntries(allowed.flatMap(key => {
            const address = record[key];
            return address === undefined ? [] : [[key, address] as const];
          }));
        }
      }
    }
    let missingCode: string[] = ['primary:unavailable'];
    let probeError = '';
    if (contracts) {
      try {
        missingCode = await findMissingRpcContractCode(args.rpcUrl, contracts);
      } catch (error) {
        probeError = serializeError(error);
      }
    }
    missingCode = [...missingCode].sort(compareStableText);
    lastStatus = { hasRpc2, primary: primary?.key ?? null, missingCode, probeError };
    if (hasRpc2 && missingCode.length === 0 && !probeError) {
      return;
    }
    if (!child.recoveryInProgress && (child.proc?.exitCode !== null || child.proc?.signalCode !== null)) {
      throw new Error(
        `${child.name}_EXITED_BEFORE_JURISDICTIONS code=${String(child.proc?.exitCode)} status=${safeStringify(lastStatus)}`,
      );
    }
    const signature = safeStringify({
      hasRpc2,
      primary: primary?.key ?? null,
      missingCode,
    });
    const evaluation = evaluateBootstrapProgressDeadline(
      progress,
      signature,
      Date.now(),
      HUB_BASELINE_STALL_TIMEOUT_MS,
    );
    progress = {
      signature: evaluation.signature,
      lastProgressAt: evaluation.lastProgressAt,
    };
    if (evaluation.stalled) {
      throw new Error(
        `${child.name}_JURISDICTIONS_STALLED idleMs=${evaluation.idleMs} ` +
        `timeoutMs=${HUB_BASELINE_STALL_TIMEOUT_MS} path=${jurisdictionsConfig.shardJurisdictionsPath} ` +
        `status=${safeStringify(lastStatus)}`,
      );
    }
    await scheduler.wait(250);
  }
};

export const createReadinessWaits = (deps: ReadinessWaitDeps) => ({
  waitForMarketMakerSelfReady: (): Promise<void> => waitForMarketMakerSelfReady(deps),
  waitForHubBaseline: (): Promise<void> => waitForHubBaseline(deps),
  waitForMarketMakerReady: (): Promise<void> => waitForMarketMakerReady(deps),
  waitForHubSelfReady: (child: HubChild): Promise<void> => waitForHubSelfReady(deps, child),
  waitForShardJurisdictions: (child: HubChild): Promise<void> => waitForShardJurisdictions(deps, child),
});

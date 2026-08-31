/** Same-j production workload and durable economic completion report. */

import { collectHltEnvironmentManifest } from '../boundary/environment-manifest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../../protocol/serialization';
import {
  decodeEntitySummaries,
  decodeHubMinTradeSize,
  decodeLoadSustainedReport,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
} from '../boundary/worker-boundary';
import {
  assertProductionSwapFullySettled,
} from '../settlement';
import { waitForFullySettledEvidence } from '../settlement-reader';
import {
  assertLaneHostSocketCounterCoverage,
  requireConnectedLaneRuntime,
  resetLaneHostOpCounters,
  stopLaneRuntimes,
} from '../lanes/lane-runtimes';
import {
  prepareParallelSameLoad,
  submitPreparedParallelSameLoad,
  type PreparedParallelSameLoad,
} from './worker-same-lanes';
import { publishHltDashboardPerfFromWorkDir, publishHltDashboardReport } from '../../../../qa/hlt/hlt-dashboard';
import {
  connectRuntime,
  disconnectRuntimeControl,
  directoryBytes,
  entryByLabel,
  exportReplayBaseSnapshotIfConfigured,
  persistReport,
  readLoadBook,
  resetHltProcessOpCounters,
  assertHltHubProcessIsolation,
  resolveWalPath,
  PRODUCTION_SWAP_LOAD_PAIR_ID,
  type WorkerArgs,
} from '../worker-runtime';
import {
  attachRustH1,
  classifyRustLiveSameRun,
  parseHltEngineSelection,
  rustLiveSameRateEvidence,
  type RustH1Handle,
} from '../rust/rust-h1';
import {
  createRustSameLoadNativeAuthority,
  readRustH1LoadBook,
  rustH1SessionPopulationReady,
  waitForRustH1Metrics,
  waitForRustSameSettlement,
} from '../rust/rust-h1-settlement';
import { waitForHltEconomicStartGate } from './worker-payments';

const runRustSameProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
  const plan = args.plan;
  if (!plan) throw new Error('HLT_RUST_SAME_PLAN_REQUIRED');
  const hubLabel = plan.economy.hubLabels[0] ?? 'H1';
  if (plan.economy.hubLabels.length !== 1 || hubLabel !== 'H1') {
    throw new Error('HLT_RUST_SAME_REQUIRES_SINGLE_H1');
  }
  let rustH1: RustH1Handle | null = await attachRustH1(
    `http://127.0.0.1:${String(args.portBase + 10)}`,
  );
  let existingOpenSessions: number | null = null;
  let preparedParallel: PreparedParallelSameLoad | null = null;
  const requireRustH1 = (): RustH1Handle => {
    if (rustH1 === null) throw new Error('HLT_RUST_NATIVE_AUTHORITY_NOT_STARTED');
    return rustH1;
  };
  try {
    const hubIdentity = {
      entityId: requireRustH1().ready.entityId,
      signerId: requireRustH1().ready.signerId,
    };
    const setupBook = await readRustH1LoadBook({
      portBase: args.portBase,
      entityId: hubIdentity.entityId,
      pairId: PRODUCTION_SWAP_LOAD_PAIR_ID,
    });
    const nativeAuthority = createRustSameLoadNativeAuthority({
      portBase: args.portBase,
      hubIdentity,
      requireRust: requireRustH1,
      replaceRust: next => { rustH1 = next; },
      observeExistingOpenSessions: count => { existingOpenSessions = count; },
    });
    preparedParallel = await prepareParallelSameLoad({
      workDir: args.workDir,
      portBase: args.portBase,
      hubIdentity,
      initialBook: setupBook,
      minimumTradeSize: requireRustH1().ready.orderbookMinTradeSize,
      swapsPerRound: args.swaps,
      rounds: args.rounds,
      lanes: args.lanes,
      laneOffset: args.laneOffset,
      execution: 'peer',
      compactSettlement: true,
      nativeAuthority,
    });
    const users = [...preparedParallel.traderRuntimes];
    if (users.length !== plan.totalUserRuntimes) {
      throw new Error(`HLT_RUST_SAME_USER_CARDINALITY:${users.length}:${plan.totalUserRuntimes}`);
    }
    await resetLaneHostOpCounters(users);
    const metricsBefore = await waitForRustH1Metrics(
      requireRustH1(),
      metrics => existingOpenSessions !== null && rustH1SessionPopulationReady(
        metrics.openSessions,
        existingOpenSessions,
        users.length,
      ),
      'HLT_RUST_SAME_METRICS_BASELINE_MISSING',
    );
    if (metricsBefore.orderbookTradeCount !== preparedParallel.setupTradeCount) {
      throw new Error(
        `PRODUCTION_SWAP_LOAD_SETUP_TRADE_COUNT_MISMATCH:` +
        `${metricsBefore.orderbookTradeCount}:${preparedParallel.setupTradeCount}`,
      );
    }
    const hubDurableBefore = {
      height: metricsBefore.height,
      canonicalStateHash: metricsBefore.postStateHash,
    };
    const walPath = join(args.workDir, 'prod-mesh', hubLabel.toLowerCase(), 'rscore-native');
    const walBytesBefore = directoryBytes(walPath);
    const driverRssBefore = process.memoryUsage().rss;
    for (const lane of users) {
      if (lane.runtime) disconnectRuntimeControl(lane.runtime);
    }
    await waitForHltEconomicStartGate();
    const startedAt = performance.now();
    const submitted = await submitPreparedParallelSameLoad({
      hubIdentity,
      swapsPerRound: args.swaps,
      rounds: args.rounds,
      cadenceMs: args.cadenceMs,
      prepared: preparedParallel,
    });
    const expectedSubmittedOffers = preparedParallel.distribution.submittedOffers;
    const expectedMatchedSwaps = preparedParallel.distribution.matchedTrades;
    const settlement = await waitForRustSameSettlement({
      rust: requireRustH1(),
      lanes: users,
      expectedMatchedSwaps,
      economicStartedAt: startedAt,
      metricsBefore,
    });
    const matchedEconomicSwaps = settlement.metrics.matchedSwaps - metricsBefore.matchedSwaps;
    const evidence = classifyRustLiveSameRun({
      users: users.length,
      orders: expectedSubmittedOffers,
      offeredOrdersPerSecond: plan.offeredOrderRatePerSecond,
      durationSeconds: plan.economy.durationSeconds,
    });
    const rateEvidence = rustLiveSameRateEvidence(evidence, {
      offeredOrdersPerSecond: plan.offeredOrderRatePerSecond,
      matchedEconomicSwaps,
      matchedElapsedMs: settlement.matchedElapsedMs,
      fullySettledElapsedMs: settlement.fullySettledElapsedMs,
    });
    const [hubIo, laneIo] = await Promise.all([
      assertHltHubProcessIsolation(args, [hubLabel], [hubLabel]),
      assertLaneHostSocketCounterCoverage(users),
    ]);
    const live = {
      engine: 'rust',
      workload: 'same',
      evidence,
      completionAuthority: 'committed_trade_count_and_bilateral_runtime_quiescence',
      users: users.length,
      perUser: { swapOrders: args.rounds },
      submittedSwapOrders: expectedSubmittedOffers,
      processedSwapOrders: expectedSubmittedOffers,
      matchedEconomicSwaps,
      offeredWindowMs: args.rounds * args.cadenceMs,
      matchedElapsedMs: settlement.matchedElapsedMs,
      fullySettledElapsedMs: settlement.fullySettledElapsedMs,
      enqueueAckElapsedMs: submitted.enqueueAckElapsedMs,
      commandObservedElapsedMs: submitted.commandObservedElapsedMs,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      driverRssBefore,
      driverRssAfter: process.memoryUsage().rss,
      hubDurableBefore,
      hubDurableAfter: {
        height: settlement.metrics.height,
        canonicalStateHash: settlement.metrics.postStateHash,
      },
      workers: requireRustH1().ready.workers,
      minFrameDelayMs: requireRustH1().ready.minFrameDelayMs,
      metricsBefore,
      metrics: settlement.metrics,
      economicPhaseMetrics: settlement.economicPhaseMetrics,
      laneQuiescence: settlement.laneQuiescence,
      hubIo,
      laneIo,
      environment: collectHltEnvironmentManifest(),
      ...rateEvidence,
    };
    writeFileSync(join(args.workDir, 'hlt-rust-h1-live.json'), `${safeStringify(live, 2)}\n`);
    console.log(`[load] rust-same verdict ${safeStringify({
      users: live.users,
      submitted: live.submittedSwapOrders,
      matched: live.matchedEconomicSwaps,
      evidence: live.evidence,
      ...rateEvidence,
    })}`);
  } finally {
    if (preparedParallel) await stopLaneRuntimes(preparedParallel.traderRuntimes);
    if (rustH1) await rustH1.stop();
  }
};

const runTypescriptSameProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  // The mesh always boots H1..H3 and MM; an economy names which of them this
  // run actually trades against, and the rest stay idle like a real network.
  const hubLabel = args.plan?.economy.hubLabels[0] ?? 'H1';
  const marketMakerLabel = args.plan?.economy.marketMakerLabels[0] ?? 'MM';
  const hub = await connectRuntime(entryByLabel(entries, hubLabel));
  const marketMaker = await connectRuntime(entryByLabel(entries, marketMakerLabel));
  let preparedParallel: PreparedParallelSameLoad | null = null;
  try {
    const hubIdentity = selectLocalHubIdentity(
      decodeEntitySummaries(await hub.adapter.read<unknown>('entities')),
      hub.adapter.runtimeId,
      31_337,
    );
    const setupBook = await readLoadBook(hub, hubIdentity.entityId);
    const minimumTradeSize = decodeHubMinTradeSize(
      await hub.adapter.read<unknown>(`entity/${hubIdentity.entityId}`),
    );
    preparedParallel = await prepareParallelSameLoad({
      workDir: args.workDir,
      portBase: args.portBase,
      hub,
      hubIdentity,
      initialBook: setupBook,
      minimumTradeSize,
      swapsPerRound: args.swaps,
      rounds: args.rounds,
      lanes: args.lanes,
      laneOffset: args.laneOffset,
      execution: 'peer',
    });
    const initialBook = await readLoadBook(hub, hubIdentity.entityId);
    if (initialBook.tradeCount !== preparedParallel.setupTradeCount) {
      throw new Error(
        `PRODUCTION_SWAP_LOAD_SETUP_TRADE_COUNT_MISMATCH:` +
        `${initialBook.tradeCount}:${preparedParallel.setupTradeCount}`,
      );
    }
    const laneRuntimes = [...preparedParallel.traderRuntimes];
    const readLaneFrames = async () => Promise.all(laneRuntimes.map(async lane =>
      decodeLoadFrame(await requireConnectedLaneRuntime(lane).adapter.read<unknown>('frame/latest'))));
    await Promise.all([
      resetLaneHostOpCounters(laneRuntimes),
      resetHltProcessOpCounters(args, [hub]),
    ]);
    await exportReplayBaseSnapshotIfConfigured(hub);
    const initialFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const laneInitialFrames = await readLaneFrames();
    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', hubLabel.toLowerCase()));
    const walBytesBefore = directoryBytes(walPath);
    const driverRssBefore = process.memoryUsage().rss;
    for (const lane of laneRuntimes) disconnectRuntimeControl(requireConnectedLaneRuntime(lane));
    const startedAt = performance.now();
    const submitted = await submitPreparedParallelSameLoad({
      hubIdentity,
      swapsPerRound: args.swaps, rounds: args.rounds, cadenceMs: args.cadenceMs,
      prepared: preparedParallel,
    });
    const settlementEvidence = await waitForFullySettledEvidence({
      hub,
      load: laneRuntimes.map(lane => ({
        runtime: requireConnectedLaneRuntime(lane),
        pairs: submitted.settlementPairs.filter(pair => pair.loadEntityId === lane.identity.entityId),
      })),
      marketMaker,
      hubBookEntityId: hubIdentity.entityId,
      pairs: submitted.settlementPairs,
      tradeCountBefore: initialBook.tradeCount,
      expectedSubmittedOffers: preparedParallel.distribution.submittedOffers,
      expectedMatchedTrades: preparedParallel.distribution.matchedTrades,
      expectedFullySettledOffers: preparedParallel.distribution.submittedOffers,
      cancelledOffers: 0,
      startedAt,
    });
    const rates = assertProductionSwapFullySettled(settlementEvidence);
    const matchedElapsedMs = settlementEvidence.matchedElapsedMs;
    const finalFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const laneFinalFrames = await readLaneFrames();
    const crossedBookAfterRun = settlementEvidence.bestBidPriceTicks !== null &&
      settlementEvidence.bestAskPriceTicks !== null &&
      settlementEvidence.bestBidPriceTicks >= settlementEvidence.bestAskPriceTicks;
    const leftoverAccounts = settlementEvidence.accounts.filter(account =>
      account.pendingFrame || account.pendingProposal || account.mempoolTxs > 0 || account.liveOfferIds.length > 0);
    console.log(
      `[load] hub-entity-settled pendingFrames=${settlementEvidence.accounts.filter(account => account.pendingFrame).length} ` +
      `pendingProposals=${settlementEvidence.accounts.filter(account => account.pendingProposal).length} ` +
      `liveOffers=${settlementEvidence.accounts.reduce((sum, account) => sum + account.liveOfferIds.length, 0)} ` +
      `mempoolTxs=${settlementEvidence.accounts.reduce((sum, account) => sum + account.mempoolTxs, 0)} ` +
      `dirtyAccounts=${leftoverAccounts.length}`,
    );
    const report = decodeLoadSustainedReport({
      schema: 'xln-production-swap-load-sustained-v1',
      mode: 'same',
      schedule: 'one_order_per_account_per_round',
      configuredUsers: args.lanes * 2,
      configuredRounds: args.rounds,
      cadenceMs: args.cadenceMs,
      offeredOrderRate: args.lanes * 2 * 1_000 / args.cadenceMs,
      offeredEconomicSwapRate: args.lanes * 1_000 / args.cadenceMs,
      loadMakerAccountCount: args.lanes,
      loadTakerAccountCount: args.lanes,
      loadParticipantAccountCount: args.lanes * 2,
      maxOrdersPerAccountFrame: submitted.offersPerRound,
      runtimeInputBatches: submitted.runtimeInputBatches,
      roundSubmissionLagMs: submitted.roundSubmissionLagMs,
      completionAuthority: 'committed_trade_count_and_bilateral_runtime_quiescence',
      expectedSubmittedOffers: preparedParallel.distribution.submittedOffers,
      expectedMatchedTrades: preparedParallel.distribution.matchedTrades,
      expectedFullySettledOffers: preparedParallel.distribution.submittedOffers,
      cancelledOffers: 0,
      stpOffers: settlementEvidence.stpOffers,
      matchedSubmittedOffers: preparedParallel.distribution.matchedSubmittedOffers,
      exchangeDistribution: preparedParallel.distribution,
      enqueueAckElapsedMs: submitted.enqueueAckElapsedMs,
      commandObservedElapsedMs: submitted.commandObservedElapsedMs,
      matchedElapsedMs,
      fullySettledElapsedMs: settlementEvidence.fullySettledElapsedMs,
      matchedTps: rates.matchedTps,
      fullySettledTps: rates.fullySettledTps,
      tradeCountBefore: initialBook.tradeCount,
      tradeCountAfter: settlementEvidence.tradeCountAfter,
      driverRssBefore,
      driverRssAfter: process.memoryUsage().rss,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      crossedBookAfterRun,
      durableBefore: initialFrame,
      durableAfter: finalFrame,
      // Every user Runtime is a separate process; the durable lane frame is
      // the aggregate height across all lane Runtimes plus the first lane's hash.
      loadDurableBefore: {
        height: laneInitialFrames.reduce((total, frame) => total + frame.height, 0),
        canonicalStateHash: laneInitialFrames[0]!.canonicalStateHash,
      },
      loadDurableAfter: {
        height: laneFinalFrames.reduce((total, frame) => total + frame.height, 0),
        canonicalStateHash: laneFinalFrames[0]!.canonicalStateHash,
      },
      settlementEvidence,
      environment: collectHltEnvironmentManifest(),
    });
    persistReport(join(args.workDir, 'production-swap-load-report.json'), report);
    publishHltDashboardReport('swap', report);
    publishHltDashboardPerfFromWorkDir(args.workDir);
    console.log(safeStringify(report));
  } finally {
    if (preparedParallel) {
      await stopLaneRuntimes(preparedParallel.traderRuntimes);
    }
    hub.adapter.disconnect();
    marketMaker.adapter.disconnect();
  }
};

export const runSameProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
  const selection = parseHltEngineSelection(process.env);
  return selection.engine === 'rust'
    ? runRustSameProductionSwapLoad(args)
    : runTypescriptSameProductionSwapLoad(args);
};

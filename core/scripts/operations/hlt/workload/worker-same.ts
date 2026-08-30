/** Same-j production workload and durable economic completion report. */

import { collectHltEnvironmentManifest } from '../boundary/environment-manifest';
import { readFileSync } from 'node:fs';
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
  resolveWalPath,
  type WorkerArgs,
} from '../worker-runtime';

export const runSameProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
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

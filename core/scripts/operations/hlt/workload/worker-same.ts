/** Same-j production workload and durable economic completion report. */

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
import { stopLaneRuntimes } from '../lanes/lane-runtimes';
import {
  prepareParallelSameLoad,
  submitPreparedParallelSameLoad,
  type PreparedParallelSameLoad,
} from './worker-same-lanes';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  persistReport,
  readLoadBook,
  resolveWalPath,
  type WorkerArgs,
} from '../worker-runtime';

export const runSameProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const hub = await connectRuntime(entryByLabel(entries, 'H1'));
  const marketMaker = await connectRuntime(entryByLabel(entries, 'MM'));
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
    });
    const initialBook = await readLoadBook(hub, hubIdentity.entityId);
    if (initialBook.tradeCount !== setupBook.tradeCount) {
      throw new Error('PRODUCTION_SWAP_LOAD_SETUP_CONCURRENT_TRADES');
    }
    const laneRuntimes = [...preparedParallel.makerRuntimes, ...preparedParallel.takerRuntimes];
    const readLaneFrames = async () => Promise.all(laneRuntimes.map(async lane =>
      decodeLoadFrame(await lane.runtime.adapter.read<unknown>('frame/latest'))));
    const initialFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const laneInitialFrames = await readLaneFrames();
    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', 'h1'));
    const walBytesBefore = directoryBytes(walPath);
    const driverRssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();
    const submitted = await submitPreparedParallelSameLoad({
      hub, hubIdentity, initialBook, initialFrame,
      swapsPerRound: args.swaps, rounds: args.rounds, cadenceMs: args.cadenceMs,
      prepared: preparedParallel,
    });
    const matchedElapsedMs = submitted.economicCompletionElapsedMs;
    const finalFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const laneFinalFrames = await readLaneFrames();
    const crossedBookAfterRun = submitted.finalBook.bestBidPriceTicks !== null &&
      submitted.finalBook.bestBidPriceTicks >= submitted.finalBook.bestAskPriceTicks;
    const settlementEvidence = await waitForFullySettledEvidence({
      hub,
      load: laneRuntimes.map(lane => ({
        runtime: lane.runtime,
        pairs: submitted.settlementPairs.filter(pair => pair.loadEntityId === lane.identity.entityId),
      })),
      marketMaker,
      hubBookEntityId: hubIdentity.entityId,
      pairs: submitted.settlementPairs,
      tradeCountBefore: initialBook.tradeCount,
      expectedSwaps: args.swaps * args.rounds,
      matchedElapsedMs,
      startedAt,
    });
    const rates = assertProductionSwapFullySettled(settlementEvidence);
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
      matchedEconomicSwaps: submitted.finalBook.tradeCount - initialBook.tradeCount,
      fullySettledEconomicSwaps: settlementEvidence.expectedSwaps,
      enqueueAckElapsedMs: submitted.enqueueAckElapsedMs,
      commandObservedElapsedMs: submitted.commandObservedElapsedMs,
      matchedElapsedMs,
      fullySettledElapsedMs: settlementEvidence.fullySettledElapsedMs,
      matchedTps: rates.matchedTps,
      fullySettledTps: rates.fullySettledTps,
      tradeCountBefore: initialBook.tradeCount,
      tradeCountAfter: submitted.finalBook.tradeCount,
      submittedEconomicSwaps: args.swaps * args.rounds,
      uncompletedEconomicSwapsAfterRun: 0,
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
    });
    persistReport(join(args.workDir, 'production-swap-load-report.json'), report);
    console.log(safeStringify(report));
  } finally {
    if (preparedParallel) {
      await stopLaneRuntimes([...preparedParallel.makerRuntimes, ...preparedParallel.takerRuntimes]);
    }
    hub.adapter.disconnect();
    marketMaker.adapter.disconnect();
  }
};

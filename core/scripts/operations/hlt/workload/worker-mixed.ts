/**
 * Simultaneous payment + same-j swap load on one user population.
 *
 * Mix 1:1 no longer partitions users into pay-only vs swap-only halves.
 * The same 1000 Entities open one Hub Account, then each cadence tick
 * every user pays someone else and every maker/taker pair matches twice
 * so offered pay/s and swap/s are equal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../../protocol/serialization';
import {
  decodeEntitySummaries,
  decodeHubSettlementCounters,
  decodeHubMinTradeSize,
  decodeLoadSustainedReport,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
} from '../boundary/worker-boundary';
import { decodeLoadPaymentReport } from '../boundary/worker-payment-boundary';
import { assertProductionSwapFullySettled } from '../settlement';
import { waitForFullySettledEvidence } from '../settlement-reader';
import { grantBilateralTokenCredit } from '../lanes/worker-lanes';
import { stopLaneRuntimes } from '../lanes/lane-runtimes';
import {
  prepareParallelSameLoad,
  submitPreparedParallelSameLoad,
  type PreparedParallelSameLoad,
} from './worker-same-lanes';
import { publishHltDashboardPerfFromWorkDir, publishHltDashboardReport } from '../../../../qa/hlt/hlt-dashboard';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  exportReplayBaseSnapshotIfConfigured,
  persistReport,
  readLoadBook,
  resolveWalPath,
  type WorkerArgs,
} from '../worker-runtime';
import {
  HLT_DEFAULT_PAYMENT_AMOUNT_RANGE,
} from '../economy';
import {
  paymentReceiverIndexSamePopulation,
  paymentTotalForSender,
  paymentTotalsByReceiverSamePopulation,
} from './worker-payments-plan';
import {
  buildRoundPayment,
  CREDIT_HEADROOM_MULTIPLE,
  PAYMENT_TOKEN_ID,
  waitForHubSettlement,
  waitForRoutableReceivers,
} from './worker-payments';
import type { LaneRuntime } from '../lanes/lane-runtimes';

export const runMixedProductionLoad = async (args: WorkerArgs): Promise<void> => {
  const plan = args.plan;
  if (!plan) throw new Error('HLT_MIXED_PLAN_REQUIRED');
  const swapMatches = plan.swapMatchesPerLaneRound;
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const hubLabel = plan.economy.hubLabels[0] ?? 'H1';
  const marketMakerLabel = plan.economy.marketMakerLabels[0] ?? 'MM';
  const hub = await connectRuntime(entryByLabel(entries, hubLabel));
  const marketMaker = await connectRuntime(entryByLabel(entries, marketMakerLabel));
  let prepared: PreparedParallelSameLoad | null = null;
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
    prepared = await prepareParallelSameLoad({
      workDir: args.workDir,
      portBase: args.portBase,
      hub,
      hubIdentity,
      initialBook: setupBook,
      minimumTradeSize,
      swapsPerRound: args.lanes,
      rounds: args.rounds * swapMatches,
      lanes: args.lanes,
      laneOffset: args.laneOffset,
    });
    const users: LaneRuntime[] = [...prepared.makerRuntimes, ...prepared.takerRuntimes];
    const amountRange = plan.economy.paymentAmountRange ?? HLT_DEFAULT_PAYMENT_AMOUNT_RANGE;
    const perSender = users.map((_, senderIndex) =>
      paymentTotalForSender(senderIndex, args.rounds, amountRange) * CREDIT_HEADROOM_MULTIPLE);
    const perReceiver = paymentTotalsByReceiverSamePopulation(users.length, args.rounds, amountRange)
      .map(total => total * CREDIT_HEADROOM_MULTIPLE);
    const quoteCredit = users.map((_, index) => {
      const spend = perSender[index]!;
      const receive = perReceiver[index]!;
      return spend > receive ? spend : receive;
    });
    await grantBilateralTokenCredit({
      hub,
      hubIdentity,
      runtimes: users,
      tokenId: PAYMENT_TOKEN_ID,
      amounts: quoteCredit,
      additive: true,
      label: 'hlt-mixed-pay-credit',
    });
    await waitForRoutableReceivers(
      users,
      hubIdentity.entityId,
      users.map((_lane, senderIndex) => Array.from(
        { length: args.rounds },
        (_, round) => users[paymentReceiverIndexSamePopulation(senderIndex, round, users.length)]!.identity.entityId,
      )),
    );

    const initialBook = await readLoadBook(hub, hubIdentity.entityId);
    if (initialBook.tradeCount !== setupBook.tradeCount) {
      throw new Error('PRODUCTION_SWAP_LOAD_SETUP_CONCURRENT_TRADES');
    }
    await exportReplayBaseSnapshotIfConfigured(hub);
    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', hubLabel.toLowerCase()));
    const walBytesBefore = directoryBytes(walPath);
    const hubDurableBefore = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const hubCountersBefore = decodeHubSettlementCounters(
      await hub.adapter.read<unknown>(`entity/${hubIdentity.entityId}`),
    );
    const driverRssBefore = process.memoryUsage().rss;
    const expectedSwaps = args.lanes * args.rounds * swapMatches;
    const senderIndexByLaneKey = new Map(users.map((lane, index) => [lane.laneKey, index]));
    const offerCadenceMs = Math.max(1, Math.floor(args.cadenceMs / swapMatches));

    const startedAt = performance.now();
    // Open-loop stream: three adjacent swap actions share one RuntimeInput.
    // With swapMatches=2 this folds alternating 2/1 payments into each input,
    // staying inside the owner-approved 1-3 swaps + 1-3 payments per frame.
    // Nothing waits for Hub progress or a previous Runtime commit.
    const submitted = await submitPreparedParallelSameLoad({
      hub,
      hubIdentity,
      initialBook,
      swapsPerRound: args.lanes,
      rounds: args.rounds * swapMatches,
      cadenceMs: offerCadenceMs,
      actionsPerFrame: 3,
      prepared,
      extraEntityTxs: ({ lane, identity, round }) => {
        if (round % swapMatches !== 0) return [];
        const senderIndex = senderIndexByLaneKey.get(lane.laneKey);
        if (senderIndex === undefined) throw new Error(`HLT_MIXED_TICK_LANE_MISMATCH:${lane.laneKey}`);
        const tick = round / swapMatches;
        const receiver = users[paymentReceiverIndexSamePopulation(senderIndex, tick, users.length)]!;
        return buildRoundPayment(
          identity,
          hubIdentity.entityId,
          receiver.identity,
          senderIndex,
          tick,
          amountRange,
        ).entityTxs ?? [];
      },
    });
    const submittedPayments = users.length * args.rounds;
    const settlementEvidence = await waitForFullySettledEvidence({
      hub,
      load: users.map(lane => ({
        runtime: lane.runtime,
        pairs: submitted.settlementPairs.filter(pair => pair.loadEntityId === lane.identity.entityId),
      })),
      marketMaker,
      hubBookEntityId: hubIdentity.entityId,
      pairs: submitted.settlementPairs,
      tradeCountBefore: initialBook.tradeCount,
      expectedSwaps,
      startedAt,
    });
    const rates = assertProductionSwapFullySettled(settlementEvidence);
    const matchedElapsedMs = settlementEvidence.matchedElapsedMs;
    const hubCountersAfter = await waitForHubSettlement(
      hub,
      hubIdentity.entityId,
      hubCountersBefore.completedPayments,
      submittedPayments,
    );
    const deliveredElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const hubDurableAfter = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));

    const paymentReport = decodeLoadPaymentReport({
      schema: 'xln-hlt-payment-load-v1',
      mode: 'payments',
      completionAuthority: 'committed_entity_metrics_and_bilateral_runtime_quiescence',
      configuredUsers: users.length,
      configuredRounds: args.rounds,
      cadenceMs: args.cadenceMs,
      senders: users.length,
      receivers: users.length,
      tokenId: PAYMENT_TOKEN_ID,
      amount: amountRange.min.toString(),
      offeredPaymentRate: plan.offeredPaymentRatePerSecond,
      submittedPayments,
      deliveredPayments: submittedPayments,
      enqueueAckElapsedMs: submitted.enqueueAckElapsedMs,
      commandObservedElapsedMs: submitted.commandObservedElapsedMs,
      deliveredElapsedMs,
      deliveredTps: submittedPayments * 1_000 / deliveredElapsedMs,
      hubCompletedPaymentsBefore: hubCountersBefore.completedPayments,
      hubCompletedPaymentsAfter: hubCountersAfter.completedPayments,
      roundSubmissionLagMs: submitted.roundSubmissionLagMs,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      hubDurableBefore,
      hubDurableAfter,
    });
    persistReport(join(args.workDir, 'hlt-payment-load-report.json'), paymentReport, decodeLoadPaymentReport);
    publishHltDashboardReport('payment', paymentReport);

    const swapReport = decodeLoadSustainedReport({
      schema: 'xln-production-swap-load-sustained-v1',
      mode: 'same',
      schedule: 'one_order_per_account_per_round',
      configuredUsers: users.length,
      configuredRounds: args.rounds * swapMatches,
      cadenceMs: offerCadenceMs,
      offeredOrderRate: users.length * 1_000 / offerCadenceMs,
      offeredEconomicSwapRate: args.lanes * 1_000 / offerCadenceMs,
      loadMakerAccountCount: args.lanes,
      loadTakerAccountCount: args.lanes,
      loadParticipantAccountCount: users.length,
      maxOrdersPerAccountFrame: submitted.offersPerRound,
      runtimeInputBatches: submitted.runtimeInputBatches,
      roundSubmissionLagMs: submitted.roundSubmissionLagMs,
      completionAuthority: 'committed_trade_count_and_bilateral_runtime_quiescence',
      matchedEconomicSwaps: settlementEvidence.tradeCountAfter - initialBook.tradeCount,
      fullySettledEconomicSwaps: settlementEvidence.expectedSwaps,
      enqueueAckElapsedMs: submitted.enqueueAckElapsedMs,
      commandObservedElapsedMs: submitted.commandObservedElapsedMs,
      matchedElapsedMs,
      fullySettledElapsedMs: settlementEvidence.fullySettledElapsedMs,
      matchedTps: rates.matchedTps,
      fullySettledTps: rates.fullySettledTps,
      tradeCountBefore: initialBook.tradeCount,
      tradeCountAfter: settlementEvidence.tradeCountAfter,
      submittedEconomicSwaps: expectedSwaps,
      uncompletedEconomicSwapsAfterRun: 0,
      driverRssBefore,
      driverRssAfter: process.memoryUsage().rss,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      crossedBookAfterRun: false,
      durableBefore: hubDurableBefore,
      durableAfter: hubDurableAfter,
      loadDurableBefore: hubDurableBefore,
      loadDurableAfter: hubDurableAfter,
      settlementEvidence,
    });
    persistReport(join(args.workDir, 'production-swap-load-report.json'), swapReport);
    publishHltDashboardReport('swap', swapReport);
    publishHltDashboardPerfFromWorkDir(args.workDir);
    console.log(safeStringify({ payment: paymentReport, swap: swapReport }));
  } finally {
    if (prepared) await stopLaneRuntimes([...prepared.makerRuntimes, ...prepared.takerRuntimes]);
    hub.adapter.disconnect();
    marketMaker.adapter.disconnect();
  }
};

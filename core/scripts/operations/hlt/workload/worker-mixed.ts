/**
 * Simultaneous payment + same-j swap load on one user population.
 *
 * Mix 1:1 no longer partitions users into pay-only vs swap-only halves.
 * The same 1000 Entities open one Hub Account, then each cadence tick
 * every user pays someone else and submits exactly one swap order. Half the
 * users ask and half bid at one exact price; roles flip every round. N users
 * therefore mean exactly N payments + N offers = N/2 economic swaps per tick.
 */

import { collectHltEnvironmentManifest } from '../boundary/environment-manifest';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
import { waitForExpectedMatchedTrades, waitForFullySettledEvidence } from '../settlement-reader';
import {
  assertLaneHostSocketCounterCoverage,
  resetLaneHostOpCounters,
  stopLaneRuntimes,
} from '../lanes/lane-runtimes';
import {
  prepareParallelSameLoad,
  cancelPreparedRestingTail,
  submitPreparedParallelSameLoad,
  type PreparedParallelSameLoad,
} from './worker-same-lanes';
import { assertBalancedExchangeDistribution } from './worker-same-plan';
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
  stopHltHubBackgroundIo,
  resolveWalPath,
  type WorkerArgs,
} from '../worker-runtime';
import {
  HLT_DEFAULT_PAYMENT_AMOUNT_RANGE,
} from '../economy';
import {
  paymentReceiverIndexSamePopulation,
} from './worker-payments-plan';
import {
  buildRoundPayment,
  PAYMENT_TOKEN_ID,
  waitForHubSettlement,
  waitForRoutableReceivers,
} from './worker-payments';
import type { LaneRuntime } from '../lanes/lane-runtimes';
import {
  hltAuthorityEvidenceEnabled,
  materializeH1CollateralEvidence,
} from './worker-authority-evidence';

export const runMixedProductionLoad = async (args: WorkerArgs): Promise<void> => {
  const plan = args.plan;
  if (!plan) throw new Error('HLT_MIXED_PLAN_REQUIRED');
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const hubLabel = plan.economy.hubLabels[0] ?? 'H1';
  const marketMakerLabel = plan.economy.marketMakerLabels[0] ?? 'MM';
  const hub = await connectRuntime(entryByLabel(entries, hubLabel));
  const marketMaker = await connectRuntime(entryByLabel(entries, marketMakerLabel));
  const authorityEvidence = hltAuthorityEvidenceEnabled();
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
    if (authorityEvidence) await exportReplayBaseSnapshotIfConfigured(hub);
    prepared = await prepareParallelSameLoad({
      workDir: args.workDir,
      portBase: args.portBase,
      hub,
      marketMaker,
      hubIdentity,
      initialBook: setupBook,
      minimumTradeSize,
      swapsPerRound: args.lanes,
      rounds: args.rounds,
      lanes: args.lanes,
      laneOffset: args.laneOffset,
      execution: 'balanced',
    });
    assertBalancedExchangeDistribution(prepared.distribution);
    console.log(`[load] balanced exchange ${safeStringify(prepared.distribution)}`);
    const users: LaneRuntime[] = [...prepared.traderRuntimes];
    const amountRange = plan.economy.paymentAmountRange ?? HLT_DEFAULT_PAYMENT_AMOUNT_RANGE;
    await waitForRoutableReceivers(
      users,
      hubIdentity.entityId,
      users.map((_lane, senderIndex) => Array.from(
        { length: args.rounds },
        (_, round) => users[paymentReceiverIndexSamePopulation(senderIndex, round, users.length)]!.identity.entityId,
      )),
    );
    if (authorityEvidence) {
      const firstUser = users[0];
      if (!firstUser) throw new Error('HLT_AUTHORITY_EVIDENCE_USER_MISSING');
      await materializeH1CollateralEvidence({ hub, hubIdentity, lane: firstUser });
    }

    const initialBook = await readLoadBook(hub, hubIdentity.entityId);
    if (initialBook.tradeCount !== prepared.setupTradeCount) {
      throw new Error(
        `PRODUCTION_SWAP_LOAD_SETUP_TRADE_COUNT_MISMATCH:${initialBook.tradeCount}:${prepared.setupTradeCount}`,
      );
    }
    await stopHltHubBackgroundIo(args);
    await Promise.all([
      resetLaneHostOpCounters(users),
      resetHltProcessOpCounters(args, [hub]),
    ]);
    if (!authorityEvidence) await exportReplayBaseSnapshotIfConfigured(hub);
    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', hubLabel.toLowerCase()));
    const walBytesBefore = directoryBytes(walPath);
    const hubDurableBefore = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const hubCountersBefore = decodeHubSettlementCounters(
      await hub.adapter.read<unknown>(`entity/${hubIdentity.entityId}/settlement-counters`),
    );
    const driverRssBefore = process.memoryUsage().rss;
    const expectedSubmittedOffers = prepared.distribution.submittedOffers;
    const senderIndexByLaneKey = new Map(users.map((lane, index) => [lane.laneKey, index]));
    const offerCadenceMs = args.cadenceMs;

    // Control URLs remain available, but no frontend is connected while H1 is
    // measured. Financial delivery uses only each sovereign Runtime's direct
    // P2P socket; settlement-reader reconnects control after Hub drain.
    for (const lane of users) disconnectRuntimeControl(lane.runtime);
    const startedAt = performance.now();
    // One cadence tick is exactly one swap + one payment per sovereign user.
    // Nothing waits for Hub progress, Runtime commit, or an earlier Account ACK.
    const submitted = await submitPreparedParallelSameLoad({
      hub,
      hubIdentity,
      initialBook,
      swapsPerRound: args.lanes,
      rounds: args.rounds,
      cadenceMs: offerCadenceMs,
      actionsPerFrame: 1,
      prepared,
      extraEntityTxs: ({ lane, identity, round }) => {
        const senderIndex = senderIndexByLaneKey.get(lane.laneKey);
        if (senderIndex === undefined) throw new Error(`HLT_MIXED_TICK_LANE_MISMATCH:${lane.laneKey}`);
        const tick = round;
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
    // Both economic counters start at the same open-loop timestamp. Waiting
    // for swap drain before observing payments made payment TPS equal to the
    // slower swap gate even when every payment had already committed.
    const paymentSettlementPromise = waitForHubSettlement(
      hub,
      hubIdentity.entityId,
      hubCountersBefore.completedPayments,
      hubCountersBefore.acceptedPayments,
      submittedPayments,
      startedAt,
    );
    // Pairwise-balanced orders have no measured MM dependency. The committed
    // Hub trade delta, not submitted order count, is the swap TPS authority.
    const matchedDrain = await waitForExpectedMatchedTrades({
      hub,
      hubBookEntityId: hubIdentity.entityId,
      tradeCountBefore: initialBook.tradeCount,
      expectedMatchedTrades: args.lanes * args.rounds,
      startedAt,
      allowAdditionalTrades: true,
      acceptDrainedBelowTarget: !authorityEvidence,
    });
    const expectedMatchedTrades = matchedDrain.matchedTrades;
    const matchedElapsedMs = matchedDrain.matchedElapsedMs;
    const observedDistribution = {
      ...prepared.distribution,
      matchedTrades: expectedMatchedTrades,
    };
    const cancellation = await cancelPreparedRestingTail(prepared);
    const [settlementEvidence, paymentSettlement] = await Promise.all([
      waitForFullySettledEvidence({
        hub,
        load: users.map(lane => ({
          runtime: lane.runtime,
          pairs: submitted.settlementPairs.filter(pair => pair.loadEntityId === lane.identity.entityId),
        })),
        marketMaker,
        hubBookEntityId: hubIdentity.entityId,
        pairs: submitted.settlementPairs,
        tradeCountBefore: initialBook.tradeCount,
        expectedSubmittedOffers,
        expectedMatchedTrades,
        expectedFullySettledOffers: expectedSubmittedOffers,
        cancelledOffers: cancellation.cancelledOffers,
        startedAt,
        matchedElapsedMs,
      }),
      paymentSettlementPromise,
    ]);
    const rates = assertProductionSwapFullySettled(settlementEvidence);
    const hubCountersAfter = paymentSettlement.counters;
    const hubIngressElapsedMs = paymentSettlement.hubIngressElapsedMs;
    const deliveredElapsedMs = paymentSettlement.deliveredElapsedMs;
    const [hubIo, laneIo] = await Promise.all([
      assertHltHubProcessIsolation(args),
      assertLaneHostSocketCounterCoverage(users),
    ]);
    console.log(`[load] economic-io ${safeStringify({ hubIo, laneIo })}`);
    const hubDurableAfter = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));

    const paymentReport = decodeLoadPaymentReport({
      schema: 'xln-hlt-payment-load-v1',
      mode: 'payments',
      runId: basename(args.workDir),
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
      sourceDispatchFinishedElapsedMs: submitted.sourceDispatchFinishedElapsedMs,
      sourceAllAckedElapsedMs: submitted.sourceAllAckedElapsedMs,
      commandObservedElapsedMs: submitted.commandObservedElapsedMs,
      deliveredElapsedMs,
      deliveredTps: submittedPayments * 1_000 / deliveredElapsedMs,
      hubCompletedPaymentsBefore: hubCountersBefore.completedPayments,
      hubCompletedPaymentsAfter: hubCountersAfter.completedPayments,
      hubAcceptedPaymentsBefore: hubCountersBefore.acceptedPayments,
      hubAcceptedPaymentsAfter: hubCountersAfter.acceptedPayments,
      hubIngressElapsedMs,
      settlementSamples: paymentSettlement.settlementSamples,
      roundSubmissionLagMs: submitted.roundSubmissionLagMs,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      hubDurableBefore,
      hubDurableAfter,
      environment: collectHltEnvironmentManifest(),
    });
    persistReport(join(args.workDir, 'hlt-payment-load-report.json'), paymentReport, decodeLoadPaymentReport);
    publishHltDashboardReport('payment', paymentReport);

    const swapReport = decodeLoadSustainedReport({
      schema: 'xln-production-swap-load-sustained-v1',
      mode: 'same',
      schedule: 'balanced_role_rotation',
      configuredUsers: users.length,
      configuredRounds: args.rounds,
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
      expectedSubmittedOffers,
      expectedMatchedTrades,
      expectedFullySettledOffers: expectedSubmittedOffers,
      cancelledOffers: cancellation.cancelledOffers,
      stpOffers: settlementEvidence.stpOffers,
      matchedSubmittedOffers: prepared.distribution.matchedSubmittedOffers,
      exchangeDistribution: observedDistribution,
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
      crossedBookAfterRun: false,
      durableBefore: hubDurableBefore,
      durableAfter: hubDurableAfter,
      loadDurableBefore: hubDurableBefore,
      loadDurableAfter: hubDurableAfter,
      settlementEvidence,
      environment: collectHltEnvironmentManifest(),
    });
    persistReport(join(args.workDir, 'production-swap-load-report.json'), swapReport);
    publishHltDashboardReport('swap', swapReport);
    publishHltDashboardPerfFromWorkDir(args.workDir);
    console.log(safeStringify({ payment: paymentReport, swap: swapReport }));
  } finally {
    if (prepared) await stopLaneRuntimes(prepared.traderRuntimes);
    hub.adapter.disconnect();
    marketMaker.adapter.disconnect();
  }
};

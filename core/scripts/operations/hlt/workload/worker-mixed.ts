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
import { readFileSync, writeFileSync } from 'node:fs';
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
  readLaneHostPaymentOperationLedgers,
  requireConnectedLaneRuntime,
  resetLaneHostOpCounters,
  stopLaneRuntimes,
} from '../lanes/lane-runtimes';
import {
  prepareParallelSameLoad,
  cancelPreparedRestingTail,
  submitPreparedParallelSameLoad,
  type PreparedParallelSameLoad,
  type SameLoadNativeAuthority,
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
  PRODUCTION_SWAP_LOAD_PAIR_ID,
  type WorkerArgs,
} from '../worker-runtime';
import {
  HLT_DEFAULT_PAYMENT_AMOUNT_RANGE,
} from '../economy';
import {
  paymentTotalForSender,
  paymentReceiverIndexSamePopulation,
} from './worker-payments-plan';
import {
  buildRoundPayment,
  assertCompleteUserPaymentLedger,
  CREDIT_HEADROOM_MULTIPLE,
  PAYMENT_TOKEN_ID,
  waitForHltEconomicStartGate,
  waitForHubSettlement,
  waitForRoutableReceivers,
} from './worker-payments';
import type { LaneRuntime } from '../lanes/lane-runtimes';
import { provisionParallelLoadTraderAccounts } from '../lanes/worker-lanes';
import {
  hltAuthorityEvidenceEnabled,
  materializeH1CollateralEvidence,
} from './worker-authority-evidence';
import {
  attachRustH1,
  isRustLiveMixedTpsAuthority,
  parseHltEngineSelection,
  type RustH1Handle,
  type RustH1Metrics,
} from '../rust/rust-h1';
import {
  connectRustH1,
  readRustH1LoadBook,
  rustH1SessionPopulationReady,
  waitForRustMixedSettlement,
} from '../rust/rust-h1-settlement';
import type { HltPaymentOperationLedgerSnapshot } from '../../../../support/performance/account-delivery-trace';

type HltSwapTerminalLedger = Readonly<{
  accepted: number;
  rejectedAtAccount: number;
  repeatedObservations: number;
  rejectionCodes: Readonly<Record<string, number>>;
}>;

const assertCompleteUserSwapProposalLedger = (
  ledgers: Readonly<Record<string, HltPaymentOperationLedgerSnapshot>>,
  expectedOfferIds: ReadonlySet<string>,
): HltSwapTerminalLedger => {
  const snapshots = Object.values(ledgers).map(ledger => ledger.swapProposals);
  const accepted = snapshots.flatMap(snapshot => [...snapshot.acceptedOfferIds]);
  const rejected = snapshots.flatMap(snapshot => [...snapshot.rejectedOfferIds]);
  const deferred = snapshots.flatMap(snapshot => [...snapshot.deferredOfferIds]);
  const all = [...accepted, ...rejected, ...deferred];
  const unique = new Set(all);
  if (
    unique.size !== all.length || unique.size !== expectedOfferIds.size ||
    [...unique].some(offerId => !expectedOfferIds.has(offerId)) ||
    [...expectedOfferIds].some(offerId => !unique.has(offerId))
  ) throw new Error(`HLT_SWAP_PROPOSAL_LEDGER_COVERAGE:${safeStringify({
    expected: expectedOfferIds.size,
    accepted: accepted.length,
    rejected: rejected.length,
    deferred: deferred.length,
    unique: unique.size,
  })}`);
  if (deferred.length > 0) {
    throw new Error(`HLT_SWAP_PROPOSAL_LEDGER_DEFERRED_AFTER_DRAIN:${deferred.length}`);
  }
  const rejectionCodes = snapshots.reduce<Record<string, number>>((totals, snapshot) => {
    for (const [code, count] of Object.entries(snapshot.rejectionCodes)) {
      totals[code] = (totals[code] ?? 0) + count;
    }
    return totals;
  }, {});
  if (Object.values(rejectionCodes).reduce((sum, count) => sum + count, 0) !== rejected.length) {
    throw new Error('HLT_SWAP_PROPOSAL_LEDGER_REJECTION_REASON_MISMATCH');
  }
  return {
    accepted: accepted.length,
    rejectedAtAccount: rejected.length,
    repeatedObservations: snapshots.reduce((sum, snapshot) => sum + snapshot.repeatedObservations, 0),
    rejectionCodes,
  };
};

const waitForRustMetrics = async (
  rust: RustH1Handle,
  predicate: (metrics: RustH1Metrics) => boolean,
  code: string,
): Promise<RustH1Metrics> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    const metrics = rust.metrics();
    if (metrics && predicate(metrics)) return metrics;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${code}:${safeStringify(rust.metrics())}:${rust.errorTail()}`);
};

export const runMixedProductionLoad = async (args: WorkerArgs): Promise<void> => {
  const plan = args.plan;
  if (!plan) throw new Error('HLT_MIXED_PLAN_REQUIRED');
  const selection = parseHltEngineSelection(process.env);
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = selection.engine === 'ts'
    ? decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
    : [];
  const hubLabel = plan.economy.hubLabels[0] ?? 'H1';
  const marketMakerLabel = plan.economy.marketMakerLabels[0] ?? 'MM';
  const hub = selection.engine === 'ts' ? await connectRuntime(entryByLabel(entries, hubLabel)) : null;
  const marketMaker = selection.engine === 'ts'
    ? await connectRuntime(entryByLabel(entries, marketMakerLabel))
    : null;
  const authorityEvidence = hltAuthorityEvidenceEnabled();
  let prepared: PreparedParallelSameLoad | null = null;
  let rustH1: RustH1Handle | null = null;
  let rustExistingOpenSessions: number | null = null;
  const requireRustH1 = (): RustH1Handle => {
    if (rustH1 === null) throw new Error('HLT_RUST_NATIVE_AUTHORITY_NOT_STARTED');
    return rustH1;
  };
  const stopRustH1 = async (): Promise<void> => {
    if (rustH1 !== null) await rustH1.stop();
  };
  const requireHub = () => {
    if (hub === null) throw new Error('HLT_TS_HUB_REQUIRED');
    return hub;
  };
  const requireMarketMaker = () => {
    if (marketMaker === null) throw new Error('HLT_TS_MARKET_MAKER_REQUIRED');
    return marketMaker;
  };
  let hubBackgroundStopped = false;
  try {
    if (selection.engine === 'rust') {
      rustH1 = await attachRustH1(`http://127.0.0.1:${String(args.portBase + 10)}`);
    }
    const hubIdentity = rustH1
      ? { entityId: rustH1.ready.entityId, signerId: rustH1.ready.signerId }
      : selectLocalHubIdentity(
          decodeEntitySummaries(await requireHub().adapter.read<unknown>('entities')),
          requireHub().adapter.runtimeId,
          31_337,
        );
    const setupBook = rustH1
      ? await readRustH1LoadBook({
          portBase: args.portBase,
          entityId: hubIdentity.entityId,
          pairId: PRODUCTION_SWAP_LOAD_PAIR_ID,
        })
      : await readLoadBook(requireHub(), hubIdentity.entityId);
    const minimumTradeSize = rustH1
      ? rustH1.ready.orderbookMinTradeSize
      : decodeHubMinTradeSize(
          await requireHub().adapter.read<unknown>(`entity/${hubIdentity.entityId}`),
        );
    const amountRange = plan.economy.paymentAmountRange ?? HLT_DEFAULT_PAYMENT_AMOUNT_RANGE;
    if (selection.engine === 'rust' && authorityEvidence) {
      throw new Error('HLT_RUST_AUTHORITY_EVIDENCE_REQUIRES_NATIVE_MATERIALIZER');
    }
    if (authorityEvidence) await exportReplayBaseSnapshotIfConfigured(requireHub());
    const nativeAuthority: SameLoadNativeAuthority | undefined = selection.engine === 'rust'
      ? {
          provisionPopulation: async (runtimes, receiveWindows, faucetAmounts) => {
            const current = requireRustH1();
            const expectedRuntimeId = current.ready.runtimeId;
            const existingMetrics = await waitForRustMetrics(
              current,
              () => true,
              'HLT_RUST_PRE_POPULATION_METRICS_MISSING',
            );
            rustExistingOpenSessions = existingMetrics.openSessions;
            await current.stop();
            rustH1 = await connectRustH1({
              portBase: args.portBase,
              lanes: runtimes,
              expectedRuntimeId,
              expectedEntityId: hubIdentity.entityId,
            });
            await provisionParallelLoadTraderAccounts({
              hubIdentity,
              runtimes,
              receiveWindows,
              ...(faucetAmounts === undefined ? {} : { faucetAmounts }),
              commitHubInput: async (commandId, input) => {
                if (input.runtimeTxs.length !== 0) {
                  throw new Error(`HLT_RUST_LOCAL_RUNTIME_TXS_FORBIDDEN:${commandId}`);
                }
                await rustH1!.submitLocalEntityInputs(commandId, input.entityInputs);
              },
            });
          },
          readTradeCheckpoint: async () => {
            if (!rustH1) throw new Error('HLT_RUST_NATIVE_AUTHORITY_NOT_STARTED');
            const metrics = await waitForRustMetrics(rustH1, () => true, 'HLT_RUST_SETUP_METRICS_MISSING');
            return {
              tradeCount: metrics.orderbookTradeCount,
              matchedSwaps: metrics.matchedSwaps,
            };
          },
        }
      : undefined;
    prepared = await prepareParallelSameLoad({
      workDir: args.workDir,
      portBase: args.portBase,
      ...(hub ? { hub } : {}),
      hubIdentity,
      initialBook: setupBook,
      minimumTradeSize,
      swapsPerRound: args.lanes,
      rounds: args.rounds,
      lanes: args.lanes,
      laneOffset: args.laneOffset,
      execution: 'balanced',
      compactSettlement: selection.engine === 'rust',
      additionalQuoteDebits: Array.from(
        { length: args.lanes * 2 },
        (_, senderIndex) =>
          paymentTotalForSender(senderIndex, args.rounds, amountRange) * CREDIT_HEADROOM_MULTIPLE,
      ),
      ...(nativeAuthority ? { nativeAuthority } : {}),
    });
    assertBalancedExchangeDistribution(prepared.distribution);
    console.log(`[load] balanced exchange ${safeStringify(prepared.distribution)}`);
    const users: LaneRuntime[] = [...prepared.traderRuntimes];
    const offeredWindowMs = args.rounds * args.cadenceMs;
    const rustTpsAuthority = selection.engine === 'rust' && isRustLiveMixedTpsAuthority({
      users: users.length,
      ratePerUser: 1_000 / args.cadenceMs,
      durationSeconds: offeredWindowMs / 1_000,
    });
    const economicPrepareStartedAt = performance.now();
    const economicPreparePhase = (name: string): void => console.log(
      `[load] economic-prepare phase=${name} elapsedMs=${Math.ceil(performance.now() - economicPrepareStartedAt)}`,
    );
    await waitForRoutableReceivers(
      users,
      hubIdentity.entityId,
      users.map((_lane, senderIndex) => Array.from(
        { length: args.rounds },
        (_, round) => users[paymentReceiverIndexSamePopulation(senderIndex, round, users.length)]!.identity.entityId,
      )),
    );
    economicPreparePhase('routes-ready');
    if (authorityEvidence) {
      const firstUser = users[0];
      if (!firstUser) throw new Error('HLT_AUTHORITY_EVIDENCE_USER_MISSING');
      await materializeH1CollateralEvidence({ hub: requireHub(), hubIdentity, lane: firstUser });
    }

    const initialBook = selection.engine === 'rust'
      ? { ...setupBook, tradeCount: prepared.setupTradeCount }
      : await readLoadBook(requireHub(), hubIdentity.entityId);
    if (initialBook.tradeCount !== prepared.setupTradeCount) {
      throw new Error(
        `PRODUCTION_SWAP_LOAD_SETUP_TRADE_COUNT_MISMATCH:${initialBook.tradeCount}:${prepared.setupTradeCount}`,
      );
    }
    if (selection.engine === 'ts' && !hubBackgroundStopped) {
      await stopHltHubBackgroundIo(args, [hubLabel]);
      hubBackgroundStopped = true;
    }
    await resetLaneHostOpCounters(users);
    economicPreparePhase('lane-counters-reset');
    if (!rustH1) {
      await resetHltProcessOpCounters(args, [requireHub()]);
      if (!authorityEvidence) await exportReplayBaseSnapshotIfConfigured(requireHub());
    }
    const rustMetricsBefore: RustH1Metrics | null = rustH1
      ? await waitForRustMetrics(
          rustH1,
          metrics => rustExistingOpenSessions !== null && rustH1SessionPopulationReady(
            metrics.openSessions,
            rustExistingOpenSessions,
            users.length,
          ),
          'HLT_RUST_MIXED_METRICS_BASELINE_MISSING',
        )
      : null;
    economicPreparePhase('metrics-baseline');
    if (rustH1 && rustMetricsBefore === null) throw new Error('HLT_RUST_MIXED_METRICS_BASELINE_MISSING');
    const hubDurableBefore = rustMetricsBefore
      ? { height: rustMetricsBefore.height, canonicalStateHash: rustMetricsBefore.postStateHash }
      : decodeLoadFrame(await requireHub().adapter.read<unknown>('frame/latest'));
    const tsHubCountersBefore = rustMetricsBefore ? null : decodeHubSettlementCounters(
      await requireHub().adapter.read<unknown>(`entity/${hubIdentity.entityId}/settlement-counters`),
    );
    const hubCountersBefore = rustMetricsBefore === null ? tsHubCountersBefore : {
      height: rustMetricsBefore.height,
      paybookOpen: rustMetricsBefore.paybookOpen,
      paybookFeesEarned: BigInt(rustMetricsBefore.paybookFeesEarned),
      acceptedPayments: rustMetricsBefore.acceptedPayments,
      completedPayments: rustMetricsBefore.completedPayments,
      matchedSwaps: rustMetricsBefore.matchedSwaps,
      metricsRuntimeHeight: rustMetricsBefore.height,
    };
    if (hubCountersBefore === null) throw new Error('HLT_MIXED_COUNTER_BASELINE_MISSING');
    const walPath = rustH1
      ? join(args.workDir, 'prod-mesh', hubLabel.toLowerCase(), 'rscore-native')
      : resolveWalPath(join(args.workDir, 'prod-mesh', hubLabel.toLowerCase()));
    const walBytesBefore = directoryBytes(walPath);
    economicPreparePhase('wal-sized');
    const driverRssBefore = process.memoryUsage().rss;
    const expectedSubmittedOffers = prepared.distribution.submittedOffers;
    const senderIndexByLaneKey = new Map(users.map((lane, index) => [lane.laneKey, index]));
    const offerCadenceMs = args.cadenceMs;

    // Control URLs remain available, but no frontend is connected while H1 is
    // measured. Financial delivery uses only each sovereign Runtime's direct
    // P2P socket; settlement-reader reconnects control after Hub drain.
    for (const lane of users) {
      if (lane.runtime) disconnectRuntimeControl(lane.runtime);
    }
    economicPreparePhase('submit-ready');
    await waitForHltEconomicStartGate();
    const economicStartedAtUnixMs = Date.now();
    const startedAt = performance.now();
    let economicFingerprint = '';
    const telemetryRustH1 = selection.engine === 'rust' ? requireRustH1() : null;
    const economicTelemetry = telemetryRustH1 ? setInterval(() => {
      const metrics = telemetryRustH1.metrics();
      if (!metrics || !rustMetricsBefore) return;
      const fingerprint = `${metrics.height}:${metrics.acceptedPayments}:${metrics.completedPayments}:` +
        `${metrics.matchedSwaps}:${metrics.outboxRowsPending}`;
      if (fingerprint === economicFingerprint) return;
      economicFingerprint = fingerprint;
      console.log(`[load] rust-economic ${safeStringify({
        elapsedMs: Math.ceil(performance.now() - startedAt),
        height: metrics.height,
        accepted: metrics.acceptedPayments - rustMetricsBefore.acceptedPayments,
        completed: metrics.completedPayments - rustMetricsBefore.completedPayments,
        matched: metrics.matchedSwaps - rustMetricsBefore.matchedSwaps,
        zeroFillSwapCancels:
          metrics.zeroFillSwapCancels - rustMetricsBefore.zeroFillSwapCancels,
        openSwapOffers: metrics.openSwapOffers - rustMetricsBefore.openSwapOffers,
        accountInputs: metrics.totalAccountInputs - rustMetricsBefore.totalAccountInputs,
        applyMicros: metrics.totalApplyMicros - rustMetricsBefore.totalApplyMicros,
        projectionMicros: metrics.totalProjectionMicros - rustMetricsBefore.totalProjectionMicros,
        projectionInputMicros:
          metrics.totalProjectionInputMicros - rustMetricsBefore.totalProjectionInputMicros,
        projectionMachineMicros:
          metrics.totalProjectionMachineMicros - rustMetricsBefore.totalProjectionMachineMicros,
        projectionMetaMicros:
          metrics.totalProjectionMetaMicros - rustMetricsBefore.totalProjectionMetaMicros,
        projectionContextMicros:
          metrics.totalProjectionContextMicros - rustMetricsBefore.totalProjectionContextMicros,
        projectionCheckpointMicros:
          metrics.totalProjectionCheckpointMicros - rustMetricsBefore.totalProjectionCheckpointMicros,
        projectionEncodeMicros:
          metrics.totalProjectionEncodeMicros - rustMetricsBefore.totalProjectionEncodeMicros,
        accountCoordinatorWallMicros:
          metrics.accountCoordinatorWallMicros - rustMetricsBefore.accountCoordinatorWallMicros,
        accountCoordinatorFoldMicros:
          metrics.accountCoordinatorFoldMicros - rustMetricsBefore.accountCoordinatorFoldMicros,
        accountWorkerWorkSumMicros:
          metrics.accountWorkerWorkSumMicros - rustMetricsBefore.accountWorkerWorkSumMicros,
        accountWorkerCriticalPathMicros:
          metrics.accountWorkerCriticalPathMicros - rustMetricsBefore.accountWorkerCriticalPathMicros,
        accountWorkerPhaseSpanMicros:
          metrics.accountWorkerPhaseSpanMicros - rustMetricsBefore.accountWorkerPhaseSpanMicros,
        accountCoordinatorDispatchJoinMicros:
          metrics.accountCoordinatorDispatchJoinMicros - rustMetricsBefore.accountCoordinatorDispatchJoinMicros,
        accountBarrierWaitSumMicros:
          metrics.accountWorkerBarrierWaitSumMicros - rustMetricsBefore.accountWorkerBarrierWaitSumMicros,
        accountTouchedShards:
          metrics.accountTouchedShards - rustMetricsBefore.accountTouchedShards,
        workerItems: metrics.workerItems.map((value, index) =>
          value - (rustMetricsBefore.workerItems[index] ?? 0)),
        entityWorkerItems: metrics.entityWorkerItems.map((value, index) =>
          value - (rustMetricsBefore.entityWorkerItems[index] ?? 0)),
        entityWorkerNanos: metrics.entityWorkerNanos.map((value, index) =>
          value - (rustMetricsBefore.entityWorkerNanos[index] ?? 0)),
        storageMicros: metrics.totalStorageMicros - rustMetricsBefore.totalStorageMicros,
        publicationMicros: metrics.totalPublicationMicros - rustMetricsBefore.totalPublicationMicros,
        outboxRows: metrics.outboxRowsPending,
      })}`);
    }, 250) : null;
    economicTelemetry?.unref();
    // One cadence tick is exactly one swap + one payment per sovereign user.
    // Nothing waits for Hub progress, Runtime commit, or an earlier Account ACK.
    const submitted = await submitPreparedParallelSameLoad({
      hubIdentity,
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
    if (rustH1 && rustMetricsBefore) {
      const expectedMatchedTrades = args.lanes * args.rounds;
      const rustSettlement = await waitForRustMixedSettlement({
        rust: rustH1,
        lanes: users,
        expectedPayments: submittedPayments,
        expectedMatchedSwaps: expectedMatchedTrades,
        economicStartedAt: startedAt,
        metricsBefore: rustMetricsBefore,
      });
      if (economicTelemetry) clearInterval(economicTelemetry);
      const finalElapsedMs = rustSettlement.fullySettledElapsedMs;
      const paymentReport = rustTpsAuthority ? decodeLoadPaymentReport({
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
        offeredPaymentRate: users.length * 1_000 / args.cadenceMs,
        submittedPayments,
        deliveredPayments: submittedPayments,
        enqueueAckElapsedMs: submitted.enqueueAckElapsedMs,
        sourceDispatchFinishedElapsedMs: submitted.sourceDispatchFinishedElapsedMs,
        sourceAllAckedElapsedMs: submitted.sourceAllAckedElapsedMs,
        commandObservedElapsedMs: submitted.sourceAllAckedElapsedMs,
        deliveredElapsedMs: finalElapsedMs,
        deliveredTps: submittedPayments * 1_000 / finalElapsedMs,
        hubCompletedPaymentsBefore: hubCountersBefore.completedPayments,
        hubCompletedPaymentsAfter: rustSettlement.metrics.completedPayments,
        hubAcceptedPaymentsBefore: hubCountersBefore.acceptedPayments,
        hubAcceptedPaymentsAfter: rustSettlement.metrics.acceptedPayments,
        // The payment report's single-sample boundary cannot express a
        // separate native ingress instant without inventing an intermediate
        // completion count. Use the conservative fully-drained instant here;
        // the exact native timestamps remain in hlt-rust-h1-live.json.
        hubIngressElapsedMs: finalElapsedMs,
        settlementSamples: [{
          elapsedMs: finalElapsedMs,
          runtimeHeight: rustSettlement.metrics.height,
          acceptedPayments: submittedPayments,
          completedPayments: submittedPayments,
          paybookOpen: 0,
        }],
        roundSubmissionLagMs: submitted.roundSubmissionLagMs,
        walBytesBefore,
        walBytesAfter: directoryBytes(walPath),
        hubDurableBefore,
        hubDurableAfter: {
          height: rustSettlement.metrics.height,
          canonicalStateHash: rustSettlement.metrics.postStateHash,
        },
        environment: collectHltEnvironmentManifest(),
      }) : null;
      if (paymentReport !== null) {
        persistReport(join(args.workDir, 'hlt-payment-load-report.json'), paymentReport, decodeLoadPaymentReport);
      }
      const [, laneIo, lanePaymentLedgers] = await Promise.all([
        assertHltHubProcessIsolation(args, [hubLabel], [hubLabel]),
        assertLaneHostSocketCounterCoverage(users),
        readLaneHostPaymentOperationLedgers(users),
      ]);
      const paymentOperationLedger = assertCompleteUserPaymentLedger(
        lanePaymentLedgers,
        submittedPayments,
        economicStartedAtUnixMs,
      );
      if (paymentOperationLedger['account-apply-done']?.['uniqueHashlocks'] !== submittedPayments) {
        throw new Error('HLT_MIXED_PAYMENT_LEDGER_DELIVERED_MISMATCH');
      }
      const expectedOfferIds = new Set(prepared.traderPlans.flatMap(plan => plan.offers.map(tx => {
        if (tx.type !== 'placeSwapOffer') throw new Error('HLT_MIXED_SWAP_PLAN_TX_INVALID');
        return tx.data.offerId;
      })));
      if (expectedOfferIds.size !== expectedSubmittedOffers) {
        throw new Error(`HLT_MIXED_SWAP_PLAN_ID_CARDINALITY:${expectedOfferIds.size}:${expectedSubmittedOffers}`);
      }
      const swapProposalLedger = assertCompleteUserSwapProposalLedger(
        lanePaymentLedgers,
        expectedOfferIds,
      );
      if (
        rustMetricsBefore.openSwapOfferIdsTruncated ||
        rustSettlement.metrics.openSwapOfferIdsTruncated
      ) throw new Error('HLT_MIXED_OPEN_SWAP_IDS_TRUNCATED');
      const initialOpenIds = new Set(rustMetricsBefore.openSwapOfferIds);
      const finalOpenIds = new Set(rustSettlement.metrics.openSwapOfferIds);
      if ([...initialOpenIds].some(offerId => !finalOpenIds.has(offerId))) {
        throw new Error('HLT_MIXED_BASELINE_ORDER_MUTATED');
      }
      const restingOfferIds = [...finalOpenIds].filter(offerId => expectedOfferIds.has(offerId));
      if (finalOpenIds.size !== initialOpenIds.size + restingOfferIds.length) {
        throw new Error('HLT_MIXED_OPEN_ORDER_ID_PARTITION');
      }
      const matchedEconomicSwaps = rustSettlement.metrics.matchedSwaps - rustMetricsBefore.matchedSwaps;
      const rejectedAtOrderbook =
        rustSettlement.metrics.zeroFillSwapCancels - rustMetricsBefore.zeroFillSwapCancels;
      const acceptedTerminal = matchedEconomicSwaps * 2 + rejectedAtOrderbook + restingOfferIds.length;
      if (swapProposalLedger.accepted !== acceptedTerminal) {
        throw new Error(`HLT_MIXED_ACCEPTED_SWAP_PARTITION:${safeStringify({
          acceptedAtAccount: swapProposalLedger.accepted,
          matchedOffers: matchedEconomicSwaps * 2,
          rejectedAtOrderbook,
          resting: restingOfferIds.length,
        })}`);
      }
      if (expectedSubmittedOffers !== swapProposalLedger.rejectedAtAccount + acceptedTerminal) {
        throw new Error('HLT_MIXED_SUBMITTED_SWAP_PARTITION');
      }
      const rateEvidence = paymentReport === null ? {} : {
        swapOrderTps: expectedSubmittedOffers * 1_000 / finalElapsedMs,
        deliveredTps: paymentReport.deliveredTps,
        matchedTps: matchedEconomicSwaps * 1_000 / rustSettlement.matchedElapsedMs,
      };
      const live = {
        engine: 'rust',
        workload: 'mixed',
        evidence: paymentReport === null ? 'functional-parity' : 'tps-authority',
        completionAuthority: 'committed_entity_metrics_and_bilateral_runtime_quiescence',
        users: users.length,
        perUser: { payments: args.rounds, swapOrders: args.rounds },
        submittedPayments,
        deliveredPayments: submittedPayments,
        submittedSwapOrders: expectedSubmittedOffers,
        processedSwapOrders: expectedSubmittedOffers,
        matchedEconomicSwaps,
        rejectedSwapOrdersAtAccount: swapProposalLedger.rejectedAtAccount,
        rejectedSwapOrdersAtOrderbook: rejectedAtOrderbook,
        restingSwapOrders: restingOfferIds.length,
        swapProposalRejectionCodes: swapProposalLedger.rejectionCodes,
        repeatedSwapProposalObservations: swapProposalLedger.repeatedObservations,
        offeredWindowMs,
        deliveredElapsedMs: finalElapsedMs,
        matchedElapsedMs: rustSettlement.matchedElapsedMs,
        fullySettledElapsedMs: finalElapsedMs,
        walBytesBefore,
        walBytesAfter: directoryBytes(walPath),
        hubDurableBefore,
        hubDurableAfter: {
          height: rustSettlement.metrics.height,
          canonicalStateHash: rustSettlement.metrics.postStateHash,
        },
        workers: requireRustH1().ready.workers,
        metricsBefore: rustMetricsBefore,
        metrics: rustSettlement.metrics,
        economicPhaseMetrics: rustSettlement.economicPhaseMetrics,
        paymentOperationLedger,
        laneQuiescence: rustSettlement.laneQuiescence,
        laneIo,
        ...rateEvidence,
      };
      writeFileSync(join(args.workDir, 'hlt-rust-h1-live.json'), `${safeStringify(live, 2)}\n`);
      console.log(`[load] rust-mixed verdict ${safeStringify({
        users: live.users,
        payments: live.deliveredPayments,
        swaps: live.matchedEconomicSwaps,
        rejected: live.rejectedSwapOrdersAtAccount + live.rejectedSwapOrdersAtOrderbook,
        resting: live.restingSwapOrders,
        evidence: live.evidence,
        ...rateEvidence,
      })}`);
      return;
    }
    // Both economic counters start at the same open-loop timestamp. Waiting
    // for swap drain before observing payments made payment TPS equal to the
    // slower swap gate even when every payment had already committed.
    const paymentSettlementPromise = waitForHubSettlement(
      requireHub(),
      hubIdentity.entityId,
      hubCountersBefore.completedPayments,
      hubCountersBefore.acceptedPayments,
      submittedPayments,
      startedAt,
    );
    // Pairwise-balanced orders have no measured MM dependency. The committed
    // Hub trade delta, not submitted order count, is the swap TPS authority.
    const matchedDrain = await waitForExpectedMatchedTrades({
      hub: requireHub(),
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
        hub: requireHub(),
        load: users.map(lane => ({
          runtime: requireConnectedLaneRuntime(lane),
          pairs: submitted.settlementPairs.filter(pair => pair.loadEntityId === lane.identity.entityId),
        })),
        marketMaker: requireMarketMaker(),
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
    const hubDurableAfter = decodeLoadFrame(await requireHub().adapter.read<unknown>('frame/latest'));

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
    await stopRustH1();
    if (prepared) await stopLaneRuntimes(prepared.traderRuntimes);
    hub?.adapter.disconnect();
    marketMaker?.adapter.disconnect();
  }
};

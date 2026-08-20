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
  buildLaneRoundOfferInputs,
  prepareParallelSameLoad,
  type PreparedParallelSameLoad,
} from './worker-same-lanes';
import { publishHltDashboardPerfFromWorkDir, publishHltDashboardReport } from '../../../../qa/hlt/hlt-dashboard';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  persistReport,
  readLoadBook,
  resolveWalPath,
  sendObserved,
  waitForTradeCount,
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
  readHubReceiverCredits,
  waitForHubSettlement,
  waitForRoutableReceivers,
} from './worker-payments';
import type { LaneRuntime } from '../lanes/lane-runtimes';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
      label: 'hlt-mixed-pay-credit',
    });
    await waitForRoutableReceivers(
      users,
      hubIdentity.entityId,
      users.map(lane => lane.identity.entityId.toLowerCase()),
    );

    const initialBook = await readLoadBook(hub, hubIdentity.entityId);
    if (initialBook.tradeCount !== setupBook.tradeCount) {
      throw new Error('PRODUCTION_SWAP_LOAD_SETUP_CONCURRENT_TRADES');
    }
    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', hubLabel.toLowerCase()));
    const walBytesBefore = directoryBytes(walPath);
    const hubDurableBefore = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const receiverIds = users.map(lane => lane.identity.entityId.toLowerCase());
    const expectedPayments = new Map(receiverIds.map((id, index) => [id, perReceiver[index]! / CREDIT_HEADROOM_MULTIPLE]));
    const baselines = await readHubReceiverCredits(hub, hubIdentity.entityId, new Set(receiverIds));
    const expectedSwaps = args.lanes * args.rounds * swapMatches;

    const startedAt = performance.now();
    let enqueueAckElapsedMs = 0;
    const roundSubmissionLagMs: number[] = [];
    for (let tick = 0; tick < args.rounds; tick += 1) {
      const dueAt = startedAt + tick * args.cadenceMs;
      const remainingMs = dueAt - performance.now();
      if (remainingMs > 0) await sleep(remainingMs);
      roundSubmissionLagMs.push(Math.max(0, Math.ceil(performance.now() - dueAt)));
      const offerOffset = tick * swapMatches;
      const swapInputs = [
        ...prepared.makerRuntimes.map((lane, index) => ({
          lane,
          inputs: buildLaneRoundOfferInputs(
            [prepared.makerIdentities[index]!],
            [prepared.makerPlans[index]!],
            offerOffset,
            swapMatches,
          ),
        })),
        ...prepared.takerRuntimes.map((lane, index) => ({
          lane,
          inputs: buildLaneRoundOfferInputs(
            [prepared.takerIdentities[index]!],
            [prepared.takerPlans[index]!],
            offerOffset,
            swapMatches,
          ),
        })),
      ];
      const paymentInputs = users.map((lane, senderIndex) => {
        const receiver = users[paymentReceiverIndexSamePopulation(senderIndex, tick, users.length)]!;
        return {
          lane,
          input: buildRoundPayment(
            lane.identity,
            hubIdentity.entityId,
            receiver.identity,
            senderIndex,
            tick,
            amountRange,
          ),
        };
      });
      const observed = await Promise.all([
        ...swapInputs.map(({ lane, inputs }) => sendObserved(
          lane.runtime,
          `hlt-mixed-swap-${tick + 1}-${lane.laneKey}`,
          { runtimeTxs: [], entityInputs: inputs },
        )),
        ...paymentInputs.map(({ lane, input }) => sendObserved(
          lane.runtime,
          `hlt-mixed-pay-${tick + 1}-${lane.laneKey}`,
          { runtimeTxs: [], entityInputs: [input] },
        )),
      ]);
      enqueueAckElapsedMs += Math.max(...observed.map(entry => entry.enqueueAckElapsedMs));
    }

    const submittedPayments = users.length * args.rounds;
    const [finalBook] = await Promise.all([
      waitForTradeCount(hub, hubIdentity.entityId, initialBook.tradeCount + expectedSwaps),
      waitForHubSettlement(hub, hubIdentity.entityId, receiverIds, baselines, expectedPayments),
    ]);
    const matchedElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const settlementEvidence = await waitForFullySettledEvidence({
      hub,
      load: users.map(lane => ({
        runtime: lane.runtime,
        pairs: [
          ...prepared.makerIdentities.map((identity, index) => ({
            hubEntityId: hubIdentity.entityId,
            loadEntityId: identity.entityId,
            offerIds: prepared.makerPlans[index]!.offers.map(tx => {
              if (tx.type !== 'placeSwapOffer') throw new Error('HLT_MIXED_OFFER_TYPE_INVALID');
              return tx.data.offerId;
            }),
          })).filter(pair => pair.loadEntityId === lane.identity.entityId),
          ...prepared.takerIdentities.map((identity, index) => ({
            hubEntityId: hubIdentity.entityId,
            loadEntityId: identity.entityId,
            offerIds: prepared.takerPlans[index]!.offers.map(tx => {
              if (tx.type !== 'placeSwapOffer') throw new Error('HLT_MIXED_OFFER_TYPE_INVALID');
              return tx.data.offerId;
            }),
          })).filter(pair => pair.loadEntityId === lane.identity.entityId),
        ],
      })),
      marketMaker,
      hubBookEntityId: hubIdentity.entityId,
      pairs: [
        ...prepared.makerIdentities.map((identity, index) => ({
          hubEntityId: hubIdentity.entityId,
          loadEntityId: identity.entityId,
          offerIds: prepared.makerPlans[index]!.offers.map(tx => {
            if (tx.type !== 'placeSwapOffer') throw new Error('HLT_MIXED_OFFER_TYPE_INVALID');
            return tx.data.offerId;
          }),
        })),
        ...prepared.takerIdentities.map((identity, index) => ({
          hubEntityId: hubIdentity.entityId,
          loadEntityId: identity.entityId,
          offerIds: prepared.takerPlans[index]!.offers.map(tx => {
            if (tx.type !== 'placeSwapOffer') throw new Error('HLT_MIXED_OFFER_TYPE_INVALID');
            return tx.data.offerId;
          }),
        })),
      ],
      tradeCountBefore: initialBook.tradeCount,
      expectedSwaps,
      matchedElapsedMs,
      startedAt,
    });
    const rates = assertProductionSwapFullySettled(settlementEvidence);
    const deliveredElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const hubDurableAfter = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));

    const paymentReport = decodeLoadPaymentReport({
      schema: 'xln-hlt-payment-load-v1',
      mode: 'payments',
      completionAuthority: 'committed_receiver_balances_and_bilateral_quiescence',
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
      enqueueAckElapsedMs,
      commandObservedElapsedMs: enqueueAckElapsedMs,
      deliveredElapsedMs,
      deliveredTps: submittedPayments * 1_000 / deliveredElapsedMs,
      roundSubmissionLagMs,
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
      schedule: 'mixed_population_two_matches_per_lane_round',
      configuredUsers: users.length,
      configuredRounds: args.rounds,
      cadenceMs: args.cadenceMs,
      offeredOrderRate: plan.offeredSwapRatePerSecond * 2,
      offeredEconomicSwapRate: plan.offeredSwapRatePerSecond,
      loadMakerAccountCount: args.lanes,
      loadTakerAccountCount: args.lanes,
      loadParticipantAccountCount: users.length,
      maxOrdersPerAccountFrame: swapMatches,
      runtimeInputBatches: args.rounds,
      roundSubmissionLagMs,
      completionAuthority: 'committed_trade_count_and_bilateral_runtime_quiescence',
      matchedEconomicSwaps: finalBook.tradeCount - initialBook.tradeCount,
      fullySettledEconomicSwaps: settlementEvidence.expectedSwaps,
      enqueueAckElapsedMs,
      commandObservedElapsedMs: enqueueAckElapsedMs,
      matchedElapsedMs,
      fullySettledElapsedMs: settlementEvidence.fullySettledElapsedMs,
      matchedTps: rates.matchedTps,
      fullySettledTps: rates.fullySettledTps,
      tradeCountBefore: initialBook.tradeCount,
      tradeCountAfter: finalBook.tradeCount,
      submittedEconomicSwaps: expectedSwaps,
      uncompletedEconomicSwapsAfterRun: 0,
      driverRssBefore: 0,
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

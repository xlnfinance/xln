/** Same-j production workload and durable economic completion report. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../../../protocol/serialization';
import {
  decodeEntitySummaries,
  decodeHubMinTradeSize,
  decodeLoadBurstReport,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
  type LoadFrame,
  type LoadIdentity,
} from '../boundary/worker-boundary';
import { type LoadBookSnapshot } from '../boundary/worker-book-boundary';
import {
  assertProductionSwapFullySettled,
} from '../settlement';
import { waitForFullySettledEvidence, type SettlementAccountPair } from '../settlement-reader';
import {
  buildSameLoadOffers,
  LOAD_QUOTE_TOKEN_ID,
  quoteCreditCeiling,
} from './worker-same-plan';
import {
  prepareParallelSameLoad,
  submitPreparedParallelSameLoad,
  type PreparedParallelSameLoad,
} from './worker-same-lanes';
import {
  connectRuntime,
  directoryBytes,
  entryByLabel,
  findIdentity,
  persistReport,
  readLoadBook,
  resolveWalPath,
  sendObserved,
  waitForCredit,
  waitForTradeCount,
  type ConnectedRuntime,
  type WorkerArgs,
} from '../worker-runtime';

const MINIMUM_CREDIT_AMOUNT = 1_000_000n * 10n ** 6n;
const submitVisibleDepthBatches = async (options: {
  hub: ConnectedRuntime;
  load: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  loadIdentity: LoadIdentity;
  initialBook: LoadBookSnapshot;
  initialFrame: LoadFrame;
  minimumTradeSize: bigint;
  swaps: number;
}): Promise<{
  finalBook: LoadBookSnapshot;
  runtimeInputBatches: number;
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  settlementPairs: readonly SettlementAccountPair[];
}> => {
  let book = options.initialBook;
  let submitted = 0;
  let batches = 0;
  let enqueueAckElapsedMs = 0;
  let commandObservedElapsedMs = 0;
  const createdOfferIds: string[] = [];
  while (submitted < options.swaps) {
    const count = Math.min(options.swaps - submitted, book.executableAskPriceTicks.length);
    if (count < 1) throw new Error('PRODUCTION_SWAP_LOAD_MM_DEPTH_EMPTY');
    const offers = buildSameLoadOffers(
      options.hubIdentity.entityId,
      `prod-load-same-${options.initialFrame.height}-${book.tradeCount}`,
      book.executableAskPriceTicks.slice(0, count),
      options.minimumTradeSize,
    );
    const observed = await sendObserved(options.load, `prod-load-batch-${options.initialFrame.height}-${batches + 1}`, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: options.loadIdentity.entityId,
        signerId: options.loadIdentity.signerId,
        entityTxs: offers,
      }],
    });
    createdOfferIds.push(...offers.map(tx => {
      if (tx.type !== 'placeSwapOffer') throw new Error('PRODUCTION_SWAP_LOAD_SETTLEMENT_OFFER_TYPE_INVALID');
      return tx.data.offerId;
    }));
    enqueueAckElapsedMs += observed.enqueueAckElapsedMs;
    commandObservedElapsedMs += observed.commandObservedElapsedMs;
    book = await waitForTradeCount(options.hub, options.hubIdentity.entityId, book.tradeCount + count);
    submitted += count;
    batches += 1;
  }
  return {
    finalBook: book, runtimeInputBatches: batches, enqueueAckElapsedMs, commandObservedElapsedMs,
    settlementPairs: [{
      hubEntityId: options.hubIdentity.entityId,
      loadEntityId: options.loadIdentity.entityId,
      offerIds: createdOfferIds,
    }],
  };
};

export const runSameProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const hub = await connectRuntime(entryByLabel(entries, 'H1'));
  const load = await connectRuntime(entryByLabel(entries, 'Custody'), `ws://127.0.0.1:${args.portBase + 8}/rpc`);
  const marketMaker = await connectRuntime(entryByLabel(entries, 'MM'));
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
    let preparedParallel: PreparedParallelSameLoad | null = null;
    let loadIdentity: LoadIdentity | null = null;
    if (args.lanes > 1) {
      preparedParallel = await prepareParallelSameLoad({
        workDir: args.workDir,
        hub,
        load,
        hubIdentity,
        initialBook: setupBook,
        minimumTradeSize,
        swaps: args.swaps,
        lanes: args.lanes,
      });
    } else {
      loadIdentity = await findIdentity(
        load,
        entity => entity.runtimeId === load.adapter.runtimeId && entity.signerId !== undefined && entity.label === 'Custody',
        'PRODUCTION_SWAP_LOAD_CUSTODY_IDENTITY_NOT_UNIQUE',
      );
      const setupFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
      const requiredCredit = quoteCreditCeiling(setupBook.executableAskPriceTicks, minimumTradeSize, args.swaps);
      const creditAmount = requiredCredit > MINIMUM_CREDIT_AMOUNT ? requiredCredit : MINIMUM_CREDIT_AMOUNT;
      await sendObserved(hub, `prod-load-credit-${setupFrame.height}-${setupBook.tradeCount}`, {
        runtimeTxs: [],
        entityInputs: [{
          entityId: hubIdentity.entityId,
          signerId: hubIdentity.signerId,
          entityTxs: [{
            type: 'extendCredit',
            data: { counterpartyEntityId: loadIdentity.entityId, tokenId: LOAD_QUOTE_TOKEN_ID, amount: creditAmount },
          }],
        }],
      });
      await waitForCredit(load, loadIdentity.entityId, hubIdentity.entityId, LOAD_QUOTE_TOKEN_ID, requiredCredit);
    }
    const initialBook = await readLoadBook(hub, hubIdentity.entityId);
    if (initialBook.tradeCount !== setupBook.tradeCount) {
      throw new Error('PRODUCTION_SWAP_LOAD_SETUP_CONCURRENT_TRADES');
    }
    const initialFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const loadInitialFrame = decodeLoadFrame(await load.adapter.read<unknown>('frame/latest'));
    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', 'h1'));
    const walBytesBefore = directoryBytes(walPath);
    const driverRssBefore = process.memoryUsage().rss;
    let submitted: Awaited<ReturnType<typeof submitVisibleDepthBatches>>;
    let matchedElapsedMs: number;
    const startedAt = performance.now();
    if (args.lanes > 1) {
      if (!preparedParallel) throw new Error('PRODUCTION_SWAP_LOAD_PARALLEL_PLAN_MISSING');
      const parallel = await submitPreparedParallelSameLoad({
        hub, load, hubIdentity, initialBook, initialFrame, swaps: args.swaps, prepared: preparedParallel,
      });
      submitted = parallel;
      matchedElapsedMs = parallel.economicCompletionElapsedMs;
    } else {
      if (!loadIdentity) throw new Error('PRODUCTION_SWAP_LOAD_SINGLE_LANE_IDENTITY_MISSING');
      submitted = await submitVisibleDepthBatches({
        hub, load, hubIdentity, loadIdentity, initialBook, initialFrame, minimumTradeSize, swaps: args.swaps,
      });
      matchedElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    }
    const finalFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const loadFinalFrame = decodeLoadFrame(await load.adapter.read<unknown>('frame/latest'));
    const crossedBookAfterRun = submitted.finalBook.bestBidPriceTicks !== null &&
      submitted.finalBook.bestBidPriceTicks >= submitted.finalBook.bestAskPriceTicks;
    const settlementEvidence = await waitForFullySettledEvidence({
      hub, load, marketMaker, hubBookEntityId: hubIdentity.entityId,
      pairs: submitted.settlementPairs,
      tradeCountBefore: initialBook.tradeCount,
      expectedSwaps: args.swaps,
      matchedElapsedMs,
      startedAt,
    });
    const rates = assertProductionSwapFullySettled(settlementEvidence);
    const report = decodeLoadBurstReport({
      schema: 'xln-production-swap-load-burst-v1',
      mode: 'same',
      schedule: args.lanes === 1
        ? 'visible_depth_runtime_input_batches'
        : 'independent_maker_taker_account_pairs',
      configuredBurstSize: args.swaps,
      loadMakerAccountCount: args.lanes === 1 ? 0 : args.lanes,
      loadTakerAccountCount: args.lanes,
      loadParticipantAccountCount: args.lanes === 1 ? 1 : args.lanes * 2,
      maxOrdersPerAccountFrame: 5,
      runtimeInputBatches: submitted.runtimeInputBatches,
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
      submittedEconomicSwaps: args.swaps,
      uncompletedEconomicSwapsAfterRun: 0,
      driverRssBefore,
      driverRssAfter: process.memoryUsage().rss,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      crossedBookAfterRun,
      durableBefore: initialFrame,
      durableAfter: finalFrame,
      loadDurableBefore: loadInitialFrame,
      loadDurableAfter: loadFinalFrame,
      settlementEvidence,
    });
    persistReport(join(args.workDir, 'production-swap-load-report.json'), report);
    console.log(safeStringify(report));
  } finally {
    hub.adapter.disconnect();
    load.adapter.disconnect();
    marketMaker.adapter.disconnect();
  }
};

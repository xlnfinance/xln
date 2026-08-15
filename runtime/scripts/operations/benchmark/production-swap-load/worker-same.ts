/** Same-j production workload and durable economic completion report. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveSwapNetAuthorization } from '../../../../account/swap/swap-net-authorization';
import { getStaticSwapTokenDimensions } from '../../../../orderbook';
import { safeStringify } from '../../../../protocol/serialization';
import type { EntityTx } from '../../../../types/entity-tx';
import {
  decodeEntitySummaries,
  decodeHubMinTradeSize,
  decodeLoadBurstReport,
  decodeLoadFrame,
  decodeRuntimeManifestEntries,
  selectLocalHubIdentity,
  type LoadFrame,
  type LoadIdentity,
} from './worker-boundary';
import {
  deriveExecutableBidForAsk,
  type LoadBookSnapshot,
} from './worker-book-boundary';
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
} from './worker-runtime';

const MINIMUM_CREDIT_AMOUNT = 1_000_000n * 10n ** 6n;
const BASE_TOKEN_ID = 2;
const QUOTE_TOKEN_ID = 1;

const buildOffers = (
  hubEntityId: string,
  offerPrefix: string,
  prices: readonly bigint[],
  minimumTradeSize: bigint,
): EntityTx[] => prices.map((priceTicks, index) => {
  const { baseAmount, quoteAmount } = deriveExecutableBidForAsk(
    BASE_TOKEN_ID,
    QUOTE_TOKEN_ID,
    minimumTradeSize,
    priceTicks,
  );
  if (quoteAmount <= 0n) throw new Error('PRODUCTION_SWAP_LOAD_QUOTE_INVALID');
  return {
    type: 'placeSwapOffer',
    data: {
      counterpartyEntityId: hubEntityId,
      offerId: `${offerPrefix}-${index + 1}`,
      giveTokenId: QUOTE_TOKEN_ID,
      giveAmount: quoteAmount,
      wantTokenId: BASE_TOKEN_ID,
      wantAmount: baseAmount,
      ...getStaticSwapTokenDimensions(QUOTE_TOKEN_ID, BASE_TOKEN_ID),
      ...deriveSwapNetAuthorization(baseAmount, 1),
    },
  };
});

const quoteCreditCeiling = (
  prices: readonly bigint[],
  minimumTradeSize: bigint,
  swaps: number,
): bigint => {
  const quotes = prices.map(priceTicks =>
    deriveExecutableBidForAsk(BASE_TOKEN_ID, QUOTE_TOKEN_ID, minimumTradeSize, priceTicks).quoteAmount
  );
  const maximum = quotes.reduce((highest, quote) => quote > highest ? quote : highest, 0n);
  if (maximum <= 0n) throw new Error('PRODUCTION_SWAP_LOAD_MM_ASK_MISSING');
  return maximum * BigInt(swaps);
};

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
}> => {
  let book = options.initialBook;
  let submitted = 0;
  let batches = 0;
  let enqueueAckElapsedMs = 0;
  let commandObservedElapsedMs = 0;
  while (submitted < options.swaps) {
    const count = Math.min(options.swaps - submitted, book.executableAskPriceTicks.length);
    if (count < 1) throw new Error('PRODUCTION_SWAP_LOAD_MM_DEPTH_EMPTY');
    const offers = buildOffers(
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
    enqueueAckElapsedMs += observed.enqueueAckElapsedMs;
    commandObservedElapsedMs += observed.commandObservedElapsedMs;
    book = await waitForTradeCount(options.hub, options.hubIdentity.entityId, book.tradeCount + count);
    submitted += count;
    batches += 1;
  }
  return { finalBook: book, runtimeInputBatches: batches, enqueueAckElapsedMs, commandObservedElapsedMs };
};

export const runSameProductionSwapLoad = async (args: WorkerArgs): Promise<void> => {
  const manifestPath = join(args.workDir, 'prod-mesh', 'runtime-import-manifest.json');
  const entries = decodeRuntimeManifestEntries(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  const hub = await connectRuntime(entryByLabel(entries, 'H1'));
  const load = await connectRuntime(entryByLabel(entries, 'Custody'), `ws://127.0.0.1:${args.portBase + 8}/rpc`);
  try {
    const hubIdentity = selectLocalHubIdentity(
      decodeEntitySummaries(await hub.adapter.read<unknown>('entities')),
      hub.adapter.runtimeId,
      31_337,
    );
    const loadIdentity = await findIdentity(
      load,
      entity => entity.runtimeId === load.adapter.runtimeId && entity.signerId !== undefined && entity.label === 'Custody',
      'PRODUCTION_SWAP_LOAD_CUSTODY_IDENTITY_NOT_UNIQUE',
    );
    const initialBook = await readLoadBook(hub, hubIdentity.entityId);
    const minimumTradeSize = decodeHubMinTradeSize(
      await hub.adapter.read<unknown>(`entity/${hubIdentity.entityId}`),
    );
    const initialFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const requiredCredit = quoteCreditCeiling(initialBook.executableAskPriceTicks, minimumTradeSize, args.swaps);
    const creditAmount = requiredCredit > MINIMUM_CREDIT_AMOUNT ? requiredCredit : MINIMUM_CREDIT_AMOUNT;
    await sendObserved(hub, `prod-load-credit-${initialFrame.height}-${initialBook.tradeCount}`, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: hubIdentity.entityId,
        signerId: hubIdentity.signerId,
        entityTxs: [{
          type: 'extendCredit',
          data: { counterpartyEntityId: loadIdentity.entityId, tokenId: QUOTE_TOKEN_ID, amount: creditAmount },
        }],
      }],
    });
    await waitForCredit(load, loadIdentity.entityId, hubIdentity.entityId, QUOTE_TOKEN_ID, requiredCredit);

    const walPath = resolveWalPath(join(args.workDir, 'prod-mesh', 'h1'));
    const walBytesBefore = directoryBytes(walPath);
    const driverRssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();
    const submitted = await submitVisibleDepthBatches({
      hub, load, hubIdentity, loadIdentity, initialBook, initialFrame, minimumTradeSize, swaps: args.swaps,
    });
    const economicCompletionElapsedMs = Math.max(1, Math.ceil(performance.now() - startedAt));
    const finalFrame = decodeLoadFrame(await hub.adapter.read<unknown>('frame/latest'));
    const report = decodeLoadBurstReport({
      schema: 'xln-production-swap-load-burst-v1',
      mode: 'same',
      schedule: 'visible_depth_runtime_input_batches',
      configuredBurstSize: args.swaps,
      runtimeInputBatches: submitted.runtimeInputBatches,
      completionAuthority: 'committed_orderbook_trade_count',
      completedEconomicSwaps: submitted.finalBook.tradeCount - initialBook.tradeCount,
      enqueueAckElapsedMs: submitted.enqueueAckElapsedMs,
      commandObservedElapsedMs: submitted.commandObservedElapsedMs,
      economicCompletionElapsedMs,
      completedTps: args.swaps * 1_000 / economicCompletionElapsedMs,
      tradeCountBefore: initialBook.tradeCount,
      tradeCountAfter: submitted.finalBook.tradeCount,
      submittedEconomicSwaps: args.swaps,
      uncompletedEconomicSwapsAfterRun: 0,
      driverRssBefore,
      driverRssAfter: process.memoryUsage().rss,
      walBytesBefore,
      walBytesAfter: directoryBytes(walPath),
      durableBefore: initialFrame,
      durableAfter: finalFrame,
    });
    persistReport(join(args.workDir, 'production-swap-load-report.json'), report);
    console.log(safeStringify(report));
  } finally {
    hub.adapter.disconnect();
    load.adapter.disconnect();
  }
};

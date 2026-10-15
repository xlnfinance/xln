/**
 * Exercises the real hub orderbook: treasury CONTROL sale, a resting DIVIDEND
 * offer, investor purchase, and company buyback. The scenario asserts the
 * authoritative live offer/book state; durable lifecycle inspection belongs
 * to the Runtime frame-history store, never the Account replica.
 */

import type { RuntimeReplica } from '../../runtime/types';
import type { EntityTx } from '../../types/entity-tx';
import { deriveSwapFillPolicyFee, deriveSwapNetAuthorization } from '../../account/swap/swap-net-authorization';
import { deriveDelta } from '../../account/utils';
import { deriveTransferOffdeltaChange } from '../../protocol/transform/delta-movement';
import { DEFAULT_SPREAD_DISTRIBUTION, quoteAmountAtPriceForDecimals } from '../../swapbook';
import { converge, findReplica, processUntil } from '../harness/helpers';
import { executeCompanyAction } from './governance';
import {
  COMPANY_SHARE_PRICE_TICKS,
  CONTROL_BUYBACK_AMOUNT,
  CONTROL_IPO_AMOUNT,
  type CompanyScenarioActors,
  type CompanyShareTokens,
} from './model';

const pairId = (left: number, right: number): string =>
  `${Math.min(left, right)}/${Math.max(left, right)}`;

const offer = (data: Extract<EntityTx, { type: 'placeSwapOffer' }>['data']): EntityTx => ({
  type: 'placeSwapOffer',
  data,
});

const assertClosed = (
  env: RuntimeReplica,
  entityId: string,
  hubId: string,
  offerId: string,
): void => {
  const account = findReplica(env, entityId)[1].state.accounts.get(hubId);
  if (account?.state.swapOffers.has(offerId)) {
    const hub = findReplica(env, hubId)[1];
    const hubAccount = hub.state.accounts.get(entityId);
    const books = [...(hub.state.orderbookExt?.books ?? [])]
      .map(([key, book]) => `${key}:${book.orders.size}`)
      .join(',');
    throw new Error(
      `COMPANY_SWAP_NOT_CLOSED:${entityId}:${offerId}:books=${books}` +
      `:heights=${account?.currentHeight ?? -1}/${hubAccount?.currentHeight ?? -1}` +
      `:localPending=${account?.pendingFrame?.height ?? 'none'}/${account?.mempool.length ?? -1}` +
      `:hubPending=${hubAccount?.pendingFrame?.height ?? 'none'}/${hubAccount?.mempool.length ?? -1}` +
      `:runtimeQueues=${env.pendingOutputs?.length ?? 0}/${env.networkInbox?.length ?? 0}`,
    );
  }
};

const isClosed = (
  env: RuntimeReplica,
  entityId: string,
  hubId: string,
  offerId: string,
): boolean => findReplica(env, entityId)[1]
  .state.accounts.get(hubId)?.state.swapOffers.has(offerId) === false;

type CompanyMarketQuotes = Readonly<{
  controlSale: bigint;
  dividendSale: bigint;
  buyback: bigint;
}>;

const deriveMarketQuotes = (): CompanyMarketQuotes => {
  const quote = (amount: bigint): bigint =>
    quoteAmountAtPriceForDecimals(0, 6, amount, COMPANY_SHARE_PRICE_TICKS);
  return {
    controlSale: quote(CONTROL_IPO_AMOUNT),
    dividendSale: quote(100n),
    buyback: quote(CONTROL_BUYBACK_AMOUNT),
  };
};

const initializeBooks = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): Promise<void> => {
  await executeCompanyAction(env, actors.hub, [{
    type: 'initOrderbookExt',
    data: {
      name: 'Company Securities Hub',
      spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
      referenceTokenId: actors.currency.tokenId,
      usdQuoteAuthorityEntityId: actors.boardCompany.id,
      minTradeSize: 0n,
      supportedPairs: [
        pairId(shares.controlTokenId, actors.currency.tokenId),
        pairId(shares.dividendTokenId, actors.currency.tokenId),
      ],
    },
  }]);
};

const placeTreasuryOffers = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
  quotes: CompanyMarketQuotes,
): Promise<void> => {
  await executeCompanyAction(env, actors.boardCompany, [
    offer({
      counterpartyEntityId: actors.hub.id,
      offerId: 'ipo-control-ask',
      giveTokenId: shares.controlTokenId,
      giveTokenDecimals: 0,
      giveAmount: CONTROL_IPO_AMOUNT,
      wantTokenId: actors.currency.tokenId,
      wantTokenDecimals: 6,
      wantAmount: quotes.controlSale,
      ...deriveSwapNetAuthorization(quotes.controlSale, 1),
    }),
    offer({
      counterpartyEntityId: actors.hub.id,
      offerId: 'ipo-dividend-ask',
      giveTokenId: shares.dividendTokenId,
      giveTokenDecimals: 0,
      giveAmount: 100n,
      wantTokenId: actors.currency.tokenId,
      wantTokenDecimals: 6,
      wantAmount: quotes.dividendSale,
      ...deriveSwapNetAuthorization(quotes.dividendSale, 1),
    }),
  ]);
};

const waitForClosedPair = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  left: readonly [entityId: string, offerId: string],
  right: readonly [entityId: string, offerId: string],
  label: string,
): Promise<void> => {
  const closed = ([entityId, offerId]: typeof left): boolean =>
    isClosed(env, entityId, actors.hub.id, offerId);
  await processUntil(env, () => closed(left) && closed(right), 80, label, undefined, () =>
    assertClosed(env, left[0], actors.hub.id, left[1]));
  await converge(env, 60);
  assertClosed(env, left[0], actors.hub.id, left[1]);
  assertClosed(env, right[0], actors.hub.id, right[1]);
};

const completeInvestorPurchase = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
  quote: bigint,
): Promise<void> => {
  await executeCompanyAction(env, actors.investor, [offer({
    counterpartyEntityId: actors.hub.id,
    offerId: 'investor-control-bid',
    giveTokenId: actors.currency.tokenId,
    giveTokenDecimals: 6,
    giveAmount: quote,
    wantTokenId: shares.controlTokenId,
    wantTokenDecimals: 0,
    wantAmount: CONTROL_IPO_AMOUNT,
    ...deriveSwapNetAuthorization(CONTROL_IPO_AMOUNT, 1),
  })]);
  await waitForClosedPair(env, actors,
    [actors.boardCompany.id, 'ipo-control-ask'],
    [actors.investor.id, 'investor-control-bid'],
    'company IPO purchase');
};

const completeBuyback = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
  quote: bigint,
): Promise<void> => {
  const assertFinancials = prepareBuybackFinancialCheck(env, actors, shares, quote);
  await executeCompanyAction(env, actors.boardCompany, [offer({
    counterpartyEntityId: actors.hub.id,
    offerId: 'company-control-buyback',
    giveTokenId: actors.currency.tokenId,
    giveTokenDecimals: 6,
    giveAmount: quote,
    wantTokenId: shares.controlTokenId,
    wantTokenDecimals: 0,
    wantAmount: CONTROL_BUYBACK_AMOUNT,
    ...deriveSwapNetAuthorization(CONTROL_BUYBACK_AMOUNT, 1),
  })]);
  await executeCompanyAction(env, actors.investor, [offer({
    counterpartyEntityId: actors.hub.id,
    offerId: 'investor-control-resale',
    giveTokenId: shares.controlTokenId,
    giveTokenDecimals: 0,
    giveAmount: CONTROL_BUYBACK_AMOUNT,
    wantTokenId: actors.currency.tokenId,
    wantTokenDecimals: 6,
    wantAmount: quote,
    ...deriveSwapNetAuthorization(quote, 1),
  })]);
  await waitForClosedPair(env, actors,
    [actors.boardCompany.id, 'company-control-buyback'],
    [actors.investor.id, 'investor-control-resale'],
    'company buyback');
  assertFinancials();
};

const readBuybackDelta = (env: RuntimeReplica, entityId: string, peerId: string, tokenId: number) => {
  const account = findReplica(env, entityId)[1].state.accounts.get(peerId);
  const delta = account?.state.deltas.get(tokenId);
  if (!account || !delta) throw new Error(`COMPANY_BUYBACK_DELTA_MISSING:${entityId}:${peerId}:${tokenId}`);
  const derived = deriveDelta(delta, account.state.leftEntity === entityId);
  return { delta: derived.delta, collateral: derived.collateral, leftEntity: account.state.leftEntity };
};

const prepareBuybackFinancialCheck = (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
  quote: bigint,
): (() => void) => {
  // The company rests first; the investor is the taker. Read the same fee policy
  // as the hub, then prove economic movement in both committed Account copies.
  // Cancelled/rejected offers also disappear, so offer absence alone proves no buyback.
  const bps = findReplica(env, actors.hub.id)[1].state.hubRebalanceConfig?.swapTakerFeeBps ?? 0;
  const fee = deriveSwapFillPolicyFee(
    { giveAmount: CONTROL_BUYBACK_AMOUNT, wantAmount: quote }, CONTROL_BUYBACK_AMOUNT, quote, bps, true,
  );
  const transfers = [
    [actors.investor.id, actors.hub.id, shares.controlTokenId, CONTROL_BUYBACK_AMOUNT],
    [actors.hub.id, actors.boardCompany.id, shares.controlTokenId, CONTROL_BUYBACK_AMOUNT],
    [actors.boardCompany.id, actors.hub.id, actors.currency.tokenId, quote],
    [actors.hub.id, actors.investor.id, actors.currency.tokenId, quote - fee],
  ] as const;
  const checks = transfers.flatMap(([sender, receiver, tokenId, amount]) =>
    ([[sender, receiver], [receiver, sender]] as const).map(([entityId, peerId]) => {
      const before = readBuybackDelta(env, entityId, peerId, tokenId);
      const expected = deriveTransferOffdeltaChange(before.leftEntity === sender, amount);
      return () => {
        const after = readBuybackDelta(env, entityId, peerId, tokenId);
        if (after.collateral !== before.collateral || after.delta - before.delta !== expected) {
          throw new Error(`COMPANY_BUYBACK_FINANCIAL_MISMATCH:${entityId}:${tokenId}:` +
            `before=${before.delta}:after=${after.delta}:expectedMovement=${expected}`);
        }
      };
    }));
  return () => {
    checks.forEach(check => check());
    console.log(`COMPANY_BUYBACK_FINANCIALS_PASS:control=${CONTROL_BUYBACK_AMOUNT}:usdt=${quote}:fee=${fee}:copies=8`);
  };
};

const assertDividendOfferResting = (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): void => {
  const hub = findReplica(env, actors.hub.id)[1];
  const dividendBook = hub.state.orderbookExt?.books.get(pairId(shares.dividendTokenId, actors.currency.tokenId));
  if (!dividendBook || dividendBook.orders.size !== 1) {
    const books = [...(hub.state.orderbookExt?.books ?? [])]
      .map(([key, book]) => `${key}:${book.orders.size}`)
      .join(',');
    const companyAccount = findReplica(env, actors.boardCompany.id)[1]
      .state.accounts.get(actors.hub.id);
    throw new Error(
      `COMPANY_DIVIDEND_BOOK_NOT_RESTING:books=${books}:liveOffers=${companyAccount?.state.swapOffers.size ?? -1}`,
    );
  }
};

/** The interactive demo and automated scenario submit the same offers. */
export const openCompanyMarket = async (
  env: RuntimeReplica, actors: CompanyScenarioActors, shares: CompanyShareTokens,
): Promise<void> => {
  await initializeBooks(env, actors, shares);
  await placeTreasuryOffers(env, actors, shares, deriveMarketQuotes());
};

export const purchaseCompanyControl = async (
  env: RuntimeReplica, actors: CompanyScenarioActors, shares: CompanyShareTokens,
): Promise<void> => {
  await completeInvestorPurchase(env, actors, shares, deriveMarketQuotes().controlSale);
  assertDividendOfferResting(env, actors, shares);
};

export const runCompanyMarket = async (
  env: RuntimeReplica, actors: CompanyScenarioActors, shares: CompanyShareTokens,
): Promise<void> => {
  await openCompanyMarket(env, actors, shares);
  await purchaseCompanyControl(env, actors, shares);
};

export const runCompanyBuyback = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): Promise<void> => {
  await completeBuyback(env, actors, shares, deriveMarketQuotes().buyback);
};

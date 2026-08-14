/**
 * Exercises the real hub orderbook: treasury CONTROL sale, a resting DIVIDEND
 * offer, investor purchase, and company buyback. Closed-order history proves
 * settlement instead of inferring success from transient book projections.
 */

import type { RuntimeReplica } from '../../runtime/types';
import type { EntityTx } from '../../types/entity-tx';
import { getSwapPairPolicyByBaseQuote } from '../../account/utils';
import { deriveSwapNetAuthorization } from '../../account/swap/swap-net-authorization';
import { DEFAULT_SPREAD_DISTRIBUTION, quoteAmountAtPriceForDecimals } from '../../orderbook';
import { converge, findReplica, processUntil } from '../harness/helpers';
import { executeCompanyAction } from './governance';
import { USDT, type CompanyScenarioActors, type CompanyShareTokens } from './model';

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
  if (!account?.swapClosedOrders.has(offerId)) {
    const history = account?.swapOrderHistory.get(offerId);
    const resolves = history?.resolves
      .map(resolve => `${resolve.fillRatio}/${resolve.cancelRemainder}/${resolve.comment ?? ''}`)
      .join(',') ?? 'missing';
    const hub = findReplica(env, hubId)[1];
    const hubAccount = hub.state.accounts.get(entityId);
    const hubHistory = hubAccount?.swapOrderHistory.get(offerId);
    const hubResolves = hubHistory?.resolves
      .map(resolve => `${resolve.fillRatio}/${resolve.cancelRemainder}/${resolve.comment ?? ''}`)
      .join(',') ?? 'missing';
    const books = [...(hub.state.orderbookExt?.books ?? [])]
      .map(([key, book]) => `${key}:${book.orders.size}`)
      .join(',');
    throw new Error(
      `COMPANY_SWAP_NOT_CLOSED:${entityId}:${offerId}:resolves=${resolves}:books=${books}` +
      `:hubResolves=${hubResolves}:heights=${account?.currentHeight ?? -1}/${hubAccount?.currentHeight ?? -1}` +
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
  .state.accounts.get(hubId)?.swapClosedOrders.has(offerId) === true;

type CompanyMarketQuotes = Readonly<{
  controlSale: bigint;
  dividendSale: bigint;
  buyback: bigint;
}>;

const deriveMarketQuotes = (shares: CompanyShareTokens): CompanyMarketQuotes => {
  const quote = (tokenId: number, amount: bigint): bigint => {
    const price = getSwapPairPolicyByBaseQuote(tokenId, USDT).mmMidPriceTicks;
    return quoteAmountAtPriceForDecimals(0, 6, amount, price);
  };
  return {
    controlSale: quote(shares.controlTokenId, 40n),
    dividendSale: quote(shares.dividendTokenId, 100n),
    buyback: quote(shares.controlTokenId, 10n),
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
      referenceTokenId: USDT,
      usdQuoteAuthorityEntityId: actors.boardCompany.id,
      minTradeSize: 0n,
      supportedPairs: [
        pairId(shares.controlTokenId, USDT),
        pairId(shares.dividendTokenId, USDT),
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
      giveAmount: 40n,
      wantTokenId: USDT,
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
      wantTokenId: USDT,
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
    giveTokenId: USDT,
    giveTokenDecimals: 6,
    giveAmount: quote,
    wantTokenId: shares.controlTokenId,
    wantTokenDecimals: 0,
    wantAmount: 40n,
    ...deriveSwapNetAuthorization(40n, 1),
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
  await executeCompanyAction(env, actors.boardCompany, [offer({
    counterpartyEntityId: actors.hub.id,
    offerId: 'company-control-buyback',
    giveTokenId: USDT,
    giveTokenDecimals: 6,
    giveAmount: quote,
    wantTokenId: shares.controlTokenId,
    wantTokenDecimals: 0,
    wantAmount: 10n,
    ...deriveSwapNetAuthorization(10n, 1),
  })]);
  await executeCompanyAction(env, actors.investor, [offer({
    counterpartyEntityId: actors.hub.id,
    offerId: 'investor-control-resale',
    giveTokenId: shares.controlTokenId,
    giveTokenDecimals: 0,
    giveAmount: 10n,
    wantTokenId: USDT,
    wantTokenDecimals: 6,
    wantAmount: quote,
    ...deriveSwapNetAuthorization(quote, 1),
  })]);
  await waitForClosedPair(env, actors,
    [actors.boardCompany.id, 'company-control-buyback'],
    [actors.investor.id, 'investor-control-resale'],
    'company buyback');
};

const assertDividendOfferResting = (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): void => {
  const hub = findReplica(env, actors.hub.id)[1];
  const dividendBook = hub.state.orderbookExt?.books.get(pairId(shares.dividendTokenId, USDT));
  if (!dividendBook || dividendBook.orders.size !== 1) {
    const books = [...(hub.state.orderbookExt?.books ?? [])]
      .map(([key, book]) => `${key}:${book.orders.size}`)
      .join(',');
    const companyAccount = findReplica(env, actors.boardCompany.id)[1]
      .state.accounts.get(actors.hub.id);
    const active = [...(companyAccount?.swapOrderHistory.keys() ?? [])].join(',');
    const closed = [...(companyAccount?.swapClosedOrders.keys() ?? [])].join(',');
    const dividendHistory = companyAccount?.swapClosedOrders.get('ipo-dividend-ask');
    const outcomes = dividendHistory?.resolves
      .map(resolve => `${resolve.fillRatio}/${resolve.cancelRemainder}/${resolve.comment ?? ''}`)
      .join(',') ?? 'missing';
    throw new Error(
      `COMPANY_DIVIDEND_BOOK_NOT_RESTING:books=${books}:active=${active}:closed=${closed}:outcomes=${outcomes}`,
    );
  }
};

export const runCompanyMarket = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  shares: CompanyShareTokens,
): Promise<void> => {
  const quotes = deriveMarketQuotes(shares);
  await initializeBooks(env, actors, shares);
  await placeTreasuryOffers(env, actors, shares, quotes);
  await completeInvestorPurchase(env, actors, shares, quotes.controlSale);
  await completeBuyback(env, actors, shares, quotes.buyback);
  assertDividendOfferResting(env, actors, shares);
};

/** Exact, one-shot Entity snapshot for the resident Rust E+A kernel. */
import { LIMITS } from '../../config/constants';
import { computeEntityConsensusSectionDigestsCold } from '../../entity/consensus/state-root';
import type { EntityState } from '../../entity/types';
import { computeBookCommitmentHash } from '../../orderbook/commitment';
import type { BookPricePage, BookPricePageTree } from '../../orderbook/pages/page';
import type { AccountReplica, SwapOffer } from '../../types/account';
import type { RscoreWireValue } from '../client';
import { hexToWireBytes } from '../shadow-wire';

const OWNED_FIELDS = new Set([
  'accounts',
  'entityId',
  'height',
  'timestamp',
  'lastFinalizedJHeight',
  'htlcRoutes',
  'htlcFeesEarned',
  'lockBook',
  'orderbookExt',
]);

const bytes32 = (value: string, code: string): Uint8Array =>
  hexToWireBytes(value, 32, code);

const optionalBytes32 = (value: string | undefined, code: string): Uint8Array | null =>
  value === undefined ? null : bytes32(value, code);

const pageWire = (
  key: Readonly<{ priceTicks: bigint; pageSequence: number }>,
  page: BookPricePage,
): RscoreWireValue[] => [
  key.priceTicks.toString(),
  key.pageSequence,
  page.headSlot,
  page.nextSlot,
  page.liveCount,
  page.totalQtyLots.toString(),
  page.slots.map(entry => entry === null ? null : [
    entry.orderId,
    bytes32(entry.ownerId, 'RSCORE_ENTITY_BOOK_OWNER'),
    entry.qtyLots.toString(),
    entry.seq,
  ]),
];

const pageTreeWire = (tree: BookPricePageTree): RscoreWireValue[] =>
  [...tree.entries()].map(([key, page]) => pageWire(key, page));

const bookWire = (book: EntityState['orderbookExt'] extends infer Ext
  ? Ext extends { books: Map<string, infer Book> } ? Book : never
  : never): RscoreWireValue[] => [
  book.params.bucketWidthTicks.toString(),
  book.params.stpPolicy,
  book.params.maxOrders,
  book.nextSeq,
  book.tradeCount,
  book.tradeQtySum.toString(),
  book.lastTradePriceTicks.toString(),
  book.lastAcceptedUsdAskPriceTicks.toString(),
  book.eventHash.toString(),
  pageTreeWire(book.bidPages),
  pageTreeWire(book.askPages),
  bytes32(book.bidPages.rootHash(), 'RSCORE_ENTITY_BID_ROOT'),
  bytes32(book.askPages.rootHash(), 'RSCORE_ENTITY_ASK_ROOT'),
  hexToWireBytes(computeBookCommitmentHash(book), 16, 'RSCORE_ENTITY_BOOK_COMMITMENT'),
];

const offerResolving = (account: AccountReplica, offerId: string): boolean => {
  const isResolve = (tx: AccountReplica['mempool'][number]): boolean =>
    tx.type === 'swap_resolve' && tx.data.offerId === offerId;
  return account.mempool.some(isResolve) || (account.pendingFrame?.accountTxs.some(isResolve) ?? false);
};

const offerWire = (
  accountId: string,
  account: AccountReplica,
  offer: SwapOffer,
): RscoreWireValue[] => {
  if (offer.crossJurisdiction !== undefined) {
    throw new Error(`RSCORE_ENTITY_CROSS_J_OFFER_UNSUPPORTED:${accountId}:${offer.offerId}`);
  }
  return [
    bytes32(accountId, 'RSCORE_ENTITY_OFFER_ACCOUNT'),
    offer.offerId,
    bytes32(account.state.leftEntity, 'RSCORE_ENTITY_OFFER_LEFT'),
    bytes32(account.state.rightEntity, 'RSCORE_ENTITY_OFFER_RIGHT'),
    offer.giveTokenId,
    offer.giveTokenDecimals,
    offer.giveAmount.toString(),
    offer.wantTokenId,
    offer.wantTokenDecimals,
    offer.wantAmount.toString(),
    offer.maxFee.toString(),
    offer.minNetReceive.toString(),
    offer.priceTicks.toString(),
    offer.timeInForce ?? null,
    offer.makerIsLeft,
    offer.createdHeight,
    offer.quantizedGive.toString(),
    offer.quantizedWant.toString(),
  ];
};

const orderbookWire = (state: EntityState): RscoreWireValue[] | null => {
  const ext = state.orderbookExt;
  if (ext === undefined) return null;
  const offers: RscoreWireValue[][] = [];
  const resolving: RscoreWireValue[][] = [];
  for (const [accountId, account] of state.accounts) {
    for (const offer of account.state.swapOffers.values()) {
      offers.push(offerWire(accountId, account, offer));
      if (offerResolving(account, offer.offerId)) {
        resolving.push([
          bytes32(accountId, 'RSCORE_ENTITY_RESOLVING_ACCOUNT'),
          offer.offerId,
        ]);
      }
    }
  }
  offers.sort((left, right) => {
    const a = `${Buffer.from(left[0] as Uint8Array).toString('hex')}:${String(left[1])}`;
    const b = `${Buffer.from(right[0] as Uint8Array).toString('hex')}:${String(right[1])}`;
    return a.localeCompare(b);
  });
  resolving.sort((left, right) => {
    const a = `${Buffer.from(left[0] as Uint8Array).toString('hex')}:${String(left[1])}`;
    const b = `${Buffer.from(right[0] as Uint8Array).toString('hex')}:${String(right[1])}`;
    return a.localeCompare(b);
  });
  const pairs = [...ext.orderPairs.entries()].map(([orderId, pairIds]) => {
    if (pairIds.length !== 1) {
      throw new Error(`RSCORE_ENTITY_ORDER_PAIR_NOT_SAME_J:${orderId}:${pairIds.length}`);
    }
    const pairId = pairIds[0];
    if (pairId === undefined) throw new Error(`RSCORE_ENTITY_ORDER_PAIR_MISSING:${orderId}`);
    return [orderId, pairId] satisfies RscoreWireValue[];
  }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return [
    [...ext.books.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pairId, book]) => [pairId, bookWire(book)]),
    [...ext.pairDimensions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pairId, dimensions]) => [
        pairId,
        dimensions.baseTokenDecimals,
        dimensions.quoteTokenDecimals,
      ]),
    offers,
    resolving,
    pairs,
    LIMITS.MAX_ORDERBOOK_ORDERS_PER_PAIR,
  ];
};

const metadataWire = (state: EntityState): RscoreWireValue[] | null => {
  const ext = state.orderbookExt;
  if (ext === undefined) return null;
  const profile = ext.hubProfile;
  return [[
    bytes32(profile.entityId, 'RSCORE_ENTITY_HUB_PROFILE'),
    profile.name,
    [
      profile.spreadDistribution.makerBps,
      profile.spreadDistribution.takerBps,
      profile.spreadDistribution.hubBps,
      profile.spreadDistribution.makerReferrerBps,
      profile.spreadDistribution.takerReferrerBps,
    ],
    profile.referenceTokenId,
    bytes32(profile.usdQuoteAuthorityEntityId, 'RSCORE_ENTITY_USD_AUTHORITY'),
    profile.minTradeSize.toString(),
    [...profile.supportedPairs],
  ], [...ext.referrals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, referral]) => [
      bytes32(key, 'RSCORE_ENTITY_REFERRAL_KEY'),
      bytes32(referral.entityId, 'RSCORE_ENTITY_REFERRAL_ENTITY'),
      referral.referrerId === null
        ? null
        : bytes32(referral.referrerId, 'RSCORE_ENTITY_REFERRER'),
      referral.timestamp,
    ])];
};

const routesWire = (state: EntityState): RscoreWireValue[] =>
  [...state.htlcRoutes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, route]) => {
      if (key !== route.hashlock) throw new Error(`RSCORE_ENTITY_HTLC_ROUTE_KEY:${key}`);
      if (route.secretAckedAt !== undefined || route.crossJurisdictionRelay !== undefined) {
        throw new Error(`RSCORE_ENTITY_HTLC_ROUTE_OUTSIDE_PROFILE:${key}`);
      }
      return [
        bytes32(route.hashlock, 'RSCORE_ENTITY_ROUTE_HASHLOCK'),
        route.tokenId ?? null,
        route.amount?.toString() ?? null,
        route.startedAtMs ?? null,
        route.originated === true,
        optionalBytes32(route.inboundEntity, 'RSCORE_ENTITY_ROUTE_INBOUND'),
        optionalBytes32(route.inboundLockId, 'RSCORE_ENTITY_ROUTE_INBOUND_LOCK'),
        optionalBytes32(route.outboundEntity, 'RSCORE_ENTITY_ROUTE_OUTBOUND'),
        optionalBytes32(route.outboundLockId, 'RSCORE_ENTITY_ROUTE_OUTBOUND_LOCK'),
        route.inboundSettled === true,
        route.outboundSettled === true,
        optionalBytes32(route.secret, 'RSCORE_ENTITY_ROUTE_SECRET'),
        route.secretAckPending === true,
        route.secretAckStartedAt ?? null,
        route.secretAckDeadlineAt ?? null,
        route.pendingFee?.toString() ?? null,
        route.createdTimestamp,
      ];
    });

const locksWire = (state: EntityState): RscoreWireValue[] =>
  [...state.lockBook.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, lock]) => {
      if (key !== lock.lockId) throw new Error(`RSCORE_ENTITY_LOCK_KEY:${key}`);
      return [
        bytes32(lock.lockId, 'RSCORE_ENTITY_LOCK_ID'),
        bytes32(lock.accountId, 'RSCORE_ENTITY_LOCK_ACCOUNT'),
        lock.tokenId,
        lock.amount.toString(),
        bytes32(lock.hashlock, 'RSCORE_ENTITY_LOCK_HASHLOCK'),
        lock.timelock.toString(),
        lock.direction === 'outgoing',
        lock.createdAt.toString(),
      ];
    });

export const entityOwnedSectionDigests = (
  state: EntityState,
): readonly Readonly<{ field: string; digest: string }>[] =>
  computeEntityConsensusSectionDigestsCold(state)
    .filter(section => OWNED_FIELDS.has(section.field))
    .sort((left, right) => left.field.localeCompare(right.field));

export const entitySnapshotWire = (state: EntityState): RscoreWireValue[] => {
  const sections = entityOwnedSectionDigests(state)
    .map(section => [
      section.field,
      bytes32(section.digest, 'RSCORE_ENTITY_SECTION_DIGEST'),
    ] satisfies RscoreWireValue[]);
  return [
    bytes32(state.entityId, 'RSCORE_ENTITY_ID'),
    state.height,
    state.timestamp,
    state.lastFinalizedJHeight,
    [...state.accounts.keys()].sort().map(accountId =>
      bytes32(accountId, 'RSCORE_ENTITY_KNOWN_ACCOUNT')),
    routesWire(state),
    state.htlcFeesEarned.toString(),
    locksWire(state),
    orderbookWire(state),
    metadataWire(state),
    sections,
  ];
};

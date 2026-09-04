/** Exact, one-shot Entity snapshot for the resident Rust E+A kernel. */
import { LIMITS } from '../../config/constants';
import { computeEntityConsensusSectionDigestsCold } from '../../entity/consensus/state-root';
import type { EntityState } from '../../entity/types';
import type { CrontabTaskState, ScheduledHook } from '../../entity/scheduler/types';
import { computeBookCommitmentHash } from '../../orderbook/commitment';
import type { BookPricePage, BookPricePageTree } from '../../orderbook/pages/page';
import type { RscoreWireValue } from '../client';
import { canonicalValueWire, hexToWireBytes } from '../shadow-wire';
import { compareStableText } from '../../protocol/serialization';
import { entityCommandNoncesWire } from './command-nonce-wire';

const OWNED_FIELDS = new Set([
  'accounts',
  'entityId',
  'height',
  'timestamp',
  'lastFinalizedJHeight',
  'reserves',
  'outDebtsByToken',
  'inDebtsByToken',
  'externalWallet',
  'deferredAccountProposals',
  'settlementContinuations',
  'entityEncryptionPublicKey',
  'profile',
  'jBatchState',
  'entityProviderActionState',
  'lending',
  'crossJurisdictionSwaps',
  'crossJurisdictionAuthorizations',
  'crossJurisdictionBookAdmissions',
  'paybook',
  'orderbookExt',
  'swapTradingPairs',
  'crontabState',
  'entityCommandNonces',
  'proposals',
  'certifiedBoardState',
  'hubRebalanceConfig',
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

const orderbookWire = (state: EntityState): RscoreWireValue[] | null => {
  const ext = state.orderbookExt;
  if (ext === undefined) return null;
  return [
    [...ext.books.entries()]
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([pairId, book]) => [pairId, bookWire(book)]),
    [...ext.pairDimensions.entries()]
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([pairId, dimensions]) => [
        pairId,
        dimensions.baseTokenDecimals,
        dimensions.quoteTokenDecimals,
      ]),
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
    .sort(([left], [right]) => compareStableText(left, right))
    .map(([key, referral]) => [
      bytes32(key, 'RSCORE_ENTITY_REFERRAL_KEY'),
      bytes32(referral.entityId, 'RSCORE_ENTITY_REFERRAL_ENTITY'),
      referral.referrerId === null
        ? null
        : bytes32(referral.referrerId, 'RSCORE_ENTITY_REFERRER'),
      referral.timestamp,
    ])];
};

const paybookWire = (state: EntityState): RscoreWireValue[] => [
  [...state.paybook.entries.entries()]
    .sort(([left], [right]) => compareStableText(left, right))
    .map(([key, route]) => {
      if (key !== route.hashlock) throw new Error(`RSCORE_ENTITY_PAYBOOK_KEY:${key}`);
      if (route.secretAckedAt !== undefined || route.crossJurisdictionRelay !== undefined) {
        throw new Error(`RSCORE_ENTITY_PAYBOOK_OUTSIDE_PROFILE:${key}`);
      }
      return [
        bytes32(route.hashlock, 'RSCORE_ENTITY_PAYBOOK_HASHLOCK'),
        route.tokenId ?? null,
        route.amount?.toString() ?? null,
        route.startedAtMs ?? null,
        route.originated === true,
        optionalBytes32(route.inboundEntity, 'RSCORE_ENTITY_PAYBOOK_INBOUND'),
        optionalBytes32(route.outboundEntity, 'RSCORE_ENTITY_PAYBOOK_OUTBOUND'),
        route.inboundSettled === true,
        route.outboundSettled === true,
        optionalBytes32(route.secret, 'RSCORE_ENTITY_PAYBOOK_SECRET'),
        route.secretAckPending === true,
        route.secretAckStartedAt ?? null,
        route.secretAckDeadlineAt ?? null,
        route.pendingFee?.toString() ?? null,
        route.createdTimestamp,
        route.description ?? null,
      ];
    }),
  state.paybook.feesEarned.toString(),
];

const crossJurisdictionCollectionWire = (
  collection: Map<string, unknown> | undefined,
): RscoreWireValue[] | null => collection === undefined ? null : [...collection.entries()]
  .sort(([left], [right]) => compareStableText(left, right))
  .map(([key, value]) => [key, canonicalValueWire(value)]);

const crontabParamWire = (
  name: string,
  value: CrontabTaskState['params'][string],
): RscoreWireValue[] => {
  if (typeof value === 'string') return [name, 0, value];
  if (typeof value === 'boolean') return [name, 2, value];
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new Error(`RSCORE_ENTITY_CRONTAB_PARAM_NUMBER:${name}:${String(value)}`);
  }
  return [name, 1, String(value)];
};

const crontabTaskWire = (task: CrontabTaskState): RscoreWireValue[] => [
  task.method,
  task.intervalMs,
  task.lastRun,
  task.enabled,
  Object.entries(task.params)
    .sort(([left], [right]) => compareStableText(left, right))
    .map(([name, value]) => crontabParamWire(name, value)),
];

const hookKindWire = (hook: ScheduledHook): RscoreWireValue[] => {
  switch (hook.type) {
    // Tags 0 and 2 were the per-payment htlc_timeout / htlc_secret_ack_timeout
    // hooks; those deadlines are derived from locks and paybook entries now.
    case 'dispute_deadline': return [1, hook.data.accountId];
    case 'settlement_window': return [3];
    case 'watchdog': return [4];
    case 'hub_rebalance_kick': return [5, hook.data.reason, hook.data.counterpartyId];
    case 'board_hanko_refresh': return [
      6, hook.data.activationJHeight, hook.data.activationLogIndex, hook.data.afterCounterpartyId,
    ];
    case 'counterparty_board_hanko_refresh_deadline': return [
      7, hook.data.accountId, hook.data.activationJHeight, hook.data.activationLogIndex,
    ];
    case 'cross_j_orderbook_sweep': return [8, hook.data.reason];
  }
};

const crontabWire = (state: EntityState): RscoreWireValue[] | null => {
  const crontab = state.crontabState;
  if (crontab === undefined) return null;
  return [
    [...crontab.tasks.entries()]
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([, task]) => crontabTaskWire(task)),
    [...crontab.hooks.entries()]
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([id, hook]) => {
        if (id !== hook.id) throw new Error(`RSCORE_ENTITY_CRONTAB_HOOK_KEY:${id}:${hook.id}`);
        return [hook.id, hook.triggerAt, hook.type, hookKindWire(hook)];
      }),
  ];
};

export const entityOwnedSectionDigests = (
  state: EntityState,
): readonly Readonly<{ field: string; digest: string }>[] =>
  computeEntityConsensusSectionDigestsCold(state)
    .filter(section => OWNED_FIELDS.has(section.field))
    .sort((left, right) => compareStableText(left.field, right.field));

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
    [...state.reserves.entries()]
      .sort(([left], [right]) => left - right)
      .map(([tokenId, amount]) => [tokenId, amount.toString()]),
    [...state.accounts.keys()].sort().map(accountId =>
      bytes32(accountId, 'RSCORE_ENTITY_KNOWN_ACCOUNT')),
    paybookWire(state),
    orderbookWire(state),
    metadataWire(state),
    sections,
    crontabWire(state),
    entityCommandNoncesWire(state.entityCommandNonces),
    state.hubRebalanceConfig === undefined ? null : canonicalValueWire(state.hubRebalanceConfig),
    [
      state.profile.name,
      state.profile.isHub,
      state.profile.entityKind ?? null,
      [...(state.profile.sectors ?? [])],
      state.profile.avatar,
      state.profile.bio,
      state.profile.website,
    ],
    state.jBatchState === undefined ? null : canonicalValueWire(state.jBatchState),
    state.lending === undefined ? null : canonicalValueWire(state.lending),
    crossJurisdictionCollectionWire(state.crossJurisdictionSwaps),
    crossJurisdictionCollectionWire(state.crossJurisdictionAuthorizations),
    crossJurisdictionCollectionWire(state.crossJurisdictionBookAdmissions),
    canonicalValueWire(state.proposals),
    state.entityProviderActionState === undefined
      ? null
      : canonicalValueWire(state.entityProviderActionState),
    state.swapTradingPairs === undefined
      ? null
      : canonicalValueWire(state.swapTradingPairs),
    state.certifiedBoardState === undefined
      ? null
      : canonicalValueWire(state.certifiedBoardState),
    state.outDebtsByToken === undefined ? null : canonicalValueWire(state.outDebtsByToken),
    state.inDebtsByToken === undefined ? null : canonicalValueWire(state.inDebtsByToken),
    state.externalWallet === undefined ? null : canonicalValueWire(state.externalWallet),
    crossJurisdictionCollectionWire(state.deferredAccountProposals),
    crossJurisdictionCollectionWire(state.settlementContinuations),
    bytes32(state.entityEncryptionPublicKey, 'RSCORE_ENTITY_ENCRYPTION_PUBLIC_KEY'),
  ];
};

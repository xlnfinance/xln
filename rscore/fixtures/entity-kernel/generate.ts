/**
 * Canonical TypeScript oracle for the isolated Rust Entity-kernel slice.
 *
 * Run from the repository root:
 *   bun rscore/fixtures/entity-kernel/generate.ts
 */
import { createHash } from 'node:crypto';

import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import { encodeAccountStateValue } from '../../../core/account/commitment/state-root';
import { canonicalAccountTxForFrameHash } from '../../../core/account/consensus/frame/hash';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { deriveSwapNetAuthorization } from '../../../core/account/swap/swap-net-authorization';
import { PersistentAccountStateMap } from '../../../core/account/state/persistent-state-map';
import {
  applyCommittedAccountFrameFollowups,
  processOrderbookCancels,
  processOrderbookSwaps,
} from '../../../core/entity/tx/handlers/account';
import {
  applyCommittedHtlcLockFollowup,
  applyDirectPaymentForwardFollowups,
  applyHtlcSecretFollowups,
} from '../../../core/entity/tx/handlers/account/committed-htlc-followups';
import {
  applyCommand,
  createBook,
  createOrderbookExtState,
  computeBookCommitmentHash,
  quoteAmountAtPrice,
  replaceOrderbookPair,
  type BookState,
  type HubProfile,
} from '../../../core/orderbook';
import type { BookPricePageTree } from '../../../core/orderbook/pages/page';
import {
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
} from '../../../core/orderbook/swap-execution';
import {
  deriveForwardHtlcLockId,
  hashHtlcSecret,
} from '../../../core/protocol/htlc/utils';
import {
  HTLC_OPAQUE_CIPHERTEXT_VERSION,
  hashOpaqueHtlcCiphertext,
} from '../../../core/protocol/htlc/multi-recipient';
import { encodeBase64Bytes } from '../../../core/protocol/serialization/base64';
import { safeStringify } from '../../../core/protocol/serialization';
import type {
  AccountFrame,
  AccountOutput,
  AccountPeerInput,
  AccountReplica,
  AccountTx,
  SwapOffer,
} from '../../../core/types/account';
import type {
  EntityCandidateEffect,
  EntityInput,
  EntityState,
} from '../../../core/entity/types';
import type { EntityRuntimeContext } from '../../../core/entity/runtime-context';
import type { EntityInfraContext } from '../../../core/types/entity/infra-context';
import type { PreparedHtlcEntry } from '../../../core/types/entity/htlc-infra-context';
import { PersistentEntityAccountMap } from '../../../core/entity/state/persistent-account-map';
import {
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityAccountValueHash,
  computeEntityConsensusSectionDigestsCold,
} from '../../../core/entity/consensus/state-root';
import { createEntityFrameCandidateState } from '../../../core/entity/state-clone';

const HUB = `0x${'11'.repeat(32)}`;
const MAKER = `0x${'22'.repeat(32)}`;
const TAKER = `0x${'33'.repeat(32)}`;
const NEXT = `0x${'44'.repeat(32)}`;
const LOCK_ID = `0x${'aa'.repeat(32)}`;
const HASHLOCK = `0x${'bb'.repeat(32)}`;
const FINAL_LOCK_ID = `0x${'cc'.repeat(32)}`;
const FINAL_SECRET = `0x${'77'.repeat(32)}`;
const FINAL_HASHLOCK = hashHtlcSecret(FINAL_SECRET);
const PRICE = 25_000_000n;
const BASE = 10n ** 18n;

const profile: HubProfile = {
  entityId: HUB,
  name: 'entity-kernel-fixture',
  spreadDistribution: {
    makerBps: 0,
    takerBps: 10_000,
    hubBps: 0,
    makerReferrerBps: 0,
    takerReferrerBps: 0,
  },
  referenceTokenId: 1,
  usdQuoteAuthorityEntityId: HUB,
  minTradeSize: 0n,
  supportedPairs: ['1/2'],
};

const digest = (value: unknown): string =>
  `0x${createHash('sha256').update(encodeAccountStateValue(value)).digest('hex')}`;

const canonicalEntityEvidence = (state: EntityState) => ({
  root: computeCanonicalEntityConsensusStateHashCold(state),
  sections: computeEntityConsensusSectionDigestsCold(state),
  accountsRoot: state.accounts.rootHash(),
  accountCount: state.accounts.size,
});

const txDigest = (tx: AccountTx): string => digest(canonicalAccountTxForFrameHash(tx));

const offerAtPrice = (
  accountId: string,
  offerId: string,
  createdHeight: number,
  ask: boolean,
  units = 1n,
  priceTicks = PRICE,
): NormalizedOrderbookOffer => {
  const baseAmount = BASE * units;
  const quoteAmount = quoteAmountAtPrice(2, 1, baseAmount, priceTicks);
  const giveAmount = ask ? baseAmount : quoteAmount;
  const wantAmount = ask ? quoteAmount : baseAmount;
  return {
    offerId,
    accountId,
    makerIsLeft: false,
    fromEntity: HUB,
    toEntity: accountId,
    createdHeight,
    giveTokenId: ask ? 2 : 1,
    giveTokenDecimals: ask ? 18 : 6,
    giveAmount,
    wantTokenId: ask ? 1 : 2,
    wantTokenDecimals: ask ? 6 : 18,
    wantAmount,
    quantizedGive: giveAmount,
    quantizedWant: wantAmount,
    ...deriveSwapNetAuthorization(wantAmount, 1),
    priceTicks,
    timeInForce: 0,
    accountOutputVerified: true,
  };
};

const offer = (
  accountId: string,
  offerId: string,
  createdHeight: number,
  ask: boolean,
): NormalizedOrderbookOffer => offerAtPrice(accountId, offerId, createdHeight, ask);

const account = (remote: string, offers: readonly NormalizedOrderbookOffer[]): AccountReplica => {
  const deltas = [1, 2].map((tokenId) => {
    const delta = createDefaultDelta(tokenId);
    delta.collateral = 10n ** 30n;
    delta.leftCreditLimit = 10n ** 30n;
    delta.rightCreditLimit = 10n ** 30n;
    for (const row of offers) {
      if (row.giveTokenId !== tokenId) continue;
      delta.rightHold += row.giveAmount;
    }
    return [tokenId, delta] as const;
  });
  return {
    state: {
      leftEntity: HUB,
      rightEntity: remote,
      domain: {
        chainId: 31_337,
        depositoryAddress: '0x8888888888888888888888888888888888888888',
      },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', deltas),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.fromEntries(
        'swapOffers',
        offers.map((row) => {
          if (row.quantizedGive === undefined || row.quantizedWant === undefined) {
            throw new Error(`ENTITY_KERNEL_FIXTURE_UNQUANTIZED_OFFER:${row.offerId}`);
          }
          const stored: SwapOffer = {
            offerId: row.offerId,
            makerIsLeft: row.makerIsLeft,
            createdHeight: row.createdHeight,
            giveTokenId: row.giveTokenId,
            giveTokenDecimals: row.giveTokenDecimals,
            giveAmount: row.giveAmount,
            wantTokenId: row.wantTokenId,
            wantTokenDecimals: row.wantTokenDecimals,
            wantAmount: row.wantAmount,
            quantizedGive: row.quantizedGive,
            quantizedWant: row.quantizedWant,
            maxFee: row.maxFee,
            minNetReceive: row.minNetReceive,
            priceTicks: row.priceTicks,
            ...(row.timeInForce !== undefined ? { timeInForce: row.timeInForce } : {}),
          };
          return [row.offerId, stored] as const;
        }),
      ),
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: HUB, toEntity: remote, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const entityState = (
  accounts: ReadonlyMap<string, AccountReplica>,
  orderbookExt?: EntityState['orderbookExt'],
): EntityState => ({
  entityId: HUB,
  entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
  height: 0,
  timestamp: 2_000,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [HUB],
    shares: { [HUB]: 1n },
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.fromMap(accounts, HUB, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: {
    name: 'entity-kernel-fixture',
    isHub: true,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  hubRebalanceConfig: {
    matchingStrategy: 'amount',
    policyVersion: 1,
    routingFeePPM: 1,
    baseFee: 0n,
    swapTakerFeeBps: 1,
    rebalanceLiquidityFeeBps: 1n,
  },
  ...(orderbookExt !== undefined ? { orderbookExt } : {}),
});

const projectOffer = (row: NormalizedOrderbookOffer) => ({
  offerId: row.offerId,
  leftEntity: row.fromEntity,
  rightEntity: row.toEntity,
  giveTokenId: row.giveTokenId,
  giveTokenDecimals: row.giveTokenDecimals,
  giveAmount: row.giveAmount,
  wantTokenId: row.wantTokenId,
  wantTokenDecimals: row.wantTokenDecimals,
  wantAmount: row.wantAmount,
  maxFee: row.maxFee,
  minNetReceive: row.minNetReceive,
  priceTicks: row.priceTicks,
  timeInForce: row.timeInForce,
  makerIsLeft: row.makerIsLeft,
  createdHeight: row.createdHeight,
  quantizedGive: row.quantizedGive,
  quantizedWant: row.quantizedWant,
});

const projectBook = (book: BookState) => ({
  maxOrders: book.params.maxOrders,
  orders: new Map(Array.from(book.orders, ([key, row]) => [key, {
    orderId: row.orderId,
    ownerId: row.ownerId,
    side: row.side === 0 ? 'bid' : 'ask',
    priceTicks: row.priceTicks,
    qtyLots: row.qtyLots,
    seq: row.seq,
  }])),
  nextSeq: book.nextSeq,
  tradeCount: book.tradeCount,
  tradeQtySum: book.tradeQtySum,
  lastTradePriceTicks: book.lastTradePriceTicks,
  lastAcceptedUsdAskPriceTicks: book.lastAcceptedUsdAskPriceTicks,
  eventHash: book.eventHash,
});

const projectExactPages = (tree: BookPricePageTree) => Array.from(
  tree.entries(),
  ([key, page]) => ({
    priceTicks: key.priceTicks.toString(),
    pageSequence: key.pageSequence,
    headSlot: page.headSlot,
    nextSlot: page.nextSlot,
    liveCount: page.liveCount,
    totalQtyLots: page.totalQtyLots.toString(),
    slots: page.slots.map(entry => entry === null ? null : ({
      orderId: entry.orderId,
      ownerId: entry.ownerId,
      qtyLots: entry.qtyLots.toString(),
      seq: entry.seq,
    })),
  }),
);

const projectExactBookSnapshot = (book: BookState) => ({
  bucketWidthTicks: book.params.bucketWidthTicks.toString(),
  stpPolicy: book.params.stpPolicy,
  maxOrders: book.params.maxOrders,
  nextSeq: book.nextSeq,
  tradeCount: book.tradeCount,
  tradeQtySum: book.tradeQtySum.toString(),
  lastTradePriceTicks: book.lastTradePriceTicks.toString(),
  lastAcceptedUsdAskPriceTicks: book.lastAcceptedUsdAskPriceTicks.toString(),
  eventHash: book.eventHash.toString(),
  bidPages: projectExactPages(book.bidPages),
  askPages: projectExactPages(book.askPages),
  expectedBidPagesRoot: book.bidPages.rootHash(),
  expectedAskPagesRoot: book.askPages.rootHash(),
  expectedCommitmentHash: computeBookCommitmentHash(book),
});

let hydrationBook = createBook({ bucketWidthTicks: 10n, maxOrders: 100, stpPolicy: 1 });
for (const [orderId, ownerId, qtyLots] of [
  ['hydrate-a', MAKER, 7n],
  ['hydrate-b', TAKER, 11n],
  ['hydrate-c', NEXT, 13n],
] as const) {
  hydrationBook = applyCommand(hydrationBook, {
    kind: 0,
    ownerId,
    orderId,
    side: 0,
    tif: 0,
    postOnly: false,
    priceTicks: 123_456n,
    qtyLots,
  }).state;
}
hydrationBook = applyCommand(hydrationBook, {
  kind: 1,
  ownerId: TAKER,
  orderId: 'hydrate-b',
}).state;

const emptyPaybook = (knownAccounts: readonly string[]) => ({
  domain: 'xln.entity-kernel.paybook.v1',
  entityId: HUB,
  timestamp: 2_000,
  knownAccounts: new Set(knownAccounts),
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const maker = offer(MAKER, 'maker-ask', 1, true);
const taker = offer(TAKER, 'taker-bid', 2, false);
const ext = createOrderbookExtState(profile);
const hubState = entityState(
  new Map([
    [MAKER, account(MAKER, [maker])],
    [TAKER, account(TAKER, [taker])],
  ]),
  ext,
);
const match = processOrderbookSwaps(
  hubState,
  [maker, taker].map(markWorkingOrderbookOffer),
);
if (match.crossJurisdictionFills.length !== 0 || match.debugProjectionRejects.length !== 0) {
  throw new Error('ENTITY_KERNEL_FIXTURE_UNEXPECTED_CROSS_OR_REJECT');
}
const finalBook = match.bookUpdates.find((row) => row.pairId === '1/2')?.book;
if (!finalBook || finalBook.tradeCount !== 1) throw new Error('ENTITY_KERNEL_FIXTURE_MATCH_MISSING');
for (const update of match.bookUpdates) replaceOrderbookPair(ext, update.pairId, update.book);
const sameJFullMatchCanonicalEntity = canonicalEntityEvidence(hubState);

const grouped = new Map<string, AccountTx[]>();
for (const row of match.accountTxs) {
  const txs = grouped.get(row.accountId) ?? [];
  txs.push(row.tx);
  grouped.set(row.accountId, txs);
}
const proposalWork = Array.from(grouped)
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([accountId, txs]) => ({ accountId, txDigests: txs.map(txDigest) }));
const orderbookProjection = {
  domain: 'xln.entity-kernel.orderbook.v1',
  books: new Map([['1/2', projectBook(finalBook)]]),
  pairDimensions: new Map([['1/2', { baseTokenDecimals: 18, quoteTokenDecimals: 6 }]]),
  offers: new Map([
    [[MAKER, maker.offerId], projectOffer(maker)],
    [[TAKER, taker.offerId], projectOffer(taker)],
  ]),
  resolvingOffers: new Set([[MAKER, maker.offerId], [TAKER, taker.offerId]]),
  pairByOrder: new Map(),
  maxOrdersPerPair: 10_000,
};
const swapOutputs = [{ kind: 'swapMatched', entityId: HUB, count: 1 }];
const outboxProjection = {
  domain: 'xln.entity-kernel.ordered-outbox.v1',
  proposalWork,
  outputs: swapOutputs,
};

// HLT deliberately creates partial user-maker fills. Preserve its remainder
// path in the oracle instead of treating a full-fill fixture as sufficient.
const partialMaker = offerAtPrice(MAKER, 'partial-maker', 1, true, 2n);
const partialTaker = offer(TAKER, 'partial-taker', 2, false);
const partialExt = createOrderbookExtState(profile);
const partialState = entityState(
  new Map([
    [MAKER, account(MAKER, [partialMaker])],
    [TAKER, account(TAKER, [partialTaker])],
  ]),
  partialExt,
);
const partialMatch = processOrderbookSwaps(
  partialState,
  [partialMaker, partialTaker].map(markWorkingOrderbookOffer),
);
const partialBook = partialMatch.bookUpdates.find((row) => row.pairId === '1/2')?.book;
if (!partialBook || partialBook.tradeCount !== 1 || partialBook.orders.size !== 1) {
  throw new Error('ENTITY_KERNEL_FIXTURE_PARTIAL_MATCH_MISSING');
}
const partialGrouped = new Map<string, AccountTx[]>();
for (const row of partialMatch.accountTxs) {
  const txs = partialGrouped.get(row.accountId) ?? [];
  txs.push(row.tx);
  partialGrouped.set(row.accountId, txs);
}
const partialProposalWork = Array.from(partialGrouped)
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([accountId, txs]) => ({ accountId, txDigests: txs.map(txDigest) }));
const partialOrderbookProjection = {
  domain: 'xln.entity-kernel.orderbook.v1',
  books: new Map([['1/2', projectBook(partialBook)]]),
  pairDimensions: new Map([['1/2', { baseTokenDecimals: 18, quoteTokenDecimals: 6 }]]),
  offers: new Map([
    [[MAKER, partialMaker.offerId], projectOffer(partialMaker)],
    [[TAKER, partialTaker.offerId], projectOffer(partialTaker)],
  ]),
  resolvingOffers: new Set([
    [MAKER, partialMaker.offerId],
    [TAKER, partialTaker.offerId],
  ]),
  pairByOrder: new Map([[`${MAKER}:${partialMaker.offerId}`, '1/2']]),
  maxOrdersPerPair: 10_000,
};
const partialOutboxProjection = {
  domain: 'xln.entity-kernel.ordered-outbox.v1',
  proposalWork: partialProposalWork,
  outputs: [{ kind: 'swapMatched', entityId: HUB, count: 1 }],
};

const sweepLowPrice = 24_999_000n;
const sweepHighPrice = 25_001_000n;
const sweepLowMaker = offerAtPrice(MAKER, 'sweep-low', 1, true, 1n, sweepLowPrice);
const sweepHighMaker = offerAtPrice(NEXT, 'sweep-high', 2, true, 1n, sweepHighPrice);
const sweepTaker = offerAtPrice(TAKER, 'sweep-taker', 3, false, 2n, sweepHighPrice);
const sweepExt = createOrderbookExtState(profile);
const sweepState = entityState(
  new Map([
    [MAKER, account(MAKER, [sweepLowMaker])],
    [NEXT, account(NEXT, [sweepHighMaker])],
    [TAKER, account(TAKER, [sweepTaker])],
  ]),
  sweepExt,
);
const sweepMatch = processOrderbookSwaps(
  sweepState,
  [sweepLowMaker, sweepHighMaker, sweepTaker].map(markWorkingOrderbookOffer),
);
const sweepBook = sweepMatch.bookUpdates.find(row => row.pairId === '1/2')?.book;
if (!sweepBook || sweepBook.tradeCount !== 2 || sweepBook.orders.size !== 0) {
  throw new Error('ENTITY_KERNEL_FIXTURE_SWEEP_MATCH_MISSING');
}
const sweepGrouped = new Map<string, AccountTx[]>();
for (const row of sweepMatch.accountTxs) {
  const txs = sweepGrouped.get(row.accountId) ?? [];
  txs.push(row.tx);
  sweepGrouped.set(row.accountId, txs);
}
const sweepProposalWork = Array.from(sweepGrouped)
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([accountId, txs]) => ({ accountId, txDigests: txs.map(txDigest) }));
const sweepOrderbookProjection = {
  domain: 'xln.entity-kernel.orderbook.v1',
  books: new Map([['1/2', projectBook(sweepBook)]]),
  pairDimensions: new Map([['1/2', { baseTokenDecimals: 18, quoteTokenDecimals: 6 }]]),
  offers: new Map([
    [[MAKER, sweepLowMaker.offerId], projectOffer(sweepLowMaker)],
    [[NEXT, sweepHighMaker.offerId], projectOffer(sweepHighMaker)],
    [[TAKER, sweepTaker.offerId], projectOffer(sweepTaker)],
  ]),
  resolvingOffers: new Set([
    [MAKER, sweepLowMaker.offerId],
    [NEXT, sweepHighMaker.offerId],
    [TAKER, sweepTaker.offerId],
  ]),
  pairByOrder: new Map(),
  maxOrdersPerPair: 10_000,
};
const sweepOutboxProjection = {
  domain: 'xln.entity-kernel.ordered-outbox.v1',
  proposalWork: sweepProposalWork,
  outputs: [{ kind: 'swapMatched', entityId: HUB, count: 2 }],
};

const cancelExt = createOrderbookExtState(profile);
const cancelMaker = offer(MAKER, 'cancel-me', 1, true);
const cancelState = entityState(
  new Map([[MAKER, account(MAKER, [cancelMaker])]]),
  cancelExt,
);
const resting = processOrderbookSwaps(cancelState, [markWorkingOrderbookOffer(cancelMaker)]);
const restingBook = resting.bookUpdates.find((row) => row.pairId === '1/2')?.book;
if (!restingBook) throw new Error('ENTITY_KERNEL_FIXTURE_RESTING_MISSING');
replaceOrderbookPair(cancelExt, '1/2', restingBook);
const canceled = processOrderbookCancels(cancelState, [{ accountId: MAKER, offerId: 'cancel-me' }]);
const cancelTx = canceled.accountTxs[0]?.tx;
if (!cancelTx || canceled.accountTxs.length !== 1) throw new Error('ENTITY_KERNEL_FIXTURE_CANCEL_MISSING');

const innerEnvelope = {
  version: HTLC_OPAQUE_CIPHERTEXT_VERSION,
  ciphertext: encodeBase64Bytes(Uint8Array.from({ length: 48 }, () => 0x61)),
};
const outerEnvelope = {
  version: HTLC_OPAQUE_CIPHERTEXT_VERSION,
  ciphertext: encodeBase64Bytes(Uint8Array.from({ length: 48 }, () => 0x51)),
};
const forwardedLockId = deriveForwardHtlcLockId(LOCK_ID);
const inboundHtlc: Extract<AccountTx, { type: 'htlc_lock' }> = {
  type: 'htlc_lock',
  data: {
    lockId: LOCK_ID,
    hashlock: HASHLOCK,
    timelock: 200_000n,
    revealBeforeHeight: 1_000,
    amount: 90n,
    tokenId: 1,
    envelope: outerEnvelope,
  },
};
const directForward: Extract<AccountOutput, { kind: 'directPaymentForward' }> = {
  kind: 'directPaymentForward',
  tokenId: 1,
  amount: 100n,
  route: [HUB, NEXT],
  deliveryMode: 'trusted',
  trustedGatewayEntityId: HUB,
};
const paybookAccounts = new Map([
  [MAKER, account(MAKER, [])],
  [NEXT, account(NEXT, [])],
]);
const paybookCommittedState = entityState(paybookAccounts);
const paybookWorkingState = createEntityFrameCandidateState(paybookCommittedState);
const committedHtlcFrame: AccountFrame = {
  height: 1,
  timestamp: 1_000,
  jHeight: 100,
  accountTxs: [inboundHtlc],
  prevFrameHash: '',
  accountStateRoot: `0x${'00'.repeat(32)}`,
  stateHash: `0x${'31'.repeat(32)}`,
  byLeft: false,
  deltas: [],
};
const paybookInput: AccountPeerInput = {
  kind: 'frame',
  fromEntityId: MAKER,
  toEntityId: HUB,
  domain: {
    chainId: 31_337,
    depositoryAddress: '0x8888888888888888888888888888888888888888',
  },
  disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  proposal: { frame: committedHtlcFrame },
};
const preparedHtlc: PreparedHtlcEntry = {
  binding: {
    fromEntityId: MAKER,
    toEntityId: HUB,
    domain: paybookInput.domain,
    accountFrameHash: committedHtlcFrame.stateHash,
    accountHeight: committedHtlcFrame.height,
    lockId: LOCK_ID,
    envelopeHash: hashOpaqueHtlcCiphertext(outerEnvelope),
    hashlock: HASHLOCK,
    tokenId: 1,
    amount: 90n,
    timelock: 200_000n,
    revealBeforeHeight: 1_000,
  },
  outcome: {
    kind: 'forward',
    nextHopEntityId: NEXT,
    forwardAmount: 87n,
    innerEnvelope,
  },
};
const paybookInfraContext: EntityInfraContext = {
  version: 1,
  proposerReplicaId: HUB,
  entityId: HUB,
  proposerSignerId: HUB,
  parentFrameHash: `0x${'00'.repeat(32)}`,
  height: 1,
  gossipProfiles: [],
  peerAssertions: [],
  htlc: { version: 1, entries: [preparedHtlc], originated: [] },
};
const fixtureEnv: EntityRuntimeContext = {
  state: {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
    timestamp: 2_000,
  },
  activeJurisdiction: 'fixture',
  error: () => undefined,
  info: () => undefined,
};
const paybookEntityOutputs: EntityInput[] = [];
const paybookAccountTxs: Array<{ accountId: string; tx: AccountTx }> = [];
const paybookCandidateEffects: EntityCandidateEffect[] = [];
const paybookFollowupContext = {
  env: fixtureEnv,
  state: paybookCommittedState,
  newState: paybookWorkingState,
  input: paybookInput,
  account: paybookAccounts.get(MAKER)!,
  outputs: paybookEntityOutputs,
  accountTxs: paybookAccountTxs,
  candidateEffects: paybookCandidateEffects,
  infraContext: paybookInfraContext,
  preparedHtlcEntriesByBinding: new Map([
    [`${committedHtlcFrame.stateHash}:${LOCK_ID}`, preparedHtlc],
  ]),
  consumedPreparedHtlcBindings: new Set<string>(),
};
await applyCommittedHtlcLockFollowup(
  paybookFollowupContext,
  inboundHtlc,
  committedHtlcFrame,
  false,
  true,
);
applyDirectPaymentForwardFollowups(paybookFollowupContext, [directForward]);
if (
  paybookAccountTxs.length !== 2
  || paybookAccountTxs[0]?.tx.type !== 'htlc_lock'
  || paybookAccountTxs[1]?.tx.type !== 'direct_payment'
) throw new Error('ENTITY_KERNEL_FIXTURE_PAYBOOK_OUTBOX_ORDER');
const forwardedHtlc = paybookAccountTxs[0].tx;
const forwardedDirect = paybookAccountTxs[1].tx;
if (forwardedHtlc.type !== 'htlc_lock' || forwardedDirect.type !== 'direct_payment') {
  throw new Error('ENTITY_KERNEL_FIXTURE_PAYBOOK_OUTBOX_KIND');
}
if (
  forwardedHtlc.data.lockId !== forwardedLockId
  || forwardedHtlc.data.timelock !== 190_000n
  || forwardedHtlc.data.revealBeforeHeight !== 997
) throw new Error('ENTITY_KERNEL_FIXTURE_PAYBOOK_FORWARD_VALUES');
const forwardEvent = paybookCandidateEffects.find(
  effect => effect.kind === 'runtimeEvent' && effect.eventName === 'HtlcForwardAccepted',
);
if (
  !forwardEvent
  || forwardEvent.kind !== 'runtimeEvent'
  || forwardEvent.eventName !== 'HtlcForwardAccepted'
  || paybookCandidateEffects.length !== 1
) {
  throw new Error('ENTITY_KERNEL_FIXTURE_PAYBOOK_EVENT');
}
const canonicalRoute = paybookWorkingState.htlcRoutes.get(HASHLOCK);
if (!canonicalRoute) throw new Error('ENTITY_KERNEL_FIXTURE_PAYBOOK_ROUTE');
const paybookProjection = {
  domain: 'xln.entity-kernel.paybook.v1',
  entityId: paybookWorkingState.entityId,
  timestamp: paybookWorkingState.timestamp,
  knownAccounts: new Set(paybookWorkingState.accounts.keys()),
  htlcRoutes: new Map([[HASHLOCK, {
    hashlock: canonicalRoute.hashlock,
    tokenId: canonicalRoute.tokenId ?? null,
    amount: canonicalRoute.amount ?? null,
    startedAtMs: canonicalRoute.startedAtMs ?? null,
    originated: canonicalRoute.originated === true,
    inboundEntity: canonicalRoute.inboundEntity ?? null,
    inboundLockId: canonicalRoute.inboundLockId ?? null,
    outboundEntity: canonicalRoute.outboundEntity ?? null,
    outboundLockId: canonicalRoute.outboundLockId ?? null,
    inboundSettled: canonicalRoute.inboundSettled === true,
    outboundSettled: canonicalRoute.outboundSettled === true,
    secret: canonicalRoute.secret ?? null,
    secretAckPending: canonicalRoute.secretAckPending === true,
    secretAckStartedAt: canonicalRoute.secretAckStartedAt ?? null,
    secretAckDeadlineAt: canonicalRoute.secretAckDeadlineAt ?? null,
    pendingFee: canonicalRoute.pendingFee ?? null,
    createdTimestamp: canonicalRoute.createdTimestamp,
  }]]),
  htlcFeesEarned: paybookWorkingState.htlcFeesEarned,
  lockBook: new Map(paybookWorkingState.lockBook),
};
const paybookProposal = [{
  accountId: NEXT,
  txDigests: paybookAccountTxs.map(row => txDigest(row.tx)),
}];
const paybookOutputs = [{
  kind: 'htlcForwardAccepted',
  entityId: String(forwardEvent.data['entityId']),
  hashlock: String(forwardEvent.data['hashlock']),
}];
const paybookForwardCanonicalEntity = canonicalEntityEvidence(paybookWorkingState);

const finalEnvelope = {
  version: HTLC_OPAQUE_CIPHERTEXT_VERSION,
  ciphertext: encodeBase64Bytes(Uint8Array.from({ length: 48 }, () => 0x71)),
};
const finalInboundHtlc: Extract<AccountTx, { type: 'htlc_lock' }> = {
  type: 'htlc_lock',
  data: {
    lockId: FINAL_LOCK_ID,
    hashlock: FINAL_HASHLOCK,
    timelock: 200_000n,
    revealBeforeHeight: 1_000,
    amount: 90n,
    tokenId: 1,
    envelope: finalEnvelope,
  },
};
const finalFrame: AccountFrame = {
  ...committedHtlcFrame,
  accountTxs: [finalInboundHtlc],
  stateHash: `0x${'71'.repeat(32)}`,
};
const finalInput: AccountPeerInput = {
  ...paybookInput,
  proposal: { frame: finalFrame },
};
const finalPrepared: PreparedHtlcEntry = {
  binding: {
    fromEntityId: MAKER,
    toEntityId: HUB,
    domain: finalInput.domain,
    accountFrameHash: finalFrame.stateHash,
    accountHeight: finalFrame.height,
    lockId: FINAL_LOCK_ID,
    envelopeHash: hashOpaqueHtlcCiphertext(finalEnvelope),
    hashlock: FINAL_HASHLOCK,
    tokenId: 1,
    amount: 90n,
    timelock: 200_000n,
    revealBeforeHeight: 1_000,
  },
  outcome: {
    kind: 'final',
    secret: FINAL_SECRET,
    startedAtMs: 1_500,
  },
};
const finalAccounts = new Map([[MAKER, account(MAKER, [])]]);
const finalCommittedState = entityState(finalAccounts);
const finalWorkingState = createEntityFrameCandidateState(finalCommittedState);
const finalCandidateEffects: EntityCandidateEffect[] = [];
const finalPreparedAccountTxs: Array<{ accountId: string; tx: AccountTx }> = [];
await applyCommittedHtlcLockFollowup(
  {
    env: fixtureEnv,
    state: finalCommittedState,
    newState: finalWorkingState,
    input: finalInput,
    account: finalAccounts.get(MAKER)!,
    outputs: [],
    accountTxs: finalPreparedAccountTxs,
    candidateEffects: finalCandidateEffects,
    infraContext: {
      ...paybookInfraContext,
      htlc: { version: 1, entries: [finalPrepared], originated: [] },
    },
    preparedHtlcEntriesByBinding: new Map([
      [`${finalFrame.stateHash}:${FINAL_LOCK_ID}`, finalPrepared],
    ]),
    consumedPreparedHtlcBindings: new Set<string>(),
  },
  finalInboundHtlc,
  finalFrame,
  false,
  true,
);
const finalResolve = finalPreparedAccountTxs[0]?.tx;
if (
  finalPreparedAccountTxs.length !== 1
  || finalResolve?.type !== 'htlc_resolve'
  || finalResolve.data.outcome !== 'secret'
) throw new Error('ENTITY_KERNEL_FIXTURE_FINAL_RESOLVE');
const committedResolveFrame: AccountFrame = {
  ...finalFrame,
  height: 2,
  accountTxs: [finalResolve],
  stateHash: `0x${'72'.repeat(32)}`,
};
const finalPostAccountTxs: Array<{ accountId: string; tx: AccountTx }> = [];
applyCommittedAccountFrameFollowups(
  finalWorkingState,
  MAKER,
  committedResolveFrame,
  false,
  finalPostAccountTxs,
  fixtureEnv,
  finalCandidateEffects,
);
applyHtlcSecretFollowups(
  {
    env: fixtureEnv,
    state: finalCommittedState,
    newState: finalWorkingState,
    outputs: [],
    accountTxs: finalPostAccountTxs,
    candidateEffects: finalCandidateEffects,
  },
  [{ secret: FINAL_SECRET, hashlock: FINAL_HASHLOCK }],
);
const finalReceivedEffect = finalCandidateEffects.find(
  effect => effect.kind === 'runtimeEvent' && effect.eventName === 'HtlcReceived',
);
if (
  !finalReceivedEffect
  || finalReceivedEffect.kind !== 'runtimeEvent'
  || finalReceivedEffect.eventName !== 'HtlcReceived'
  || finalCandidateEffects.length !== 1
  || finalPostAccountTxs.length !== 0
  || finalWorkingState.htlcRoutes.size !== 0
) throw new Error('ENTITY_KERNEL_FIXTURE_FINAL_COMMIT');
const finalOutputs = [{ kind: 'htlcReceived', ...finalReceivedEffect.data }];

const fixture = {
  version: 1,
  canonicalSource: 'TypeScript Entity paybook follow-ups + processOrderbookSwaps/processOrderbookCancels',
  paybookForward: {
    forwardLockId: forwardedLockId,
    outerEnvelopeHash: hashOpaqueHtlcCiphertext(outerEnvelope),
    paybookRoot: digest(paybookProjection),
    orderbookRoot: digest({ domain: 'xln.entity-kernel.orderbook.v1', state: null }),
    orderedOutboxDigest: digest({
      domain: 'xln.entity-kernel.ordered-outbox.v1',
      proposalWork: paybookProposal,
      outputs: paybookOutputs,
    }),
    txDigests: paybookProposal[0]!.txDigests,
    canonicalEntity: paybookForwardCanonicalEntity,
  },
  paybookFinalResolve: {
    paybookRoot: digest(emptyPaybook([MAKER])),
    orderedOutboxDigest: digest({
      domain: 'xln.entity-kernel.ordered-outbox.v1',
      proposalWork: [],
      outputs: finalOutputs,
    }),
    resolveDigest: txDigest(finalResolve),
  },
  sameJFullMatch: {
    paybookRoot: digest(emptyPaybook([MAKER, TAKER])),
    orderbookRoot: digest(orderbookProjection),
    orderedOutboxDigest: digest(outboxProjection),
    makerResolveDigest: proposalWork.find((row) => row.accountId === MAKER)?.txDigests[0],
    takerResolveDigest: proposalWork.find((row) => row.accountId === TAKER)?.txDigests[0],
    tradeCount: finalBook.tradeCount,
    tradeQtyLots: finalBook.tradeQtySum.toString(),
    eventHash: finalBook.eventHash.toString(),
    bidPagesRoot: finalBook.bidPages.rootHash(),
    askPagesRoot: finalBook.askPages.rootHash(),
    bookCommitmentHash: computeBookCommitmentHash(finalBook),
    canonicalEntity: sameJFullMatchCanonicalEntity,
  },
  sameJPartialMatch: {
    orderbookRoot: digest(partialOrderbookProjection),
    orderedOutboxDigest: digest(partialOutboxProjection),
    makerResolveDigest: partialProposalWork.find((row) => row.accountId === MAKER)?.txDigests[0],
    takerResolveDigest: partialProposalWork.find((row) => row.accountId === TAKER)?.txDigests[0],
    remainingMakerQtyLots: partialBook.orders
      .get(`${MAKER}:${partialMaker.offerId}`)?.qtyLots.toString(),
    bidPagesRoot: partialBook.bidPages.rootHash(),
    askPagesRoot: partialBook.askPages.rootHash(),
    bookCommitmentHash: computeBookCommitmentHash(partialBook),
  },
  sameJSweepMatch: {
    orderbookRoot: digest(sweepOrderbookProjection),
    orderedOutboxDigest: digest(sweepOutboxProjection),
    lowMakerResolveDigest: sweepProposalWork.find(row => row.accountId === MAKER)?.txDigests[0],
    highMakerResolveDigest: sweepProposalWork.find(row => row.accountId === NEXT)?.txDigests[0],
    takerResolveDigest: sweepProposalWork.find(row => row.accountId === TAKER)?.txDigests[0],
    tradeCount: sweepBook.tradeCount,
    tradeQtyLots: sweepBook.tradeQtySum.toString(),
    eventHash: sweepBook.eventHash.toString(),
    bidPagesRoot: sweepBook.bidPages.rootHash(),
    askPagesRoot: sweepBook.askPages.rootHash(),
    bookCommitmentHash: computeBookCommitmentHash(sweepBook),
  },
  sameJCancel: {
    resolveDigest: txDigest(cancelTx),
  },
  bookHydration: projectExactBookSnapshot(hydrationBook),
};

process.stdout.write(`${safeStringify(fixture, 2)}\n`);

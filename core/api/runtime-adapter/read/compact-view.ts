import { getBookSideLevels, projectBookDepth, type BookState } from '../../../orderbook';
import { projectBookPricePageTree, type BookPricePage } from '../../../orderbook/pages/page';
import type { ExternalWalletState } from '../../../entity/types';
import type { JBatch, JBatchState, SentJBatch } from '../../../jurisdiction/machine/batch';
import { normalizeEntityId } from '../../../storage/keys';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../../../storage/types';
import { compareAscii } from '../../../support/collections/sorted-map-index';
import { copyAccountStateDomain } from '../../../protocol/state/account-input-clone';
import {
  emptyPageMeta,
  withDefinedProp,
  type NativeMapView,
  type RuntimeAdapterAccountPage,
  type RuntimeAdapterAccountPageSummary,
  type RuntimeAdapterBookPage,
  type RuntimeAdapterEntityCoreDoc,
} from './context';

// Bounded network DTOs for Entity cores, Account docs, J-batches and books:
// samples, counts and redactions so a view never clones unbounded live state.

type AccountStateDoc = StorageAccountDoc['state'];
type RuntimeAdapterAccountStateDoc = Omit<
  AccountStateDoc,
  | 'deltas'
  | 'locks'
  | 'swapOffers'
  | 'pulls'
  | 'subcontracts'
  | 'lendingIntents'
  | 'requestedRebalance'
  | 'requestedRebalanceFeeState'
  | 'rebalanceFeePolicies'
> & {
  deltas: NativeMapView<AccountStateDoc['deltas']>;
  locks: NativeMapView<AccountStateDoc['locks']>;
  swapOffers: NativeMapView<AccountStateDoc['swapOffers']>;
  pulls?: NativeMapView<NonNullable<AccountStateDoc['pulls']>>;
  subcontracts?: NativeMapView<NonNullable<AccountStateDoc['subcontracts']>>;
  lendingIntents?: NativeMapView<NonNullable<AccountStateDoc['lendingIntents']>>;
  requestedRebalance: NativeMapView<AccountStateDoc['requestedRebalance']>;
  requestedRebalanceFeeState: NativeMapView<AccountStateDoc['requestedRebalanceFeeState']>;
  rebalanceFeePolicies?: NativeMapView<NonNullable<AccountStateDoc['rebalanceFeePolicies']>>;
};
type AccountRebalanceShadow = StorageAccountDoc['shadow']['rebalance'];
type RuntimeAdapterActiveDispute = Pick<NonNullable<StorageAccountDoc['activeDispute']>,
  | 'startedByLeft' | 'initialProofbodyHash' | 'initialNonce' | 'initialProposerIsLeft'
  | 'disputeTimeout' | 'disputeStartTimestamp' | 'jNonce' | 'starterCounterProofCommitment'
  | 'observedOnChain' | 'observedBlockNumber' | 'batchNonce' | 'selectedCounterNonce'
  | 'selectedCounterProofbodyHash' | 'selectedCounterProposerIsLeft' | 'finalizeQueued'
>;
type RuntimeAdapterAccountDoc = Omit<StorageAccountDoc, 'state' | 'pendingWithdrawals' | 'shadow' | 'activeDispute' | 'disputePrepare'> & {
  state: RuntimeAdapterAccountStateDoc;
  /** Bodies stay redacted; zero here means the live Account queue is actually empty. */
  mempoolCount: number;
  activeDispute?: RuntimeAdapterActiveDispute;
  disputePrepare?: Pick<NonNullable<StorageAccountDoc['disputePrepare']>, 'startedAt' | 'readyAfter' | 'reason'>;
  pendingWithdrawals: NativeMapView<StorageAccountDoc['pendingWithdrawals']>;
  shadow: {
    rebalance: Omit<AccountRebalanceShadow, 'policy' | 'submittedAtByToken'> & {
      policy: NativeMapView<AccountRebalanceShadow['policy']>;
      submittedAtByToken: NativeMapView<AccountRebalanceShadow['submittedAtByToken']>;
    };
  };
};
export type RuntimeAdapterAccountViewPage = Omit<RuntimeAdapterAccountPage, 'items'> & {
  items: RuntimeAdapterAccountDoc[];
};

export type RuntimeAdapterPortableBookPage = Omit<RuntimeAdapterBookPage, 'items'> & {
  items: Array<{ pairId: string; book: PortableBookState }>;
};

type PortableBookState = Omit<BookState, 'orders' | 'bidPages' | 'askPages'> & Readonly<{
  bidPages: ReadonlyMap<string, BookPricePage>;
  askPages: ReadonlyMap<string, BookPricePage>;
  /** Full committed depth; page slots are only the bounded visible order sample. */
  bidLevels: ReadonlyArray<{ priceTicks: bigint; qtyLots: bigint }>;
  askLevels: ReadonlyArray<{ priceTicks: bigint; qtyLots: bigint }>;
}>;

const compactArrayTail = <T>(value: readonly T[] | undefined, limit = 20): T[] | undefined =>
  Array.isArray(value) ? value.slice(-limit) : undefined;

const compactMapHead = <K, V>(value: ReadonlyMap<K, V> | undefined, limit = 20): Map<K, V> | undefined =>
  value === undefined ? undefined : new Map(Array.from(value.entries()).slice(0, limit));

const compactMapTail = <K, V>(value: ReadonlyMap<K, V> | undefined, limit = 20): Map<K, V> | undefined =>
  value === undefined ? undefined : new Map(Array.from(value.entries()).slice(-limit));

const compactAccountFrameForView = (
  frame: StorageAccountDoc['currentFrame'],
  txLimit = 20,
): StorageAccountDoc['currentFrame'] => ({
  height: frame.height,
  timestamp: frame.timestamp,
  jHeight: frame.jHeight,
  accountTxs: compactArrayTail(frame.accountTxs, txLimit) ?? [],
  prevFrameHash: frame.prevFrameHash,
  accountStateRoot: frame.accountStateRoot,
  stateHash: frame.stateHash,
});

/** Lifecycle metadata is observable; proof arguments and recovery work stay with the owning Account. */
const compactActiveDisputeForView = (
  dispute: NonNullable<StorageAccountDoc['activeDispute']>,
): RuntimeAdapterActiveDispute => ({
  startedByLeft: dispute.startedByLeft,
  initialProofbodyHash: dispute.initialProofbodyHash,
  initialNonce: dispute.initialNonce,
  initialProposerIsLeft: dispute.initialProposerIsLeft,
  disputeTimeout: dispute.disputeTimeout,
  jNonce: dispute.jNonce,
  starterCounterProofCommitment: dispute.starterCounterProofCommitment,
  ...withDefinedProp('disputeStartTimestamp', dispute.disputeStartTimestamp),
  ...withDefinedProp('observedOnChain', dispute.observedOnChain),
  ...withDefinedProp('observedBlockNumber', dispute.observedBlockNumber),
  ...withDefinedProp('batchNonce', dispute.batchNonce),
  ...withDefinedProp('selectedCounterNonce', dispute.selectedCounterNonce),
  ...withDefinedProp('selectedCounterProofbodyHash', dispute.selectedCounterProofbodyHash),
  ...withDefinedProp('selectedCounterProposerIsLeft', dispute.selectedCounterProposerIsLeft),
  ...withDefinedProp('finalizeQueued', dispute.finalizeQueued),
});

export const compactAccountDocForView = (
  doc: StorageAccountDoc,
): RuntimeAdapterAccountDoc => {
  // Settlement workspaces may contain large transient proof material. They are
  // consensus data, but aggregate inspection endpoints must expose the compact
  // settlement status through dedicated views instead of cloning the workspace.
  const {
    settlementWorkspace: _settlementWorkspace,
    deltas: _deltas,
    locks: _locks,
    swapOffers: _swapOffers,
    pulls: _pulls,
    subcontracts: _subcontracts,
    lendingIntents: _lendingIntents,
    requestedRebalance: _requestedRebalance,
    requestedRebalanceFeeState: _requestedRebalanceFeeState,
    rebalanceFeePolicies: _rebalanceFeePolicies,
    ...boundedState
  } = doc.state;
  const compact: RuntimeAdapterAccountDoc = {
    state: {
      ...boundedState,
      domain: copyAccountStateDomain(doc.state.domain),
      watchSeed: '',
      // Runtime-adapter payloads are network DTOs. The Patricia collection is
      // an internal live-state owner and must never leak into the binary codec.
      deltas: compactMapHead(doc.state.deltas, 100) ?? new Map(),
      locks: compactMapTail(doc.state.locks, 20) ?? new Map(),
      swapOffers: compactMapTail(doc.state.swapOffers, 100) ?? new Map(),
      requestedRebalance: compactMapHead(doc.state.requestedRebalance, 100) ?? new Map(),
      requestedRebalanceFeeState: compactMapHead(doc.state.requestedRebalanceFeeState, 100) ?? new Map(),
    },
    status: doc.status,
    mempool: [],
    mempoolCount: doc.mempool.length,
    currentFrame: compactAccountFrameForView(doc.currentFrame),
    currentHeight: doc.currentHeight,
    rollbackCount: doc.rollbackCount,
    proofHeader: doc.proofHeader,
    pendingWithdrawals: compactMapTail(doc.pendingWithdrawals, 20) ?? new Map(),
    shadow: {
      rebalance: {
        policy: compactMapHead(doc.shadow.rebalance.policy, 100) ?? new Map(),
        submittedAtByToken: compactMapHead(doc.shadow.rebalance.submittedAtByToken, 100) ?? new Map(),
        ...(doc.shadow.rebalance.activeQuote ? { activeQuote: doc.shadow.rebalance.activeQuote } : {}),
        ...(doc.shadow.rebalance.pendingRequest ? { pendingRequest: doc.shadow.rebalance.pendingRequest } : {}),
      },
    },
  };

  if (doc.activeDispute) compact.activeDispute = compactActiveDisputeForView(doc.activeDispute);
  if (doc.disputePrepare) {
    const { startedAt, readyAfter, reason } = doc.disputePrepare;
    compact.disputePrepare = { startedAt, readyAfter, reason };
  }
  const pulls = compactMapTail(doc.state.pulls, 20);
  if (pulls) compact.state.pulls = pulls;
  const subcontracts = compactMapTail(doc.state.subcontracts, 20);
  if (subcontracts) compact.state.subcontracts = subcontracts;
  const lendingIntents = compactMapTail(doc.state.lendingIntents, 20);
  if (lendingIntents) compact.state.lendingIntents = lendingIntents;
  const rebalanceFeePolicies = compactMapHead(doc.state.rebalanceFeePolicies, 100);
  if (rebalanceFeePolicies) compact.state.rebalanceFeePolicies = rebalanceFeePolicies;
  // Account history is a point-read concern. Aggregate Entity views retain
  // the required canonical fields as empty maps instead of multiplying their
  // payload by the page width.
  if (doc.pendingFrame) compact.pendingFrame = compactAccountFrameForView(doc.pendingFrame);
  if (doc.lastOutboundAckFrame) compact.lastOutboundAckFrame = doc.lastOutboundAckFrame;
  if (doc.lastRollbackFrameHash) compact.lastRollbackFrameHash = doc.lastRollbackFrameHash;
  if (doc.currentFrameHanko) compact.currentFrameHanko = doc.currentFrameHanko;
  if (doc.counterpartyFrameHanko) compact.counterpartyFrameHanko = doc.counterpartyFrameHanko;
  if (doc.boardHankoRefreshMigration) compact.boardHankoRefreshMigration = { ...doc.boardHankoRefreshMigration };
  if (doc.currentDisputeProofHanko) compact.currentDisputeProofHanko = doc.currentDisputeProofHanko;
  if (doc.currentDisputeProofNonce !== undefined) compact.currentDisputeProofNonce = doc.currentDisputeProofNonce;
  if (doc.currentDisputeProofBodyHash) compact.currentDisputeProofBodyHash = doc.currentDisputeProofBodyHash;
  if (doc.currentDisputeHash) compact.currentDisputeHash = doc.currentDisputeHash;
  if (doc.counterpartyDisputeProofHanko) compact.counterpartyDisputeProofHanko = doc.counterpartyDisputeProofHanko;
  if (doc.counterpartyDisputeProofNonce !== undefined) compact.counterpartyDisputeProofNonce = doc.counterpartyDisputeProofNonce;
  if (doc.counterpartyDisputeProofBodyHash) compact.counterpartyDisputeProofBodyHash = doc.counterpartyDisputeProofBodyHash;
  if (doc.counterpartyDisputeHash) compact.counterpartyDisputeHash = doc.counterpartyDisputeHash;
  if (doc.counterpartySettlementHanko) compact.counterpartySettlementHanko = doc.counterpartySettlementHanko;
  return compact;
};

const compactDebtLedgerForView = (
  value: StorageEntityCoreDoc['outDebtsByToken'] | StorageEntityCoreDoc['inDebtsByToken'],
  outerLimit = 20,
  innerLimit = 20,
): typeof value => {
  if (!(value instanceof Map)) return undefined;
  return new Map(Array.from(value.entries()).slice(0, outerLimit).map(([tokenId, bucket]) => [
    tokenId,
    bucket instanceof Map ? new Map(Array.from(bucket.entries()).slice(0, innerLimit)) : bucket,
  ]));
};

const compactExternalWalletMap = <V>(
  value: Map<string, Map<string, V>>,
  outerLimit = 20,
  innerLimit = 20,
): Map<string, Map<string, V>> =>
  new Map(Array.from(value.entries()).slice(0, outerLimit).map(([owner, records]) => [
    owner,
    records instanceof Map ? new Map(Array.from(records.entries()).slice(0, innerLimit)) : new Map(),
  ]));

const compactExternalWalletForView = (wallet: ExternalWalletState | undefined): ExternalWalletState | undefined =>
  wallet
    ? {
      balances: compactExternalWalletMap(wallet.balances),
      allowances: compactExternalWalletMap(wallet.allowances),
    }
    : undefined;

const compactHubProfileForView = (profile: StorageEntityCoreDoc['orderbookHubProfile']): StorageEntityCoreDoc['orderbookHubProfile'] | undefined =>
  profile
    ? {
      ...profile,
      supportedPairs: profile.supportedPairs.slice(0, 50),
    }
    : undefined;

const BATCH_VIEW_OP_LIMIT = 50;

const compactProofBodyForBatchView = (proofBody: unknown): unknown => {
  if (!proofBody || typeof proofBody !== 'object') return proofBody;
  const body = proofBody as {
    watchSeed?: unknown;
    offdeltas?: unknown[];
    tokenIds?: unknown[];
    transformers?: Array<{ allowances?: unknown[] }>;
  };
  return {
    ...body,
    watchSeed: '',
    offdeltas: compactArrayTail(body.offdeltas, 100) ?? [],
    tokenIds: compactArrayTail(body.tokenIds, 100) ?? [],
    transformers: compactArrayTail(body.transformers, 20)?.map((transformer) => ({
      ...transformer,
      allowances: compactArrayTail(transformer.allowances, 50) ?? [],
    })) ?? [],
  };
};

const compactJBatchForView = (batch: JBatch | undefined): JBatch | undefined => {
  if (!batch) return undefined;
  return {
    reserveToReserve: compactArrayTail(batch.reserveToReserve, BATCH_VIEW_OP_LIMIT) ?? [],
    reserveToCollateral: (compactArrayTail(batch.reserveToCollateral, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      pairs: compactArrayTail(op.pairs, BATCH_VIEW_OP_LIMIT) ?? [],
    })),
    collateralToReserve: compactArrayTail(batch.collateralToReserve, BATCH_VIEW_OP_LIMIT) ?? [],
    settlements: (compactArrayTail(batch.settlements, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      diffs: compactArrayTail(op.diffs, 100) ?? [],
      forgiveDebtsInTokenIds: compactArrayTail(op.forgiveDebtsInTokenIds, 100) ?? [],
      sig: op.sig ? '[redacted]' : '',
    })),
    disputeStarts: (compactArrayTail(batch.disputeStarts, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      initialProofbody: compactProofBodyForBatchView(op.initialProofbody) as typeof op.initialProofbody,
      watchSeed: '',
      sig: op.sig ? '[redacted]' : '',
      starterInitialArguments: op.starterInitialArguments ? '[redacted]' : '',
      starterCounterArguments: op.starterCounterArguments ? '[redacted]' : '',
    })),
    counterDisputes: (compactArrayTail(batch.counterDisputes, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      counterProofbody: compactProofBodyForBatchView(op.counterProofbody) as typeof op.counterProofbody,
      sig: op.sig ? '[redacted]' : '',
    })),
    disputeFinalizations: (compactArrayTail(batch.disputeFinalizations, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      finalProofbody: compactProofBodyForBatchView(op.finalProofbody) as typeof op.finalProofbody,
      starterArguments: op.starterArguments ? '[redacted]' : '',
      otherArguments: op.otherArguments ? '[redacted]' : '',
      sig: op.sig ? '[redacted]' : '',
    })),
    externalTokenToReserve: compactArrayTail(batch.externalTokenToReserve, BATCH_VIEW_OP_LIMIT) ?? [],
    reserveToExternalToken: compactArrayTail(batch.reserveToExternalToken, BATCH_VIEW_OP_LIMIT) ?? [],
    revealSecrets: (compactArrayTail(batch.revealSecrets, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      secret: op.secret ? '[redacted]' : '',
    })),
    hashLadderRegistrations: (compactArrayTail(batch.hashLadderRegistrations, BATCH_VIEW_OP_LIMIT) ?? []).map((op) => ({
      ...op,
      witness: {
        ...op.witness,
        fullSecret: op.witness.fullSecret ? '[redacted]' : '',
        reveals: ['[redacted]', '[redacted]', '[redacted]', '[redacted]'],
      } as typeof op.witness,
    })),
  };
};

const compactSentJBatchForView = (sentBatch: SentJBatch | undefined): SentJBatch | undefined => {
  if (!sentBatch) return undefined;
  const batch = compactJBatchForView(sentBatch.batch);
  if (!batch) return undefined;
  return {
    ...sentBatch,
    batch,
    encodedBatch: sentBatch.encodedBatch ? '[redacted]' : '',
  };
};

const compactJBatchStateForView = (state: JBatchState | undefined): JBatchState | undefined => {
  if (!state) return undefined;
  const batch = compactJBatchForView(state.batch);
  if (!batch) return undefined;
  const compactState: JBatchState = {
    batch,
    jurisdiction: state.jurisdiction,
    lastBroadcast: state.lastBroadcast,
    broadcastCount: state.broadcastCount,
    failedAttempts: state.failedAttempts,
    status: state.status,
  };
  if (typeof state.entityNonce === 'number') compactState.entityNonce = state.entityNonce;
  const sentBatch = compactSentJBatchForView(state.sentBatch);
  if (sentBatch) compactState.sentBatch = sentBatch;
  return compactState;
};

export const compactEntityCoreForRemote = (core: RuntimeAdapterEntityCoreDoc): RuntimeAdapterEntityCoreDoc => {
  const compact: RuntimeAdapterEntityCoreDoc = {
    entityId: core.entityId,
    entityEncryptionPublicKey: core.entityEncryptionPublicKey,
    ...withDefinedProp('signerId', core.signerId),
    ...withDefinedProp('isProposer', core.isProposer),
    height: core.height,
    timestamp: core.timestamp,
    profile: core.profile,
    config: core.config,
    nonces: compactMapTail(core.nonces, 100) ?? new Map(),
    proposals: new Map(Array.from(core.proposals.entries()).slice(-20)),
    reserves: compactMapHead(core.reserves, 100) ?? new Map(),
    lastFinalizedJHeight: core.lastFinalizedJHeight,
    paybook: {
      entries: compactMapTail(core.paybook.entries, 20) ?? new Map(),
      feesEarned: core.paybook.feesEarned,
    },
    paybookOpen: core.paybook.entries.size,
    ...withDefinedProp('metrics', core.metrics),
  };

  if (core.prevFrameHash) compact.prevFrameHash = core.prevFrameHash;
  const externalWallet = compactExternalWalletForView(core.externalWallet);
  if (externalWallet) compact.externalWallet = externalWallet;
  const deferredAccountProposals = compactMapTail(core.deferredAccountProposals, 20);
  if (deferredAccountProposals) compact.deferredAccountProposals = deferredAccountProposals;
  const jBatchState = compactJBatchStateForView(core.jBatchState);
  if (jBatchState) compact.jBatchState = jBatchState;
  const outDebtsByToken = compactDebtLedgerForView(core.outDebtsByToken);
  if (outDebtsByToken) compact.outDebtsByToken = outDebtsByToken;
  const inDebtsByToken = compactDebtLedgerForView(core.inDebtsByToken);
  if (inDebtsByToken) compact.inDebtsByToken = inDebtsByToken;
  if (core.swapTradingPairs) compact.swapTradingPairs = core.swapTradingPairs.slice(0, 50);
  const crossJurisdictionSwaps = compactMapTail(core.crossJurisdictionSwaps, 20);
  if (crossJurisdictionSwaps) compact.crossJurisdictionSwaps = crossJurisdictionSwaps;
  const crossJurisdictionBookAdmissions = compactMapTail(core.crossJurisdictionBookAdmissions, 20);
  if (crossJurisdictionBookAdmissions) compact.crossJurisdictionBookAdmissions = crossJurisdictionBookAdmissions;
  const orderbookReferrals = compactMapTail(core.orderbookReferrals, 20);
  if (orderbookReferrals) compact.orderbookReferrals = orderbookReferrals;
  const orderbookHubProfile = compactHubProfileForView(core.orderbookHubProfile);
  if (orderbookHubProfile) compact.orderbookHubProfile = orderbookHubProfile;
  if (core.hubRebalanceConfig) compact.hubRebalanceConfig = core.hubRebalanceConfig;
  return compact;
};

const accountCounterpartyIdForView = (
  entityId: string,
  doc: StorageAccountDoc | RuntimeAdapterAccountDoc,
): string => {
  const normalized = normalizeEntityId(entityId);
  const left = normalizeEntityId(doc.state.leftEntity);
  const right = normalizeEntityId(doc.state.rightEntity);
  return left === normalized ? right : left;
};

const absoluteBigInt = (value: bigint): bigint => value < 0n ? -value : value;

export const accountPageSummaryForView = (
  entityId: string,
  page: RuntimeAdapterAccountPage | RuntimeAdapterAccountViewPage,
): RuntimeAdapterAccountPageSummary => {
  const limit = Math.max(1, Number(page.limit ?? (page.items.length || 1)));
  const totalItems = Number.isFinite(Number(page.totalItems)) ? Math.max(0, Math.floor(Number(page.totalItems))) : null;
  const pageIndex = Number.isFinite(Number(page.pageIndex)) ? Math.max(0, Math.floor(Number(page.pageIndex))) : null;
  const pageCount = Number.isFinite(Number(page.pageCount)) ? Math.max(0, Math.floor(Number(page.pageCount))) : null;
  const sampleIds = page.items.slice(0, 8).map((doc) => accountCounterpartyIdForView(entityId, doc));
  const pageStateHashes = Array.from(new Set(page.items
    .map((doc) => String(doc.currentFrame?.stateHash || doc.currentDisputeProofBodyHash || doc.counterpartyDisputeProofBodyHash || '').trim())
    .filter(Boolean)))
    .slice(0, 8);
  const visibleTopDeltas = page.items
    .flatMap((doc) => {
      const counterpartyId = accountCounterpartyIdForView(entityId, doc);
      return Array.from(doc.state.deltas.entries()).map(([tokenId, delta]) => {
        const netDelta = BigInt(delta.offdelta ?? 0n) + BigInt(delta.ondelta ?? 0n);
        return {
          counterpartyId,
          tokenId: Number(delta.tokenId ?? tokenId),
          delta: String(netDelta),
          magnitude: absoluteBigInt(netDelta),
        };
      });
    })
    .sort((left, right) => {
      if (left.magnitude === right.magnitude) return compareAscii(left.counterpartyId, right.counterpartyId);
      return left.magnitude > right.magnitude ? -1 : 1;
    })
    .slice(0, 8)
    .map(({ counterpartyId, tokenId, delta }) => ({ counterpartyId, tokenId, delta }));

  return {
    totalItems,
    visibleItems: page.items.length,
    limit,
    pageIndex,
    pageCount,
    hasMore: Boolean(page.nextCursor) || (totalItems !== null && pageIndex !== null && pageCount !== null && pageIndex + 1 < pageCount),
    sampleIds,
    pageStateHashes,
    visibleTopDeltas,
  };
};

const compactBookStateForView = (
  book: BookState,
  maxLevelsPerSide = 5,
  maxOrdersPerLevel = 20,
): PortableBookState => {
  // This is a bounded remote view, never a persistence format. LevelDB stores
  // the original Patricia header/branch/leaf graph directly.
  const compact = projectBookDepth(book, maxLevelsPerSide, maxOrdersPerLevel);
  return {
    params: compact.params,
    bidLevels: getBookSideLevels(book, 0, maxLevelsPerSide).map(({ priceTicks, qtyLots }) => ({ priceTicks, qtyLots })),
    askLevels: getBookSideLevels(book, 1, maxLevelsPerSide).map(({ priceTicks, qtyLots }) => ({ priceTicks, qtyLots })),
    bidPages: projectBookPricePageTree(compact.bidPages),
    askPages: projectBookPricePageTree(compact.askPages),
    nextSeq: compact.nextSeq,
    tradeCount: compact.tradeCount,
    tradeQtySum: compact.tradeQtySum,
    lastTradePriceTicks: compact.lastTradePriceTicks,
    lastAcceptedUsdAskPriceTicks: compact.lastAcceptedUsdAskPriceTicks,
    eventHash: compact.eventHash,
    ...(compact.commitmentHash === undefined ? {} : { commitmentHash: compact.commitmentHash }),
  };
};

export const compactViewPageForRemote = (entityId: string, view: {
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountPage;
  books: RuntimeAdapterBookPage;
}): {
  core: RuntimeAdapterEntityCoreDoc;
  accounts: RuntimeAdapterAccountViewPage;
  books: RuntimeAdapterPortableBookPage;
} => ({
  core: compactEntityCoreForRemote(view.core),
  accounts: {
    ...view.accounts,
    items: view.accounts.items.map((account) => compactAccountDocForView(account)),
    summary: accountPageSummaryForView(entityId, view.accounts),
  },
  books: {
    ...view.books,
    items: view.books.items.map((item) => ({
      pairId: item.pairId,
      book: compactBookStateForView(item.book),
    })),
  },
});

export const singleAccountViewPage = (
  accountId: string,
  account: RuntimeAdapterAccountDoc | null,
  limit: number,
): RuntimeAdapterAccountViewPage => account
  ? {
      items: [account],
      nextCursor: null,
      prevCursor: null,
      firstCursor: accountId,
      lastCursor: accountId,
      pageIndex: 0,
      pageCount: 1,
      totalItems: 1,
      limit,
    }
  : { items: [], ...emptyPageMeta(limit) };

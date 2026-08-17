/**
 * Reads authenticated operator settlement evidence from every production
 * Runtime and combines matching bilateral Account replicas. It never infers
 * completion from the orderbook counter alone.
 */

import {
  decodeSettlementEvidenceResponse,
  MAX_SETTLEMENT_EVIDENCE_ACCOUNTS,
  type SettlementEvidenceRequest,
  type SettlementEvidenceResponse,
} from '../../../../api/runtime-adapter/control/settlement-evidence';
import { safeStringify } from '../../../../protocol/serialization';
import { assertProductionSwapFullySettled, type ProductionSwapSettlementEvidence } from './settlement';
import { PRODUCTION_SWAP_LOAD_PAIR_ID, type ConnectedRuntime } from './worker-runtime';

export type SettlementAccountPair = Readonly<{
  hubEntityId: string;
  loadEntityId: string;
  offerIds: readonly string[];
}>;

type RuntimeRole = ProductionSwapSettlementEvidence['runtimes'][number]['role'];
type AccountResponse = SettlementEvidenceResponse['accounts'][number];

export const sameBilateralAccountHead = (
  hub: Pick<AccountResponse, 'accountKey' | 'currentHeight' | 'currentStateHash'>,
  load: Pick<AccountResponse, 'accountKey' | 'currentHeight' | 'currentStateHash'>,
): boolean => hub.accountKey === load.accountKey && hub.currentHeight === load.currentHeight &&
  hub.currentStateHash === load.currentStateHash;

const requestFor = (
  pairs: readonly SettlementAccountPair[],
  side: 'hub' | 'load',
  hubBookEntityId: string,
): SettlementEvidenceRequest => ({
  type: 'settlement-evidence',
  book: side === 'hub'
    ? { entityId: hubBookEntityId, pairId: PRODUCTION_SWAP_LOAD_PAIR_ID }
    : null,
  accounts: pairs.map(pair => side === 'hub'
    ? { entityId: pair.hubEntityId, counterpartyEntityId: pair.loadEntityId, offerIds: pair.offerIds }
    : { entityId: pair.loadEntityId, counterpartyEntityId: pair.hubEntityId, offerIds: pair.offerIds }),
});

const readEvidencePage = async (
  runtime: ConnectedRuntime,
  request: SettlementEvidenceRequest,
): Promise<SettlementEvidenceResponse> =>
  decodeSettlementEvidenceResponse(await runtime.adapter.control<unknown>(request));

const readEvidence = async (
  runtime: ConnectedRuntime,
  request: SettlementEvidenceRequest,
): Promise<SettlementEvidenceResponse | null> => {
  if (request.accounts.length === 0) return readEvidencePage(runtime, request);
  const pages: SettlementEvidenceResponse[] = [];
  for (let offset = 0; offset < request.accounts.length; offset += MAX_SETTLEMENT_EVIDENCE_ACCOUNTS) {
    pages.push(await readEvidencePage(runtime, {
      type: 'settlement-evidence',
      book: request.book,
      accounts: request.accounts.slice(offset, offset + MAX_SETTLEMENT_EVIDENCE_ACCOUNTS),
    }));
  }
  const first = pages[0];
  if (!first) throw new Error('PRODUCTION_SWAP_SETTLEMENT_EVIDENCE_PAGE_MISSING');
  const queueFingerprint = safeStringify(first.queues);
  const bookFingerprint = safeStringify(first.book);
  if (pages.some(page => page.runtimeHeight !== first.runtimeHeight ||
    safeStringify(page.queues) !== queueFingerprint || safeStringify(page.book) !== bookFingerprint)) {
    return null;
  }
  return { ...first, accounts: pages.flatMap(page => page.accounts) };
};

const runtimeEvidence = (
  role: RuntimeRole,
  response: SettlementEvidenceResponse,
): ProductionSwapSettlementEvidence['runtimes'][number] => ({
  role,
  processing: response.queues.processing.count,
  pendingOutputs: response.queues.pendingOutputs.count,
  pendingNetworkOutputs: response.queues.pendingNetworkOutputs.count,
  networkInbox: response.queues.networkInbox.count,
  runtimeEntityInputs: response.queues.runtimeEntityInputs.count,
  runtimeTxs: response.queues.runtimeTxs.count,
  runtimeJInputs: response.queues.runtimeJInputs.count,
  retryEntries: response.queues.retryEntries.count,
  pendingReceipts: response.queues.pendingReceipts.count,
});

const requireAccount = (
  response: SettlementEvidenceResponse,
  entityId: string,
  counterpartyEntityId: string,
): AccountResponse => {
  const matches = response.accounts.filter(account =>
    account.entityId === entityId && account.counterpartyEntityId === counterpartyEntityId);
  if (matches.length !== 1) throw new Error(`PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_RESPONSE_NOT_UNIQUE:${entityId}:${counterpartyEntityId}`);
  return matches[0]!;
};

const sameOfferIds = (account: AccountResponse, ids: readonly string[]): boolean =>
  account.offers.length === ids.length && account.offers.every((offer, index) => offer.offerId === ids[index]);

const combineAccount = (
  pair: SettlementAccountPair,
  hub: SettlementEvidenceResponse,
  load: SettlementEvidenceResponse,
): ProductionSwapSettlementEvidence['accounts'][number] | null => {
  const hubAccount = requireAccount(hub, pair.hubEntityId, pair.loadEntityId);
  const loadAccount = requireAccount(load, pair.loadEntityId, pair.hubEntityId);
  if (!sameOfferIds(hubAccount, pair.offerIds) || !sameOfferIds(loadAccount, pair.offerIds)) {
    throw new Error(`PRODUCTION_SWAP_SETTLEMENT_OFFER_RESPONSE_MISMATCH:${hubAccount.accountKey}`);
  }
  // Account consensus is bilateral: one Runtime may expose H+1 a network tick
  // before its peer. That is ordinary in-flight work, not divergence. A result
  // is authoritative only after both certified heads are byte-identical.
  if (!sameBilateralAccountHead(hubAccount, loadAccount)) return null;
  const committed = pair.offerIds.filter((_id, index) =>
    hubAccount.offers[index]!.offerCommitted && loadAccount.offers[index]!.offerCommitted);
  const resolved = pair.offerIds.filter((_id, index) =>
    hubAccount.offers[index]!.resolveCommitted && loadAccount.offers[index]!.resolveCommitted &&
    hubAccount.offers[index]!.closed && loadAccount.offers[index]!.closed);
  const live = pair.offerIds.filter((_id, index) =>
    hubAccount.offers[index]!.live || loadAccount.offers[index]!.live);
  return {
    accountKey: hubAccount.accountKey,
    createdOfferIds: pair.offerIds,
    committedOfferIds: committed,
    committedResolveIds: resolved,
    liveOfferIds: live,
    pendingFrame: hubAccount.pendingFrame || loadAccount.pendingFrame,
    pendingProposal: hubAccount.pendingProposal || loadAccount.pendingProposal,
    mempoolTxs: hubAccount.mempool.count + loadAccount.mempool.count,
  };
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const waitForFullySettledEvidence = async (options: {
  hub: ConnectedRuntime;
  load: ConnectedRuntime;
  marketMaker: ConnectedRuntime;
  hubBookEntityId: string;
  pairs: readonly SettlementAccountPair[];
  tradeCountBefore: number;
  expectedSwaps: number;
  matchedElapsedMs: number;
  startedAt: number;
  timeoutMs?: number;
}): Promise<ProductionSwapSettlementEvidence> => {
  const deadline = performance.now() + (options.timeoutMs ?? 60_000);
  const emptyRequest: SettlementEvidenceRequest = { type: 'settlement-evidence', book: null, accounts: [] };
  while (performance.now() <= deadline) {
    const [hub, load, marketMaker] = await Promise.all([
      readEvidence(options.hub, requestFor(options.pairs, 'hub', options.hubBookEntityId)),
      readEvidence(options.load, requestFor(options.pairs, 'load', options.hubBookEntityId)),
      readEvidence(options.marketMaker, emptyRequest),
    ]);
    if (hub === null || load === null || marketMaker === null) {
      await sleep(20);
      continue;
    }
    const accounts: ProductionSwapSettlementEvidence['accounts'][number][] = [];
    for (const pair of options.pairs) {
      const account = combineAccount(pair, hub, load);
      if (account === null) break;
      accounts.push(account);
    }
    if (accounts.length !== options.pairs.length) {
      await sleep(20);
      continue;
    }
    const book = hub.book;
    if (!book || book.entityId !== options.hubBookEntityId || book.pairId !== PRODUCTION_SWAP_LOAD_PAIR_ID) {
      throw new Error('PRODUCTION_SWAP_SETTLEMENT_BOOK_EVIDENCE_MISSING');
    }
    const evidence: ProductionSwapSettlementEvidence = {
      expectedSwaps: options.expectedSwaps,
      tradeCountBefore: options.tradeCountBefore,
      tradeCountAfter: book.tradeCount,
      matchedElapsedMs: options.matchedElapsedMs,
      fullySettledElapsedMs: Math.max(1, Math.ceil(performance.now() - options.startedAt)),
      createdOfferIds: options.pairs.flatMap(pair => pair.offerIds),
      accounts,
      runtimes: [runtimeEvidence('hub', hub), runtimeEvidence('load', load), runtimeEvidence('market-maker', marketMaker)],
      bestBidPriceTicks: book.bestBidPriceTicks,
      bestAskPriceTicks: book.bestAskPriceTicks,
    };
    const accountsReady = evidence.accounts.every(account =>
      account.committedOfferIds.length === account.createdOfferIds.length &&
      account.committedResolveIds.length === account.createdOfferIds.length &&
      account.liveOfferIds.length === 0 && !account.pendingFrame &&
      !account.pendingProposal && account.mempoolTxs === 0);
    const runtimesReady = evidence.runtimes.every(runtime => Object.entries(runtime)
      .every(([key, value]) => key === 'role' || value === 0));
    if (accountsReady && runtimesReady) {
      assertProductionSwapFullySettled(evidence);
      return evidence;
    }
    await sleep(20);
  }
  throw new Error('PRODUCTION_SWAP_SETTLEMENT_TIMEOUT');
};

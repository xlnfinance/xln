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
} from '../../../api/runtime-adapter/control/settlement-evidence';
import { RuntimeAdapterError } from '../../../api/runtime-adapter/errors';
import { safeStringify } from '../../../protocol/serialization';
import { assertProductionSwapFullySettled, type ProductionSwapSettlementEvidence } from './settlement';
import { PRODUCTION_SWAP_LOAD_PAIR_ID, type ConnectedRuntime } from './worker-runtime';

export type SettlementAccountPair = Readonly<{
  hubEntityId: string;
  loadEntityId: string;
  offerIds: readonly string[];
}>;

type RuntimeRole = ProductionSwapSettlementEvidence['runtimes'][number]['role'];
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
// Evidence reads walk history views on the Hub under test; polling every few
// milliseconds would measure the poller, not settlement.
const SETTLEMENT_POLL_MS = 250;
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

/**
 * A rate-limited page is an observation gap, not settlement evidence: the
 * poll simply reads again after the adapter's own retry hint. The production
 * per-client budget stays untouched on hubs; only the driver backs off.
 */
const readEvidencePage = async (
  runtime: ConnectedRuntime,
  request: SettlementEvidenceRequest,
): Promise<SettlementEvidenceResponse | null> => {
  try {
    return decodeSettlementEvidenceResponse(await runtime.adapter.control<unknown>(request));
  } catch (error) {
    if (error instanceof RuntimeAdapterError && error.code === 'E_RATE_LIMITED') {
      await sleep(Math.max(20, error.retryAfterMs ?? 200));
      return null;
    }
    throw error;
  }
};

const readEvidence = async (
  runtime: ConnectedRuntime,
  request: SettlementEvidenceRequest,
): Promise<SettlementEvidenceResponse | null> => {
  if (request.accounts.length === 0) return readEvidencePage(runtime, request);
  const pages: SettlementEvidenceResponse[] = [];
  // The daemon bounds one request by accounts and by total offer ids; a
  // sustained run carries hundreds of offers per account, so page by both.
  const MAX_SETTLEMENT_EVIDENCE_OFFERS = 4_096;
  type EvidenceAccount = SettlementEvidenceRequest['accounts'][number];
  const accountPages: EvidenceAccount[][] = [];
  let current: EvidenceAccount[] = [];
  let currentOffers = 0;
  for (const account of request.accounts) {
    if (current.length > 0 && (
      current.length >= MAX_SETTLEMENT_EVIDENCE_ACCOUNTS ||
      currentOffers + account.offerIds.length > MAX_SETTLEMENT_EVIDENCE_OFFERS
    )) {
      accountPages.push(current);
      current = [];
      currentOffers = 0;
    }
    current.push(account);
    currentOffers += account.offerIds.length;
  }
  if (current.length > 0) accountPages.push(current);
  for (const accounts of accountPages) {
    const page = await readEvidencePage(runtime, { type: 'settlement-evidence', book: request.book, accounts });
    if (page === null) return null;
    pages.push(page);
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

/** One user Runtime per lane: each reads only its own bilateral Account with the Hub. */
export type LoadRuntimeGroup = Readonly<{ runtime: ConnectedRuntime; pairs: readonly SettlementAccountPair[] }>;

const sumQueues = (
  responses: readonly SettlementEvidenceResponse[],
): SettlementEvidenceResponse['queues'] => {
  const first = responses[0];
  if (!first) throw new Error('PRODUCTION_SWAP_SETTLEMENT_LOAD_RUNTIMES_EMPTY');
  const keys = Object.keys(first.queues) as Array<keyof SettlementEvidenceResponse['queues']>;
  return Object.fromEntries(keys.map(key => [
    key,
    { count: responses.reduce((total, response) => total + response.queues[key].count, 0) },
  ])) as SettlementEvidenceResponse['queues'];
};

const readLoadEvidence = async (
  groups: readonly LoadRuntimeGroup[],
  hubBookEntityId: string,
): Promise<SettlementEvidenceResponse | null> => {
  const responses = await Promise.all(groups.map(group =>
    readEvidence(group.runtime, requestFor(group.pairs, 'load', hubBookEntityId))));
  if (responses.some(response => response === null)) return null;
  const pages = responses as SettlementEvidenceResponse[];
  return { ...pages[0]!, accounts: pages.flatMap(page => page.accounts), queues: sumQueues(pages) };
};

export const waitForFullySettledEvidence = async (options: {
  hub: ConnectedRuntime;
  load: readonly LoadRuntimeGroup[];
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
      readLoadEvidence(options.load, options.hubBookEntityId),
      readEvidence(options.marketMaker, emptyRequest),
    ]);
    if (hub === null || load === null || marketMaker === null) {
      await sleep(SETTLEMENT_POLL_MS);
      continue;
    }
    const accounts: ProductionSwapSettlementEvidence['accounts'][number][] = [];
    for (const pair of options.pairs) {
      const account = combineAccount(pair, hub, load);
      if (account === null) break;
      accounts.push(account);
    }
    if (accounts.length !== options.pairs.length) {
      await sleep(SETTLEMENT_POLL_MS);
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
    if (performance.now() + SETTLEMENT_POLL_MS > deadline) {
      console.error('[load] settlement not ready', JSON.stringify({
        accounts: evidence.accounts.filter(account => account.liveOfferIds.length || account.pendingFrame ||
          account.pendingProposal || account.mempoolTxs ||
          account.committedOfferIds.length !== account.createdOfferIds.length ||
          account.committedResolveIds.length !== account.createdOfferIds.length).slice(0, 3),
        runtimes: evidence.runtimes,
      }));
    }
    await sleep(SETTLEMENT_POLL_MS);
  }
  throw new Error('PRODUCTION_SWAP_SETTLEMENT_TIMEOUT');
};

/**
 * Reads authenticated operator settlement evidence from every production
 * Runtime and combines matching bilateral Account replicas. It never infers
 * completion from the orderbook counter alone.
 */

import {
  decodeSettlementEvidenceResponse,
  type SettlementEvidenceRequest,
  type SettlementEvidenceResponse,
} from '../../../../api/runtime-adapter/control/settlement-evidence';
import { assertProductionSwapFullySettled, type ProductionSwapSettlementEvidence } from './settlement';
import { readLoadBook, type ConnectedRuntime } from './worker-runtime';

export type SettlementAccountPair = Readonly<{
  hubEntityId: string;
  loadEntityId: string;
  offerIds: readonly string[];
}>;

type RuntimeRole = ProductionSwapSettlementEvidence['runtimes'][number]['role'];
type AccountResponse = SettlementEvidenceResponse['accounts'][number];

const requestFor = (
  pairs: readonly SettlementAccountPair[],
  side: 'hub' | 'load',
): SettlementEvidenceRequest => ({
  type: 'settlement-evidence',
  accounts: pairs.map(pair => side === 'hub'
    ? { entityId: pair.hubEntityId, counterpartyEntityId: pair.loadEntityId, offerIds: pair.offerIds }
    : { entityId: pair.loadEntityId, counterpartyEntityId: pair.hubEntityId, offerIds: pair.offerIds }),
});

const readEvidence = async (
  runtime: ConnectedRuntime,
  request: SettlementEvidenceRequest,
): Promise<SettlementEvidenceResponse> =>
  decodeSettlementEvidenceResponse(await runtime.adapter.control<unknown>(request));

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
): ProductionSwapSettlementEvidence['accounts'][number] => {
  const hubAccount = requireAccount(hub, pair.hubEntityId, pair.loadEntityId);
  const loadAccount = requireAccount(load, pair.loadEntityId, pair.hubEntityId);
  if (!sameOfferIds(hubAccount, pair.offerIds) || !sameOfferIds(loadAccount, pair.offerIds)) {
    throw new Error(`PRODUCTION_SWAP_SETTLEMENT_OFFER_RESPONSE_MISMATCH:${hubAccount.accountKey}`);
  }
  if (hubAccount.accountKey !== loadAccount.accountKey || hubAccount.currentHeight !== loadAccount.currentHeight ||
    hubAccount.currentStateHash !== loadAccount.currentStateHash) {
    throw new Error(`PRODUCTION_SWAP_SETTLEMENT_BILATERAL_HEAD_MISMATCH:${hubAccount.accountKey}`);
  }
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
  const emptyRequest: SettlementEvidenceRequest = { type: 'settlement-evidence', accounts: [] };
  while (performance.now() <= deadline) {
    const [hub, load, marketMaker, book] = await Promise.all([
      readEvidence(options.hub, requestFor(options.pairs, 'hub')),
      readEvidence(options.load, requestFor(options.pairs, 'load')),
      readEvidence(options.marketMaker, emptyRequest),
      readLoadBook(options.hub, options.hubBookEntityId),
    ]);
    const evidence: ProductionSwapSettlementEvidence = {
      expectedSwaps: options.expectedSwaps,
      tradeCountBefore: options.tradeCountBefore,
      tradeCountAfter: book.tradeCount,
      matchedElapsedMs: options.matchedElapsedMs,
      fullySettledElapsedMs: Math.max(1, Math.ceil(performance.now() - options.startedAt)),
      createdOfferIds: options.pairs.flatMap(pair => pair.offerIds),
      accounts: options.pairs.map(pair => combineAccount(pair, hub, load)),
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

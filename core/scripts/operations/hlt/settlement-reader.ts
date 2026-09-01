/**
 * Reads authenticated operator settlement evidence from every production
 * Runtime and combines matching bilateral Account replicas. It never infers
 * completion from the orderbook counter alone.
 */

import { forEachLimited } from '../../../support/collections/for-each-limited';
import {
  decodeSettlementEvidenceResponse,
  MAX_PENDING_ACCOUNT_SAMPLE,
  MAX_SETTLEMENT_EVIDENCE_ACCOUNTS,
  type SettlementEvidenceRequest,
  type SettlementEvidenceResponse,
} from '../../../api/runtime-adapter/control/settlement-evidence';
import { RuntimeAdapterError } from '../../../api/runtime-adapter/errors';
import { safeStringify } from '../../../protocol/serialization';
import { assertProductionSwapFullySettled, type ProductionSwapSettlementEvidence } from './settlement';
import {
  PRODUCTION_SWAP_LOAD_PAIR_ID,
  reconnectRuntimeControl,
  type ConnectedRuntime,
} from './worker-runtime';

export type SettlementAccountPair = Readonly<{
  hubEntityId: string;
  loadEntityId: string;
  offerIds: readonly string[];
}>;

type RuntimeRole = ProductionSwapSettlementEvidence['runtimes'][number]['role'];
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
// Evidence reads hold a short committed-state lease on the Hub under test;
// polling every few milliseconds would measure the poller, not settlement.
const SETTLEMENT_POLL_MS = 250;
// The measured phase reads only the Hub's compact committed counters. User
// Runtime state is intentionally untouched until matching has completed, so
// population size must not degrade the timestamp to a two-second grid.
const SETTLEMENT_POLL_WIDE_MS = 100;
const LOAD_EVIDENCE_CONCURRENCY = 8;
const settlementPollMs = (pairCount: number): number =>
  pairCount > 64 ? SETTLEMENT_POLL_WIDE_MS : SETTLEMENT_POLL_MS;

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
    if (
      error instanceof RuntimeAdapterError &&
      (error.code === 'E_RATE_LIMITED' || error.retryable)
    ) {
      // Hub frames at 1000 users can block the adapter for >10s and close the
      // socket (1000c: runtime adapter socket closed after trades 5000/5000).
      // That is an observation gap; the adapter reconnects.
      await sleep(Math.max(20, error.retryAfterMs ?? 200));
      if (request.book !== null) {
        console.error('[load] hub evidence miss', JSON.stringify({
          code: error.code,
          retryable: error.retryable,
          message: error.message.slice(0, 160),
          accounts: request.accounts.length,
        }));
      }
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
  const sampleFingerprint = safeStringify(first.pendingAccountSample);
  if (pages.some(page => page.runtimeHeight !== first.runtimeHeight ||
    safeStringify(page.queues) !== queueFingerprint ||
    safeStringify(page.book) !== bookFingerprint ||
    safeStringify(page.pendingAccountSample) !== sampleFingerprint)) {
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
  pendingAccountFrames: response.queues.pendingAccountFrames.count,
});

const requireAccount = (
  response: SettlementEvidenceResponse,
  entityId: string,
  counterpartyEntityId: string,
): AccountResponse => {
  const matches = response.accounts.filter(account =>
    account.entityId === entityId && account.counterpartyEntityId === counterpartyEntityId);
  if (matches.length !== 1) throw new Error(`PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_RESPONSE_NOT_UNIQUE:${entityId}:${counterpartyEntityId}`);
  const match = matches[0];
  if (!match) throw new Error(`PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_RESPONSE_MISSING:${entityId}:${counterpartyEntityId}`);
  return match;
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
  const live = pair.offerIds.filter((_id, index) =>
    hubAccount.offers[index]!.live || loadAccount.offers[index]!.live);
  return {
    accountKey: hubAccount.accountKey,
    createdOfferIds: pair.offerIds,
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

const mergePendingAccountSample = (
  responses: readonly SettlementEvidenceResponse[],
): SettlementEvidenceResponse['pendingAccountSample'] =>
  responses.flatMap(page => page.pendingAccountSample).slice(0, MAX_PENDING_ACCOUNT_SAMPLE);

const readLoadEvidence = async (
  groups: readonly LoadRuntimeGroup[],
  hubBookEntityId: string,
): Promise<SettlementEvidenceResponse | null> => {
  const responses: Array<SettlementEvidenceResponse | null> = groups.map(() => null);
  await forEachLimited(
    groups.map((group, index) => ({ group, index })),
    LOAD_EVIDENCE_CONCURRENCY,
    async ({ group, index }) => {
      responses[index] = await readEvidence(
        group.runtime,
        requestFor(group.pairs, 'load', hubBookEntityId),
      );
    },
  );
  if (responses.some(response => response === null)) return null;
  const pages = responses as SettlementEvidenceResponse[];
  return {
    ...pages[0]!,
    accounts: pages.flatMap(page => page.accounts),
    queues: sumQueues(pages),
    pendingAccountSample: mergePendingAccountSample(pages),
  };
};

const EMPTY_ACCOUNTS_REQUEST: SettlementEvidenceRequest = { type: 'settlement-evidence', book: null, accounts: [] };

const readLoadLite = async (
  groups: readonly LoadRuntimeGroup[],
): Promise<SettlementEvidenceResponse | null> => {
  const responses: Array<SettlementEvidenceResponse | null> = groups.map(() => null);
  await forEachLimited(
    groups.map((group, index) => ({ group, index })),
    LOAD_EVIDENCE_CONCURRENCY,
    async ({ group, index }) => {
      responses[index] = await readEvidence(group.runtime, EMPTY_ACCOUNTS_REQUEST);
    },
  );
  if (responses.some(response => response === null)) return null;
  const pages = responses as SettlementEvidenceResponse[];
  return {
    ...pages[0]!,
    accounts: [],
    queues: sumQueues(pages),
    pendingAccountSample: mergePendingAccountSample(pages),
  };
};


/**
 * Timeout post-mortem per the drain playbook: for each stuck Hub pair, read
 * the USER-side replica of that bilateral account and print the height diff
 * (hub pending height vs user current/pending/ack heights). This names the
 * side that dropped the ball instead of guessing "resend is broken".
 */
const dumpStuckCounterpartyState = async (
  load: readonly LoadRuntimeGroup[],
  sample: SettlementEvidenceResponse['pendingAccountSample'],
): Promise<void> => {
  for (const entry of sample.slice(0, 4)) {
    const group = load.find(candidate =>
      candidate.pairs.some(pair => pair.loadEntityId === entry.counterpartyEntityId));
    if (!group) {
      console.error(JSON.stringify({ stuckDump: 'lane-not-found', counterparty: entry.counterpartyEntityId.slice(-8), hubPendingHeight: entry.height }));
      continue;
    }
    try {
      const pair = group.pairs.find(candidate =>
        candidate.hubEntityId === entry.entityId && candidate.loadEntityId === entry.counterpartyEntityId);
      if (!pair) throw new Error('PRODUCTION_SWAP_SETTLEMENT_STUCK_PAIR_MISSING');
      const response = await readEvidence(
        group.runtime,
        requestFor([pair], 'load', entry.entityId),
      );
      const account = response?.accounts[0];
      console.error(JSON.stringify({
        stuckDump: 'counterparty-view',
        counterparty: entry.counterpartyEntityId.slice(-8),
        hub: entry,
        user: account ?? null,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        stuckDump: 'counterparty-read-failed',
        counterparty: entry.counterpartyEntityId.slice(-8),
        error: error instanceof Error ? error.message.slice(0, 120) : String(error),
      }));
    }
  }
};

const queuesBusy = (response: SettlementEvidenceResponse): boolean =>
  Object.values(response.queues).some(queue => queue.count > 0);

export const waitForExpectedMatchedTrades = async (options: Readonly<{
  hub: ConnectedRuntime;
  hubBookEntityId: string;
  tradeCountBefore: number;
  expectedMatchedTrades: number;
  startedAt: number;
  timeoutMs?: number;
  allowAdditionalTrades?: boolean;
  acceptDrainedBelowTarget?: boolean;
}>): Promise<Readonly<{ matchedTrades: number; matchedElapsedMs: number }>> => {
  const deadline = performance.now() + (
    options.timeoutMs ?? Number(process.env['XLN_LOAD_TRADE_DRAIN_TIMEOUT_MS'] || 60_000)
  );
  const request: SettlementEvidenceRequest = {
    type: 'settlement-evidence',
    book: { entityId: options.hubBookEntityId, pairId: PRODUCTION_SWAP_LOAD_PAIR_ID },
    accounts: [],
  };
  const target = options.tradeCountBefore + options.expectedMatchedTrades;
  let matchedElapsedMs: number | null = null;
  let lastTradeCount: number | undefined;
  let lastLiveOrderCount: number | undefined;
  // A silent wait that ends in a timeout says nothing about whether the book
  // was still moving. Report the trajectory so slow and stuck are separable
  // from the log alone, without a second instrumented run.
  let nextReportAt = performance.now();
  while (performance.now() <= deadline) {
    const evidence = await readEvidence(options.hub, request);
    const tradeCount = evidence?.book?.tradeCount;
    const tradeCountChanged = tradeCount !== undefined && tradeCount !== lastTradeCount;
    lastLiveOrderCount = evidence?.book?.liveOrderCount ?? lastLiveOrderCount;
    if (tradeCount !== undefined && tradeCount > target && !options.allowAdditionalTrades) {
      throw new Error(`PRODUCTION_SWAP_LOAD_UNEXPECTED_CONCURRENT_TRADES:${tradeCount}:${target}`);
    }
    const targetReached = tradeCount !== undefined && (
      options.allowAdditionalTrades ? tradeCount >= target : tradeCount === target
    );
    if (targetReached && (matchedElapsedMs === null || tradeCountChanged)) {
      matchedElapsedMs = Math.max(1, Math.ceil(performance.now() - options.startedAt));
    }
    lastTradeCount = tradeCount ?? lastTradeCount;
    const drained = evidence !== null && !queuesBusy(evidence);
    if (performance.now() >= nextReportAt) {
      nextReportAt = performance.now() + 5_000;
      console.log(`[load] trade drain ${JSON.stringify({
        trades: lastTradeCount ?? null,
        target,
        liveOrders: lastLiveOrderCount ?? null,
        // A crossed book (bid >= ask) that stops moving is a matcher defect;
        // an uncrossed one means the two legs of a pair never faced each other.
        bestBid: evidence?.book?.bestBidPriceTicks?.toString() ?? null,
        bestAsk: evidence?.book?.bestAskPriceTicks?.toString() ?? null,
        drained,
        queues: evidence ? Object.fromEntries(
          Object.entries(evidence.queues).filter(([, queue]) => queue.count > 0)
            .map(([name, queue]) => [name, queue.count]),
        ) : null,
        elapsedMs: Math.round(performance.now() - options.startedAt),
      })}`);
    }
    if (drained && (targetReached || options.acceptDrainedBelowTarget)) {
      matchedElapsedMs ??= Math.max(1, Math.ceil(performance.now() - options.startedAt));
      return {
        matchedTrades: (tradeCount ?? options.tradeCountBefore) - options.tradeCountBefore,
        matchedElapsedMs,
      };
    }
    await sleep(SETTLEMENT_POLL_WIDE_MS);
  }
  // Name the orders that are still resting. Without them the timeout cannot
  // distinguish a stranded counterparty from an uncrossed price.
  const stuck = await readEvidence(options.hub, request);
  console.error(`[load] trade drain stuck ${JSON.stringify({
    bestBid: stuck?.book?.bestBidPriceTicks?.toString() ?? null,
    bestAsk: stuck?.book?.bestAskPriceTicks?.toString() ?? null,
    liveOrders: (stuck?.book?.liveOrderSample ?? []).map(order => ({
      orderId: order.orderId,
      owner: order.ownerId.slice(-8),
      side: order.side === 0 ? 'bid' : 'ask',
      price: order.priceTicks.toString(),
      qty: order.qtyLots.toString(),
    })),
  })}`);
  throw new Error(
    `PRODUCTION_SWAP_LOAD_MATCH_TIMEOUT:actual=${String(lastTradeCount)}:target=${target}:` +
    `liveOrders=${String(lastLiveOrderCount)}`,
  );
};

export const waitForRestingMakerOffers = async (options: Readonly<{
  hub: ConnectedRuntime;
  hubBookEntityId: string;
  pairs: readonly SettlementAccountPair[];
  timeoutMs?: number;
}>): Promise<void> => {
  const deadline = performance.now() + (
    options.timeoutMs ?? Number(process.env['XLN_LOAD_TRADE_DRAIN_TIMEOUT_MS'] || 60_000)
  );
  const request = requestFor(options.pairs, 'hub', options.hubBookEntityId);
  let lastEvidence: SettlementEvidenceResponse | null = null;
  while (performance.now() <= deadline) {
    const evidence = await readEvidence(options.hub, request);
    lastEvidence = evidence ?? lastEvidence;
    const ready = evidence?.accounts.length === options.pairs.length &&
      evidence.accounts.every(account => account.offers.length === 1 &&
        account.offers[0]?.live === true);
    if (ready) return;
    await sleep(SETTLEMENT_POLL_WIDE_MS);
  }
  const notReady = lastEvidence?.accounts.filter(account =>
    account.offers.length !== 1 || account.offers[0]?.live !== true) ?? [];
  console.error('[load] maker rest timeout', safeStringify({
    expected: options.pairs.length,
    observed: lastEvidence?.accounts.length ?? 0,
    ready: (lastEvidence?.accounts.length ?? 0) - notReady.length,
    sample: notReady.slice(0, 5),
    queues: lastEvidence?.queues ?? null,
    pendingAccountSample: lastEvidence?.pendingAccountSample ?? null,
  }));
  throw new Error(`PRODUCTION_SWAP_LOAD_MAKER_REST_TIMEOUT:${options.pairs.length}`);
};

/**
 * Report every planned offer the Hub still holds as a committed Account row.
 * An offer live here while the book has no matching order is the exact
 * divergence a trade shortfall hides: the maker's capacity stays locked
 * bilaterally, but no counterparty can ever reach it.
 */
export const reportHubCommittedOffers = async (
  hub: ConnectedRuntime,
  hubBookEntityId: string,
  pairs: readonly SettlementAccountPair[],
): Promise<void> => {
  const live: string[] = [];
  for (let start = 0; start < pairs.length; start += 256) {
    const evidence = await readEvidence(hub, {
      type: 'settlement-evidence',
      book: { entityId: hubBookEntityId, pairId: PRODUCTION_SWAP_LOAD_PAIR_ID },
      accounts: pairs.slice(start, start + 256).map(pair => ({
        entityId: pair.hubEntityId,
        counterpartyEntityId: pair.loadEntityId,
        offerIds: pair.offerIds,
      })),
    });
    for (const account of evidence?.accounts ?? []) {
      for (const offer of account.offers) if (offer.live) live.push(offer.offerId);
    }
  }
  console.error(`[load] hub committed offers ${JSON.stringify({
    liveInHubAccounts: live.length,
    sample: live.slice(0, 24),
  })}`);
};

export const waitForFullySettledEvidence = async (options: {
  hub: ConnectedRuntime;
  load: readonly LoadRuntimeGroup[];
  marketMaker: ConnectedRuntime;
  hubBookEntityId: string;
  pairs: readonly SettlementAccountPair[];
  tradeCountBefore: number;
  expectedSubmittedOffers: number;
  expectedMatchedTrades: number;
  cancelledOffers: number;
  startedAt: number;
  matchedElapsedMs?: number;
  timeoutMs?: number;
}): Promise<ProductionSwapSettlementEvidence> => {
  const deadline = performance.now() + (
    options.timeoutMs ?? Number(process.env['XLN_LOAD_TRADE_DRAIN_TIMEOUT_MS'] || 60_000)
  );
  const pollMs = settlementPollMs(options.pairs.length);
  const hubLiteRequest: SettlementEvidenceRequest = {
    type: 'settlement-evidence',
    book: { entityId: options.hubBookEntityId, pairId: PRODUCTION_SWAP_LOAD_PAIR_ID },
    accounts: [],
  };
  let lastProgressAt = 0;
  let lastTradeCount = options.tradeCountBefore;
  let matchedElapsedMs: number | null = options.matchedElapsedMs ?? null;
  let hubLiteLastSample: SettlementEvidenceResponse['pendingAccountSample'] = [];
  let loadControlConnected = false;
  while (performance.now() <= deadline) {
    // The Hub is the causal source for matching and every bilateral output.
    // Poll it alone until matching and its queues drain. Fan-out reads across
    // hundreds of sovereign user Runtimes during active settlement steal CPU
    // from the very nodes under test and cannot prove completion any earlier.
    const hubLite = await readEvidence(options.hub, hubLiteRequest);
    const liteBook = hubLite?.book;
    if (liteBook) {
      const targetTradeCount = options.tradeCountBefore + options.expectedMatchedTrades;
      if (liteBook.tradeCount > targetTradeCount) {
        throw new Error(
          `PRODUCTION_SWAP_LOAD_UNEXPECTED_CONCURRENT_TRADES:${liteBook.tradeCount}:${targetTradeCount}`,
        );
      }
      if (liteBook.tradeCount !== lastTradeCount) {
        lastTradeCount = liteBook.tradeCount;
        console.log(
          `[load] trades ${liteBook.tradeCount}/${targetTradeCount} ` +
          `liveOrders=${liteBook.liveOrderCount}`,
        );
      }
      if (liteBook.tradeCount === targetTradeCount && matchedElapsedMs === null) {
        matchedElapsedMs = Math.max(1, Math.ceil(performance.now() - options.startedAt));
      }
    }
    if (hubLite === null) {
      const now = performance.now();
      if (now - lastProgressAt >= 10_000 || now + pollMs > deadline) {
        console.error('[load] settlement evidence incomplete', JSON.stringify({
          hub: false,
          pairs: options.pairs.length, elapsedMs: Math.round(now - options.startedAt),
          hubQueues: null,
          hubPendingSample: null,
        }));
        lastProgressAt = now;
      }
      if (now + pollMs > deadline) break;
      await sleep(pollMs);
      continue;
    }
    const targetTradeCount = options.tradeCountBefore + options.expectedMatchedTrades;
    if (queuesBusy(hubLite) || liteBook?.tradeCount !== targetTradeCount) {
      hubLiteLastSample = hubLite.pendingAccountSample;
      const now = performance.now();
      if (now - lastProgressAt >= 10_000 || now + pollMs > deadline) {
        console.error('[load] settlement queues busy', JSON.stringify({
          elapsedMs: Math.round(now - options.startedAt),
          hubQueues: hubLite.queues,
          hubPendingSample: hubLite.pendingAccountSample,
        }));
        lastProgressAt = now;
      }
      if (now + pollMs > deadline) break;
      await sleep(pollMs);
      continue;
    }
    if (!loadControlConnected) {
      // Sovereign users have no frontend during the measured phase. Their
      // RuntimeAdapter control sockets are opened only after Hub matching and
      // queue drain, when the auditor needs exact bilateral completion state.
      await Promise.all(options.load.map(group => reconnectRuntimeControl(group.runtime)));
      loadControlConnected = true;
    }
    const [loadLite, marketMakerLite] = await Promise.all([
      readLoadLite(options.load),
      readEvidence(options.marketMaker, EMPTY_ACCOUNTS_REQUEST),
    ]);
    if (loadLite === null || marketMakerLite === null ||
      queuesBusy(loadLite) || queuesBusy(marketMakerLite)) {
      const now = performance.now();
      if (now - lastProgressAt >= 10_000 || now + pollMs > deadline) {
        console.error('[load] settlement peer queues busy', safeStringify({
          elapsedMs: Math.round(now - options.startedAt),
          loadQueues: loadLite?.queues ?? null,
          loadPendingSample: loadLite?.pendingAccountSample ?? null,
          marketMakerQueues: marketMakerLite?.queues ?? null,
        }));
        lastProgressAt = now;
      }
      if (now + pollMs > deadline) break;
      await sleep(pollMs);
      continue;
    }
    const [hub, load, marketMaker] = await Promise.all([
      readEvidence(options.hub, requestFor(options.pairs, 'hub', options.hubBookEntityId)),
      readLoadEvidence(options.load, options.hubBookEntityId),
      Promise.resolve(marketMakerLite),
    ]);
    if (hub === null || load === null || marketMaker === null) {
      const now = performance.now();
      if (now - lastProgressAt >= 10_000 || now + pollMs > deadline) {
        console.error('[load] settlement evidence incomplete', JSON.stringify({
          hub: hub !== null, load: load !== null, marketMaker: marketMaker !== null,
          pairs: options.pairs.length, elapsedMs: Math.round(now - options.startedAt),
          hubQueues: hub?.queues ?? null,
          hubPendingSample: hub?.pendingAccountSample ?? null,
          loadQueues: load?.queues ?? null,
          loadPendingSample: load?.pendingAccountSample ?? null,
        }));
        lastProgressAt = now;
      }
      if (now + pollMs > deadline) break;
      await sleep(pollMs);
      continue;
    }
    const accounts: ProductionSwapSettlementEvidence['accounts'][number][] = [];
    for (const pair of options.pairs) {
      const account = combineAccount(pair, hub, load);
      if (account === null) break;
      accounts.push(account);
    }
    if (accounts.length !== options.pairs.length) {
      const now = performance.now();
      if (now - lastProgressAt >= 10_000 || now + pollMs > deadline) {
        console.error('[load] settlement heads diverged', JSON.stringify({
          assembled: accounts.length, pairs: options.pairs.length,
          elapsedMs: Math.round(now - options.startedAt),
        }));
        lastProgressAt = now;
      }
      await sleep(pollMs);
      continue;
    }
    const book = hub.book;
    if (!book || book.entityId !== options.hubBookEntityId || book.pairId !== PRODUCTION_SWAP_LOAD_PAIR_ID) {
      throw new Error('PRODUCTION_SWAP_SETTLEMENT_BOOK_EVIDENCE_MISSING');
    }
    if (matchedElapsedMs === null) {
      throw new Error(
        `PRODUCTION_SWAP_LOAD_TRADE_NOT_COMMITTED:` +
        `${options.tradeCountBefore + options.expectedMatchedTrades}:reached=${book.tradeCount}`,
      );
    }
    const evidence: ProductionSwapSettlementEvidence = {
      expectedSubmittedOffers: options.expectedSubmittedOffers,
      expectedMatchedTrades: options.expectedMatchedTrades,
      cancelledOffers: options.cancelledOffers,
      tradeCountBefore: options.tradeCountBefore,
      tradeCountAfter: book.tradeCount,
      matchedElapsedMs,
      fullySettledElapsedMs: Math.max(1, Math.ceil(performance.now() - options.startedAt)),
      createdOfferIds: options.pairs.flatMap(pair => pair.offerIds),
      accounts,
      runtimes: [runtimeEvidence('hub', hub), runtimeEvidence('load', load), runtimeEvidence('market-maker', marketMaker)],
      bestBidPriceTicks: book.bestBidPriceTicks,
      bestAskPriceTicks: book.bestAskPriceTicks,
    };
    const accountsReady = evidence.accounts.every(account =>
      account.liveOfferIds.length === 0 && !account.pendingFrame &&
      !account.pendingProposal && account.mempoolTxs === 0);
    const runtimesReady = evidence.runtimes.every(runtime => Object.entries(runtime)
      .every(([key, value]) => key === 'role' || value === 0));
    if (accountsReady && runtimesReady) {
      assertProductionSwapFullySettled(evidence);
      return evidence;
    }
    if (performance.now() + pollMs > deadline) {
      console.error('[load] settlement not ready', JSON.stringify({
        accounts: evidence.accounts.filter(account => account.liveOfferIds.length || account.pendingFrame ||
          account.pendingProposal || account.mempoolTxs).slice(0, 3),
        runtimes: evidence.runtimes,
        hubPendingSample: hub.pendingAccountSample,
        loadPendingSample: load.pendingAccountSample,
      }));
    }
    await sleep(pollMs);
  }
  await dumpStuckCounterpartyState(options.load, hubLiteLastSample);
  throw new Error('PRODUCTION_SWAP_SETTLEMENT_TIMEOUT');
};

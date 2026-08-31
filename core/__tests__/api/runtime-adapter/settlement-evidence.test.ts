import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { expect, test } from 'bun:test';

import { decodeRuntimeAdapterBrowserMessage, decodeRuntimeAdapterMessage } from '../../../api/runtime-adapter/codec';
import {
  buildSettlementEvidence,
  decodeSettlementEvidenceRequest,
  decodeSettlementEvidenceResponse,
} from '../../../api/runtime-adapter/control/settlement-evidence';
import { handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';
import { validateRuntimeAdapterWireMessage } from '../../../api/runtime-adapter/wire-schema';
import { RuntimeAdapterError } from '../../../api/runtime-adapter/errors';
import { applyCommand, canonicalPair, createBook } from '../../../orderbook';
import { createEmptyEnv } from '../../../runtime';
import {
  addReplica,
  addr,
  entity,
  makeAccount,
  makeJurisdiction,
  makeState,
  openWritableEntityAccounts,
} from '../../helpers/cross-j';

const leftId = entity('11');
const rightId = entity('22');
const offerId = 'settlement-offer-1';

const makeSettlementEnv = (pending = false, stp = false) => {
  const env = createEmptyEnv('settlement-evidence');
  const signerId = addr('aa');
  const jurisdiction = makeJurisdiction('J1', 31_337, 'dd', 'ee');
  const state = makeState(leftId, signerId, jurisdiction);
  const pairId = canonicalPair(1, 2).pairId;
  let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 0 });
  book = applyCommand(book, {
    kind: 0, ownerId: rightId, orderId: 'resting-ask', side: 1, tif: 0,
    postOnly: true, priceTicks: 2n, qtyLots: 1n,
  }).state;
  state.orderbookExt = {
    books: new Map([[pairId, book]]), orderPairs: new Map(), pairDimensions: new Map(), referrals: new Map(),
    hubProfile: {
      entityId: leftId, name: 'Settlement hub', spreadDistribution: 'pro_rata', referenceTokenId: 1,
      usdQuoteAuthorityEntityId: leftId, minTradeSize: 1n, supportedPairs: [pairId],
    },
  };
  const account = makeAccount(leftId, rightId, jurisdiction);
  const offer = {
    offerId, giveTokenId: 1, giveTokenDecimals: 6, giveAmount: 10n,
    wantTokenId: 2, wantTokenDecimals: 18, wantAmount: 20n,
    maxFee: 0n, minNetReceive: 20n, priceTicks: 1n,
    makerIsLeft: true, createdHeight: 1, quantizedGive: 10n, quantizedWant: 20n,
  };
  account.currentHeight = 2;
  account.currentFrame = {
    ...account.currentFrame,
    height: 2,
    accountTxs: [{
      type: 'swap_offer', data: offer,
    }, {
      type: 'swap_resolve',
      data: {
        offerId,
        fillRatio: stp ? 0 : 65_535,
        cancelRemainder: true,
        ...(stp ? { comment: 'STP:self-resting-order' } : {}),
      },
    }],
    accountStateRoot: `0x${'12'.repeat(32)}`,
    stateHash: `0x${'34'.repeat(32)}`,
  };
  if (pending) {
    account.pendingFrame = account.currentFrame;
    account.pendingAccountInput = {
      kind: 'ack_frame',
      fromEntityId: leftId,
      toEntityId: rightId,
      domain: structuredClone(account.state.domain),
      disputeConfig: structuredClone(account.state.disputeConfig),
      proposal: { frame: structuredClone(account.currentFrame) },
    };
  }
  const accounts = openWritableEntityAccounts(state);
  accounts.set(rightId, account);
  state.accounts = accounts.sealCandidate();
  addReplica(env, state, signerId);
  return env;
};

const request = {
  type: 'settlement-evidence' as const,
  book: { entityId: leftId, pairId: canonicalPair(1, 2).pairId },
  accounts: [{ entityId: leftId, counterpartyEntityId: rightId, offerIds: [offerId] }],
};

test('settlement evidence returns exact queue digests and certified-frame lifecycle', async () => {
  const env = makeSettlementEnv();
  const account = Array.from(env.state.eReplicas.values())[0]!.state.accounts.get(rightId)!;
  const readFrames = async () => [account.currentFrame];
  const decodedRequest = decodeSettlementEvidenceRequest(request);
  const response = decodeSettlementEvidenceResponse(
    await buildSettlementEvidence(env, decodedRequest, readFrames),
  );
  expect(response.queues.pendingOutputs.count).toBe(0);
  expect(response.queues.pendingAccountFrames.count).toBe(0);
  expect(response.pendingAccountSample).toEqual([]);
  const pendingEnv = makeSettlementEnv(true);
  const pendingAccount = Array.from(pendingEnv.state.eReplicas.values())[0]!.state.accounts.get(rightId)!;
  const pending = decodeSettlementEvidenceResponse(
    await buildSettlementEvidence(pendingEnv, decodedRequest, async () => [pendingAccount.currentFrame]),
  );
  expect(pending.queues.pendingAccountFrames.count).toBe(1);
  expect(pending.pendingAccountSample).toEqual([{
    entityId: leftId,
    counterpartyEntityId: rightId,
    localIsLeft: true,
    currentHeight: 2,
    currentStateHash: `0x${'34'.repeat(32)}`,
    height: 2,
    pendingFrameHash: `0x${'34'.repeat(32)}`,
    pendingFrameTxCount: 2,
    pendingInputKind: 'frame',
    pendingAckHeight: null,
    pendingProposalHeight: 2,
    lastOutboundAckHeight: null,
    rollbackCount: 0,
    lastRollbackFrameHash: null,
    mempoolCount: 0,
  }]);
  expect(response.queues.pendingOutputs.digest).toMatch(/^0x[0-9a-f]{64}$/);
  expect(response.book).toEqual({
    entityId: leftId,
    pairId: canonicalPair(1, 2).pairId,
    tradeCount: 0,
    bestBidPriceTicks: null,
    bestAskPriceTicks: 2n,
    liveOrderCount: 1,
    digest: expect.stringMatching(/^0x[0-9a-f]{64}$/),
  });
  expect(response.accounts[0]?.offers).toEqual([{
    offerId, offerCommitted: true, resolveCommitted: true, stpCommitted: false, live: false, closed: true,
  }]);
  expect(() => decodeSettlementEvidenceRequest({ ...request, extra: true }))
    .toThrow('RADAPTER_SETTLEMENT_REQUEST_FIELDS_INVALID');
  expect(() => decodeSettlementEvidenceResponse({
    ...response,
    queues: { ...response.queues, pendingOutputs: { count: 0, digest: 'bad' } },
  })).toThrow('RADAPTER_SETTLEMENT_RESPONSE_QUEUE_INVALID:pendingOutputs_DIGEST');
  expect(() => decodeSettlementEvidenceResponse({
    ...response,
    book: { ...response.book, liveOrderCount: 'all' },
  })).toThrow('RADAPTER_SETTLEMENT_BOOK_RESPONSE_LIVE_COUNT_INVALID');
});

test('settlement evidence classifies only a persisted head behind live state as retryable', async () => {
  const env = makeSettlementEnv();
  const account = Array.from(env.state.eReplicas.values())[0]!.state.accounts.get(rightId)!;
  const staleFrame = { ...account.currentFrame, height: account.currentHeight - 1 };
  const behind = await buildSettlementEvidence(env, request, async () => [staleFrame])
    .then(() => null, error => error);
  expect(behind).toBeInstanceOf(RuntimeAdapterError);
  expect(behind).toMatchObject({ code: 'E_INTERNAL', retryable: true });

  const divergentFrame = { ...account.currentFrame, stateHash: `0x${'ff'.repeat(32)}` };
  const divergent = await buildSettlementEvidence(env, request, async () => [divergentFrame])
    .then(() => null, error => error);
  expect(divergent).not.toBeInstanceOf(RuntimeAdapterError);
  expect(divergent).toMatchObject({
    message: `RADAPTER_SETTLEMENT_CERTIFIED_HEAD_MISMATCH:${leftId}:${rightId}`,
  });
});

test('settlement evidence counts a committed STP resolve explicitly', async () => {
  const env = makeSettlementEnv(false, true);
  const account = Array.from(env.state.eReplicas.values())[0]!.state.accounts.get(rightId)!;
  const response = decodeSettlementEvidenceResponse(
    await buildSettlementEvidence(env, request, async () => [account.currentFrame]),
  );
  expect(response.accounts[0]?.offers[0]?.stpCommitted).toBe(true);
});

test('settlement queue counters never traverse signed payload bodies', async () => {
  const env = makeSettlementEnv();
  const poison = new Proxy({}, {
    ownKeys: () => { throw new Error('SETTLEMENT_QUEUE_PAYLOAD_TRAVERSED'); },
    getOwnPropertyDescriptor: () => { throw new Error('SETTLEMENT_QUEUE_PAYLOAD_TRAVERSED'); },
  });
  env.pendingOutputs = [poison as never];
  env.pendingNetworkOutputs = [poison as never];
  env.networkInbox = [poison as never];
  env.runtimeMempool.entityInputs = [poison as never];
  const response = await buildSettlementEvidence(
    env,
    { type: 'settlement-evidence', book: null, accounts: [] },
    async () => [],
  );
  expect(response.queues.pendingOutputs.count).toBe(1);
  expect(response.queues.pendingNetworkOutputs.count).toBe(1);
  expect(response.queues.networkInbox.count).toBe(1);
  expect(response.queues.runtimeEntityInputs.count).toBe(1);
});

test('settlement evidence control is admin-authenticated and exact on the wire', async () => {
  expect(() => validateRuntimeAdapterWireMessage({
    v: XLN_PROTOCOL_VERSION, id: 'settlement-invalid', op: 'control',
    action: { ...request, accounts: [{ ...request.accounts[0], unknown: true }] },
  })).toThrow('RADAPTER_SETTLEMENT_ACCOUNT_FIELDS_INVALID:0');

  const messages: unknown[] = [];
  await handleRuntimeAdapterMessage({ send: message => messages.push(message) }, {
    v: XLN_PROTOCOL_VERSION, id: 'settlement-denied', op: 'control', action: request,
  }, makeSettlementEnv(), {
    enqueueRuntimeInput: () => {},
    controlRuntime: async (env, action) => {
      if (action === 'verify-chain') return {};
      const account = Array.from(env.state.eReplicas.values())[0]!.state.accounts.get(rightId)!;
      return buildSettlementEvidence(env, action, async () => [account.currentFrame]);
    },
  });
  const raw = messages[0]!;
  const denied = typeof raw === 'string'
    ? decodeRuntimeAdapterBrowserMessage(raw)
    : decodeRuntimeAdapterMessage(raw);
  expect('ok' in denied && denied.ok).toBe(false);
  if (!('ok' in denied) || denied.ok) throw new Error('TEST_SETTLEMENT_AUTH_RESPONSE_INVALID');
  expect(denied.error.code).toBe('E_UNAUTHORIZED');
});

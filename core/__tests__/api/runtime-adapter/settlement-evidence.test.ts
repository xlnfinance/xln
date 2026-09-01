import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { expect, test } from 'bun:test';

import { decodeRuntimeAdapterBrowserMessage, decodeRuntimeAdapterMessage } from '../../../api/runtime-adapter/codec';
import {
  buildSettlementEvidence,
  decodeSettlementEvidenceRequest,
  decodeSettlementEvidenceResponse,
} from '../../../api/runtime-adapter/control/settlement-evidence';
import { handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';
import { resolveRuntimeAdminControl } from '../../../api/server/control/runtime-admin';
import { validateRuntimeAdapterWireMessage } from '../../../api/runtime-adapter/wire-schema';
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

const makeSettlementEnv = (pending = false) => {
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
        fillRatio: 65_535,
        cancelRemainder: true,
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
  const decodedRequest = decodeSettlementEvidenceRequest(request);
  const response = decodeSettlementEvidenceResponse(
    buildSettlementEvidence(env, decodedRequest),
  );
  expect(response.queues.pendingOutputs.count).toBe(0);
  expect(response.queues.pendingAccountFrames.count).toBe(0);
  expect(response.pendingAccountSample).toEqual([]);
  const pendingEnv = makeSettlementEnv(true);
  const pending = decodeSettlementEvidenceResponse(
    buildSettlementEvidence(pendingEnv, decodedRequest),
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
    pendingInputKind: 'ack_frame',
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
    // The sample names the resting order so a drain that times out with live
    // orders and empty queues can say which order is stuck and who owns it.
    liveOrderSample: [{
      orderId: 'resting-ask',
      ownerId: rightId,
      side: 1,
      priceTicks: 2n,
      qtyLots: 1n,
    }],
    digest: expect.stringMatching(/^0x[0-9a-f]{64}$/),
  });
  expect(response.accounts[0]?.offers).toEqual([{
    offerId, live: false,
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

test('settlement evidence reports only the current committed Account head', () => {
  const env = makeSettlementEnv();
  const account = Array.from(env.state.eReplicas.values())[0]!.state.accounts.get(rightId)!;
  const response = buildSettlementEvidence(env, request);
  expect(response.accounts[0]).toMatchObject({
    currentHeight: account.currentHeight,
    currentStateHash: account.currentFrame.stateHash,
  });
});

test('runtime admin settlement succeeds from live state without an Account history store', async () => {
  const response = decodeSettlementEvidenceResponse(
    await resolveRuntimeAdminControl(makeSettlementEnv(), request),
  );
  expect(response.accounts[0]?.offers).toEqual([{ offerId, live: false }]);
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
  const response = buildSettlementEvidence(
    env,
    { type: 'settlement-evidence', book: null, accounts: [] },
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
      return buildSettlementEvidence(env, action);
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

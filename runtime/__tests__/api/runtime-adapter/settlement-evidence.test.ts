import { expect, test } from 'bun:test';

import { decodeRuntimeAdapterBrowserMessage, decodeRuntimeAdapterMessage } from '../../../api/runtime-adapter/codec';
import {
  buildSettlementEvidence,
  decodeSettlementEvidenceRequest,
  decodeSettlementEvidenceResponse,
} from '../../../api/runtime-adapter/control/settlement-evidence';
import { handleRuntimeAdapterMessage } from '../../../api/runtime-adapter/server';
import { validateRuntimeAdapterWireMessage } from '../../../api/runtime-adapter/wire-schema';
import { createEmptyEnv } from '../../../runtime';
import { addReplica, addr, entity, makeJurisdiction, makeState } from '../../helpers/cross-j';

const leftId = entity('11');
const rightId = entity('22');
const offerId = 'settlement-offer-1';

const makeSettlementEnv = () => {
  const env = createEmptyEnv('settlement-evidence');
  const signerId = addr('aa');
  const state = makeState(leftId, signerId, makeJurisdiction('J1', 31_337, 'dd', 'ee'), rightId);
  const account = state.accounts.get(rightId)!;
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
      data: { offerId, fillRatio: 65_535, cancelRemainder: true },
    }],
    accountStateRoot: `0x${'12'.repeat(32)}`,
    stateHash: `0x${'34'.repeat(32)}`,
  };
  addReplica(env, state, signerId);
  return env;
};

const request = {
  type: 'settlement-evidence' as const,
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
  expect(response.queues.pendingOutputs.digest).toMatch(/^0x[0-9a-f]{64}$/);
  expect(response.accounts[0]?.offers).toEqual([{
    offerId, offerCommitted: true, resolveCommitted: true, live: false, closed: true,
  }]);
  expect(() => decodeSettlementEvidenceRequest({ ...request, extra: true }))
    .toThrow('RADAPTER_SETTLEMENT_REQUEST_FIELDS_INVALID');
  expect(() => decodeSettlementEvidenceResponse({
    ...response,
    queues: { ...response.queues, pendingOutputs: { count: 0, digest: 'bad' } },
  })).toThrow('RADAPTER_SETTLEMENT_RESPONSE_QUEUE_INVALID:pendingOutputs_DIGEST');
});

test('settlement evidence control is admin-authenticated and exact on the wire', async () => {
  expect(() => validateRuntimeAdapterWireMessage({
    v: 1, id: 'settlement-invalid', op: 'control',
    action: { ...request, accounts: [{ ...request.accounts[0], unknown: true }] },
  })).toThrow('RADAPTER_SETTLEMENT_ACCOUNT_FIELDS_INVALID:0');

  const messages: unknown[] = [];
  await handleRuntimeAdapterMessage({ send: message => messages.push(message) }, {
    v: 1, id: 'settlement-denied', op: 'control', action: request,
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

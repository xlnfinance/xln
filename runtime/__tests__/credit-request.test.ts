import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../validation-utils';
import { handleCreditRequest } from '../server/credit-request';
import type { AccountMachine, Env, RuntimeInput } from '../types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const signer = (byte: string): string => `0x${byte.repeat(20)}`;

const HUB = entity('11');
const USER = entity('22');
const HUB_SIGNER = signer('33');
const RUNTIME_ID = signer('44');

const makeAccount = (): AccountMachine => {
  const delta = createDefaultDelta(1);
  return {
    leftEntity: HUB,
    rightEntity: USER,
    status: 'active',
    currentHeight: 1,
    currentFrame: {
      height: 1,
      timestamp: 1,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: `0x${'55'.repeat(32)}`,
      stateHash: `0x${'66'.repeat(32)}`,
      deltas: [],
      byLeft: true,
    },
    mempool: [],
    deltas: new Map([[1, delta]]),
  } as unknown as AccountMachine;
};

const makeEnv = (): Env => ({
  height: 9,
  runtimeId: RUNTIME_ID,
  eReplicas: new Map([
    [`${HUB}:${HUB_SIGNER}`, {
      entityId: HUB,
      signerId: HUB_SIGNER,
      isProposer: true,
      mempool: [],
      state: {
        entityId: HUB,
        accounts: new Map([[USER, makeAccount()]]),
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [HUB_SIGNER],
          shares: { [HUB_SIGNER]: 1n },
        },
      },
    }],
  ]),
  gossip: {
    getProfiles: () => [{
      entityId: HUB,
      name: 'H1',
      metadata: { isHub: true },
    }],
  },
} as unknown as Env);

describe('credit request ingress', () => {
  test('queues hub credit extension through runtime admission and returns receipt status metadata', async () => {
    const env = makeEnv();
    let enqueued: RuntimeInput | null = null;
    let validated: RuntimeInput | null = null;

    const response = await handleCreditRequest({
      req: new Request('http://xln.local/api/credit/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userEntityId: USER,
          hubEntityId: HUB,
          tokenId: 1,
          amount: '25',
        }),
      }),
      env,
      headers: { 'content-type': 'application/json' },
      activeHubEntityIds: [HUB],
      validateRuntimeInputAdmission: (_env, runtimeInput) => {
        validated = runtimeInput;
      },
      enqueueRuntimeInput: (_env, runtimeInput) => {
        enqueued = runtimeInput;
      },
      registerReceipt: (receipt) => ({
        id: receipt.id ?? 'receipt-1',
        kind: receipt.kind,
        status: 'pending',
        counts: receipt.counts,
        enqueuedAt: 1,
        enqueuedHeight: receipt.enqueuedHeight,
        expiresAt: 10_001,
        ...(receipt.note ? { note: receipt.note } : {}),
      }),
      getCurrentRuntimeHeight: (targetEnv) => Number(targetEnv?.height ?? 0),
      buildRuntimeInputStatusUrl: (id) => `/api/runtime-input/${id}`,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.status).toBe('queued');
    expect(String(body.requestId)).toMatch(/^credit_/);
    expect(body.runtimeId).toBe(RUNTIME_ID);
    expect(body.currentHeight).toBe(9);
    expect(body.receipt).toMatchObject({
      id: body.requestId,
      kind: 'credit-request',
      status: 'pending',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 9,
    });
    expect(body.statusUrl).toBe(`/api/runtime-input/${body.requestId}`);
    expect(validated).toBe(enqueued);
    expect(enqueued?.entityInputs).toHaveLength(1);
    expect(enqueued?.entityInputs?.[0]).toMatchObject({
      entityId: HUB,
      signerId: HUB_SIGNER,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: USER,
          tokenId: 1,
          amount: 25n,
        },
      }],
    });
  });
});

import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../../../account/state/delta';
import { handleCreditRequest } from '../../../api/server/faucet/credit';
import type { AccountState } from '../../../types/account';
import type { RuntimeReplica, RuntimeInput } from '../../../runtime/types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const signer = (byte: string): string => `0x${byte.repeat(20)}`;

const HUB = entity('11');
const USER = entity('22');
const HUB_SIGNER = signer('33');
const RUNTIME_ID = signer('44');

const makeAccount = (): AccountState => {
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
  } as unknown as AccountState;
};

const makeEnv = (): RuntimeReplica => ({
  state: {
  height: 9,
  eReplicas: new Map([
      [`${HUB}:${HUB_SIGNER}`, {
        entityId: HUB,
        signerId: HUB_SIGNER,
        entityEncPubKey: '',
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
  },
  runtimeId: RUNTIME_ID,
  gossip: {
    getProfiles: () => [{
      entityId: HUB,
      name: 'H1',
      metadata: { isHub: true },
    }],
  },
} as unknown as RuntimeReplica);

describe('credit request ingress', () => {
  test('queues hub credit extension through runtime admission without transport receipts', async () => {
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
      getCurrentRuntimeHeight: (targetEnv) => Number(targetEnv?.state.height ?? 0),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.status).toBe('queued');
    expect(String(body.requestId)).toMatch(/^credit_/);
    expect(body.runtimeId).toBe(RUNTIME_ID);
    expect(body.currentHeight).toBe(9);
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

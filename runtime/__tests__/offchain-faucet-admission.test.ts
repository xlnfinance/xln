import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../account/delta';
import { handleOffchainFaucet } from '../server/offchain-faucet';
import {
  describeOffchainFaucetAccountState,
  shouldRejectOffchainFaucetForSettledCapacity,
} from '../server/offchain-faucet-admission';
import { createRelayStore } from '../relay/store';
import type { AccountFrame, AccountState, RuntimeState, RuntimeInput } from '../types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const signer = (byte: string): string => `0x${byte.repeat(20)}`;

const HUB = entity('11');
const USER = entity('22');
const HUB_SIGNER = signer('33');
const USER_RUNTIME_ID = signer('44');
const SECONDARY_HUB = entity('55');
const SECONDARY_HUB_SIGNER = signer('66');
const USDC_UNIT = 10n ** 6n;

const makeFrame = (height: number): AccountFrame => ({
  height,
  timestamp: height,
  jHeight: 0,
  accountTxs: [],
  prevFrameHash: height <= 0 ? '' : `0x${'55'.repeat(32)}`,
  stateHash: height <= 0 ? '' : `0x${'66'.repeat(32)}`,
  deltas: [],
  byLeft: true,
});

const makeAccount = (input: {
  currentHeight: number;
  pendingFrame?: AccountFrame;
  mempool?: AccountState['mempool'];
  outCapacity?: bigint;
}, ownerEntityId: string = HUB): AccountState => {
  const delta = createDefaultDelta(1);
  delta.leftCreditLimit = input.outCapacity ?? 0n;
  return {
    leftEntity: ownerEntityId,
    rightEntity: USER,
    status: 'active',
    currentHeight: input.currentHeight,
    currentFrame: makeFrame(input.currentHeight),
    ...(input.pendingFrame ? { pendingFrame: input.pendingFrame } : {}),
    mempool: input.mempool ?? [],
    deltas: new Map([[1, delta]]),
  } as unknown as AccountState;
};

const makeEnv = (
  account: AccountState,
  hubEntityId: string = HUB,
  hubSignerId: string = HUB_SIGNER,
): RuntimeState => ({
  eReplicas: new Map([
    [`${hubEntityId}:${hubSignerId}`, {
      entityId: hubEntityId,
      signerId: hubSignerId,
      entityEncPubKey: '',
      entityEncPrivKey: '',
      isProposer: true,
      mempool: [],
      state: {
        entityId: hubEntityId,
        accounts: new Map([[USER, account]]),
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [hubSignerId],
          shares: { [hubSignerId]: 1n },
        },
      },
    }],
  ]),
  gossip: { getProfiles: () => [] },
  runtimeId: USER_RUNTIME_ID,
} as unknown as RuntimeState);

const callFaucet = async (
  account: AccountState,
  options: {
    hubEntityId?: string;
    hubSignerId?: string;
    activeHubEntityIds?: string[];
    requestBody?: Record<string, unknown>;
  } = {},
): Promise<{
  response: Response;
  body: Record<string, unknown>;
  enqueued: RuntimeInput | null;
}> => {
  let enqueued: RuntimeInput | null = null;
  const hubEntityId = options.hubEntityId ?? HUB;
  const hubSignerId = options.hubSignerId ?? HUB_SIGNER;
  const relayStore = createRelayStore('offchain-faucet-test');
  relayStore.activeHubEntityIds = options.activeHubEntityIds ?? [hubEntityId];
  const response = await handleOffchainFaucet({
    req: new Request('http://xln.local/api/faucet/offchain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userEntityId: USER,
        userRuntimeId: USER_RUNTIME_ID,
        hubEntityId,
        tokenId: 1,
        amount: '100',
        ...options.requestBody,
      }),
    }),
    env: makeEnv(account, hubEntityId, hubSignerId),
    headers: { 'content-type': 'application/json' },
    relayStore,
    enqueueRuntimeInput: (_env, runtimeInput) => {
      enqueued = runtimeInput;
    },
    validateRuntimeInputAdmission: () => {},
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
    getCurrentRuntimeHeight: () => 7,
    buildRuntimeInputStatusUrl: (id) => `/api/runtime-input/${id}`,
  });
  return {
    response,
    body: await response.json(),
    enqueued,
  };
};

describe('offchain faucet admission', () => {
  test('treats pending setup frames as queueable instead of not-ready rejection', async () => {
    const account = makeAccount({
      currentHeight: 0,
      pendingFrame: makeFrame(1),
      mempool: [{ type: 'add_delta', data: { tokenId: 1 } }],
      outCapacity: 0n,
    });

    const { response, body, enqueued } = await callFaucet(account);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.status).toBe('queued');
    expect(String(body.requestId)).toMatch(/^offchain_/);
    expect(body.statusUrl).toBe(`/api/runtime-input/${body.requestId}`);
    expect(body.accountReady).toBe(false);
    expect(body.accountState).toMatchObject({
      currentHeight: 0,
      pendingFrameHeight: 1,
      mempool: 1,
      settledCapacitySnapshot: false,
    });
    expect(enqueued?.entityInputs).toHaveLength(1);
    expect(enqueued?.entityInputs[0]?.entityTxs?.[0]).toMatchObject({
      type: 'directPayment',
      data: {
        targetEntityId: USER,
        tokenId: 1,
        amount: 100n * USDC_UNIT,
        route: [HUB, USER],
      },
    });
  });

  test('accepts sibling hub bootstrap entity from the active hub set', async () => {
    const account = makeAccount({
      currentHeight: 0,
      pendingFrame: makeFrame(1),
      mempool: [{ type: 'add_delta', data: { tokenId: 1 } }],
      outCapacity: 0n,
    }, SECONDARY_HUB);

    const { response, body, enqueued } = await callFaucet(account, {
      hubEntityId: SECONDARY_HUB,
      hubSignerId: SECONDARY_HUB_SIGNER,
      activeHubEntityIds: [HUB, SECONDARY_HUB],
    });

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(enqueued?.entityInputs[0]?.entityId).toBe(SECONDARY_HUB);
    expect(enqueued?.entityInputs[0]?.signerId).toBe(SECONDARY_HUB_SIGNER);
    expect(enqueued?.entityInputs[0]?.entityTxs?.[0]).toMatchObject({
      type: 'directPayment',
      data: {
        targetEntityId: USER,
        route: [SECONDARY_HUB, USER],
      },
    });
  });

  test('reports typed transient failure when no faucet hub is visible', async () => {
    const account = makeAccount({
      currentHeight: 0,
      pendingFrame: makeFrame(1),
      mempool: [{ type: 'add_delta', data: { tokenId: 1 } }],
      outCapacity: 0n,
    });

    const { response, body, enqueued } = await callFaucet(account, {
      activeHubEntityIds: [],
    });

    expect(response.status).toBe(503);
    expect(body.error).toBe('No faucet hub available in gossip');
    expect(body.code).toBe('FAUCET_HUBS_EMPTY');
    expect(body.category).toBe('TransientRace');
    expect(body.retryable).toBe(true);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'TransientRace',
      code: 'FAUCET_HUBS_EMPTY',
      retryable: true,
      fatal: false,
    });
    expect(body.activeHubEntityIds).toEqual([]);
    expect(enqueued).toBeNull();
  });

  test('reports typed expected-empty failure for settled insufficient capacity', async () => {
    const account = makeAccount({
      currentHeight: 1,
      outCapacity: 99n * USDC_UNIT,
    });

    const { response, body, enqueued } = await callFaucet(account);

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.code).toBe('FAUCET_INSUFFICIENT_OUT_CAPACITY');
    expect(body.category).toBe('ExpectedEmpty');
    expect(body.retryable).toBe(false);
    expect(body.fatal).toBe(false);
    expect(body.failure).toMatchObject({
      category: 'ExpectedEmpty',
      code: 'FAUCET_INSUFFICIENT_OUT_CAPACITY',
      retryable: false,
      fatal: false,
    });
    expect(body.senderOutCapacity).toBe((99n * USDC_UNIT).toString());
    expect(enqueued).toBeNull();
  });

  test('rejects a non-integer token id before constructing financial input', async () => {
    const account = makeAccount({
      currentHeight: 1,
      outCapacity: 1_000n * USDC_UNIT,
    });

    const { response, body, enqueued } = await callFaucet(account, {
      requestBody: { tokenId: '1.5' },
    });

    expect(response.status).toBe(400);
    expect(body.code).toBe('FAUCET_INVALID_TOKEN_ID');
    expect(enqueued).toBeNull();
  });

  test('still rejects insufficient capacity from a settled account snapshot', () => {
    const account = makeAccount({
      currentHeight: 1,
      outCapacity: 99n * USDC_UNIT,
    });

    expect(describeOffchainFaucetAccountState(account).settledCapacitySnapshot).toBe(true);
    expect(shouldRejectOffchainFaucetForSettledCapacity({
      account,
      senderOutCapacity: 99n * USDC_UNIT,
      amount: 100n * USDC_UNIT,
    })).toBe(true);
  });
});

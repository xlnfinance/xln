import { describe, expect, test } from 'bun:test';

import { createDefaultDelta } from '../validation-utils';
import {
  handleLendingBorrowRequest,
  handleLendingOfferRequest,
  handleLendingRepayRequest,
} from '../server/lending';
import type { AccountMachine, Env, RuntimeInput } from '../types';

const entity = (byte: string): string => `0x${byte.repeat(32)}`;
const signer = (byte: string): string => `0x${byte.repeat(20)}`;

const HUB = entity('11');
const USER = entity('22');
const LENDER = entity('44');
const HUB_SIGNER = signer('33');
const RUNTIME_ID = signer('55');

const makeAccount = (): AccountMachine => {
  const delta = createDefaultDelta(1);
  delta.rightCreditLimit = 1_000_000n;
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
      prevFrameHash: `0x${'66'.repeat(32)}`,
      stateHash: `0x${'77'.repeat(32)}`,
      deltas: [],
      byLeft: true,
    },
    mempool: [],
    deltas: new Map([[1, delta]]),
  } as unknown as AccountMachine;
};

const makeEnv = (lending: Record<string, unknown> | null = null): Env => ({
  height: 12,
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
        ...(lending ? { lending } : {}),
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [HUB_SIGNER],
          shares: { [HUB_SIGNER]: 1n },
        },
      },
    }],
  ]),
} as unknown as Env);

const deps = (env: Env, capture: { enqueued: RuntimeInput | null; validated: RuntimeInput | null }) => ({
  env,
  headers: { 'content-type': 'application/json' },
  activeHubEntityIds: [HUB],
  validateRuntimeInputAdmission: (_env: Env, runtimeInput: RuntimeInput) => {
    capture.validated = runtimeInput;
  },
  enqueueRuntimeInput: (_env: Env, runtimeInput: RuntimeInput) => {
    capture.enqueued = runtimeInput;
  },
  registerReceipt: (receipt: { id?: string; kind: string; counts: { runtimeTxs: number; entityInputs: number; jInputs: number }; enqueuedHeight: number; note?: string }) => ({
    id: receipt.id ?? 'receipt-1',
    kind: receipt.kind,
    status: 'pending' as const,
    counts: receipt.counts,
    enqueuedAt: 1,
    enqueuedHeight: receipt.enqueuedHeight,
    expiresAt: 10_001,
    ...(receipt.note ? { note: receipt.note } : {}),
  }),
  getCurrentRuntimeHeight: (targetEnv: Env | null) => Number(targetEnv?.height ?? 0),
  buildRuntimeInputStatusUrl: (id: string) => `/api/runtime-input/${id}`,
});

const post = (path: string, body: Record<string, unknown>): Request =>
  new Request(`http://xln.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const expectAcceptedMutation = async (
  response: Response,
  capture: { enqueued: RuntimeInput | null; validated: RuntimeInput | null },
  kind: string,
): Promise<Record<string, unknown>> => {
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  expect(body.status).toBe('queued');
  expect(String(body.requestId)).toMatch(new RegExp(`^${kind}_`));
  expect(body.runtimeId).toBe(RUNTIME_ID);
  expect(body.currentHeight).toBe(12);
  expect(body.receipt).toMatchObject({
    id: body.requestId,
    kind,
    status: 'pending',
    counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
    enqueuedHeight: 12,
  });
  expect(body.statusUrl).toBe(`/api/runtime-input/${body.requestId}`);
  expect(capture.validated).toBe(capture.enqueued);
  expect(capture.enqueued?.entityInputs).toHaveLength(1);
  return body as Record<string, unknown>;
};

describe('lending API ingress receipts', () => {
  test('offer queues RuntimeInput through admission and returns receipt metadata', async () => {
    const env = makeEnv();
    const capture = { enqueued: null as RuntimeInput | null, validated: null as RuntimeInput | null };
    const response = await handleLendingOfferRequest({
      req: post('/api/lending/offer', {
        hubEntityId: HUB,
        lenderEntityId: USER,
        tokenId: 1,
        amount: '25',
        termId: '1d',
        interestBps: 100,
      }),
      ...deps(env, capture),
    });

    await expectAcceptedMutation(response, capture, 'lending-offer');
    expect(capture.enqueued?.entityInputs?.[0]).toMatchObject({
      entityId: HUB,
      signerId: HUB_SIGNER,
      entityTxs: [{
        type: 'lendingOffer',
        data: { lenderEntityId: USER, tokenId: 1, amount: 25n, termId: '1d', interestBps: 100 },
      }],
    });
  });

  test('borrow queues RuntimeInput through admission and returns receipt metadata', async () => {
    const env = makeEnv({
      pools: new Map([['pool-1', {
        positionId: 'pool-1',
        hubEntityId: HUB,
        lenderEntityId: LENDER,
        tokenId: 1,
        principalAmount: 100n,
        availableAmount: 100n,
        borrowedAmount: 0n,
        interestBps: 100,
        termId: '1d',
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
      }]]),
      loans: new Map(),
    });
    const capture = { enqueued: null as RuntimeInput | null, validated: null as RuntimeInput | null };
    const response = await handleLendingBorrowRequest({
      req: post('/api/lending/borrow', {
        hubEntityId: HUB,
        borrowerEntityId: USER,
        tokenId: 1,
        amount: '25',
        termId: '1d',
        maxInterestBps: 150,
      }),
      ...deps(env, capture),
    });

    await expectAcceptedMutation(response, capture, 'lending-borrow');
    expect(capture.enqueued?.entityInputs?.[0]).toMatchObject({
      entityId: HUB,
      signerId: HUB_SIGNER,
      entityTxs: [{
        type: 'lendingBorrow',
        data: { borrowerEntityId: USER, tokenId: 1, amount: 25n, termId: '1d', maxInterestBps: 150 },
      }],
    });
  });

  test('repay queues RuntimeInput through admission and returns receipt metadata', async () => {
    const env = makeEnv({
      pools: new Map(),
      loans: new Map([['loan-1', {
        loanId: 'loan-1',
        hubEntityId: HUB,
        borrowerEntityId: USER,
        lenderEntityId: LENDER,
        positionId: 'pool-1',
        tokenId: 1,
        principalAmount: 25n,
        interestAmount: 1n,
        repaymentAmount: 26n,
        repaidAmount: 0n,
        interestBps: 100,
        termId: '1d',
        openedAt: 1,
        dueAt: 2,
        status: 'active',
      }]]),
    });
    const capture = { enqueued: null as RuntimeInput | null, validated: null as RuntimeInput | null };
    const response = await handleLendingRepayRequest({
      req: post('/api/lending/repay', {
        hubEntityId: HUB,
        borrowerEntityId: USER,
        loanId: 'loan-1',
      }),
      ...deps(env, capture),
    });

    await expectAcceptedMutation(response, capture, 'lending-repay');
    expect(capture.enqueued?.entityInputs?.[0]).toMatchObject({
      entityId: HUB,
      signerId: HUB_SIGNER,
      entityTxs: [{
        type: 'lendingRepay',
        data: { borrowerEntityId: USER, loanId: 'loan-1' },
      }],
    });
  });
});

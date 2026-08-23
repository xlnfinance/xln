import { describe, expect, test } from 'bun:test';

import { handleDirectPayment } from '../../../account/tx/handlers/balance/direct-payment';
import { computeFrameHash } from '../../../account/consensus/frame/hash';
import { applyDirectPaymentForwardFollowups } from '../../../entity/tx/handlers/account/committed-htlc-followups';
import type {
  AccountFrame,
  AccountInput,
  AccountOutput,
  AccountReplica,
  AccountTx,
} from '../../../types/account';
import type { EntityState } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import { createDefaultDelta } from '../../../account/state/delta';
import { makeAccount as makeCanonicalAccount } from '../../helpers/cross-j';
import { MalformedEntityFrameInputError } from '../../../entity/tx/processing/invariant-errors';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';

const LEFT = `0x${'aa'.repeat(32)}`;
const RIGHT = `0x${'bb'.repeat(32)}`;
const NEXT = `0x${'cc'.repeat(32)}`;
type DirectPaymentTx = Extract<AccountTx, { type: 'direct_payment' }>;
type DirectPaymentForward = Extract<AccountOutput, { kind: 'directPaymentForward' }>;

async function makeHashedFrame(): Promise<AccountFrame> {
  const delta = {
    ...createDefaultDelta(1),
    collateral: 100_000n,
  };
  const frame: AccountFrame = {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: `0x${'00'.repeat(32)}`,
    stateHash: '',
    byLeft: true,
    deltas: [{ ...delta }],
  };
  frame.stateHash = await computeFrameHash(frame);
  return frame;
}

async function makeAccount(): Promise<AccountReplica> {
  const delta = {
    ...createDefaultDelta(1),
    collateral: 100_000n,
  };
  const account = makeCanonicalAccount(LEFT, RIGHT);
  account.proofHeader = { fromEntity: RIGHT, toEntity: LEFT, nextProofNonce: 1 };
  account.currentHeight = 1;
  account.currentFrame = await makeHashedFrame();
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]);
  return account;
}

const applyCommittedDirectPayment = (
  account: AccountReplica,
  tx: DirectPaymentTx,
  byLeft: boolean,
) => {
  const transition = beginAccountTransition(account);
  const result = handleDirectPayment(accountTransitionView(transition), tx, byLeft);
  if (result.ok) {
    publishAccountTransition(account, transition, 'direct-payment-frame-integrity');
  } else {
    discardAccountTransition(transition);
  }
  return result;
};

const directPaymentForwards = (
  outputs: readonly AccountOutput[] | undefined,
): DirectPaymentForward[] =>
  (outputs ?? []).filter(
    (output): output is DirectPaymentForward => output.kind === 'directPaymentForward',
  );

describe('direct payment frame integrity', () => {
  test('updates live deltas without mutating the hashed current frame', async () => {
    const account = await makeAccount();
    const frameHashBefore = account.currentFrame.stateHash;
    const frameJsonBefore = JSON.stringify(account.currentFrame, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    const tx: Extract<AccountTx, { type: 'direct_payment' }> = {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 100n,
        route: [LEFT],
        fromEntityId: RIGHT,
        toEntityId: LEFT,
        deliveryMode: 'direct',
        description: 'integrity-regression',
      },
    };

    const result = applyCommittedDirectPayment(account, tx, false);

    expect(result.ok).toBe(true);
    expect(account.state.deltas.get(1)?.offdelta).toBe(100n);
    expect(account.currentFrame.stateHash).toBe(frameHashBefore);
    expect(await computeFrameHash(account.currentFrame)).toBe(frameHashBefore);
    expect(JSON.stringify(account.currentFrame, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    )).toBe(frameJsonBefore);
  });

  test('derives payer from frame proposer and rejects forged direction fields', async () => {
    const account = await makeAccount();
    const forged: Extract<AccountTx, { type: 'direct_payment' }> = {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 100n,
        route: [RIGHT],
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        deliveryMode: 'direct',
      },
    };

    const result = applyCommittedDirectPayment(account, forged, false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected forged payment rejection');
    expect(result.rejection.message).toContain('must match the frame proposer');
    expect(account.state.deltas.get(1)?.offdelta).toBe(0n);
  });

  for (const paymentCount of [2, 1_000]) {
    test(`forwards all ${paymentCount} routed payments without payload deduplication`, async () => {
      const account = await makeAccount();
      account.proofHeader.fromEntity = LEFT;
      account.proofHeader.toEntity = RIGHT;
      const tx: Extract<AccountTx, { type: 'direct_payment' }> = {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 1n,
          route: [LEFT, NEXT],
          fromEntityId: RIGHT,
          toEntityId: LEFT,
          deliveryMode: 'trusted',
          trustedGatewayEntityId: LEFT,
          description: 'identical-routed-payment',
        },
      };

      const transition = beginAccountTransition(account);
      const draft = accountTransitionView(transition);
      const forwards: DirectPaymentForward[] = [];
      for (let index = 0; index < paymentCount; index += 1) {
        const result = handleDirectPayment(draft, tx, false);
        expect(result.ok).toBe(true);
        forwards.push(...directPaymentForwards(result.candidateEffects));
      }
      publishAccountTransition(account, transition, 'direct-payment-forward-multiplicity');
      expect(forwards).toHaveLength(paymentCount);
      expect('pendingForwards' in account).toBe(false);

      const accountTxs: Array<{ accountId: string; tx: AccountTx }> = [];
      const state = { entityId: LEFT } as EntityState;
      const newState = { entityId: LEFT, accounts: new Map([[NEXT, makeCanonicalAccount(LEFT, NEXT)]]) } as EntityState;
      applyDirectPaymentForwardFollowups({
        env: {} as RuntimeReplica,
        state,
        newState,
        input: {} as AccountInput,
        account,
        outputs: [],
        accountTxs,
        candidateEffects: [],
      }, forwards);

      expect(accountTxs).toHaveLength(paymentCount);
      expect(accountTxs.every(op => op.accountId === NEXT && op.tx.type === 'direct_payment')).toBe(true);
      expect(forwards).toHaveLength(paymentCount);
    });
  }

  test('queues a trusted forward when canonical entity ids arrive with mixed case', async () => {
    const account = await makeAccount();
    account.proofHeader.fromEntity = LEFT;
    account.proofHeader.toEntity = RIGHT;
    const result = applyCommittedDirectPayment(account, {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [LEFT.toUpperCase(), NEXT],
        fromEntityId: RIGHT,
        toEntityId: LEFT.toUpperCase(),
        deliveryMode: 'trusted',
        trustedGatewayEntityId: LEFT.toUpperCase(),
      },
    }, false);

    expect(result.ok).toBe(true);
    expect(account.state.deltas.get(1)?.offdelta).toBe(1n);
    const forwards = directPaymentForwards(result.candidateEffects);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]?.route).toEqual([LEFT.toUpperCase(), NEXT]);
  });

  test('rejects direct multihop and trusted multi-gateway routes before mutation', async () => {
    const account = await makeAccount();
    const payment = (deliveryMode: 'direct' | 'trusted', route: string[]) => applyCommittedDirectPayment(account, {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 100n,
        route,
        fromEntityId: RIGHT,
        toEntityId: LEFT,
        deliveryMode,
        ...(deliveryMode === 'trusted' ? { trustedGatewayEntityId: LEFT } : {}),
      },
    }, false);

    expect(payment('direct', [LEFT, NEXT]).ok).toBe(false);
    expect(payment('trusted', [LEFT, NEXT, `0x${'44'.repeat(32)}`]).ok).toBe(false);
    expect(account.state.deltas.get(1)?.offdelta).toBe(0n);
    expect('pendingForwards' in account).toBe(false);
  });

  test('classifies an absent routed next-hop account as discardable malformed ingress', async () => {
    const account = await makeAccount();
    const forwards: DirectPaymentForward[] = [{
      kind: 'directPaymentForward',
      tokenId: 1,
      amount: 1n,
      route: [LEFT, NEXT],
      deliveryMode: 'trusted',
      trustedGatewayEntityId: LEFT,
    }];

    expect(() => applyDirectPaymentForwardFollowups({
      env: {} as RuntimeReplica,
      state: { entityId: LEFT } as EntityState,
      newState: { entityId: LEFT, accounts: new Map() } as EntityState,
      input: {} as AccountInput,
      account,
      outputs: [],
      accountTxs: [],
      candidateEffects: [],
    }, forwards)).toThrow(MalformedEntityFrameInputError);
    expect(forwards).toHaveLength(1);
    expect('pendingForwards' in account).toBe(false);
  });
});

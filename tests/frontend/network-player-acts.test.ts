import { describe, expect, test } from 'bun:test';
// `three` is a frontend-only dependency; the root test runner has no copy of its own.
import * as THREE from '../../frontend/node_modules/three';
import { deriveNetworkActs, actIndexOfStep } from '../../frontend/src/lib/network3d/networkActs';
import { createAccountBars } from '../../frontend/src/lib/network3d/AccountBarRenderer';

const event = (height: number, type: string, rawType: string) => ({
  id: `e${height}`,
  runtimeId: 'r1',
  height,
  timestamp: height,
  kind: 'offchain',
  type,
  source: 'runtime_input',
  direction: 'neutral',
  title: type,
  subtitle: '',
  status: 'committed',
  rawType,
}) as never;

const steps = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ index, runtimeId: 'r1', height: index + 1 }));

describe('network acts', () => {
  test('names the opening act funding, not payments, when reserves move', () => {
    // r2r classifies as a payment by type; only the raw type says it is a reserve move.
    const acts = deriveNetworkActs(steps(2), [event(1, 'payment', 'r2r'), event(2, 'account', 'r2c')]);

    expect(acts).toHaveLength(1);
    expect(acts[0]?.title).toBe('Funding');
    expect(acts[0]?.stepCount).toBe(2);
  });

  test('batch broadcasts and bookkeeping continue the running act instead of splitting it', () => {
    const acts = deriveNetworkActs(steps(3), [
      event(1, 'payment', 'directPayment'),
      event(2, 'j_batch', 'j_broadcast'),
      event(3, 'payment', 'directPayment'),
    ]);

    expect(acts.map((act) => act.title)).toEqual(['Payments']);
    expect(acts[0]?.stepCount).toBe(3);
  });

  test('absorbs a one-step interruption inside a run but keeps a real transition', () => {
    const interrupted = deriveNetworkActs(steps(4), [
      event(1, 'payment', 'directPayment'),
      event(2, 'account', 'set_credit_limit'),
      event(3, 'payment', 'directPayment'),
      event(4, 'payment', 'directPayment'),
    ]);
    expect(interrupted.map((act) => act.title)).toEqual(['Payments']);

    // A single dispute step is a chapter, not noise: nothing of the same kind flanks it.
    const transition = deriveNetworkActs(steps(3), [
      event(1, 'payment', 'directPayment'),
      event(2, 'dispute', 'prepareDispute'),
      event(3, 'settlement', 'settle_execute'),
    ]);
    expect(transition.map((act) => act.title)).toEqual(['Payments', 'Dispute', 'Settlement']);
  });

  test('locates the act a step belongs to', () => {
    const acts = deriveNetworkActs(steps(3), [
      event(1, 'payment', 'directPayment'),
      event(2, 'dispute', 'prepareDispute'),
      event(3, 'dispute', 'disputeFinalize'),
    ]);

    expect(actIndexOfStep(acts, 0)).toBe(0);
    expect(actIndexOfStep(acts, 2)).toBe(1);
    expect(actIndexOfStep(acts, 99)).toBe(-1);
  });
});

const endpoint = (id: string, x: number) => ({ id, position: new THREE.Vector3(x, 0, 0) });
const runtime = {
  deriveDelta: () => ({
    delta: 0n, totalCapacity: 0n, ownCreditLimit: 0n, peerCreditLimit: 0n,
    inCapacity: 0n, outCapacity: 0n, collateral: 0n,
    outOwnCredit: 0n, inCollateral: 0n, outPeerCredit: 0n,
    inOwnCredit: 0n, outCollateral: 0n, inPeerCredit: 0n,
  }),
  getTokenInfo: () => ({ symbol: 'USDC', decimals: 6 }),
};

describe('account bar lanes', () => {
  test('a token lane the account never used draws nothing, not a lone delta separator', () => {
    const parent = new THREE.Object3D();
    createAccountBars(
      parent,
      endpoint('a', 0),
      endpoint('b', 40),
      new Map([
        [1, { tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n }],
        [2, { tokenId: 2, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n }],
      ]) as never,
      true,
      { barsMode: 'close', portfolioScale: 5000 } as never,
      () => 1,
      runtime as never,
    );

    const group = parent.children[0];
    expect(group?.children ?? []).toHaveLength(0);
  });
});

import { describe, expect, test } from 'bun:test';

import { buildPaymentRuntimeInput } from '../../../../frontend/src/lib/components/Entity/payments/runtime/payment-command';
import {
  quotePaymentCandidateRoutes,
  quoteRequiredInboundForForward,
} from '../../../../frontend/src/lib/components/Entity/payments/runtime/payment-route-quote';
import type {
  DeriveDeltaFn,
  LocalReplicaLike,
} from '../../../../frontend/src/lib/components/Entity/payment-routing';
import type { Delta, DerivedDelta } from '../../../types/account';

const derivedWithOutCapacity: DeriveDeltaFn = (delta): DerivedDelta => ({
  delta: 0n,
  collateral: 0n,
  inCollateral: 0n,
  outCollateral: 0n,
  inOwnCredit: 0n,
  outPeerCredit: 0n,
  inAllowance: 0n,
  outAllowance: 0n,
  totalCapacity: delta.leftCreditLimit,
  ownCreditLimit: delta.leftCreditLimit,
  peerCreditLimit: 0n,
  inCapacity: delta.leftCreditLimit,
  outCapacity: delta.leftCreditLimit,
  outOwnCredit: delta.leftCreditLimit,
  inPeerCredit: 0n,
  peerCreditUsed: 0n,
  ownCreditUsed: 0n,
  outTotalHold: 0n,
  inTotalHold: 0n,
  ascii: '',
});

const deltaWithCapacity = (capacity: bigint): Delta => ({
  tokenId: 1,
  collateral: 0n,
  ondelta: 0n,
  offdelta: 0n,
  leftCreditLimit: capacity,
  rightCreditLimit: 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
});

const replicaWithAccount = (
  leftEntity: string,
  rightEntity: string,
  capacity: bigint,
): LocalReplicaLike => ({
  state: {
    accounts: new Map([[rightEntity, {
      leftEntity,
      rightEntity,
      deltas: new Map([[1, deltaWithCapacity(capacity)]]),
    }]]),
  },
});

describe('shared payment command helpers', () => {
  test('builds the exact conditional PaymentPanel RuntimeInput shape', () => {
    const route = {
      path: ['alice', 'hub', 'bob'],
      hops: [
        { from: 'alice', to: 'hub', fee: 0n, feePPM: 0 },
        { from: 'hub', to: 'bob', fee: 11n, feePPM: 10_000 },
      ],
      totalFee: 11n,
      senderAmount: 1_011n,
      recipientAmount: 1_000n,
    };

    expect(buildPaymentRuntimeInput({
      entityId: 'alice',
      signerId: 'alice-signer',
      targetEntityId: 'stale-target',
      tokenId: 1,
      deliveryMode: 'instant',
      description: '  invoice  ',
      route,
    })).toEqual({
      runtimeTxs: [],
      entityInputs: [{
        entityId: 'alice',
        signerId: 'alice-signer',
        entityTxs: [{
          type: 'htlcPayment',
          data: {
            targetEntityId: 'bob',
            tokenId: 1,
            amount: 1_000n,
            maxSenderDebit: 1_011n,
            route: route.path,
            deliveryMode: 'instant',
            description: 'invoice',
          },
        }],
      }],
      jInputs: [],
    });
  });

  test('preserves direct and trusted route admission rules', () => {
    const directRoute = {
      path: ['alice', 'bob'],
      hops: [{ from: 'alice', to: 'bob', fee: 0n, feePPM: 0 }],
      totalFee: 0n,
      senderAmount: 1_000n,
      recipientAmount: 1_000n,
    };
    expect(buildPaymentRuntimeInput({
      entityId: 'alice',
      signerId: 'alice-signer',
      targetEntityId: 'bob',
      tokenId: 1,
      deliveryMode: 'direct',
      description: '',
      route: directRoute,
    }).entityInputs[0]?.entityTxs?.[0]).toEqual({
      type: 'directPayment',
      data: {
        targetEntityId: 'bob',
        tokenId: 1,
        amount: 1_000n,
        route: directRoute.path,
        deliveryMode: 'direct',
      },
    });
    expect(() => buildPaymentRuntimeInput({
      entityId: 'alice',
      signerId: 'alice-signer',
      targetEntityId: 'bob',
      tokenId: 1,
      deliveryMode: 'trusted',
      description: '',
      route: { ...directRoute, path: ['alice', 'hub', 'bob'], totalFee: 1n },
    })).toThrow('Trusted delivery requires exactly one fee-free gateway');
  });

  test('quotes intermediary fees backward and rejects insufficient hop capacity', () => {
    const replicaMap = new Map<string, LocalReplicaLike>([
      ['alice:signer', replicaWithAccount('alice', 'hub', 2_000n)],
      ['hub:signer', replicaWithAccount('hub', 'bob', 2_000n)],
    ]);
    const common = {
      paths: [['alice', 'hub', 'bob']],
      canonicalIds: new Map<string, string>(),
      replicaMap,
      profiles: [],
      deriveDelta: derivedWithOutCapacity,
      tokenId: 1,
      recipientAmount: 1_000n,
      defaultUnknownHopFeePPM: 100_000,
    };

    expect(quoteRequiredInboundForForward(1_000n, 100_000, 7n)).toBe(1_118n);
    expect(quotePaymentCandidateRoutes(common)).toEqual([{
      path: ['alice', 'hub', 'bob'],
      hops: [
        { from: 'alice', to: 'hub', fee: 0n, feePPM: 0 },
        { from: 'hub', to: 'bob', fee: 111n, feePPM: 100_000 },
      ],
      totalFee: 111n,
      senderAmount: 1_111n,
      recipientAmount: 1_000n,
    }]);

    replicaMap.set('hub:signer', replicaWithAccount('hub', 'bob', 999n));
    expect(quotePaymentCandidateRoutes(common)).toEqual([]);
  });
});

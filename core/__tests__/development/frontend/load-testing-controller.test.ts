import { describe, expect, test } from 'bun:test';

import {
  createLoadTestingController,
  selectExternalSwapLevel,
} from '../../../../frontend/src/lib/components/Entity/account/load-testing-controller';
import {
  LoadTestScheduler,
  type LoadTestSchedulerSnapshot,
} from '../../../../frontend/src/lib/components/Entity/account/load-testing-scheduler';
import type { PaymentPanelView } from '../../../../frontend/src/lib/components/Entity/payments/payment-panel-view';
import type { DeriveDeltaFn } from '../../../../frontend/src/lib/components/Entity/payment-routing';
import { applyCommand, createBook } from '../../../orderbook';
import type { Delta, DerivedDelta } from '../../../types/account';

const delta = (capacity: bigint): Delta => ({
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

const deriveDelta: DeriveDeltaFn = (value): DerivedDelta => ({
  delta: 0n,
  collateral: 0n,
  inCollateral: 0n,
  outCollateral: 0n,
  inOwnCredit: 0n,
  outPeerCredit: 0n,
  inAllowance: 0n,
  outAllowance: 0n,
  totalCapacity: value.leftCreditLimit,
  ownCreditLimit: value.leftCreditLimit,
  peerCreditLimit: 0n,
  inCapacity: value.leftCreditLimit,
  outCapacity: value.leftCreditLimit,
  outOwnCredit: value.leftCreditLimit,
  inPeerCredit: 0n,
  peerCreditUsed: 0n,
  ownCreditUsed: 0n,
  outTotalHold: 0n,
  inTotalHold: 0n,
  ascii: '',
});

describe('Account load testing controller', () => {
  test('submits an available USDC payment through the shared canonical builder', async () => {
    const profile = {
      entityId: 'bob',
      entityEncryptionPublicKey: `0x${'11'.repeat(32)}`,
      name: 'Bob',
      avatar: '',
      bio: '',
      website: '',
      lastUpdated: 1,
      runtimeId: 'bob-runtime',
      runtimeEncPubKey: '',
      runtimeSignature: 'runtime-signature',
      publicAccounts: ['alice'],
      wsUrl: null,
      relays: [],
      metadata: {
        isHub: false,
        routingFeePPM: 0,
        baseFee: 0n,
        profileHanko: 'profile-hanko',
      },
      accounts: [],
    };
    const paymentView: PaymentPanelView = {
      replicaMap: new Map([['alice:signer', {
        state: {
          accounts: new Map([['bob', {
            leftEntity: 'alice',
            rightEntity: 'bob',
            deltas: new Map([[1, delta(10_000_000n)]]),
          }]]),
          lockBook: new Map(),
        },
      }]]),
      profiles: [profile],
      knownRecipientEntities: ['bob'],
      blockedCounterpartyIds: new Set(),
      networkGraph: {
        findPaths: async () => [{
          path: ['alice', 'bob'],
          hops: [],
          totalFee: 0n,
          totalAmount: 1_000_000n,
          probability: 1,
        }],
      },
    };
    const submitted: unknown[] = [];
    const controller = createLoadTestingController({
      sourceEntityId: () => 'alice',
      selectedHubEntityId: () => 'hub',
      paymentView: () => paymentView,
      swapView: () => null,
      sourceReplica: () => null,
      runtimeFunctions: () => ({
        deriveDelta,
        deriveSwapNetAuthorization: () => ({ maxFee: 0n, minNetReceive: 1n }),
        getDefaultSwapTradingPairs: () => [],
        getSwapPairOrientation: () => ({ baseTokenId: 1, quoteTokenId: 2, pairId: '1/2' }),
        getTokenInfo: () => ({ symbol: 'USDC', decimals: 6 }),
        planSwapCommand: () => { throw new Error('unused'); },
        requantizeRemainingSwapAtPrice: () => null,
      }),
      resolveSignerId: entityId => `${entityId}-signer`,
      submitRuntimeInput: input => submitted.push(input),
      random: () => 0,
    });

    expect(await controller.attempt('pay')).toEqual({ status: 'submitted', reason: 'USDC payment submitted' });
    expect(submitted).toEqual([{
      runtimeTxs: [],
      entityInputs: [{
        entityId: 'alice',
        signerId: 'alice-signer',
        entityTxs: [{
          type: 'htlcPayment',
          data: {
            targetEntityId: 'bob',
            tokenId: 1,
            amount: 1_000_000n,
            maxSenderDebit: 1_000_000n,
            route: ['alice', 'bob'],
            deliveryMode: 'instant',
            description: 'Load testing',
          },
        }],
      }],
      jInputs: [],
    }]);
  });

  test('filters a self-owned top level and exposes STP prevention', () => {
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 8, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'alice',
      orderId: 'self-bid',
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 10n,
    }).state;
    expect(selectExternalSwapLevel(book, 0, 'alice')).toEqual({
      priceTicks: 10_000n,
      stpPrevented: true,
    });

    const externalBook = applyCommand(
      createBook({ bucketWidthTicks: 1n, maxOrders: 8, stpPolicy: 1 }),
      {
        kind: 0,
        ownerId: 'bob',
        orderId: 'external-bid',
        side: 0,
        tif: 0,
        postOnly: false,
        priceTicks: 9_900n,
        qtyLots: 10n,
      },
    ).state;
    expect(selectExternalSwapLevel(externalBook, 0, 'alice')).toEqual({
      priceTicks: 9_900n,
      stpPrevented: false,
    });
  });

  test('does not catch up in bursts and counts an in-flight lane as skipped attempt', async () => {
    let now = 1_000;
    let timer: (() => void) | null = null;
    let finishAttempt: (() => void) | null = null;
    let latest: LoadTestSchedulerSnapshot | null = null;
    const scheduler = new LoadTestScheduler({
      now: () => now,
      random: () => 0,
      setTimer: run => {
        timer = run;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      attempt: () => new Promise(resolve => {
        finishAttempt = () => resolve({ status: 'submitted' });
      }),
      onSnapshot: snapshot => latest = snapshot,
    });
    scheduler.start({
      durationMinutes: 1,
      pay: { enabled: true, rate: 100 },
      swap: { enabled: false, rate: 1 },
    });
    timer?.();
    now = 1_010;
    timer?.();
    expect(latest?.metrics.pay).toMatchObject({ attempted: 2, skipped: 1 });
    finishAttempt?.();
    await Promise.resolve();
    scheduler.stop();
  });
});

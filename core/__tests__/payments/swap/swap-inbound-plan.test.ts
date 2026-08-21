import { describe, expect, test } from 'bun:test';

import {
  planSwapInboundCapacity,
  readSwapAccountCapacity,
} from '../../../account/swap/swap-inbound-plan';
import type { AccountState, Delta } from '../../../types/account';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

const left = `0x${'11'.repeat(32)}`;
const right = `0x${'22'.repeat(32)}`;

const delta = (overrides: Partial<Delta> = {}): Delta => ({
  tokenId: 1,
  collateral: 0n,
  ondelta: 0n,
  offdelta: 0n,
  leftCreditLimit: 0n,
  rightCreditLimit: 0n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
  ...overrides,
});

const account = (tokenDelta?: Delta): AccountState => ({
  leftEntity: left,
  rightEntity: right,
  domain: {
    chainId: 31337,
    depositoryAddress: '0x0000000000000000000000000000000000000002',
  },
  watchSeed: `0x${'33'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {
    height: 1,
    timestamp: 1,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    stateHash: `0x${'44'.repeat(32)}`,
    accountStateRoot: `0x${'55'.repeat(32)}`,
    deltas: [],
  },
  deltas: new Map(tokenDelta ? [[tokenDelta.tokenId, tokenDelta]] : []),
  locks: new Map(),
  swapOffers: new Map(),
  currentHeight: 1,
  rollbackCount: 0,
  proofHeader: { fromEntity: left, toEntity: right, nextProofNonce: 0 },
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  lastFinalizedJHeight: 0,
  disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  jNonce: 0,
});

describe('swap inbound capacity planner', () => {
  test('exposes canonical capacity without leaking deriveDelta into UI', () => {
    expect(readSwapAccountCapacity({
      account: account(delta({
        rightCreditLimit: 500n,
        offdelta: 200n,
        rightHold: 50n,
      })),
      ownerEntityId: left,
      counterpartyEntityId: right,
      tokenId: 1,
    })).toEqual({
      accountExists: true,
      tokenActive: true,
      inCapacity: 250n,
      outCapacity: 200n,
      peerCreditLimit: 500n,
    });
  });

  test('opens a missing account with exactly the required credit and no floor', () => {
    const plan = planSwapInboundCapacity({
      account: null,
      ownerEntityId: left,
      counterpartyEntityId: right,
      tokenId: 1,
      requiredInboundAmount: 12_345n,
      allowOpenAccount: true,
      newAccountDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
    });

    expect(plan.requiredPeerCreditLimit).toBe(12_345n);
    expect(plan.creditIncrease).toBe(12_345n);
    expect(plan.setupTxs).toEqual([{
      type: 'openAccount',
      data: {
        targetEntityId: right,
        disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
        tokenId: 1,
        creditAmount: 12_345n,
      },
    }]);
  });

  test('uses canonical deriveDelta fields for an exact existing-account increase', () => {
    const plan = planSwapInboundCapacity({
      account: account(delta({
        rightCreditLimit: 500n,
        offdelta: 200n,
        rightHold: 50n,
      })),
      ownerEntityId: left,
      counterpartyEntityId: right,
      tokenId: 1,
      requiredInboundAmount: 700n,
      allowOpenAccount: false,
    });

    expect(plan.currentInboundCapacity).toBe(250n);
    expect(plan.currentPeerCreditLimit).toBe(500n);
    expect(plan.requiredPeerCreditLimit).toBe(950n);
    expect(plan.creditIncrease).toBe(450n);
    expect(plan.setupTxs).toEqual([{
      type: 'extendCredit',
      data: { counterpartyEntityId: right, tokenId: 1, amount: 950n },
    }]);
  });

  test('emits no transaction when canonical inbound capacity is sufficient', () => {
    const plan = planSwapInboundCapacity({
      account: account(delta({ rightCreditLimit: 1_000n })),
      ownerEntityId: left,
      counterpartyEntityId: right,
      tokenId: 1,
      requiredInboundAmount: 600n,
      allowOpenAccount: false,
    });

    expect(plan.currentInboundCapacity).toBe(1_000n);
    expect(plan.requiredPeerCreditLimit).toBeNull();
    expect(plan.setupTxs).toEqual([]);
  });

  test('uses the mirrored credit field for the right entity perspective', () => {
    const plan = planSwapInboundCapacity({
      account: account(delta({
        leftCreditLimit: 500n,
        offdelta: -200n,
        leftHold: 50n,
      })),
      ownerEntityId: right,
      counterpartyEntityId: left,
      tokenId: 1,
      requiredInboundAmount: 700n,
      allowOpenAccount: false,
    });

    expect(plan.currentInboundCapacity).toBe(250n);
    expect(plan.currentPeerCreditLimit).toBe(500n);
    expect(plan.requiredPeerCreditLimit).toBe(950n);
    expect(plan.setupTxs).toEqual([{
      type: 'extendCredit',
      data: { counterpartyEntityId: left, tokenId: 1, amount: 950n },
    }]);
  });

  test('adds new inbound capacity above an already fully held credit window', () => {
    const plan = planSwapInboundCapacity({
      account: account(delta({
        rightCreditLimit: 24_900_000n,
        rightHold: 24_900_000n,
      })),
      ownerEntityId: left,
      counterpartyEntityId: right,
      tokenId: 1,
      requiredInboundAmount: 10_000_000n,
      allowOpenAccount: false,
    });

    expect(plan.currentInboundCapacity).toBe(0n);
    expect(plan.requiredPeerCreditLimit).toBe(34_900_000n);
    expect(plan.creditIncrease).toBe(10_000_000n);
  });
});

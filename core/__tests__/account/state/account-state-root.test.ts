import { describe, expect, test } from 'bun:test';

import {
  computeAccountShadowRoot,
  computeAccountStateRoot,
  encodeAccountStateValue,
  encodeAccountStateValueOracle,
} from '../../../account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';
import type { AccountReplica } from '../../../types/account';
import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const DOMAIN = { chainId: 31337, depositoryAddress: `0x${'33'.repeat(20)}` };

const account = (): AccountReplica => ({
  state: {
    leftEntity: LEFT,
    rightEntity: RIGHT,
    domain: DOMAIN,
    watchSeed: `0x${'44'.repeat(32)}`,
    deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, createDefaultDelta(1)]]),
    locks: PersistentAccountStateMap.empty('locks'),
    pulls: PersistentAccountStateMap.empty('pulls'),
    swapOffers: PersistentAccountStateMap.empty('swapOffers'),
    jNonce: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    lastFinalizedJHeight: 0,
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
    requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
  },
  status: 'active',
  shadow: { rebalance: {
    policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
    submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
  } },
  mempool: [],
  pendingSignatures: [],
  currentFrame: {} as never,
  currentHeight: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
});

describe('canonical account state root', () => {
  test('direct canonical RLP encoder stays byte-identical to the recursive oracle', () => {
    const fixtures: unknown[] = [
      null,
      false,
      true,
      0,
      -17,
      0n,
      -12345678901234567890n,
      '',
      'xln',
      [1, 'two', 3n, { z: false, a: null }],
      new Map<unknown, unknown>([[2, 'b'], [1, { nested: 7n }]]),
      new Set<unknown>(['z', 'a', 5n]),
      { z: [3, 2, 1], omitted: undefined, a: new Map([['k', 9n]]) },
    ];
    for (const fixture of fixtures) {
      expect(encodeAccountStateValue(fixture)).toEqual(encodeAccountStateValueOracle(fixture));
    }
  });

  test('is independent of host locale for map keys, object keys, and dispute subcontracts', () => {
    const base = account();
    base.state.lendingIntents = PersistentAccountStateMap.fromEntries('lendingIntents', [
      ['0xaa12', 'fund'],
      ['0xab34', 'fund'],
    ]);
    base.state.subcontracts = PersistentAccountStateMap.fromEntries('subcontracts', [
      ['0xaa12', {
        transformerAddress: `0x${'66'.repeat(20)}`,
        encodedBatch: '0x12',
        allowances: [],
      }],
      ['0xab34', {
        transformerAddress: `0x${'77'.repeat(20)}`,
        encodedBatch: '0x34',
        allowances: [],
      }],
    ]);
    const originalLocaleCompare = String.prototype.localeCompare;
    const underLocale = (locale: string): { root: string; proofBodyHash: string } => {
      String.prototype.localeCompare = function localeCompare(that: string): number {
        return originalLocaleCompare.call(this, that, locale);
      };
      return {
        root: computeAccountStateRoot(base.state),
        proofBodyHash: buildAccountProofBody(base, '').proofBodyHash,
      };
    };
    try {
      expect(underLocale('en')).toEqual(underLocale('da'));
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  test('binds account domain and every financial delta field', () => {
    const base = account();
    const root = computeAccountStateRoot(base.state);

    const otherParty = account();
    otherParty.state.rightEntity = `0x${'55'.repeat(32)}`;
    expect(computeAccountStateRoot(otherParty.state)).not.toBe(root);
    const otherDomain = account();
    otherDomain.state.domain = { ...DOMAIN, chainId: 1 };
    expect(computeAccountStateRoot(otherDomain.state)).not.toBe(root);

    for (const mutate of [
      (delta: ReturnType<typeof createDefaultDelta>) => ({ ...delta, collateral: 1n }),
      (delta: ReturnType<typeof createDefaultDelta>) => ({ ...delta, ondelta: 1n }),
      (delta: ReturnType<typeof createDefaultDelta>) => ({ ...delta, offdelta: -1n }),
      (delta: ReturnType<typeof createDefaultDelta>) => ({ ...delta, leftCreditLimit: 1n }),
      (delta: ReturnType<typeof createDefaultDelta>) => ({ ...delta, rightAllowance: 1n }),
      (delta: ReturnType<typeof createDefaultDelta>) => ({ ...delta, leftHold: 1n }),
    ]) {
      const changed = account();
      const delta = changed.state.deltas.get(1);
      if (!delta) throw new Error('TEST_DELTA_MISSING');
      changed.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, mutate(delta)]]);
      expect(computeAccountStateRoot(changed.state)).not.toBe(root);
    }
  });

  test('repeat Account-root queries on unchanged scalars and maps reuse the memo', () => {
    const base = account();
    const root = computeAccountStateRoot(base.state);
    expect(computeAccountStateRoot(base.state)).toBe(root);
    expect(computeAccountStateRoot(base.state)).toBe(root);
  });

  test('replacing jNonce or settlementWorkspace misses the Account-root memo', () => {
    const base = account();
    const root = computeAccountStateRoot(base.state);
    expect(computeAccountStateRoot(base.state)).toBe(root);

    base.state.jNonce = 1;
    const afterNonce = computeAccountStateRoot(base.state);
    expect(afterNonce).not.toBe(root);
    expect(computeAccountStateRoot(base.state)).toBe(afterNonce);

    base.state.settlementWorkspace = {
      workspaceHash: `0x${'88'.repeat(32)}`,
      revision: 1,
      status: 'awaiting_counterparty',
      lastModifiedByLeft: true,
      ops: [],
      createdAt: 10,
      lastUpdatedAt: 10,
      executorIsLeft: true,
    };
    const afterWorkspace = computeAccountStateRoot(base.state);
    expect(afterWorkspace).not.toBe(afterNonce);
    expect(computeAccountStateRoot(base.state)).toBe(afterWorkspace);
  });

  test('excludes mempool, signatures, pending frames, and proof caches', () => {
    const base = account();
    const root = computeAccountStateRoot(base.state);
    base.mempool.push({ type: 'direct_payment', data: { tokenId: 1, amount: 5n } });
    base.pendingSignatures.push('0x1234');
    base.pendingFrame = { stateHash: '0xdead' } as never;
    base.currentDisputeProofHanko = '0xbeef';
    base.disputeProofBodiesByHash = { '0x01': { local: true } };

    expect(computeAccountStateRoot(base.state)).toBe(root);
  });

  test('commits settlement authority bilaterally while keeping entity-only lifecycle state out', () => {
    const base = account();
    const bilateralRoot = computeAccountStateRoot(base.state);
    const overlayRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    const settlement = account();
    settlement.state.settlementWorkspace = {
      workspaceHash: `0x${'88'.repeat(32)}`,
      revision: 1,
      status: 'awaiting_counterparty',
      lastModifiedByLeft: true,
      ops: [],
      createdAt: 10,
      lastUpdatedAt: 10,
      executorIsLeft: true,
    };
    expect(computeAccountStateRoot(settlement.state)).not.toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, settlement]]))).not.toBe(overlayRoot);

    const disputed = account();
    disputed.status = 'disputed';
    disputed.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: `0x${'55'.repeat(32)}`,
      initialNonce: 1,
      disputeTimeout: 1700000100,
      disputeStartTimestamp: 1700000000,
      jNonce: 1,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
    expect(computeAccountStateRoot(disputed.state)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, disputed]]))).not.toBe(overlayRoot);

    const withdrawal = account();
    withdrawal.pendingWithdrawals = PersistentAccountStateMap.fromEntries('pendingWithdrawals', [['withdraw-1', {
      requestId: 'withdraw-1',
      tokenId: 1,
      amount: 5n,
      requestedAt: 10,
      direction: 'outgoing',
      status: 'pending',
    }]]);
    expect(computeAccountStateRoot(withdrawal.state)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, withdrawal]]))).not.toBe(overlayRoot);
  });

  test('commits settlement targets but excludes non-unique quorum Hanko bytes', () => {
    const base = account();
    base.state.settlementWorkspace = {
      workspaceHash: `0x${'88'.repeat(32)}`,
      revision: 1,
      status: 'ready_to_submit',
      lastModifiedByLeft: true,
      ops: [],
      createdAt: 10,
      lastUpdatedAt: 10,
      executorIsLeft: true,
      postSettlementDisputeProof: {
        disputeHash: `0x${'66'.repeat(32)}`,
        proofBodyHash: `0x${'77'.repeat(32)}`,
        nonce: 2,
      },
    };
    base.pendingWithdrawals = PersistentAccountStateMap.fromEntries('pendingWithdrawals', [['withdraw-1', {
      requestId: 'withdraw-1',
      tokenId: 1,
      amount: 5n,
      requestedAt: 10,
      direction: 'outgoing',
      status: 'approved',
    }]]);
    const bilateralRoot = computeAccountStateRoot(base.state);
    const overlayRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    base.state.settlementWorkspace.leftHanko = '0x1234';
    base.state.settlementWorkspace.rightHanko = '0x5678';
    base.state.settlementWorkspace.postSettlementDisputeProof!.leftHanko = '0x9abc';
    base.state.settlementWorkspace.postSettlementDisputeProof!.rightHanko = '0xdef0';
    const pending = base.pendingWithdrawals.get('withdraw-1')!;
    base.pendingWithdrawals = PersistentAccountStateMap.fromEntries(
      'pendingWithdrawals',
      [['withdraw-1', { ...pending, signature: '0xbeef' }]],
    );

    const sealedBilateralRoot = computeAccountStateRoot(base.state);
    expect(sealedBilateralRoot).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).toBe(overlayRoot);

    base.pendingWithdrawals = PersistentAccountStateMap.fromEntries(
      'pendingWithdrawals',
      [['withdraw-1', { ...pending, signature: '0xcafe' }]],
    );
    expect(computeAccountStateRoot(base.state)).toBe(sealedBilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).toBe(overlayRoot);
  });

  test('separates bilateral state from entity-private automation state', () => {
    const base = account();
    const bilateralRoot = computeAccountStateRoot(base.state);
    const shadowRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    base.shadow.rebalance.policy = PersistentAccountStateMap.fromEntries('rebalanceShadowPolicy', [[1, {
      r2cRequestSoftLimit: 500n,
      hardLimit: 10_000n,
      maxAcceptableFee: 15n,
    }]]);
    base.shadow.rebalance.submittedAtByToken = PersistentAccountStateMap.fromEntries(
      'rebalanceShadowSubmitted',
      [[1, 123]],
    );

    expect(computeAccountStateRoot(base.state)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).not.toBe(shadowRoot);
  });

  test('commits bilateral lending receipts while excluding local lifecycle state', () => {
    const base = account();
    const root = computeAccountStateRoot(base.state);

    base.state.lendingIntents = PersistentAccountStateMap.fromEntries(
      'lendingIntents',
      [['lend-0123456789abcdef', 'fund']],
    );

    expect(computeAccountStateRoot(base.state)).not.toBe(root);
  });

  test('commits generic custom transformers and preserves opaque ProofBody batches', () => {
    const base = account();
    base.state.subcontracts = PersistentAccountStateMap.fromEntries('subcontracts', [['custom-risk-engine', {
      transformerAddress: `0x${'66'.repeat(20)}`,
      encodedBatch: '0x1234',
      allowances: [{ deltaIndex: 0, rightAllowance: 7n, leftAllowance: 9n }],
      leftArgumentsHash: `0x${'77'.repeat(32)}`,
    }]]);
    const root = computeAccountStateRoot(base.state);
    const proof = buildAccountProofBody(base, '');

    expect(proof.proofBodyStruct.transformers).toContainEqual({
      transformerAddress: `0x${'66'.repeat(20)}`,
      encodedBatch: '0x1234',
      allowances: [{ deltaIndex: 0n, rightAllowance: 7n, leftAllowance: 9n }],
    });
    const changed = account();
    changed.state.subcontracts = PersistentAccountStateMap.fromEntries('subcontracts', [[
      'custom-risk-engine',
      {
        transformerAddress: `0x${'66'.repeat(20)}`,
        encodedBatch: '0xabcd',
        allowances: [{ deltaIndex: 0, rightAllowance: 7n, leftAllowance: 9n }],
        leftArgumentsHash: `0x${'77'.repeat(32)}`,
      },
    ]]);
    expect(computeAccountStateRoot(changed.state)).not.toBe(root);
  });
});

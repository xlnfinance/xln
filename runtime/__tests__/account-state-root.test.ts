import { describe, expect, test } from 'bun:test';

import {
  computeAccountShadowRoot,
  computeAccountStateRoot,
  encodeAccountStateValue,
  encodeAccountStateValueOracle,
} from '../account/state-root';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import type { AccountMachine } from '../types';
import { createDefaultDelta } from '../validation-utils';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const DOMAIN = { chainId: 31337, depositoryAddress: `0x${'33'.repeat(20)}` };

const account = (): AccountMachine => ({
  leftEntity: LEFT,
  rightEntity: RIGHT,
  domain: DOMAIN,
  watchSeed: `0x${'44'.repeat(32)}`,
  status: 'active',
  deltas: new Map([[1, createDefaultDelta(1)]]),
  locks: new Map(),
  pulls: new Map(),
  swapOffers: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  jNonce: 0,
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  lastFinalizedJHeight: 0,
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  mempool: [],
  pendingSignatures: [],
  currentFrame: {} as never,
  currentHeight: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  pendingWithdrawals: new Map(),
} as AccountMachine);

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
    base.lendingIntents = new Map([
      ['0xaa12', 'fund'],
      ['0xab34', 'fund'],
    ]);
    base.subcontracts = new Map([
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
        root: computeAccountStateRoot(base),
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
    const root = computeAccountStateRoot(base);

    const otherParty = account();
    otherParty.rightEntity = `0x${'55'.repeat(32)}`;
    expect(computeAccountStateRoot(otherParty)).not.toBe(root);
    const otherDomain = structuredClone(base);
    otherDomain.domain = { ...DOMAIN, chainId: 1 };
    expect(computeAccountStateRoot(otherDomain)).not.toBe(root);

    for (const mutate of [
      (machine: AccountMachine) => { machine.deltas.get(1)!.collateral = 1n; },
      (machine: AccountMachine) => { machine.deltas.get(1)!.ondelta = 1n; },
      (machine: AccountMachine) => { machine.deltas.get(1)!.offdelta = -1n; },
      (machine: AccountMachine) => { machine.deltas.get(1)!.leftCreditLimit = 1n; },
      (machine: AccountMachine) => { machine.deltas.get(1)!.rightAllowance = 1n; },
      (machine: AccountMachine) => { machine.deltas.get(1)!.leftHold = 1n; },
    ]) {
      const changed = structuredClone(base);
      mutate(changed);
      expect(computeAccountStateRoot(changed)).not.toBe(root);
    }
  });

  test('excludes mempool, signatures, pending frames, and proof caches', () => {
    const base = account();
    const root = computeAccountStateRoot(base);
    base.mempool.push({ type: 'direct_payment', data: { tokenId: 1, amount: 5n } });
    base.pendingSignatures.push('0x1234');
    base.pendingFrame = { stateHash: '0xdead' } as never;
    base.currentDisputeProofHanko = '0xbeef';
    base.disputeProofBodiesByHash = { '0x01': { local: true } };

    expect(computeAccountStateRoot(base)).toBe(root);
  });

  test('commits settlement authority bilaterally while keeping entity-only lifecycle state out', () => {
    const base = account();
    const bilateralRoot = computeAccountStateRoot(base);
    const overlayRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    const settlement = structuredClone(base);
    settlement.settlementWorkspace = {
      workspaceHash: `0x${'88'.repeat(32)}`,
      version: 1,
      status: 'awaiting_counterparty',
      lastModifiedByLeft: true,
      ops: [],
      createdAt: 10,
      lastUpdatedAt: 10,
      executorIsLeft: true,
    };
    expect(computeAccountStateRoot(settlement)).not.toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, settlement]]))).not.toBe(overlayRoot);

    const disputed = structuredClone(base);
    disputed.status = 'disputed';
    disputed.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: `0x${'55'.repeat(32)}`,
      initialNonce: 1,
      disputeTimeout: 20,
      jNonce: 1,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
    };
    expect(computeAccountStateRoot(disputed)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, disputed]]))).not.toBe(overlayRoot);

    const withdrawal = structuredClone(base);
    withdrawal.pendingWithdrawals.set('withdraw-1', {
      requestId: 'withdraw-1',
      tokenId: 1,
      amount: 5n,
      requestedAt: 10,
      direction: 'outgoing',
      status: 'pending',
    });
    expect(computeAccountStateRoot(withdrawal)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, withdrawal]]))).not.toBe(overlayRoot);
  });

  test('commits settlement Hankos bilaterally while excluding post-consensus overlay signatures', () => {
    const base = account();
    base.settlementWorkspace = {
      workspaceHash: `0x${'88'.repeat(32)}`,
      version: 1,
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
    base.pendingWithdrawals.set('withdraw-1', {
      requestId: 'withdraw-1',
      tokenId: 1,
      amount: 5n,
      requestedAt: 10,
      direction: 'outgoing',
      status: 'approved',
    });
    const bilateralRoot = computeAccountStateRoot(base);
    const overlayRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    base.settlementWorkspace.leftHanko = '0x1234';
    base.settlementWorkspace.rightHanko = '0x5678';
    base.settlementWorkspace.postSettlementDisputeProof!.leftHanko = '0x9abc';
    base.settlementWorkspace.postSettlementDisputeProof!.rightHanko = '0xdef0';
    base.pendingWithdrawals.get('withdraw-1')!.signature = '0xbeef';

    const sealedBilateralRoot = computeAccountStateRoot(base);
    expect(sealedBilateralRoot).not.toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).toBe(overlayRoot);

    base.pendingWithdrawals.get('withdraw-1')!.signature = '0xcafe';
    expect(computeAccountStateRoot(base)).toBe(sealedBilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).toBe(overlayRoot);
  });

  test('separates bilateral state from entity-private automation state', () => {
    const base = account();
    const bilateralRoot = computeAccountStateRoot(base);
    const shadowRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    base.shadow.rebalance.policy.set(1, {
      r2cRequestSoftLimit: 500n,
      hardLimit: 10_000n,
      maxAcceptableFee: 15n,
    });
    base.shadow.rebalance.submittedAtByToken.set(1, 123);

    expect(computeAccountStateRoot(base)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).not.toBe(shadowRoot);
  });

  test('commits bilateral lending receipts while excluding local lifecycle state', () => {
    const base = account();
    const root = computeAccountStateRoot(base);

    base.lendingIntents = new Map([['lend-0123456789abcdef', 'fund']]);

    expect(computeAccountStateRoot(base)).not.toBe(root);
  });

  test('commits generic custom transformers and preserves opaque ProofBody batches', () => {
    const base = account();
    base.subcontracts = new Map([['custom-risk-engine', {
      transformerAddress: `0x${'66'.repeat(20)}`,
      encodedBatch: '0x1234',
      allowances: [{ deltaIndex: 0, rightAllowance: 7n, leftAllowance: 9n }],
      leftArgumentsHash: `0x${'77'.repeat(32)}`,
    }]]);
    const root = computeAccountStateRoot(base);
    const proof = buildAccountProofBody(base, '');

    expect(proof.proofBodyStruct.transformers).toContainEqual({
      transformerAddress: `0x${'66'.repeat(20)}`,
      encodedBatch: '0x1234',
      allowances: [{ deltaIndex: 0n, rightAllowance: 7n, leftAllowance: 9n }],
    });
    const changed = structuredClone(base);
    changed.subcontracts!.get('custom-risk-engine')!.encodedBatch = '0xabcd';
    expect(computeAccountStateRoot(changed)).not.toBe(root);
  });
});

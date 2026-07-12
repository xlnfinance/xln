import { describe, expect, test } from 'bun:test';

import { computeAccountShadowRoot, computeAccountStateRoot } from '../account/state-root';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import type { AccountMachine } from '../types';
import { createDefaultDelta } from '../validation-utils';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const DOMAIN = { chainId: 31337, depositoryAddress: `0x${'33'.repeat(20)}` };

const account = (): AccountMachine => ({
  leftEntity: LEFT,
  rightEntity: RIGHT,
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
  leftJObservations: [],
  rightJObservations: [],
  jEventChain: [],
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
  test('binds account domain and every financial delta field', () => {
    const base = account();
    const root = computeAccountStateRoot(base, DOMAIN);

    const otherParty = account();
    otherParty.rightEntity = `0x${'55'.repeat(32)}`;
    expect(computeAccountStateRoot(otherParty, DOMAIN)).not.toBe(root);
    expect(computeAccountStateRoot(base, { ...DOMAIN, chainId: 1 })).not.toBe(root);

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
      expect(computeAccountStateRoot(changed, DOMAIN)).not.toBe(root);
    }
  });

  test('excludes mempool, signatures, pending frames, and proof caches', () => {
    const base = account();
    const root = computeAccountStateRoot(base, DOMAIN);
    base.mempool.push({ type: 'direct_payment', data: { tokenId: 1, amount: 5n } });
    base.pendingSignatures.push('0x1234');
    base.pendingFrame = { stateHash: '0xdead' } as never;
    base.currentDisputeProofHanko = '0xbeef';
    base.disputeProofBodiesByHash = { '0x01': { local: true } };

    expect(computeAccountStateRoot(base, DOMAIN)).toBe(root);
  });

  test('moves entity-owned lifecycle state out of the bilateral root', () => {
    const base = account();
    const bilateralRoot = computeAccountStateRoot(base, DOMAIN);
    const overlayRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    const settlement = structuredClone(base);
    settlement.settlementWorkspace = {
      version: 1,
      status: 'awaiting_counterparty',
      lastModifiedByLeft: true,
      ops: [],
      createdAt: 10,
      lastUpdatedAt: 10,
      executorIsLeft: true,
    } as never;
    expect(computeAccountStateRoot(settlement, DOMAIN)).toBe(bilateralRoot);
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
    expect(computeAccountStateRoot(disputed, DOMAIN)).toBe(bilateralRoot);
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
    expect(computeAccountStateRoot(withdrawal, DOMAIN)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, withdrawal]]))).not.toBe(overlayRoot);
  });

  test('keeps hankos and signatures outside bilateral and entity overlay roots', () => {
    const base = account();
    base.settlementWorkspace = {
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
    const bilateralRoot = computeAccountStateRoot(base, DOMAIN);
    const overlayRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    base.settlementWorkspace.leftHanko = '0x1234';
    base.settlementWorkspace.rightHanko = '0x5678';
    base.settlementWorkspace.postSettlementDisputeProof!.leftHanko = '0x9abc';
    base.settlementWorkspace.postSettlementDisputeProof!.rightHanko = '0xdef0';
    base.pendingWithdrawals.get('withdraw-1')!.signature = '0xbeef';

    expect(computeAccountStateRoot(base, DOMAIN)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).toBe(overlayRoot);
  });

  test('separates bilateral state from entity-private automation state', () => {
    const base = account();
    const bilateralRoot = computeAccountStateRoot(base, DOMAIN);
    const shadowRoot = computeAccountShadowRoot(new Map([[RIGHT, base]]));

    base.shadow.rebalance.policy.set(1, {
      r2cRequestSoftLimit: 500n,
      hardLimit: 10_000n,
      maxAcceptableFee: 15n,
    });
    base.shadow.rebalance.submittedAtByToken.set(1, 123);

    expect(computeAccountStateRoot(base, DOMAIN)).toBe(bilateralRoot);
    expect(computeAccountShadowRoot(new Map([[RIGHT, base]]))).not.toBe(shadowRoot);
  });

  test('commits bilateral lending receipts while excluding local lifecycle state', () => {
    const base = account();
    const root = computeAccountStateRoot(base, DOMAIN);

    base.lendingIntents = new Map([['lend-0123456789abcdef', 'fund']]);

    expect(computeAccountStateRoot(base, DOMAIN)).not.toBe(root);
  });

  test('commits generic custom transformers and preserves opaque ProofBody batches', () => {
    const base = account();
    base.subcontracts = new Map([['custom-risk-engine', {
      transformerAddress: `0x${'66'.repeat(20)}`,
      encodedBatch: '0x1234',
      allowances: [{ deltaIndex: 0, rightAllowance: 7n, leftAllowance: 9n }],
      leftArgumentsHash: `0x${'77'.repeat(32)}`,
    }]]);
    const root = computeAccountStateRoot(base, DOMAIN);
    const proof = buildAccountProofBody(base);

    expect(proof.proofBodyStruct.transformers).toContainEqual({
      transformerAddress: `0x${'66'.repeat(20)}`,
      encodedBatch: '0x1234',
      allowances: [{ deltaIndex: 0n, rightAllowance: 7n, leftAllowance: 9n }],
    });
    const changed = structuredClone(base);
    changed.subcontracts!.get('custom-risk-engine')!.encodedBatch = '0xabcd';
    expect(computeAccountStateRoot(changed, DOMAIN)).not.toBe(root);
  });
});

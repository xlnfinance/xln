import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { createEmptyEnv } from '../../../runtime';
import {
  flushDeferredHashLadderReveals,
  isSourceRevealWindowExpired,
  queueHashLadderRevealRegistration,
} from '../../../entity/tx/j-events-htlc';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { CrossJurisdictionPullLeg } from '../../../types/cross-jurisdiction';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../../protocol/dispute/arguments';
import { initJBatch } from '../../../jurisdiction/machine/batch';
import {
  addReplica,
  addr,
  entity,
  makeJurisdiction,
  makeAccount,
  makeState,
  registerTestSigner,
} from '../../helpers/cross-j';

const pull: CrossJurisdictionPullLeg = {
  pullId: 'test-pull',
  tokenId: 1,
  amount: 65_535n,
  signedAmount: 65_535n,
  fullHash: `0x${'11'.repeat(32)}`,
  partialRoot: `0x${'22'.repeat(32)}`,
};

const reveal = (fillRatio: number) => ({
  fillRatio,
  fullSecret: `0x${'00'.repeat(32)}`,
  reveals: [
    `0x${'33'.repeat(32)}`,
    `0x${'44'.repeat(32)}`,
    `0x${'55'.repeat(32)}`,
    `0x${'66'.repeat(32)}`,
  ] as [string, string, string, string],
});

test('Source reveal window includes the complete signed deadline second', () => {
  const deadlineSec = 1_700_000_123;
  expect(isSourceRevealWindowExpired(deadlineSec * 1_000, deadlineSec)).toBe(false);
  expect(isSourceRevealWindowExpired(deadlineSec * 1_000 + 999, deadlineSec)).toBe(false);
  expect(isSourceRevealWindowExpired((deadlineSec + 1) * 1_000, deadlineSec)).toBe(true);
});

const installActiveSignedPull = (
  state: ReturnType<typeof makeState>,
  counterparty: string,
  targetRole = false,
  pullId = pull.pullId,
  draftStart = false,
): CrossJurisdictionPullLeg => {
  const account = state.accounts.get(counterparty)!;
  const selfIsLeft = account.state.leftEntity.toLowerCase() === state.entityId.toLowerCase();
  const signedPull = {
    ...pull,
    pullId,
    signedAmount: selfIsLeft ? pull.amount : -pull.amount,
  };
  account.state.pulls ??= new Map();
  account.state.pulls.set(signedPull.pullId, {
    pullId: signedPull.pullId,
    tokenId: signedPull.tokenId,
    amount: signedPull.signedAmount,
    fullHash: signedPull.fullHash,
    partialRoot: signedPull.partialRoot,
    crossJurisdiction: {
      orderId: 'test-order',
      routeHash: ethers.ZeroHash,
      leg: targetRole ? 'target' : 'source',
    },
    createdHeight: 1,
    createdTimestamp: state.timestamp,
  });
  const proof = buildAccountProofBody(account, addr('99'));
  account.disputeProofBodiesByHash = { [proof.proofBodyHash]: proof.proofBodyStruct };
  storeDisputeArgumentSnapshot(
    account,
    captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, false, proof.proofBodyStruct),
  );
  account.status = 'disputed';
  // Runtime timestamps are unix milliseconds; jurisdiction dispute clocks are
  // unix seconds. Both signed roles open at their own account's S.
  state.timestamp = 1_000;
  account.activeDispute = {
    startedByLeft: false,
    initialProofbodyHash: proof.proofBodyHash,
    initialNonce: 1,
    initialProposerIsLeft: false,
    disputeTimeout: 21,
    disputeStartTimestamp: 1,
    jNonce: 1,
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    observedOnChain: true,
  };
  if (draftStart) {
    account.activeDispute.observedOnChain = false;
    account.activeDispute.disputeTimeout = 0;
    delete account.activeDispute.disputeStartTimestamp;
    state.jBatchState ??= initJBatch();
    state.jBatchState.batch.disputeStarts.push({
      counterentity: counterparty,
      nonce: 1,
      proofbodyHash: proof.proofBodyHash,
      initialProofbody: proof.proofBodyStruct,
      watchSeed: String(proof.proofBodyStruct.watchSeed),
      sig: '0x',
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
  }
  return signedPull;
};

describe('hash-ladder reveal queue (source single-shot / target replaceable)', () => {
  test('mirrors the first-Source active window before mutating the J draft', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const hub = entity('5a');
    const user = entity('5b');

    const timely = makeState(hub, addr('5c'), eth, user);
    const timelyPull = installActiveSignedPull(timely, user);
    timely.timestamp = 11_999;
    expect(queueHashLadderRevealRegistration(timely, user, timelyPull, reveal(0x1000), false))
      .toBe('queued');

    const late = makeState(hub, addr('5d'), eth, user);
    const latePull = installActiveSignedPull(late, user);
    late.timestamp = 12_000;
    expect(queueHashLadderRevealRegistration(late, user, latePull, reveal(0x1000), false))
      .toBe('source-window-expired');
    expect(late.jBatchState?.batch.hashLadderRegistrations ?? []).toHaveLength(0);

    const inactive = makeState(hub, addr('5e'), eth, user);
    const inactivePull = installActiveSignedPull(inactive, user);
    delete inactive.accounts.get(user)!.activeDispute;
    expect(() => queueHashLadderRevealRegistration(inactive, user, inactivePull, reveal(0x1000), false))
      .toThrow('J_HASH_LADDER_SOURCE_ACTIVE_DISPUTE_MISSING');
  });

  test('full Entity draft defers an urgent reveal and drains it after capacity clears', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const hub = entity('a0');
    const user = entity('a1');
    const state = makeState(hub, addr('a2'), eth, user);
    const signedPull = installActiveSignedPull(state, user);
    const route: CrossJurisdictionSwapRoute = {
      orderId: 'capacity-deferred',
      makerEntityId: user,
      hubEntityId: hub,
      source: { jurisdiction: 'eth', entityId: user, counterpartyEntityId: hub, tokenId: 1, amount: 100n },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      target: { jurisdiction: 'base', entityId: entity('a3'), counterpartyEntityId: entity('a4'), tokenId: 1, amount: 90n },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      sourcePull: signedPull,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    state.jBatchState = initJBatch();
    state.jBatchState.batch.hashLadderRegistrations = Array.from({ length: 32 }, (_, index) => ({
      counterpartyEntity: user,
      targetRole: false,
      fullHash: ethers.zeroPadValue(ethers.toBeHex(index + 100), 32),
      partialRoot: ethers.zeroPadValue(ethers.toBeHex(index + 200), 32),
      witness: {
        fillRatio: 1,
        fullSecret: ethers.ZeroHash,
        reveals: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      },
    }));
    state.jBatchState.sentBatch = {
      batch: initJBatch().batch,
      batchHash: ethers.ZeroHash,
      encodedBatch: '0x',
      entityNonce: 1,
      firstSubmittedAt: 1,
      lastSubmittedAt: 1,
      submitAttempts: 1,
    };

    expect(queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x1000), false))
      .toBe('deferred-batch-pending');
    expect(route.pendingSourceRegistryReveal?.fillRatio).toBe(0x1000);
    expect(state.jBatchState.autoBroadcastDraft).toBe(true);
    expect(flushDeferredHashLadderReveals(state)).toBe(0);
    expect(route.pendingSourceRegistryReveal?.fillRatio).toBe(0x1000);
    delete state.jBatchState.sentBatch;
    state.jBatchState.batch.hashLadderRegistrations = [];
    expect(flushDeferredHashLadderReveals(state)).toBe(1);
    expect(route.pendingSourceRegistryReveal).toBeUndefined();
    expect(state.jBatchState.batch.hashLadderRegistrations).toHaveLength(1);
  });

  test('queues the first source write and rejects a different second ratio', () => {
    const env = createEmptyEnv('reveal-queue-exact-once');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('61');
    const hub = entity('62');
    const signer = registerTestSigner(env, 'reveal-queue-exact-once', 'hub');
    const state = makeState(hub, signer, eth, user);
    addReplica(env, state, signer);
    const signedPull = installActiveSignedPull(state, user);

    expect(queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x1000), false)).toBe('queued');
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);
    expect(state.jBatchState?.batch.hashLadderRegistrations[0]?.witness.fillRatio).toBe(0x1000);

    // Reject before broadcast so a conflicting Source witness cannot poison
    // an otherwise valid processBatch with Solidity's E12.
    expect(() => queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x2000), false))
      .toThrow('J_HASH_LADDER_REGISTRATION_CONFLICT');
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);
    expect(state.jBatchState?.batch.hashLadderRegistrations[0]?.witness.fillRatio).toBe(0x1000);
  });

  test('same-ratio retry stays already-queued (idempotent)', () => {
    const env = createEmptyEnv('reveal-queue-same-ratio');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('71');
    const hub = entity('72');
    const signer = registerTestSigner(env, 'reveal-queue-same-ratio', 'hub');
    const state = makeState(hub, signer, eth, user);
    const signedPull = installActiveSignedPull(state, user);

    expect(queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x0123), false)).toBe('queued');
    expect(queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x0123), false)).toBe('already-queued');
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);
  });

  test('does not re-queue after the role-specific own-slot latch is set', () => {
    const env = createEmptyEnv('reveal-queue-registry-latch');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('81');
    const hub = entity('82');
    const signer = addr('91');
    const state = makeState(hub, signer, eth, user);
    const signedPull = installActiveSignedPull(state, user);
    const route: CrossJurisdictionSwapRoute = {
      orderId: 'latch-route',
      makerEntityId: user,
      hubEntityId: hub,
      source: {
        jurisdiction: 'eth',
        entityId: user,
        counterpartyEntityId: hub,
        tokenId: 1,
        amount: 100n,
      },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      target: {
        jurisdiction: 'base',
        entityId: entity('83'),
        counterpartyEntityId: entity('84'),
        tokenId: 1,
        amount: 90n,
      },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      sourcePull: signedPull,
      // On-chain registration already observed — must not enqueue again.
      sourceRegistryFillRatio: 0x1000,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);

    expect(() => queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x2000), false))
      .toThrow('J_HASH_LADDER_REGISTRATION_CONFLICT');
    expect(state.jBatchState?.batch.hashLadderRegistrations ?? []).toHaveLength(0);
  });

  test('target retries are exact no-ops, higher replacements, and lower conflicts', () => {
    const env = createEmptyEnv('reveal-queue-target-replace');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('a1');
    const hub = entity('a2');
    const signer = addr('a3');
    const state = makeState(user, signer, eth, hub);
    const signedPull = installActiveSignedPull(state, hub, true);

    expect(queueHashLadderRevealRegistration(state, hub, signedPull, reveal(0x1000), true)).toBe('queued');
    expect(queueHashLadderRevealRegistration(state, hub, signedPull, reveal(0x1000), true)).toBe('already-queued');
    expect(queueHashLadderRevealRegistration(state, hub, signedPull, reveal(0x2000), true)).toBe('queued');
    expect(state.jBatchState?.batch.hashLadderRegistrations[0]?.witness.fillRatio)
      .toBe(0x2000);
    state.jBatchState!.recoveryBatches = [state.jBatchState!.batch];
    state.jBatchState!.batch = initJBatch().batch;
    expect(queueHashLadderRevealRegistration(state, hub, signedPull, reveal(0x2000), true))
      .toBe('already-queued');
    expect(() => queueHashLadderRevealRegistration(state, hub, signedPull, reveal(0x1800), true))
      .toThrow('J_HASH_LADDER_REGISTRATION_CONFLICT');
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(0);
  });

  test('queues target immediately at its dispute-start millisecond', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('b1');
    const hub = entity('b2');
    const state = makeState(user, addr('b3'), eth, hub);
    const signedPull = installActiveSignedPull(state, hub, true);
    const route: CrossJurisdictionSwapRoute = {
      orderId: 'early-target',
      makerEntityId: entity('b4'),
      hubEntityId: hub,
      source: {
        jurisdiction: 'base', entityId: entity('b4'), counterpartyEntityId: entity('b5'),
        tokenId: 1, amount: 100n,
      },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      target: { jurisdiction: 'eth', entityId: hub, counterpartyEntityId: user, tokenId: 1, amount: 90n },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetPull: signedPull,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    state.timestamp = 1_000;

    expect(queueHashLadderRevealRegistration(state, hub, signedPull, reveal(0x1000), true))
      .toBe('queued');
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);
  });

  test('co-batches target registration with its exact unobserved dispute start', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('c1');
    const hub = entity('c2');
    const state = makeState(user, addr('c3'), eth, hub);
    const signedPull = installActiveSignedPull(state, hub, true, pull.pullId, true);

    // Zero-second windows are valid bilateral policy. Waiting for the
    // DisputeStarted event would make such a Target reveal impossible, so the
    // runtime authenticates the exact mutable start and submits both ops in
    // one batch. Depository orders starts before registrations.
    expect(queueHashLadderRevealRegistration(state, hub, signedPull, reveal(0x1000), true))
      .toBe('queued');
    expect(state.jBatchState?.batch.disputeStarts).toHaveLength(1);
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);
    expect(state.jBatchState?.batch.hashLadderRegistrations[0]?.targetRole).toBe(true);
  });

  test('same writer/ladder/role stays isolated across bilateral Account keys', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const hub = entity('f0');
    const userA = entity('01');
    const userB = entity('02');
    const state = makeState(hub, addr('f1'), eth, userA);
    state.accounts.set(userB, makeAccount(hub, userB, eth));
    const pullA = installActiveSignedPull(state, userA);
    const pullB = installActiveSignedPull(state, userB, false, 'test-pull-b');
    const routeFor = (orderId: string, user: string, sourcePull: CrossJurisdictionPullLeg): CrossJurisdictionSwapRoute => ({
      orderId,
      makerEntityId: user,
      hubEntityId: hub,
      source: { jurisdiction: 'eth', entityId: user, counterpartyEntityId: hub, tokenId: 1, amount: 100n },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      target: {
        jurisdiction: 'base', entityId: entity('e1'), counterpartyEntityId: entity('e2'),
        tokenId: 1, amount: 90n,
      },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      sourcePull,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    });
    state.crossJurisdictionSwaps = new Map([
      ['slot-a', routeFor('slot-a', userA, pullA)],
      ['slot-b', routeFor('slot-b', userB, pullB)],
    ]);

    expect(queueHashLadderRevealRegistration(state, userA, pullA, reveal(0x1000), false)).toBe('queued');
    expect(queueHashLadderRevealRegistration(state, userB, pullB, reveal(0x1000), false))
      .toBe('queued');
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(2);
  });

  test('own-slot latch blocks queue; foreign-looking claimedRatio alone does not', () => {
    // claimedRatio is signed close progress; sourceRegistryFillRatio is the
    // own-slot queue latch. Confusing them is the silent target-leg-zero bug.
    const env = createEmptyEnv('reveal-queue-foreign-vs-own');
    env.scenarioMode = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const user = entity('91');
    const hub = entity('92');
    const signer = addr('93');
    const state = makeState(hub, signer, eth, user);
    const signedPull = installActiveSignedPull(state, user);
    const route: CrossJurisdictionSwapRoute = {
      orderId: 'foreign-vs-own',
      makerEntityId: user,
      hubEntityId: hub,
      source: {
        jurisdiction: 'eth',
        entityId: user,
        counterpartyEntityId: hub,
        tokenId: 1,
        amount: 100n,
      },
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      target: {
        jurisdiction: 'base',
        entityId: entity('94'),
        counterpartyEntityId: user,
        tokenId: 1,
        amount: 90n,
      },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      sourcePull: signedPull,
      claimedRatio: 0x1000,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);

    expect(queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x1000), false)).toBe('queued');
    expect(state.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);

    route.sourceRegistryFillRatio = 0x1000;
    state.jBatchState!.batch.hashLadderRegistrations = [];
    expect(queueHashLadderRevealRegistration(state, user, signedPull, reveal(0x1000), false)).toBe('already-queued');
  });
});

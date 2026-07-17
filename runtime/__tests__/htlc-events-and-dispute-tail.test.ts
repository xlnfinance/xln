import { describe, expect, test } from 'bun:test';

import { executeCrontab, initCrontab, scheduleHook } from '../entity/scheduler';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import {
  buildHtlcFinalizedEventPayload,
  buildHtlcReceivedEventPayload,
} from '../protocol/htlc/events';
import { applyCommittedAccountFrameFollowups } from '../entity/tx/handlers/account';
import { applyHtlcSecretFollowups } from '../entity/tx/handlers/account/committed-htlc-followups';
import { handleResolveHtlcLockEntityTx } from '../entity/tx/handlers/htlc-direct';
import { pruneSettledOriginatedHtlcRoutes } from '../entity/tx/htlc-route-lifecycle';
import { createEmptyEnv } from '../runtime';
import type { AccountMachine, EntityReplica } from '../types';

const makeReplica = (entityId: string, counterpartyId: string): EntityReplica => {
  const account: AccountMachine = {
    leftEntity: entityId,
    rightEntity: counterpartyId,
    domain: {
      chainId: 31337,
      depositoryAddress: `0x${'dd'.repeat(20)}`,
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      deltas: [],
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '',
      byLeft: true,
    },
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
  };

  return {
    entityId,
    signerId: '1',
    mempool: [],
    isProposer: true,
    state: {
      entityId,
      height: 0,
      timestamp: 50_000,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: ['1'],
        shares: { '1': 1n },
      },
      reserves: new Map(),
      accounts: new Map([[counterpartyId, account]]),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
      jBlockChain: [],
      entityEncPubKey: `${'0x'}${'11'.repeat(32)}`,
      entityEncPrivKey: `${'0x'}${'22'.repeat(32)}`,
      profile: {
        name: 'Replica',
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      htlcNotes: new Map(),
      lockBook: new Map(),
      swapTradingPairs: [],
      pendingSwapFillRatios: new Map(),
      crontabState: initCrontab(),
    },
  };
};

describe('htlc event contract and dispute tail', () => {
  test('persists a verified out-of-band preimage before the counterparty ACKs', () => {
    const entityId = `0x${'22'.repeat(32)}`;
    const counterpartyId = `0x${'11'.repeat(32)}`;
    const lockId = `0x${'33'.repeat(32)}`;
    const secret = `0x${'44'.repeat(32)}`;
    const hashlock = `0x4033fb2e6fa5cf816f87a9a40e8ce681fb6d8aa53c5302e72b80f654141a0e65`;
    const replica = makeReplica(entityId, counterpartyId);
    const account = replica.state.accounts.get(counterpartyId)!;
    account.leftEntity = counterpartyId;
    account.rightEntity = entityId;
    account.locks.set(lockId, {
      lockId,
      hashlock,
      tokenId: 1,
      amount: 10n,
      timelock: 100_000n,
      revealBeforeHeight: 10,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: replica.state.timestamp - 1_000,
    });

    const result = handleResolveHtlcLockEntityTx(replica.state, {
      type: 'resolveHtlcLock',
      data: { counterpartyEntityId: counterpartyId, lockId, secret },
    });

    expect(result.mempoolOps).toEqual([{
      accountId: counterpartyId,
      tx: { type: 'htlc_resolve', data: { lockId, outcome: 'secret', secret } },
    }]);
    expect(result.newState.htlcRoutes.get(hashlock)).toMatchObject({
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: counterpartyId,
      inboundLockId: lockId,
      secret,
    });
    expect(replica.state.htlcRoutes.has(hashlock)).toBe(false);

    const invalid = handleResolveHtlcLockEntityTx(replica.state, {
      type: 'resolveHtlcLock',
      data: { counterpartyEntityId: counterpartyId, lockId, secret: `0x${'55'.repeat(32)}` },
    });
    expect(invalid.mempoolOps).toEqual([]);
    expect(invalid.newState.htlcRoutes.has(hashlock)).toBe(false);

    const conflicted = structuredClone(replica.state);
    conflicted.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: `0x${'66'.repeat(32)}`,
      inboundLockId: lockId,
      createdTimestamp: conflicted.timestamp,
    });
    expect(() => handleResolveHtlcLockEntityTx(conflicted, {
      type: 'resolveHtlcLock',
      data: { counterpartyEntityId: counterpartyId, lockId, secret },
    })).toThrow('HTLC_ROUTE_ENTITY_CONFLICT');
  });

  test('builds explicit HtlcReceived and HtlcFinalized payloads', () => {
    const received = buildHtlcReceivedEventPayload({
      entityId: '0xrecipient',
      fromEntity: '0xhub',
      toEntity: '0xrecipient',
      hashlock: `0x${'ab'.repeat(32)}`,
      lockId: 'lock-1',
      amount: 10n,
      tokenId: 1,
      jurisdictionId: 'simnet',
      description: 'invoice',
      startedAtMs: 1000000000,
      receivedAtMs: 1000000250,
    });
    expect(received).toMatchObject({
      entityId: '0xrecipient',
      fromEntity: '0xhub',
      toEntity: '0xrecipient',
      amount: '10',
      tokenId: 1,
      jurisdictionId: 'simnet',
      hashlock: `0x${'ab'.repeat(32)}`,
      lockId: 'lock-1',
      startedAtMs: 1000000000,
      receivedAtMs: 1000000250,
      elapsedMs: 250,
    });

    const finalized = buildHtlcFinalizedEventPayload({
      entityId: '0xsender',
      fromEntity: '0xsender',
      toEntity: '0xhub',
      hashlock: `0x${'cd'.repeat(32)}`,
      lockId: 'lock-2',
      amount: 10n,
      tokenId: 1,
      jurisdictionId: 'simnet',
      description: 'invoice',
      startedAtMs: 1000000000,
      finalizedAtMs: 1000000300,
    });
    expect(finalized).toMatchObject({
      entityId: '0xsender',
      fromEntity: '0xsender',
      toEntity: '0xhub',
      amount: '10',
      tokenId: 1,
      jurisdictionId: 'simnet',
      hashlock: `0x${'cd'.repeat(32)}`,
      lockId: 'lock-2',
      startedAtMs: 1000000000,
      finalizedAtMs: 1000000300,
      elapsedMs: 300,
      finalizedInMs: 300,
    });
  });

  test('preserves the final decrypted note in the durable HtlcReceived event', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const lockId = 'received-lock';
    const hashlock = `0x${'33'.repeat(32)}`;
    const secret = `0x${'44'.repeat(32)}`;
    const env = createEmptyEnv('htlc-received-description-seed');
    env.quietRuntimeLogs = true;
    const replica = makeReplica(entityId, counterpartyId);
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      startedAtMs: replica.state.timestamp - 250,
      inboundEntity: counterpartyId,
      inboundLockId: lockId,
      createdTimestamp: replica.state.timestamp - 500,
    });
    replica.state.htlcNotes.set(`hashlock:${hashlock}`, 'uid:customer-7');

    applyCommittedAccountFrameFollowups(replica.state, counterpartyId, {
      height: 1,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: {
          lockId,
          outcome: 'secret',
          secret,
          offerHash: `0x${'55'.repeat(32)}`,
        },
      }],
      prevFrameHash: '',
      deltas: [],
      stateHash: `0x${'66'.repeat(32)}`,
      byLeft: true,
    }, [], env);

    expect(env.frameLogs.filter((entry) => entry.message === 'HtlcReceived')).toHaveLength(1);
    expect(env.frameLogs.find((entry) => entry.message === 'HtlcReceived')?.data).toMatchObject({
      entityId,
      fromEntity: counterpartyId,
      toEntity: entityId,
      hashlock,
      lockId,
      amount: '10',
      tokenId: 1,
      description: 'uid:customer-7',
    });
  });

  test('queues prepareDispute when secret-ack removal stalls after recipient-side receive', async () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const inboundLockId = 'lock-inbound';
    const hashlock = `0x${'44'.repeat(32)}`;
    const env = createEmptyEnv('htlc-dispute-tail-seed');
    env.quietRuntimeLogs = true;
    const replica = makeReplica(entityId, counterpartyId);
    const account = replica.state.accounts.get(counterpartyId)!;
    account.locks.set(inboundLockId, {
      lockId: inboundLockId,
      hashlock,
      tokenId: 1,
      amount: 10n,
      timelock: 100000n,
      revealBeforeHeight: 10,
    });
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: counterpartyId,
      inboundLockId,
      createdTimestamp: replica.state.timestamp - 1000,
      secret: `0x${'55'.repeat(32)}`,
      secretAckPending: true,
      secretAckStartedAt: replica.state.timestamp - 500,
      secretAckDeadlineAt: replica.state.timestamp,
    });
    scheduleHook(replica.state.crontabState!, {
      id: `htlc-secret-ack:${hashlock}`,
      triggerAt: replica.state.timestamp,
      type: 'htlc_secret_ack_timeout',
      data: {
        hashlock,
        counterpartyEntityId: counterpartyId,
        inboundLockId,
      },
    });

    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(entityId);
    expect(outputs[0]?.entityTxs).toEqual([
      {
        type: 'prepareDispute',
        data: {
          counterpartyEntityId: counterpartyId,
          description: 'auto-prepare-dispute-after-secret-ack-timeout',
        },
      },
    ]);
  });

  test('clears secretAckPending route when committed ACK frame finalizes htlc_resolve(secret)', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const inboundLockId = 'lock-inbound';
    const hashlock = `0x${'66'.repeat(32)}`;
    const replica = makeReplica(entityId, counterpartyId);
    const account = replica.state.accounts.get(counterpartyId)!;
    account.locks.set(inboundLockId, {
      lockId: inboundLockId,
      hashlock,
      tokenId: 1,
      amount: 10n,
      timelock: 100000n,
      revealBeforeHeight: 10,
    });
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: counterpartyId,
      inboundLockId,
      createdTimestamp: replica.state.timestamp - 1000,
      secret: `0x${'55'.repeat(32)}`,
      secretAckPending: true,
      secretAckStartedAt: replica.state.timestamp - 500,
      secretAckDeadlineAt: replica.state.timestamp + 30_000,
    });
    scheduleHook(replica.state.crontabState!, {
      id: `htlc-secret-ack:${hashlock}`,
      triggerAt: replica.state.timestamp + 30_000,
      type: 'htlc_secret_ack_timeout',
      data: {
        hashlock,
        counterpartyEntityId: counterpartyId,
        inboundLockId,
      },
    });

    applyCommittedAccountFrameFollowups(replica.state, counterpartyId, {
      height: 1,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: {
          lockId: inboundLockId,
          outcome: 'secret',
          secret: `0x${'55'.repeat(32)}`,
        },
      }],
      prevFrameHash: '',
      deltas: [],
      stateHash: '',
      byLeft: true,
    });

    expect(replica.state.htlcRoutes.has(hashlock)).toBe(false);
    expect(replica.state.crontabState?.hooks.has(`htlc-secret-ack:${hashlock}`)).toBe(false);
  });

  test('keeps a forwarded route until the revealed secret is queued upstream', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const inboundEntityId = `0x${'22'.repeat(32)}`;
    const outboundEntityId = `0x${'33'.repeat(32)}`;
    const inboundLockId = 'lock-inbound-forwarded';
    const outboundLockId = 'lock-outbound-forwarded';
    const hashlock = `0x${'68'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const replica = makeReplica(entityId, outboundEntityId);
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: inboundEntityId,
      inboundLockId,
      outboundEntity: outboundEntityId,
      outboundLockId,
      createdTimestamp: replica.state.timestamp - 1_000,
    });

    applyCommittedAccountFrameFollowups(replica.state, outboundEntityId, {
      height: 1,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: { lockId: outboundLockId, outcome: 'secret', secret },
      }],
      prevFrameHash: '',
      deltas: [],
      stateHash: '',
      byLeft: true,
    });

    expect(replica.state.htlcRoutes.has(hashlock)).toBe(true);

    const mempoolOps: Array<{
      accountId: string;
      tx: { type: 'htlc_resolve'; data: { lockId: string; outcome: 'secret'; secret: string } };
    }> = [];
    applyHtlcSecretFollowups({
      env: createEmptyEnv('htlc-forwarded-secret-seed'),
      state: replica.state,
      newState: replica.state,
      outputs: [],
      mempoolOps,
    }, [{ hashlock, secret }]);

    expect(mempoolOps).toEqual([{
      accountId: inboundEntityId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: inboundLockId, outcome: 'secret', secret },
      },
    }]);
    expect(replica.state.htlcRoutes.get(hashlock)).toMatchObject({
      secret,
      secretAckPending: true,
    });
    expect(replica.state.crontabState?.hooks.has(`htlc-secret-ack:${hashlock}`)).toBe(true);
  });

  test('emits HtlcFinalized before pruning originated outbound route on committed resolve', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const outboundLockId = 'lock-outbound';
    const hashlock = `0x${'77'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const env = createEmptyEnv('htlc-finalized-commit-seed');
    env.quietRuntimeLogs = true;
    env.activeJurisdiction = 'Testnet';
    const replica = makeReplica(entityId, counterpartyId);
    const account = replica.state.accounts.get(counterpartyId)!;
    account.mempool.push({
      type: 'htlc_lock',
      data: {
        lockId: outboundLockId,
        hashlock,
        tokenId: 1,
        amount: 10n,
        timelock: 100000n,
        revealBeforeHeight: 10,
      },
    });
    replica.state.htlcNotes.set(`lock:${outboundLockId}`, 'invoice-42');
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      startedAtMs: replica.state.timestamp - 750,
      outboundEntity: counterpartyId,
      outboundLockId,
      createdTimestamp: replica.state.timestamp - 1000,
    });

    applyCommittedAccountFrameFollowups(replica.state, counterpartyId, {
      height: 1,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: {
          lockId: outboundLockId,
          outcome: 'secret',
          secret,
        },
      }],
      prevFrameHash: '',
      deltas: [],
      stateHash: '',
      byLeft: true,
    }, [], env);

    const finalizedEvents = env.frameLogs.filter((entry) => entry.message === 'HtlcFinalized');
    expect(replica.state.htlcRoutes.has(hashlock)).toBe(false);
    expect(account.mempool).toEqual([]);
    expect(finalizedEvents).toHaveLength(1);
    expect(finalizedEvents[0]?.data).toMatchObject({
      entityId,
      fromEntity: entityId,
      toEntity: counterpartyId,
      hashlock,
      secret,
      lockId: outboundLockId,
      amount: '10',
      tokenId: 1,
      jurisdictionId: 'Testnet',
      description: 'invoice-42',
      finalizedAtMs: replica.state.timestamp,
      elapsedMs: 750,
      finalizedInMs: 750,
    });
  });

  test('keeps an accepted originated route until its ACK-bound reveal finalizes it', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const outboundLockId = 'lock-accepted-offer';
    const hashlock = `0x${'78'.repeat(32)}`;
    const offerHash = `0x${'79'.repeat(32)}`;
    const accountFrameHash = `0x${'7a'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const env = createEmptyEnv('htlc-accepted-offer-seed');
    env.quietRuntimeLogs = true;
    const replica = makeReplica(entityId, counterpartyId);
    const account = replica.state.accounts.get(counterpartyId)!;
    account.mempool.push({
      type: 'htlc_lock',
      data: {
        lockId: outboundLockId,
        hashlock,
        tokenId: 1,
        amount: 10n,
        timelock: 100000n,
        revealBeforeHeight: 10,
      },
    });
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      outboundEntity: counterpartyId,
      outboundLockId,
      createdTimestamp: replica.state.timestamp - 1000,
    });

    applyCommittedAccountFrameFollowups(replica.state, counterpartyId, {
      height: 7,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: { lockId: outboundLockId, outcome: 'secret', offerHash },
      }],
      prevFrameHash: '',
      deltas: [],
      stateHash: accountFrameHash,
      byLeft: true,
    }, [], env);

    expect(replica.state.htlcRoutes.get(hashlock)).toMatchObject({
      acceptedOfferHash: offerHash,
      acceptedAccountFrameHash: accountFrameHash,
      acceptedAccountFrameHeight: 7,
    });
    expect(env.frameLogs.some((entry) => entry.message === 'HtlcFinalized')).toBe(false);

    applyHtlcSecretFollowups({
      env,
      state: replica.state,
      newState: replica.state,
      outputs: [],
      mempoolOps: [],
    }, [{ hashlock, secret }]);

    expect(replica.state.htlcRoutes.has(hashlock)).toBe(false);
    expect(env.frameLogs.filter((entry) => entry.message === 'HtlcFinalized')).toHaveLength(1);
  });

  test('keeps originated outbound route while lock is still queued for account consensus', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const outboundLockId = 'lock-pending';
    const hashlock = `0x${'88'.repeat(32)}`;
    const replica = makeReplica(entityId, counterpartyId);
    const account = replica.state.accounts.get(counterpartyId)!;
    account.mempool.push({
      type: 'htlc_lock',
      data: {
        lockId: outboundLockId,
        hashlock,
        tokenId: 1,
        amount: 10n,
        timelock: 100000n,
        revealBeforeHeight: 10,
      },
    });
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      outboundEntity: counterpartyId,
      outboundLockId,
      createdTimestamp: replica.state.timestamp - 1000,
    });

    expect(pruneSettledOriginatedHtlcRoutes(replica.state, replica.state.timestamp)).toBe(0);
    expect(replica.state.htlcRoutes.has(hashlock)).toBe(true);

    account.mempool = [];
    expect(pruneSettledOriginatedHtlcRoutes(replica.state, replica.state.timestamp)).toBe(1);
    expect(replica.state.htlcRoutes.has(hashlock)).toBe(false);
  });

  test('prunes originated outbound route when only stale committed frame still names the lock', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const outboundLockId = 'lock-stale-current-frame';
    const hashlock = `0x${'89'.repeat(32)}`;
    const replica = makeReplica(entityId, counterpartyId);
    const account = replica.state.accounts.get(counterpartyId)!;
    account.currentFrame = {
      ...account.currentFrame,
      accountTxs: [{
        type: 'htlc_lock',
        data: {
          lockId: outboundLockId,
          hashlock,
          tokenId: 1,
          amount: 10n,
          timelock: 100000n,
          revealBeforeHeight: 10,
        },
      }],
    };
    replica.state.lockBook.set(outboundLockId, {
      lockId: outboundLockId,
      hashlock,
      tokenId: 1,
      amount: 10n,
      direction: 'outgoing',
      counterpartyEntityId: counterpartyId,
      createdTimestamp: replica.state.timestamp - 1000,
    });
    replica.state.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      outboundEntity: counterpartyId,
      outboundLockId,
      createdTimestamp: replica.state.timestamp - 1000,
    });

    expect(pruneSettledOriginatedHtlcRoutes(replica.state, replica.state.timestamp)).toBe(1);
    expect(replica.state.lockBook.has(outboundLockId)).toBe(false);
    expect(replica.state.htlcRoutes.has(hashlock)).toBe(false);
  });
});

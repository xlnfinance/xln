import { describe, expect, test } from 'bun:test';

import { executeCrontab, initCrontab } from '../../../entity/scheduler';
import { collectDerivedDeadlines, earliestDerivedDeadline } from '../../../entity/scheduler/derived-deadlines';
import { armPaymentSecretAckTimeout } from '../../../entity/paybook/lifecycle';
import { HTLC_ENFORCEMENT_RESERVE_MS } from '../../../account/consensus/dispute/deadline-policy';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { installCommittedAccountFrameHead } from '../../../account/consensus/frame/committed-envelope';
import {
  buildHtlcFinalizedEventPayload,
  buildHtlcReceivedEventPayload,
} from '../../../protocol/htlc/events';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { applyCommittedAccountFrameFollowups } from '../../../entity/tx/handlers/account/index';
import { applyHtlcSecretFollowups } from '../../../entity/tx/handlers/account/committed-htlc-followups';
import { handleResolveHtlcLockEntityTx } from '../../../entity/tx/handlers/htlc/direct';
import { applyBookIntentProgram, createBookIntentProgram } from '../../../entity/books/book-intents';
import {
  publishEntityCandidateEffects,
  readRuntimeFrameEvents,
} from '../../../runtime/observability/env-events';
import { createEmptyEnv } from '../../../runtime';
import type { AccountFrame, AccountReplica } from '../../../types/account';
import type { EntityCandidateEffect, EntityReplica } from '../../../entity/types';
import {
  getEntityAccountForWrite,
  PersistentEntityAccountMap,
  EntityAccountCandidateMap,
} from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../account/state/persistent-state-map';

const resolveWithBooks = (
  state: EntityReplica['state'],
  tx: Parameters<typeof handleResolveHtlcLockEntityTx>[1],
) => {
  const program = createBookIntentProgram();
  const result = handleResolveHtlcLockEntityTx(state, tx, false, program.openSlot());
  applyBookIntentProgram(result.newState, program);
  return result;
};

const commitFollowups = (
  ...args: Parameters<typeof applyCommittedAccountFrameFollowups>
): void => {
  const program = createBookIntentProgram();
  applyCommittedAccountFrameFollowups(
    args[0], args[1], args[2], args[3], args[4], args[5], args[6], program.openSlot(),
  );
  applyBookIntentProgram(args[0], program);
};

const secretFollowups = (
  context: Parameters<typeof applyHtlcSecretFollowups>[0],
  secrets: Parameters<typeof applyHtlcSecretFollowups>[1],
): void => {
  const program = createBookIntentProgram();
  applyHtlcSecretFollowups({ ...context, bookIntentSlot: program.openSlot() }, secrets);
  applyBookIntentProgram(context.newState, program);
};

const makeReplica = (entityId: string, counterpartyId: string): EntityReplica => {
  const account: AccountReplica = {
    state: {
      leftEntity: entityId,
      rightEntity: counterpartyId,
      domain: {
        chainId: 31337,
        depositoryAddress: `0x${'dd'.repeat(20)}`,
      },
      deltas: PersistentAccountStateMap.empty('deltas'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      watchSeed: `0x${'f1'.repeat(32)}`,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
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
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  };

  const state: EntityReplica['state'] = {
      entityId,
      entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
      height: 0,
      timestamp: 50_000,
      nonces: new Map(),
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: ['1'],
        shares: { '1': 1n },
      },
      reserves: new Map(),
      accounts: PersistentEntityAccountMap.fromMap(
        new Map([[counterpartyId, account]]),
        entityId,
        computeEntityAccountValueHash,
      ),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
      profile: {
        name: 'Replica',
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      paybook: { entries: new Map(), feesEarned: 0n },
      swapTradingPairs: [],
      crontabState: initCrontab(),
  };
  return {
    entityId,
    signerId: '1',
    entityEncPubKey: '',
    mempool: [],
    isProposer: true,
    state: createEntityFrameCandidateState(state),
  };
};

describe('htlc event contract and dispute tail', () => {
  test('wakes for a withheld secret ACK before the signed lock loses its enforcement reserve', async () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const replica = makeReplica(entityId, counterpartyId);
    const lockDeadline = replica.state.timestamp + HTLC_ENFORCEMENT_RESERVE_MS + 10_000;
    const account = getEntityAccountForWrite(replica.state.accounts, counterpartyId)!;
    account.state.locks = account.state.locks.updated(hashlock, {
      lockId: hashlock,
      hashlock,
      tokenId: 1,
      amount: 10n,
      timelock: BigInt(lockDeadline),
      revealBeforeHeight: 100,
      senderIsLeft: false,
    });
    const entry = {
      hashlock,
      secret,
      inboundEntity: counterpartyId,
      createdTimestamp: replica.state.timestamp,
    };
    armPaymentSecretAckTimeout(replica.state, entry);
    replica.state.paybook.entries.set(hashlock, entry);

    const expectedWake = lockDeadline - HTLC_ENFORCEMENT_RESERVE_MS;
    expect(earliestDerivedDeadline(replica.state)).toBe(expectedWake);
    expect(collectDerivedDeadlines(replica.state, expectedWake)).toMatchObject([
      { type: 'htlc_secret_ack_timeout', triggerAt: expectedWake },
    ]);
    replica.state.timestamp = expectedWake;
    const outputs = await executeCrontab(createEmptyEnv('late-secret-ack'), replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
      bookIntentSlot: createBookIntentProgram().openSlot(),
    });
    expect(outputs.flatMap(output => output.entityTxs ?? [])).toContainEqual({
      type: 'prepareDispute',
      data: { counterpartyEntityId: counterpartyId, description: 'auto-prepare-dispute-after-secret-ack-timeout' },
    });
    account.status = 'dispute_preparing';
    expect(collectDerivedDeadlines(replica.state, expectedWake)).toEqual([]);
    expect(earliestDerivedDeadline(replica.state)).toBe(170_000);
  });


  test('persists a verified out-of-band preimage before the counterparty ACKs', () => {
    const entityId = `0x${'22'.repeat(32)}`;
    const counterpartyId = `0x${'11'.repeat(32)}`;
    const secret = `0x${'44'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const lockId = hashlock;
    const replica = makeReplica(entityId, counterpartyId);
    const account = getEntityAccountForWrite(replica.state.accounts, counterpartyId)!;
    account.state.leftEntity = counterpartyId;
    account.state.rightEntity = entityId;
    account.state.locks = requirePersistentAccountStateMap(account.state.locks, 'locks').updated(lockId, {
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

    const result = resolveWithBooks(replica.state, {
      type: 'resolveHtlcLock',
      data: { counterpartyEntityId: counterpartyId, lockId, secret },
    });

    expect(result.accountTxs).toEqual([{
      accountId: counterpartyId,
      tx: { type: 'htlc_resolve', data: { lockId, outcome: 'secret', secret } },
    }]);
    expect(result.newState.paybook.entries.get(hashlock)).toMatchObject({
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: counterpartyId,
      secret,
    });
    expect(replica.state.paybook.entries.has(hashlock)).toBe(false);

    expect(() => resolveWithBooks(replica.state, {
      type: 'resolveHtlcLock',
      data: { counterpartyEntityId: counterpartyId, lockId, secret: `0x${'55'.repeat(32)}` },
    })).toThrow(`HTLC_RESOLVE_HASHLOCK_MISMATCH:${lockId}`);
    expect(replica.state.paybook.entries.has(hashlock)).toBe(false);

    expect(() => resolveWithBooks(replica.state, {
      type: 'resolveHtlcLock',
      data: { counterpartyEntityId: counterpartyId, lockId: `0x${'77'.repeat(32)}`, secret },
    })).toThrow('HTLC_RESOLVE_LOCK_MISSING');

    const conflicted = createEntityFrameCandidateState(replica.state);
    conflicted.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: `0x${'66'.repeat(32)}`,
      createdTimestamp: conflicted.timestamp,
    });
    expect(() => resolveWithBooks(conflicted, {
      type: 'resolveHtlcLock',
      data: { counterpartyEntityId: counterpartyId, lockId, secret },
    })).toThrow('PAYBOOK_ENTITY_CONFLICT');
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
    const secret = `0x${'44'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const lockId = hashlock;
    const env = createEmptyEnv('htlc-received-description-seed');
    env.quietRuntimeLogs = true;
    const replica = makeReplica(entityId, counterpartyId);
    env.state.eReplicas.set(`${entityId}:${replica.signerId}`, replica);
    replica.state.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      startedAtMs: replica.state.timestamp - 250,
      description: 'uid:customer-7',
      inboundEntity: counterpartyId,
      createdTimestamp: replica.state.timestamp - 500,
    });


    const candidateEffects: EntityCandidateEffect[] = [];
    commitFollowups(replica.state, counterpartyId, {
      height: 1,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: {
          lockId,
          outcome: 'secret',
          secret,
        },
      }],
      prevFrameHash: '',
      accountStateRoot: '',
      stateHash: `0x${'66'.repeat(32)}`,
    }, true, [], env, candidateEffects);

  expect(readRuntimeFrameEvents(env).filter((entry) => entry.message === 'HtlcReceived')).toHaveLength(0);
    publishEntityCandidateEffects(env, replica, candidateEffects);
  expect(readRuntimeFrameEvents(env).filter((entry) => entry.message === 'HtlcReceived')).toHaveLength(1);
  expect(readRuntimeFrameEvents(env).find((entry) => entry.message === 'HtlcReceived')?.data).toMatchObject({
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

  test('uses the exact producing replica when sibling validators host the same Entity', () => {
    const recipientEntityId = `0x${'22'.repeat(32)}`;
    const counterpartyId = `0x${'33'.repeat(32)}`;
    const secret = `0x${'44'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const env = createEmptyEnv('multi-validator-event-enrichment');
    const recipientReplica = makeReplica(recipientEntityId, counterpartyId);
    const siblingReplica = makeReplica(recipientEntityId, counterpartyId);
    siblingReplica.signerId = '2';
    for (const [target, description] of [
      [recipientReplica, 'uid:recipient-7'], [siblingReplica, 'uid:sibling-incorrect'],
    ] as const) {
      target.state.paybook.entries.set(hashlock, {
        hashlock, inboundEntity: counterpartyId, description, createdTimestamp: target.state.timestamp,
      });
    }
    env.state.eReplicas.set(`${recipientEntityId}:${recipientReplica.signerId}`, recipientReplica);
    env.state.eReplicas.set(`${recipientEntityId}:${siblingReplica.signerId}`, siblingReplica);

    const effects: EntityCandidateEffect[] = [];
    commitFollowups(recipientReplica.state, counterpartyId, {
      height: 1, timestamp: recipientReplica.state.timestamp, jHeight: 0,
      accountTxs: [{ type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'secret', secret } }],
      prevFrameHash: '', accountStateRoot: '', stateHash: '',
    }, true, [], env, effects);
    expect(siblingReplica.state.paybook.entries.get(hashlock)?.description).toBe('uid:sibling-incorrect');

    publishEntityCandidateEffects(env, recipientReplica, effects);
  expect(readRuntimeFrameEvents(env).find((entry) => entry.message === 'HtlcReceived')?.data).toMatchObject({
      entityId: recipientEntityId,
      hashlock,
      description: 'uid:recipient-7',
    });
  });

  test('queues prepareDispute when secret-ack removal stalls after recipient-side receive', async () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const hashlock = `0x${'44'.repeat(32)}`;
    const inboundLockId = hashlock;
    const env = createEmptyEnv('htlc-dispute-tail-seed');
    env.quietRuntimeLogs = true;
    const replica = makeReplica(entityId, counterpartyId);
    const account = getEntityAccountForWrite(replica.state.accounts, counterpartyId)!;
    account.state.locks = requirePersistentAccountStateMap(account.state.locks, 'locks').updated(inboundLockId, {
      lockId: inboundLockId,
      hashlock,
      tokenId: 1,
      amount: 10n,
      timelock: 100000n,
      revealBeforeHeight: 10,
    });
    replica.state.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: counterpartyId,
      createdTimestamp: replica.state.timestamp - 1000,
      secret: `0x${'55'.repeat(32)}`,
      secretAckPending: true,
      secretAckStartedAt: replica.state.timestamp - 500,
      secretAckDeadlineAt: replica.state.timestamp,
    });

    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
      bookIntentSlot: createBookIntentProgram().openSlot(),
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
    const secret = `0x${'55'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const inboundLockId = hashlock;
    const replica = makeReplica(entityId, counterpartyId);
    const account = getEntityAccountForWrite(replica.state.accounts, counterpartyId)!;
    account.state.locks = requirePersistentAccountStateMap(account.state.locks, 'locks').updated(inboundLockId, {
      lockId: inboundLockId,
      hashlock,
      tokenId: 1,
      amount: 10n,
      timelock: 100000n,
      revealBeforeHeight: 10,
    });
    replica.state.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: counterpartyId,
      createdTimestamp: replica.state.timestamp - 1000,
      secret,
      secretAckPending: true,
      secretAckStartedAt: replica.state.timestamp - 500,
      secretAckDeadlineAt: replica.state.timestamp + 30_000,
    });

    commitFollowups(replica.state, counterpartyId, {
      height: 1,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: {
          lockId: inboundLockId,
          outcome: 'secret',
          secret,
        },
      }],
      prevFrameHash: '',
      accountStateRoot: '',
      stateHash: '',
    }, true, [], undefined, []);

    expect(replica.state.paybook.entries.has(hashlock)).toBe(false);
    expect(collectDerivedDeadlines(replica.state).some((deadline) => deadline.id === `htlc-secret-ack:${hashlock}`)).toBe(false);
  });

  test('keeps a forwarded route until the revealed secret is queued upstream', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const inboundEntityId = `0x${'22'.repeat(32)}`;
    const outboundEntityId = `0x${'33'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const inboundLockId = hashlock;
    const outboundLockId = hashlock;
    const replica = makeReplica(entityId, outboundEntityId);
    replica.state.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: inboundEntityId,
      outboundEntity: outboundEntityId,
      createdTimestamp: replica.state.timestamp - 1_000,
    });

    commitFollowups(replica.state, outboundEntityId, {
      height: 1,
      timestamp: replica.state.timestamp,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_resolve',
        data: { lockId: outboundLockId, outcome: 'secret', secret },
      }],
      prevFrameHash: '',
      accountStateRoot: '',
      stateHash: '',
    }, true, [], undefined, []);

    expect(replica.state.paybook.entries.has(hashlock)).toBe(true);

    const accountTxs: Array<{
      accountId: string;
      tx: { type: 'htlc_resolve'; data: { lockId: string; outcome: 'secret'; secret: string } };
    }> = [];
    secretFollowups({
      env: createEmptyEnv('htlc-forwarded-secret-seed'),
      state: replica.state,
      newState: replica.state,
      outputs: [],
      accountTxs,
      candidateEffects: [],
    }, [{ hashlock, secret }]);

    expect(accountTxs).toEqual([{
      accountId: inboundEntityId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: inboundLockId, outcome: 'secret', secret },
      },
    }]);
    expect(replica.state.paybook.entries.get(hashlock)).toMatchObject({
      secret,
      secretAckPending: true,
    });
    expect(collectDerivedDeadlines(replica.state).some((deadline) => deadline.id === `htlc-secret-ack:${hashlock}`)).toBe(true);
  });

  test('queues only the inbound self-cycle resolution until the secret propagates back', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const inboundEntityId = `0x${'22'.repeat(32)}`;
    const outboundEntityId = `0x${'33'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const replica = makeReplica(entityId, outboundEntityId);
    replica.state.paybook.entries.set(hashlock, {
      hashlock,
      originated: true,
      inboundEntity: inboundEntityId,
      outboundEntity: outboundEntityId,
      createdTimestamp: replica.state.timestamp,
    });
    const accountTxs: Parameters<typeof applyHtlcSecretFollowups>[0]['accountTxs'] = [];

    secretFollowups({
      env: createEmptyEnv('htlc-self-cycle-secret-seed'),
      state: replica.state,
      newState: replica.state,
      outputs: [],
      accountTxs,
      candidateEffects: [],
    }, [{ hashlock, secret }]);

    expect(accountTxs).toEqual([
      {
        accountId: inboundEntityId,
        tx: { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'secret', secret } },
      },
    ]);
  });

  test('emits HtlcFinalized before pruning originated outbound route on committed resolve', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const counterpartyId = `0x${'22'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const outboundLockId = hashlock;
    const env = createEmptyEnv('htlc-finalized-commit-seed');
    env.quietRuntimeLogs = true;
    env.activeJurisdiction = 'Testnet';
    const replica = makeReplica(entityId, counterpartyId);
    env.state.eReplicas.set(`${entityId}:${replica.signerId}`, replica);
    const account = getEntityAccountForWrite(replica.state.accounts, counterpartyId)!;
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

    replica.state.paybook.entries.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      startedAtMs: replica.state.timestamp - 750,
      description: 'invoice-42',
      outboundEntity: counterpartyId,
      createdTimestamp: replica.state.timestamp - 1000,
    });

    const candidateEffects: EntityCandidateEffect[] = [];
    const committedFrame: AccountFrame = {
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
      accountStateRoot: '',
      stateHash: '',
    };
    installCommittedAccountFrameHead(account, committedFrame);
    commitFollowups(
      replica.state,
      counterpartyId,
      committedFrame,
      true,
      [],
      env,
      candidateEffects,
    );

    expect(replica.state.paybook.entries.has(hashlock)).toBe(false);
    expect(account.mempool).toEqual([]);
  expect(readRuntimeFrameEvents(env).filter((entry) => entry.message === 'HtlcFinalized')).toHaveLength(0);
    publishEntityCandidateEffects(env, replica, candidateEffects);
  const finalizedEvents = readRuntimeFrameEvents(env).filter((entry) => entry.message === 'HtlcFinalized');
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

  test('keeps both self-cycle legs until receive and origin finalization commit in either order', () => {
    const entityId = `0x${'11'.repeat(32)}`;
    const outboundEntity = `0x${'22'.repeat(32)}`;
    const inboundEntity = `0x${'33'.repeat(32)}`;
    const secret = `0x${'55'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const inboundLockId = hashlock;
    const outboundLockId = hashlock;

    for (const order of ['inbound-first', 'outbound-first'] as const) {
      const env = createEmptyEnv(`htlc-self-cycle-${order}`);
      env.quietRuntimeLogs = true;
      const replica = makeReplica(entityId, outboundEntity);
      const inboundReplica = makeReplica(entityId, inboundEntity);
      if (!(inboundReplica.state.accounts instanceof EntityAccountCandidateMap)) {
        throw new Error('TEST_ENTITY_ACCOUNT_CANDIDATE_REQUIRED');
      }
      const inboundAccount = inboundReplica.state.accounts.snapshotCandidate().get(inboundEntity)!;
      replica.state.accounts.set(inboundEntity, inboundAccount);
      replica.state.paybook.entries.set(hashlock, {
        hashlock,
        tokenId: 1,
        amount: 10n,
        startedAtMs: replica.state.timestamp - 500,
        originated: true,
        outboundEntity,

        inboundEntity,

        createdTimestamp: replica.state.timestamp - 1_000,
      });
      replica.state.paybook.feesEarned = 13n;
      const candidateEffects: EntityCandidateEffect[] = [];
      const commit = (counterpartyId: string, lockId: string, secret: string) =>
        commitFollowups(replica.state, counterpartyId, {
          height: 1,
          timestamp: replica.state.timestamp,
          jHeight: 0,
          accountTxs: [{
            type: 'htlc_resolve',
              data: { lockId, outcome: 'secret', secret },
          }],
          prevFrameHash: '',
          accountStateRoot: '',
          stateHash: `0x${'44'.repeat(32)}`,
        }, true, [], env, candidateEffects);
      const commits = order === 'inbound-first'
        ? [
            () => commit(inboundEntity, inboundLockId, secret),
            () => commit(outboundEntity, outboundLockId, secret),
          ]
        : [
            () => commit(outboundEntity, outboundLockId, secret),
            () => commit(inboundEntity, inboundLockId, secret),
          ];

      commits[0]!();
      expect(replica.state.paybook.entries.has(hashlock), `${order}: first leg must retain route`).toBe(true);
      const retained = replica.state.paybook.entries.get(hashlock)!;
      expect(retained.inboundSettled).toBe(order === 'inbound-first' ? true : undefined);
      expect(retained.outboundSettled).toBe(order === 'outbound-first' ? true : undefined);
      expect(candidateEffects.filter(effect => effect.kind === 'runtimeEvent' && effect.eventName === 'HtlcFinalized'))
        .toHaveLength(order === 'outbound-first' ? 1 : 0);
      expect(replica.state.paybook.feesEarned).toBe(13n);
      commits[1]!();
      expect(replica.state.paybook.feesEarned).toBe(13n);
      expect(replica.state.paybook.entries.has(hashlock), `${order}: both legs terminate route`).toBe(false);
      expect(candidateEffects.filter(effect => effect.kind === 'runtimeEvent' && effect.eventName === 'HtlcReceived')).toHaveLength(1);
      expect(candidateEffects.filter(effect => effect.kind === 'runtimeEvent' && effect.eventName === 'HtlcFinalized')).toHaveLength(1);
    }
  });

  for (const evidence of ['queued', 'historical'] as const) {
    test(`rejects secret resolution authorized only by ${evidence} evidence, then accepts a live lock`, () => {
      const entityId = `0x${'11'.repeat(32)}`;
      const counterpartyId = `0x${'22'.repeat(32)}`;
      const secret = `0x${'88'.repeat(32)}`;
      const hashlock = hashHtlcSecret(secret);
      const replica = makeReplica(entityId, counterpartyId);
      const account = getEntityAccountForWrite(replica.state.accounts, counterpartyId)!;
      const lock = {
        lockId: hashlock, hashlock, tokenId: 1, amount: 10n,
        timelock: 100000n, revealBeforeHeight: 10,
      };
      const tx = { type: 'htlc_lock' as const, data: lock };
      if (evidence === 'queued') account.mempool.push(tx);
      else account.currentFrame = { ...account.currentFrame, accountTxs: [tx] };
      replica.state.paybook.entries.set(hashlock, {
        hashlock, tokenId: 1, amount: 10n, outboundEntity: counterpartyId,
        createdTimestamp: replica.state.timestamp - 1000,
      });
      const beforeEntries = [...replica.state.paybook.entries];
      const beforeMempool = [...account.mempool];
      const beforeFrame = account.currentFrame;
      const resolve = { type: 'resolveHtlcLock' as const, data: {
        counterpartyEntityId: counterpartyId, lockId: hashlock, secret,
      } };
      expect(() => resolveWithBooks(replica.state, resolve)).toThrow(
        `HTLC_RESOLVE_LOCK_MISSING:${counterpartyId}:${hashlock}`,
      );
      expect([...replica.state.paybook.entries]).toEqual(beforeEntries);
      expect(account.mempool).toEqual(beforeMempool);
      expect(account.currentFrame).toBe(beforeFrame);
      expect(account.state.locks.size).toBe(0);

      account.state.locks = requirePersistentAccountStateMap(account.state.locks, 'locks').updated(hashlock, {
        ...lock, senderIsLeft: true, createdHeight: 1, createdTimestamp: replica.state.timestamp,
      });
      const result = resolveWithBooks(replica.state, resolve);
      expect(result.accountTxs).toEqual([{
        accountId: counterpartyId,
        tx: { type: 'htlc_resolve', data: { lockId: hashlock, outcome: 'secret', secret } },
      }]);
      expect(result.newState.paybook.entries.get(hashlock)?.secret).toBe(secret);
      expect([...replica.state.paybook.entries]).toEqual(beforeEntries);
      expect(account.mempool).toEqual(beforeMempool);
    });
  }
});

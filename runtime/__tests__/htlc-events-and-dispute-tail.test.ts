import { describe, expect, test } from 'bun:test';

import { executeCrontab, initCrontab, scheduleHook } from '../entity-crontab';
import {
  buildHtlcFinalizedEventPayload,
  buildHtlcReceivedEventPayload,
} from '../htlc-events';
import { applyCommittedAccountFrameFollowups } from '../entity-tx/handlers/account';
import { createEmptyEnv } from '../runtime';
import type { AccountMachine, EntityReplica } from '../types';

const makeReplica = (entityId: string, counterpartyId: string): EntityReplica => {
  const account: AccountMachine = {
    leftEntity: entityId,
    rightEntity: counterpartyId,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      tokenIds: [],
      deltas: [],
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
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
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
      jBlockObservations: [],
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
      swapBook: new Map(),
      lockBook: new Map(),
      swapTradingPairs: [],
      pendingSwapFillRatios: new Map(),
      crontabState: initCrontab(),
    },
  };
};

describe('htlc event contract and dispute tail', () => {
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

  test('queues disputeStart when secret-ack removal stalls after recipient-side receive', async () => {
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
        type: 'disputeStart',
        data: {
          counterpartyEntityId: counterpartyId,
          description: 'auto-dispute-after-secret-ack-timeout',
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
      tokenIds: [],
      deltas: [],
      stateHash: '',
      byLeft: true,
    });

    expect(replica.state.htlcRoutes.has(hashlock)).toBe(false);
    expect(replica.state.crontabState?.hooks.has(`htlc-secret-ack:${hashlock}`)).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import type { EntityReplica } from '../../runtime/types';
import { buildEntityConsensusSettingsView } from '../../frontend/src/lib/components/Entity/entity-consensus-settings';

const replicaFixture = (): EntityReplica => ({
  entityId: 'entity-a',
  signerId: 'alice',
  isProposer: true,
  mempool: [],
  state: {
    entityId: 'entity-a',
    height: 8,
    timestamp: 1_234,
    prevFrameHash: '0xentity7',
    nonces: new Map(),
    messages: [],
    proposals: new Map([['proposal-1', {
      id: 'proposal-1',
      proposer: 'alice',
      boardHash: '0xboard',
      boardEpoch: 2,
      action: { type: 'collective_message', data: { message: 'ship' } },
      actionHash: '0xaction',
      votes: new Map([['alice', 'yes'], ['bob', { choice: 'no', comment: 'wait' }]]),
      status: 'pending',
      created: 1_220,
    }]]),
    config: {
      mode: 'proposer-based',
      threshold: 2n,
      validators: ['alice', 'bob'],
      shares: { alice: 2n, bob: 1n },
    },
    leaderState: { activeValidatorId: 'alice', view: 3, changedAtHeight: 7 },
    reserves: new Map(),
    accounts: new Map([['entity-b', {
      currentHeight: 4,
      currentFrame: { height: 4, timestamp: 1_230, stateHash: '0xaccount4' },
      pendingFrame: { height: 5, timestamp: 1_234, stateHash: '0xaccount5' },
    }]]),
    lastFinalizedJHeight: 91,
    jBlockChain: [],
    jHistoryFinality: {
      jurisdictionRef: 'testnet',
      baseHeight: 1,
      finalizedThroughHeight: 91,
      tipBlockHash: '0xj91',
      eventHistoryRoot: '0xjroot',
      proposerSignerId: 'alice',
      proposerSignature: '0xsig',
      entityHeight: 8,
    },
    crontabState: {
      tasks: new Map(),
      hooks: new Map([['hook-1', {
        id: 'hook-1',
        triggerAt: 1_500,
        type: 'watchdog',
        data: {},
      }]]),
    },
    profile: { name: 'A' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
  } as EntityReplica['state'],
  proposal: { height: 9, hash: '0xpending9' } as EntityReplica['proposal'],
  lockedFrame: { height: 9, hash: '0xlocked9' } as EntityReplica['lockedFrame'],
  leaderVotes: new Map([['bob', {} as never]]),
  certifiedFrameLineage: [{} as never, {} as never],
  certifiedFrameAnchor: { height: 6, frameHash: '0xanchor6' } as EntityReplica['certifiedFrameAnchor'],
  hankoWitness: new Map(),
  lastConsensusProgressAt: 1_233,
});

describe('entity consensus settings projection', () => {
  test('projects board, votes, frames, accounts and hooks without reading runtime internals', () => {
    const view = buildEntityConsensusSettingsView(replicaFixture(), 44, true);

    expect(view.runtimeHeight).toBe(44);
    expect(view.entityHeight).toBe(8);
    expect(view.totalShares).toBe(3n);
    expect(view.board).toEqual([
      { signerId: 'alice', shares: 2n, isLeader: true, isLocalSigner: true },
      { signerId: 'bob', shares: 1n, isLeader: false, isLocalSigner: false },
    ]);
    expect(view.proposals[0]).toMatchObject({ yesShares: 2n, noShares: 1n, voteCount: 2 });
    expect(view.accounts[0]).toMatchObject({ currentHeight: 4, currentHash: '0xaccount4', pendingHeight: 5 });
    expect(view.hooks).toEqual([{ id: 'hook-1', type: 'watchdog', triggerAt: 1_500 }]);
    expect(view.pendingFrameHash).toBe('0xpending9');
    expect(view.lockedFrameHash).toBe('0xlocked9');
    expect(view.certifiedLineageLength).toBe(2);
  });

  test('fails loudly when a stored proposal contains an unknown voter', () => {
    const replica = replicaFixture();
    replica.state.proposals.get('proposal-1')!.votes.set('mallory', 'yes');

    expect(() => buildEntityConsensusSettingsView(replica, 44, true)).toThrow(
      'CONSENSUS_SETTINGS_UNKNOWN_VOTER',
    );
  });
});

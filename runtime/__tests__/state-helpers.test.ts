import { describe, expect, test } from 'bun:test';

import { cloneAccountMachine, cloneEntityReplica } from '../state-helpers';

const makeProjectionReplica = () => ({
  entityId: `0x${'aa'.repeat(32)}`,
  signerId: `0x${'11'.repeat(20)}`,
  isProposer: false,
  state: {
    entityId: `0x${'aa'.repeat(32)}`,
    height: 0,
    timestamp: 1,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [`0x${'11'.repeat(20)}`],
      shares: { [`0x${'11'.repeat(20)}`]: 1n },
    },
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockObservations: [],
    jBlockChain: [],
    entityEncPubKey: '',
    entityEncPrivKey: '',
    profile: { name: 'Projection', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
  },
});

describe('state helper cloning', () => {
  test('clones projection-shaped replicas without a transient mempool', () => {
    const cloned = cloneEntityReplica(makeProjectionReplica() as any);
    expect(cloned.mempool).toEqual([]);
  });

  test('manual account clone fallback normalizes missing mempool', () => {
    const cloned = cloneAccountMachine({
      currentFrame: { height: 0, timestamp: 0, accountTxs: [], deltas: [] },
      deltas: new Map(),
      locks: new Map(),
      swapOffers: new Map(),
      pulls: new Map(),
      uncloneable: () => undefined,
    } as any);

    expect(cloned.mempool).toEqual([]);
  });
});

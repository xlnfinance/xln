import { describe, expect, test } from 'bun:test';

import { handleDisputeFinalize } from '../entity-tx/handlers/dispute';
import type { EntityState, EntityTx, Env } from '../types';

const ALICE = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;

const makeEntityState = (): EntityState => ({
  entityId: ALICE,
  height: 1,
  timestamp: 1,
  lastFinalizedJHeight: 0,
  messages: [],
  accounts: new Map([
    [HUB, {
      status: 'disputed',
      leftEntity: ALICE,
      rightEntity: HUB,
      mempool: [],
      deltas: new Map(),
      locks: new Map(),
      swapOffers: new Map(),
      globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
      currentHeight: 1,
      rollbackCount: 0,
      leftJObservations: [],
      rightJObservations: [],
      jEventChain: [],
      lastFinalizedJHeight: 0,
      pendingWithdrawals: new Map(),
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
      currentFrame: {
        height: 1,
        timestamp: 1,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: 'genesis',
        stateHash: `0x${'33'.repeat(32)}`,
        byLeft: true,
        deltas: [],
      },
      activeDispute: {
        observedOnChain: true,
        finalizeQueued: false,
        startedByLeft: true,
        disputeTimeout: 10,
      },
    }],
  ]),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [ALICE],
    shares: { [ALICE]: 1n },
    jurisdiction: { name: 'local' },
  },
  reserves: new Map(),
} as unknown as EntityState);

describe('dispute quiet logging', () => {
  test('suppresses expected finalize rejection warnings when runtime logs are quiet', async () => {
    const originalWarn = console.warn;
    const originalLog = console.log;
    const consoleLines: string[] = [];
    console.warn = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };
    console.log = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); };

    try {
      const result = await handleDisputeFinalize(
        makeEntityState(),
        {
          type: 'disputeFinalize',
          data: {
            counterpartyEntityId: HUB,
            cooperative: true,
          },
        } as Extract<EntityTx, { type: 'disputeFinalize' }>,
        { quietRuntimeLogs: true } as Env,
      );

      expect(result.newState.messages?.some((message) =>
        message.includes('cooperative=true rejected'),
      )).toBe(true);
      expect(consoleLines).toEqual([]);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });
});

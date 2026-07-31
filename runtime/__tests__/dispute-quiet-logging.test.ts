import { describe, expect, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../entity/frame-events';

import { handleDisputeFinalize } from '../entity/tx/handlers/dispute';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import type { EntityState } from '../entity/types';
import type { RuntimeReplica } from '../runtime/types';
import type { EntityTx } from '../types/entity-tx';

const ALICE = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;

const makeEntityState = (): EntityState => ({
  entityId: ALICE,
  height: 1,
  timestamp: 1,
  lastFinalizedJHeight: 0,
  proposals: new Map(),
  accounts: new Map([
    [HUB, {
      state: {
        leftEntity: ALICE,
        rightEntity: HUB,
        domain: {
          chainId: 31337,
          depositoryAddress: `0x${'dd'.repeat(20)}`,
        },
        watchSeed: `0x${'55'.repeat(32)}`,
        deltas: new Map(),
        locks: new Map(),
        swapOffers: new Map(),
        globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
        leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
        rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
        lastFinalizedJHeight: 0,
        disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
        jNonce: 0,
        requestedRebalance: new Map(),
        requestedRebalanceFeeState: new Map(),
      },
      status: 'disputed',
      mempool: [],
      currentHeight: 1,
      pendingSignatures: [],
      rollbackCount: 0,
      pendingWithdrawals: new Map(),
      shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
      currentFrame: {
        height: 1,
        timestamp: 1,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: 'genesis',
        stateHash: `0x${'33'.repeat(32)}`,
        accountStateRoot: `0x${'44'.repeat(32)}`,
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
        { quietRuntimeLogs: true } as RuntimeReplica,
      );

      expect(readEntityFrameEventMessages(result.newState)?.some((message) =>
        message.includes('cooperative=true rejected'),
      )).toBe(true);
      expect(consoleLines).toEqual([]);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });
});

import { describe, expect, test } from 'bun:test';

import { computeAccountStateRoot } from '../account-state-root';
import { handleJEventClaim } from '../account/tx/handlers/j-event-claim';
import type { AccountMachine, AccountTx, JurisdictionEvent } from '../types';
import { createDefaultDelta } from '../validation-utils';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const BLOCK_HASH = `0x${'33'.repeat(32)}`;
const DOMAIN = { chainId: 31337, depositoryAddress: `0x${'44'.repeat(20)}` };

const settledEvent: JurisdictionEvent = {
  type: 'AccountSettled',
  data: {
    leftEntity: LEFT,
    rightEntity: RIGHT,
    tokenId: 1,
    leftReserve: '0',
    rightReserve: '0',
    collateral: '125',
    ondelta: '7',
    nonce: 3,
  },
};

const machine = (): AccountMachine => ({
  leftEntity: LEFT,
  rightEntity: RIGHT,
  watchSeed: `0x${'55'.repeat(32)}`,
  status: 'active',
  mempool: [],
  currentFrame: {} as never,
  deltas: new Map([[1, createDefaultDelta(1)]]),
  locks: new Map(),
  swapOffers: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  leftJObservations: [{
    jHeight: 7,
    jBlockHash: BLOCK_HASH,
    events: [settledEvent],
    observedAt: 10,
  }],
  rightJObservations: [],
  jEventChain: [],
  lastFinalizedJHeight: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  jNonce: 0,
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
} as AccountMachine);

describe('account J-event validate/commit parity', () => {
  test('finalizes the same canonical state in validation and commit modes', () => {
    const validation = machine();
    const commit = structuredClone(validation);
    const tx: Extract<AccountTx, { type: 'j_event_claim' }> = {
      type: 'j_event_claim',
      data: {
        jHeight: 7,
        jBlockHash: BLOCK_HASH,
        events: [settledEvent],
        observedAt: 11,
      },
    };

    const validationResult = handleJEventClaim(validation, tx, false, 100, true, LEFT, () => {});
    const commitResult = handleJEventClaim(commit, tx, false, 100, false, LEFT, () => {});

    expect(validationResult.success).toBe(true);
    expect(commitResult.success).toBe(true);
    expect(computeAccountStateRoot(validation, DOMAIN)).toBe(computeAccountStateRoot(commit, DOMAIN));
    expect(validation.lastFinalizedJHeight).toBe(7);
    expect(validation.deltas.get(1)).toEqual(commit.deltas.get(1));
    expect(validation.jEventChain).toEqual(commit.jEventChain);
  });
});

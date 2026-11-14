import { expect, test } from 'bun:test';

import { applyAccountInput } from '../../../account/consensus';
import { computeFrameHash } from '../../../account/consensus/frame/hash';
import type { AccountInputSecurityContext } from '../../../account/consensus/dispute/deadline-policy';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import type { AccountFrame, AccountInput, AccountReplica } from '../../../types/account';
import type { HankoString } from '../../../types/hanko';
import { createEmptyEnv } from '../../../runtime';
import { safeStringify } from '../../../protocol/serialization/index';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const OWN_HANKO_H11 = `0x${'55'.repeat(65)}` as HankoString;
const PEER_ACK_HANKO_H10 = `0x${'99'.repeat(65)}` as HankoString;

const frame = (height: number, prevFrameHash: string): AccountFrame => {
  const value: AccountFrame = {
    height,
    timestamp: height,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash,
    accountStateRoot: `0x${'66'.repeat(32)}`,
    stateHash: `0x${'00'.repeat(32)}`,
  };
  value.stateHash = computeFrameHash(value);
  return value;
};

const H10 = frame(10, `0x${'22'.repeat(32)}`);
const H11 = frame(11, H10.stateHash);

const account = (): AccountReplica => ({
  state: {
    leftEntity: LEFT,
    rightEntity: RIGHT,
    domain: { chainId: 31_337, depositoryAddress: `0x${'77'.repeat(20)}` },
    watchSeed: `0x${'88'.repeat(32)}`,
    deltas: PersistentAccountStateMap.empty('deltas'),
    locks: PersistentAccountStateMap.empty('locks'),
    swapOffers: PersistentAccountStateMap.empty('swapOffers'),
    pulls: PersistentAccountStateMap.empty('pulls'),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    jNonce: 0,
    requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
    requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
  },
  status: 'active',
  mempool: [],
  // LEFT (victim) proposed H10; RIGHT (peer) ACKed it with PEER_ACK_HANKO_H10.
  currentFrame: structuredClone(H10),
  currentHeight: 10,
  counterpartyFrameHanko: PEER_ACK_HANKO_H10,
  rollbackCount: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
  shadow: {
    rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    },
  },
} as AccountReplica);

// A peer legitimately holds our committed head and its own ACK Hanko for it. Sending both
// back as a "proposal" while our successor is pending must be a typed reject: before the
// fix it threw an untyped local-corruption error, which fail-stops the Runtime.
test('a peer replaying our committed head while our successor is pending is rejected, not fatal', async () => {
  const victim = account();
  // LEFT then proposed H11; hanko-witness leaves currentFrameHanko on the
  // pending proposal (entity/consensus/input/hanko-witness.ts:218-231).
  victim.pendingFrame = structuredClone(H11);
  victim.currentFrameHanko = OWN_HANKO_H11;
  victim.pendingAccountInput = {
    kind: 'ack_frame',
    fromEntityId: LEFT,
    toEntityId: RIGHT,
    domain: { ...victim.state.domain },
    disputeConfig: { ...victim.state.disputeConfig },
    watchSeed: victim.state.watchSeed,
    proposal: { frame: structuredClone(H11), frameHanko: OWN_HANKO_H11 },
  };

  // Honest verifier: a Hanko is valid only for the hash it actually signed.
  const signed = new Map<string, string>([
    [OWN_HANKO_H11, H11.stateHash],
    [PEER_ACK_HANKO_H10, H10.stateHash],
  ]);
  const securityContext: AccountInputSecurityContext = {
    entityTimestamp: 11,
    finalizedJHeight: 0,
    owningEntityIsHub: true,
    verifyHanko: async (hanko, hash, expectedEntityId) =>
      signed.get(hanko) === hash
        ? { valid: true, entityId: expectedEntityId }
        : { valid: false, entityId: null },
  };

  // RIGHT sends bytes it legitimately holds: our frame H10 + its own ACK Hanko.
  const poison: AccountInput = {
    kind: 'ack_frame',
    fromEntityId: RIGHT,
    toEntityId: LEFT,
    domain: { ...victim.state.domain },
    disputeConfig: { ...victim.state.disputeConfig },
    watchSeed: victim.state.watchSeed,
    proposal: { frame: structuredClone(H10), frameHanko: PEER_ACK_HANKO_H10 },
  };

  const result = await applyAccountInput(
    createAccountConsensusContext(createEmptyEnv('audit-duplicate-own-frame')),
    victim,
    poison,
    securityContext,
  );
  expect(result.ok).toBe(false);
  expect(safeStringify(result)).toContain('ACCOUNT_INPUT_FRAME_HANKO_INVALID');
  expect(victim.currentHeight).toBe(10);
  expect(victim.pendingFrame?.stateHash).toBe(H11.stateHash);
  expect(victim.currentFrameHanko).toBe(OWN_HANKO_H11);
});

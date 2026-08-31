import { describe, expect, test } from 'bun:test';

import { buildDuplicateCommittedAckFrame } from '../../../account/consensus/incoming/replay';
import type { AccountInputSecurityContext } from '../../../account/consensus/dispute/deadline-policy';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import type { AccountFrame, AccountInput, AccountReplica } from '../../../types/account';
import type { HankoString } from '../../../types/hanko';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const FRAME_HASH = `0x${'33'.repeat(32)}`;
const ACK_HANKO = `0x${'44'.repeat(65)}` as HankoString;
const SUCCESSOR_HANKO = `0x${'55'.repeat(65)}` as HankoString;

const frame = (height = 10): AccountFrame => ({
  height,
  timestamp: height,
  jHeight: 0,
  accountTxs: [],
  prevFrameHash: height === 10 ? `0x${'22'.repeat(32)}` : FRAME_HASH,
  accountStateRoot: `0x${'66'.repeat(32)}`,
  stateHash: height === 10 ? FRAME_HASH : `0x${'aa'.repeat(32)}`,
});

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
  currentFrame: frame(),
  currentHeight: 10,
  rollbackCount: 0,
  proofHeader: { fromEntity: LEFT, toEntity: RIGHT, nextProofNonce: 1 },
  pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
  shadow: {
    rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    },
  },
});

const duplicateInput = (current: AccountReplica): Extract<AccountInput, { kind: 'ack_frame' }> => ({
  kind: 'ack_frame',
  fromEntityId: RIGHT,
  toEntityId: LEFT,
  domain: { ...current.state.domain },
  disputeConfig: { ...current.state.disputeConfig },
  watchSeed: current.state.watchSeed,
  proposal: {
    frame: structuredClone(current.currentFrame),
    frameHanko: `0x${'99'.repeat(65)}`,
  },
});

const verifier = (
  expectedHanko: HankoString,
  calls: { count: number },
  valid = true,
): AccountInputSecurityContext => ({
  entityTimestamp: 10,
  finalizedJHeight: 0,
  owningEntityIsHub: false,
  verifyHanko: async (hanko, hash, expectedEntityId, authority) => {
    calls.count += 1;
    expect(hanko).toBe(expectedHanko);
    expect(hash).toBe(FRAME_HASH);
    expect(expectedEntityId).toBe(LEFT);
    expect(authority).toEqual({ allowPreviousBoard: true });
    return valid
      ? { valid: true, entityId: LEFT }
      : { valid: false, entityId: null };
  },
});

const countDraftSignerCalls = (result: Awaited<ReturnType<typeof buildDuplicateCommittedAckFrame>>): number => {
  let calls = 0;
  for (const _hash of result?.ok ? result.hashesToSign ?? [] : []) calls += 1;
  return calls;
};

describe('duplicate committed Account ACK Hanko reuse', () => {
  test('returns the byte-identical persisted ACK Hanko without scheduling a signer', async () => {
    const current = account();
    current.currentFrameHanko = ACK_HANKO;
    current.lastOutboundAckFrame = {
      height: 10,
      counterpartyEntityId: RIGHT,
      response: {
        kind: 'ack',
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        domain: { ...current.state.domain },
        disputeConfig: { ...current.state.disputeConfig },
        ack: { height: 10, frameHash: FRAME_HASH, frameHanko: ACK_HANKO },
      },
    };
    const verifyCalls = { count: 0 };

    const result = await buildDuplicateCommittedAckFrame(
      current,
      duplicateInput(current),
      [],
      10,
      current.currentFrame,
      verifier(ACK_HANKO, verifyCalls),
    );

    expect(result?.ok).toBe(true);
    expect(result?.response?.kind === 'ack' ? result.response.ack.frameHanko : undefined).toBe(ACK_HANKO);
    expect(result?.response).toEqual(current.lastOutboundAckFrame.response);
    expect(countDraftSignerCalls(result)).toBe(0);
    expect(verifyCalls.count).toBe(1);
  });

  test('H current plus pending H+1 reuses the embedded ACK, not the successor Hanko', async () => {
    const current = account();
    const successor = frame(11);
    current.pendingFrame = successor;
    current.currentFrameHanko = SUCCESSOR_HANKO;
    current.pendingAccountInput = {
      kind: 'ack_frame',
      fromEntityId: LEFT,
      toEntityId: RIGHT,
      domain: { ...current.state.domain },
      disputeConfig: { ...current.state.disputeConfig },
      ack: { height: 10, frameHash: FRAME_HASH, frameHanko: ACK_HANKO },
      proposal: {
        frame: successor,
        frameHanko: SUCCESSOR_HANKO,
      },
    };
    const verifyCalls = { count: 0 };

    const result = await buildDuplicateCommittedAckFrame(
      current,
      duplicateInput(current),
      [],
      10,
      current.currentFrame,
      verifier(ACK_HANKO, verifyCalls),
    );

    expect(result?.response?.kind === 'ack' ? result.response.ack.frameHanko : undefined).toBe(ACK_HANKO);
    expect(current.currentFrameHanko).toBe(SUCCESSOR_HANKO);
    expect(current.lastOutboundAckFrame?.response.ack.frameHanko).toBe(ACK_HANKO);
    expect(countDraftSignerCalls(result)).toBe(0);
    expect(verifyCalls.count).toBe(1);
  });

  test('cache miss rebuilds with the verified current-frame Hanko and never schedules signing', async () => {
    const current = account();
    current.currentFrameHanko = ACK_HANKO;
    const verifyCalls = { count: 0 };

    const result = await buildDuplicateCommittedAckFrame(
      current,
      duplicateInput(current),
      [],
      10,
      current.currentFrame,
      verifier(ACK_HANKO, verifyCalls),
    );

    expect(result?.response?.kind === 'ack' ? result.response.ack.frameHanko : undefined).toBe(ACK_HANKO);
    expect(countDraftSignerCalls(result)).toBe(0);
    expect(verifyCalls.count).toBe(1);
  });

  test('missing or corrupt persisted ACK Hankos fail loud instead of scheduling signing', async () => {
    const missing = account();
    missing.lastOutboundAckFrame = {
      height: 10,
      counterpartyEntityId: RIGHT,
      response: {
        kind: 'ack',
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        domain: { ...missing.state.domain },
        disputeConfig: { ...missing.state.disputeConfig },
        ack: { height: 10, frameHash: FRAME_HASH },
      },
    };
    await expect(buildDuplicateCommittedAckFrame(
      missing,
      duplicateInput(missing),
      [],
      10,
      missing.currentFrame,
      verifier(ACK_HANKO, { count: 0 }),
    )).rejects.toThrow('DUPLICATE_ACK_CACHED_HANKO_MISSING:height=10');

    const corruptCached = account();
    corruptCached.lastOutboundAckFrame = {
      height: 10,
      counterpartyEntityId: RIGHT,
      response: {
        kind: 'ack',
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        domain: { ...corruptCached.state.domain },
        disputeConfig: { ...corruptCached.state.disputeConfig },
        ack: { height: 10, frameHash: FRAME_HASH, frameHanko: ACK_HANKO },
      },
    };
    await expect(buildDuplicateCommittedAckFrame(
      corruptCached,
      duplicateInput(corruptCached),
      [],
      10,
      corruptCached.currentFrame,
      verifier(ACK_HANKO, { count: 0 }, false),
    )).rejects.toThrow('DUPLICATE_ACK_CACHED_HANKO_INVALID:height=10');

    const corruptCurrent = account();
    corruptCurrent.currentFrameHanko = ACK_HANKO;
    await expect(buildDuplicateCommittedAckFrame(
      corruptCurrent,
      duplicateInput(corruptCurrent),
      [],
      10,
      corruptCurrent.currentFrame,
      verifier(ACK_HANKO, { count: 0 }, false),
    )).rejects.toThrow('DUPLICATE_ACK_CURRENT_FRAME_HANKO_INVALID:height=10');
  });
});

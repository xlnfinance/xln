import { expect, test } from 'bun:test';

import { applyAccountInput } from '../../../account/consensus';
import {
  createAccountDisputeFinalityInput,
  createAccountDisputeStartedInput,
} from '../../../account/input';
import { cloneIsolatedAccountInput } from '../../../protocol/state/account-input-clone';
import { safeStringify } from '../../../protocol/serialization';
import { createDefaultDelta } from '../../../account/state/delta';
import { createEmptyEnv } from '../../../runtime';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { getDisputeProofTupleError } from '../../../account/consensus/dispute/proof-views';
import { addr, makeAccount } from '../../helpers/cross-j';

test('authenticated J finality enters the canonical AccountInput boundary', async () => {
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = makeAccount(leftEntity, rightEntity, {
    chainId: 31_337,
    depositoryAddress: addr('dd'),
  });
  const token1 = {
    ...account.state.deltas.get(1)!,
    collateral: 7n,
    ondelta: 3n,
    offdelta: -2n,
    leftHold: 1n,
  };
  const token2 = {
    ...createDefaultDelta(2),
    collateral: 11n,
    ondelta: -4n,
    offdelta: 9n,
    leftHold: 3n,
    rightHold: 5n,
    leftAllowance: 6n,
    rightAllowance: 7n,
  };
  account.state.deltas = PersistentAccountStateMap.fromEntries('deltas', [[1, token1], [2, token2]]);
  account.state.pulls = PersistentAccountStateMap.fromEntries('pulls', [[
    'stale-after-finality',
    {
      pullId: 'stale-after-finality',
      tokenId: 1,
      amount: -1n,
      claimedRatio: 0,
      claimedAmount: 0n,
      fullHash: `0x${'aa'.repeat(32)}`,
      partialRoot: `0x${'bb'.repeat(32)}`,
      createdHeight: 1,
      createdTimestamp: 1,
    },
  ]]);
  account.mempool = [{
    type: 'j_event_claim',
    data: {
      jHeight: 3,
      jBlockHash: `0x${'cc'.repeat(32)}`,
      events: [],
    },
  }];
  account.counterpartyDisputeProofHanko = `0x${'44'.repeat(65)}`;
  account.counterpartyDisputeProofNonce = 3;
  account.counterpartyDisputeProofProposerIsLeft = true;
  account.counterpartyDisputeProofBodyHash = `0x${'55'.repeat(32)}`;
  account.counterpartyDisputeHash = `0x${'66'.repeat(32)}`;
  expect(getDisputeProofTupleError(account)).toBeNull();

  const input = createAccountDisputeFinalityInput(
    account.state,
    leftEntity,
    4,
    [1],
  );
  const cloned = cloneIsolatedAccountInput(input);
  expect(cloned).toEqual(input);
  expect(cloned).not.toBe(input);
  expect(cloned.finality.finalizedTokenIds).not.toBe(
    input.finality.finalizedTokenIds,
  );

  const env = createEmptyEnv('account-external-finality');
  const result = await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    cloned,
  );

  expect(result.ok).toBe(true);
  expect(result.externalFinality).toEqual({
    hadActiveDispute: false,
    hadSettlementWorkspace: false,
    removedSettlementTxs: 0,
  });
  expect(account.mempool).toEqual([]);
  expect(account.currentHeight).toBe(0);
  expect(account.state.jNonce).toBe(4);
  expect(account.status).toBe('disputed');
  expect(account.state.deltas.get(1)).toMatchObject({
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftHold: 0n,
  });
  expect(account.state.deltas.get(2)).toMatchObject({
    collateral: 11n,
    ondelta: -4n,
    offdelta: 0n,
    leftHold: 0n,
    rightHold: 0n,
    leftAllowance: 0n,
    rightAllowance: 0n,
  });
  expect(account.state.pulls?.size).toBe(0);
  expect(account.counterpartyDisputeProofHanko).toBeUndefined();
  expect(account.counterpartyDisputeProofNonce).toBeUndefined();
  expect(account.counterpartyDisputeProofProposerIsLeft).toBeUndefined();
  expect(account.counterpartyDisputeProofBodyHash).toBeUndefined();
  expect(account.counterpartyDisputeHash).toBeUndefined();
  expect(getDisputeProofTupleError(account)).toBeNull();
});

test('external finality rejects an entity outside the bilateral account', () => {
  const account = makeAccount(
    `0x${'11'.repeat(32)}`,
    `0x${'22'.repeat(32)}`,
  );
  expect(() =>
    createAccountDisputeFinalityInput(
      account.state,
      `0x${'33'.repeat(32)}`,
      1,
      [],
    ),
  ).toThrow('ACCOUNT_FINALITY_INPUT_OWNER_MISMATCH');
});

test('DisputeStarted enters Account through the same external-finality boundary', async () => {
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = makeAccount(leftEntity, rightEntity);
  const input = createAccountDisputeStartedInput(account.state, rightEntity, {
    kind: 'dispute_started',
    starterEntityId: leftEntity,
    initialProofbodyHash: `0x${'44'.repeat(32)}`,
    initialNonce: 7,
    initialProposerIsLeft: true,
    disputeTimeout: 1700000020,
    disputeStartTimestamp: 1700000000,
    leftResponseSeconds: 10,
    rightResponseSeconds: 10,
    jNonce: 9,
    starterInitialArguments: '0x1234',
    starterCounterArguments: '0x5678',
    starterCounterProofCommitment: `0x${'00'.repeat(32)}`,
    observedBlockNumber: 100,
    batchNonce: 3,
  });

  const cloned = cloneIsolatedAccountInput(input);
  expect(cloned).toEqual(input);
  expect(cloned).not.toBe(input);
  const env = createEmptyEnv('account-dispute-started-finality');
  const result = await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    cloned,
  );

  expect(result).toMatchObject({
    ok: true,
    events: ['ACCOUNT_DISPUTE_STARTED_APPLIED'],
  });
  expect(account.status).toBe('disputed');
  expect(account.state.jNonce).toBe(9);
  expect(account.activeDispute).toEqual({
    startedByLeft: true,
    initialProofbodyHash: `0x${'44'.repeat(32)}`,
    initialNonce: 7,
    initialProposerIsLeft: true,
    disputeTimeout: 1700000020,
    disputeStartTimestamp: 1700000000,
    jNonce: 9,
    starterInitialArguments: '0x1234',
    starterCounterArguments: '0x5678',
    starterCounterProofCommitment: `0x${'00'.repeat(32)}`,
    observedOnChain: true,
    observedBlockNumber: 100,
    batchNonce: 3,
    finalizeQueued: false,
  });
});

test('invalid DisputeStarted finality leaves Account byte-identical', async () => {
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = makeAccount(leftEntity, rightEntity);
  const before = safeStringify(account);
  const input = createAccountDisputeStartedInput(account.state, leftEntity, {
    kind: 'dispute_started',
    starterEntityId: rightEntity,
    initialProofbodyHash: `0x${'44'.repeat(32)}`,
    initialNonce: 1,
    initialProposerIsLeft: false,
    disputeTimeout: 100,
    disputeStartTimestamp: 100,
    leftResponseSeconds: 10,
    rightResponseSeconds: 10,
    jNonce: 1,
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    observedBlockNumber: 100,
  });

  await expect(
    applyAccountInput(
      createAccountConsensusContext(createEmptyEnv('invalid-dispute-started')),
      account,
      input,
    ),
  ).rejects.toThrow('ACCOUNT_DISPUTE_CLOCK_MISMATCH:100:100:10:10:10:10');
  expect(safeStringify(account)).toBe(before);
});

test('zero-window DisputeStarted accepts the exact same-second deadline', async () => {
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = makeAccount(leftEntity, rightEntity);
  account.state.disputeConfig = { leftResponseSeconds: 0, rightResponseSeconds: 0 };
  const input = createAccountDisputeStartedInput(account.state, leftEntity, {
    kind: 'dispute_started',
    starterEntityId: leftEntity,
    initialProofbodyHash: `0x${'44'.repeat(32)}`,
    initialNonce: 1,
    initialProposerIsLeft: true,
    disputeTimeout: 100,
    disputeStartTimestamp: 100,
    leftResponseSeconds: 0,
    rightResponseSeconds: 0,
    jNonce: 1,
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    observedBlockNumber: 100,
  });

  const result = await applyAccountInput(
    createAccountConsensusContext(createEmptyEnv('zero-window-dispute-started')),
    account,
    input,
  );
  expect(result.ok).toBe(true);
  expect(account.activeDispute?.disputeTimeout).toBe(100);
});

test('DisputeStarted atomically moves cross-j recovery into the active phase', async () => {
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = makeAccount(leftEntity, rightEntity);
  const recovery = {
    requiredPullIds: ['pull-1', 'pull-2'],
    resultsByPullId: { 'pull-1': '0x1234' },
  };
  account.status = 'dispute_preparing';
  account.disputePrepare = {
    startedAt: 10,
    readyAfter: 20,
    reason: 'cross-j-recovery',
    crossJurisdictionRecovery: recovery,
  };
  const input = createAccountDisputeStartedInput(account.state, rightEntity, {
    kind: 'dispute_started',
    starterEntityId: leftEntity,
    initialProofbodyHash: `0x${'55'.repeat(32)}`,
    initialNonce: 7,
    initialProposerIsLeft: true,
    disputeTimeout: 1700000020,
    disputeStartTimestamp: 1700000000,
    leftResponseSeconds: 10,
    rightResponseSeconds: 10,
    jNonce: 9,
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    observedBlockNumber: 100,
  });

  const result = await applyAccountInput(
    createAccountConsensusContext(createEmptyEnv('account-dispute-started-cross-j-phase')),
    account,
    input,
  );

  expect(result.ok).toBe(true);
  expect(account.disputePrepare).toBeUndefined();
  expect(account.activeDispute?.crossJurisdictionRecovery).toEqual(recovery);
});

test('Entity J-event routing never writes Account dispute fields directly', async () => {
  const source = await Bun.file(
    new URL('../../../entity/tx/j-events.ts', import.meta.url),
  ).text();
  expect(source).not.toMatch(
    /\baccount\.(?:status|activeDispute|jNonce)\s*=/,
  );
});

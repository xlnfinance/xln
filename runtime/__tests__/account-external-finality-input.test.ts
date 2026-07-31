import { expect, test } from 'bun:test';

import { applyAccountInput } from '../account/consensus';
import {
  createAccountDisputeFinalityInput,
  createAccountDisputeStartedInput,
} from '../account/input';
import { cloneIsolatedAccountInput } from '../protocol/account-input-clone';
import { createEmptyEnv } from '../runtime';
import { createAccountConsensusContext } from '../entity/account-consensus-context';
import { addr, makeAccount } from './helpers/cross-j';

test('authenticated J finality enters the canonical AccountInput boundary', async () => {
  const leftEntity = `0x${'11'.repeat(32)}`;
  const rightEntity = `0x${'22'.repeat(32)}`;
  const account = makeAccount(leftEntity, rightEntity, {
    chainId: 31_337,
    depositoryAddress: addr('dd'),
  });
  const delta = account.state.deltas.get(1)!;
  delta.collateral = 7n;
  delta.ondelta = 3n;
  delta.offdelta = -2n;
  delta.leftHold = 1n;

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

  expect(result.success).toBe(true);
  expect(result.externalFinality).toEqual({
    hadActiveDispute: false,
    hadSettlementWorkspace: false,
    removedSettlementTxs: 0,
  });
  expect(account.currentHeight).toBe(0);
  expect(account.state.jNonce).toBe(4);
  expect(account.status).toBe('disputed');
  expect(account.state.deltas.get(1)).toMatchObject({
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftHold: 0n,
  });
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
    disputeTimeout: 120,
    jNonce: 9,
    starterInitialArguments: '0x1234',
    starterIncrementedArguments: '0x5678',
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
    success: true,
    events: ['ACCOUNT_DISPUTE_STARTED_APPLIED'],
  });
  expect(account.status).toBe('disputed');
  expect(account.state.jNonce).toBe(9);
  expect(account.activeDispute).toEqual({
    startedByLeft: true,
    initialProofbodyHash: `0x${'44'.repeat(32)}`,
    initialNonce: 7,
    disputeTimeout: 120,
    jNonce: 9,
    starterInitialArguments: '0x1234',
    starterIncrementedArguments: '0x5678',
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
  const before = structuredClone(account);
  const input = createAccountDisputeStartedInput(account.state, leftEntity, {
    kind: 'dispute_started',
    starterEntityId: rightEntity,
    initialProofbodyHash: `0x${'44'.repeat(32)}`,
    initialNonce: 1,
    disputeTimeout: 100,
    jNonce: 1,
    starterInitialArguments: '0x',
    starterIncrementedArguments: '0x',
    observedBlockNumber: 100,
  });

  await expect(
    applyAccountInput(
      createAccountConsensusContext(createEmptyEnv('invalid-dispute-started')),
      account,
      input,
    ),
  ).rejects.toThrow('ACCOUNT_DISPUTE_TIMEOUT_INVALID:100:100');
  expect(account).toEqual(before);
});

test('Entity J-event routing never writes Account dispute fields directly', async () => {
  const source = await Bun.file(
    new URL('../entity/tx/j-events.ts', import.meta.url),
  ).text();
  expect(source).not.toMatch(
    /\baccount\.(?:status|activeDispute|jNonce)\s*=/,
  );
});

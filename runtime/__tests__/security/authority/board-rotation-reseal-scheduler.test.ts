import { expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { initCrontab, scheduleHook } from '../../../entity/scheduler';
import {
  accountNeedsBoardResealForActivation,
  BOARD_RESEAL_HOOK_ID,
  captureAccountBoardResealEvidence,
  markBoardRotationResealsPending,
} from '../../../entity/tx/state-effects/board-rotation-reseal';
import { scheduleChangedAccountBoardReseals } from '../../../entity/scheduler/board-reseal-hook';
import { buildQuorumHanko } from '../../../hanko/signing';
import { handleScheduledWakeEntityTx } from '../../../entity/tx/handlers/system/scheduled-wake';
import {
  COUNTERPARTY_BOARD_RESEAL_DEADLINE_MS,
  counterpartyBoardResealDeadlineHookId,
} from '../../../entity/tx/j-events-board';
import { safeStringify } from '../../../protocol/serialization';
import { createEmptyEnv } from '../../../runtime';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import {
  hydrateEntityStateFromStorage,
  projectAccountDoc,
  projectEntityCoreDoc,
} from '../../../storage/read/projections';
import type { EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { EntityTx } from '../../../types/entity-tx';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { addr, makeAccount, makeState } from '../../helpers/cross-j';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';

const putCommittedAccount = (
  state: EntityState,
  counterpartyId: string,
  account: ReturnType<typeof makeAccount>,
): void => {
  if (!(state.accounts instanceof PersistentEntityAccountMap)) {
    throw new Error('TEST_PERSISTENT_ACCOUNT_MAP_REQUIRED');
  }
  state.accounts = state.accounts.updated(counterpartyId, account);
};

const digest = (value: number): string => `0x${value.toString(16).padStart(64, '0')}`;

const jurisdiction = {
  name: 'board-reseal-scheduler',
  address: 'http://127.0.0.1:8545',
  chainId: 31_337,
  depositoryAddress: addr('d1'),
  entityProviderAddress: addr('e1'),
  entityProviderDeploymentBlock: 1,
  registrationBlock: 1,
} satisfies JurisdictionConfig;

const activation = (entityId: string, logIndex = 2): Extract<JurisdictionEvent, { type: 'BoardActivated' }> => ({
  type: 'BoardActivated',
  blockNumber: 44,
  blockHash: digest(44),
  transactionHash: digest(45 + logIndex),
  logIndex,
  data: {
    entityId,
    previousBoardHash: digest(46),
    newBoardHash: digest(47),
    previousBoardValidUntil: '1700604800',
  },
});

const installBoardResealHook = (state: EntityState, event: ReturnType<typeof activation>): void => {
  const pending = markBoardRotationResealsPending(state, event);
  if (!state.crontabState) throw new Error('TEST_BOARD_RESEAL_CRONTAB_MISSING');
  scheduleHook(state.crontabState, {
    id: BOARD_RESEAL_HOOK_ID,
    triggerAt: state.timestamp,
    type: 'board_reseal',
    data: {
      activationJHeight: pending.activation.jHeight,
      activationLogIndex: pending.activation.logIndex,
      afterCounterpartyId: '',
    },
  });
};

const scheduledWakeForHook = (
  state: EntityState,
  proposerSignerId: string,
): Extract<EntityTx, { type: 'scheduledWake' }> => {
  const hook = state.crontabState?.hooks.get(BOARD_RESEAL_HOOK_ID);
  if (!hook || hook.type !== 'board_reseal') throw new Error('TEST_BOARD_RESEAL_HOOK_MISSING');
  return {
    type: 'scheduledWake',
    data: {
      version: 1,
      proposerSignerId,
      dueAt: hook.triggerAt,
      jobs: [{ kind: 'hook', id: hook.id, dueAt: hook.triggerAt }],
    },
  };
};

const scheduledWakeForId = (
  state: EntityState,
  proposerSignerId: string,
  hookId: string,
): Extract<EntityTx, { type: 'scheduledWake' }> => {
  const hook = state.crontabState?.hooks.get(hookId);
  if (!hook) throw new Error(`TEST_SCHEDULED_HOOK_MISSING:${hookId}`);
  return {
    type: 'scheduledWake',
    data: {
      version: 1,
      proposerSignerId,
      dueAt: hook.triggerAt,
      jobs: [{ kind: 'hook', id: hook.id, dueAt: hook.triggerAt }],
    },
  };
};

const makeCommittedAccount = (
  sourceEntityId: string,
  counterpartyId: string,
  frameHash: string,
) => {
  const account = makeAccount(sourceEntityId, counterpartyId);
  account.currentHeight = 1;
  account.currentFrame = {
    ...account.currentFrame,
    height: 1,
    timestamp: 1,
    jHeight: 43,
    prevFrameHash: digest(90),
    accountStateRoot: frameHash,
    stateHash: frameHash,
  };
  account.currentFrameHanko = '0x01';
  return account;
};

const makeCertifiedCounterpartyAccount = async (
  env: RuntimeReplica,
  sourceEntityId: string,
  signerId: string,
  weight: bigint,
  frameHash: string,
) => {
  const counterpartyId = generateLazyEntityId([{ name: signerId, weight }], 1n).toLowerCase();
  const account = makeCommittedAccount(sourceEntityId, counterpartyId, frameHash);
  account.counterpartyFrameHanko = await buildQuorumHanko(env, counterpartyId, frameHash, [{
    signerId,
    signature: await signAccountFrame(env, signerId, frameHash),
  }], {
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: weight },
  });
  return { counterpartyId, account };
};

test('bad board reseal account cannot block good output and re-arms only after Account evidence changes', async () => {
  const signerId = deriveSignerAddressSync('board-reseal-bad-good', '1').toLowerCase();
  const sourceEntityId = digest(100);
  const env = createEmptyEnv('board-reseal-bad-good');
  registerSignerKey(env, signerId, deriveSignerKeySync('board-reseal-bad-good', '1'));
  const state = makeState(sourceEntityId, signerId, jurisdiction);
  state.timestamp = 1_000;
  state.crontabState = initCrontab();
  state.leaderState = { activeValidatorId: signerId, view: 0, changedAtHeight: 0 };
  const badFixture = await makeCertifiedCounterpartyAccount(env, sourceEntityId, signerId, 1n, digest(201));
  const goodFixture = await makeCertifiedCounterpartyAccount(env, sourceEntityId, signerId, 2n, digest(202));
  const { counterpartyId: badId, account: bad } = badFixture;
  const { counterpartyId: goodId, account: good } = goodFixture;
  bad.currentDisputeHash = digest(211);
  bad.currentDisputeProofBodyHash = digest(212);
  bad.currentDisputeProofNonce = 7;
  bad.currentDisputeProofProposerIsLeft = true;
  bad.currentDisputeProofHanko = '0x03';
  putCommittedAccount(state, badId, bad);
  putCommittedAccount(state, goodId, good);
  installBoardResealHook(state, activation(sourceEntityId));

  const evidenceBeforeFirst = captureAccountBoardResealEvidence(state, new Set([badId]));
  const first = await handleScheduledWakeEntityTx(
    env,
    createEntityFrameCandidateState(state),
    scheduledWakeForHook(state, signerId),
    false,
  );
  expect(first.outputs.map(output => output.entityId)).toEqual([goodId]);
  expect(first.accountChanges).toEqual([badId, goodId].sort());
  expect(first.hashesToSign).toEqual([expect.objectContaining({ hash: digest(202), type: 'accountFrame' })]);
  expect(first.newState.accounts.get(goodId)?.boardResealMigration).toEqual({
    activationJHeight: 44,
    activationLogIndex: 2,
    reason: 'issued',
    issuedFrameHeight: 1,
    issuedFrameHash: digest(202),
  });
  expect(first.newState.accounts.get(badId)?.boardResealMigration?.reason)
    .toBe('bilateral-dispute-uncertified');
  expect(first.newState.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)).toBe(false);
  scheduleChangedAccountBoardReseals(
    first.newState,
    evidenceBeforeFirst,
    new Set([badId]),
  );
  expect(first.newState.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)).toBe(false);

  const evidenceBeforeCertification = captureAccountBoardResealEvidence(
    first.newState,
    new Set([badId]),
  );
  const updatedBad = first.newState.accounts.get(badId)!;
  updatedBad.counterpartyDisputeHash = updatedBad.currentDisputeHash;
  updatedBad.counterpartyDisputeProofBodyHash = updatedBad.currentDisputeProofBodyHash;
  updatedBad.counterpartyDisputeProofNonce = updatedBad.currentDisputeProofNonce;
  updatedBad.counterpartyDisputeProofProposerIsLeft = updatedBad.currentDisputeProofProposerIsLeft;
  updatedBad.counterpartyDisputeProofHanko = '0x04';
  scheduleChangedAccountBoardReseals(
    first.newState,
    evidenceBeforeCertification,
    new Set([badId]),
  );
  expect(first.newState.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)).toBe(true);
  const second = await handleScheduledWakeEntityTx(
    env,
    first.newState,
    scheduledWakeForHook(first.newState, signerId),
    false,
  );
  expect(second.outputs.map(output => output.entityId)).toEqual([badId]);
  expect(second.accountChanges).toEqual([badId]);
  expect(second.hashesToSign?.map(entry => entry.hash).sort()).toEqual([digest(201), digest(211)].sort());
  expect(second.newState.accounts.get(badId)?.boardResealMigration).toEqual({
    activationJHeight: 44,
    activationLogIndex: 2,
    reason: 'issued',
    issuedFrameHeight: 1,
    issuedFrameHash: digest(201),
  });
  expect(second.newState.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)).toBe(false);
});

test('Account advance re-arms the same activation and issues the current frame reseal', async () => {
  const signerId = deriveSignerAddressSync('board-reseal-frame-race', '1').toLowerCase();
  const sourceEntityId = digest(250);
  const env = createEmptyEnv('board-reseal-frame-race');
  registerSignerKey(env, signerId, deriveSignerKeySync('board-reseal-frame-race', '1'));
  const state = makeState(sourceEntityId, signerId, jurisdiction);
  state.timestamp = 3_000;
  state.crontabState = initCrontab();
  state.leaderState = { activeValidatorId: signerId, view: 0, changedAtHeight: 0 };
  const fixture = await makeCertifiedCounterpartyAccount(
    env,
    sourceEntityId,
    signerId,
    1n,
    digest(251),
  );
  putCommittedAccount(state, fixture.counterpartyId, fixture.account);
  installBoardResealHook(state, activation(sourceEntityId, 7));

  const first = await handleScheduledWakeEntityTx(
    env,
    createEntityFrameCandidateState(state),
    scheduledWakeForHook(state, signerId),
    false,
  );
  expect(first.outputs).toHaveLength(1);
  expect(first.newState.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)).toBe(false);

  const evidenceBeforeAdvance = captureAccountBoardResealEvidence(
    first.newState,
    new Set([fixture.counterpartyId]),
  );
  const advanced = first.newState.accounts.get(fixture.counterpartyId)!;
  advanced.currentHeight = 2;
  advanced.currentFrame = {
    ...advanced.currentFrame,
    height: 2,
    prevFrameHash: digest(251),
    accountStateRoot: digest(252),
    stateHash: digest(252),
  };
  advanced.currentFrameHanko = '0x05';
  advanced.counterpartyFrameHanko = await buildQuorumHanko(
    env,
    fixture.counterpartyId,
    digest(252),
    [{
      signerId,
      signature: await signAccountFrame(env, signerId, digest(252)),
    }],
    {
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
    },
  );
  scheduleChangedAccountBoardReseals(
    first.newState,
    evidenceBeforeAdvance,
    new Set([fixture.counterpartyId]),
  );
  expect(first.newState.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)).toBe(true);

  const second = await handleScheduledWakeEntityTx(
    env,
    first.newState,
    scheduledWakeForHook(first.newState, signerId),
    false,
  );
  const accountInput = second.outputs[0]?.entityTxs?.[0];
  expect(accountInput).toMatchObject({
    type: 'accountInput',
    data: {
      kind: 'board_reseal',
      reseal: { height: 2, frameHash: digest(252) },
    },
  });
  expect(second.newState.accounts.get(fixture.counterpartyId)?.boardResealMigration)
    .toMatchObject({ reason: 'issued', issuedFrameHeight: 2, issuedFrameHash: digest(252) });
  expect(second.newState.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)).toBe(false);
});

test('1000 board reseals drain in deterministic 32-account frames across restart', async () => {
  const signerId = deriveSignerAddressSync('board-reseal-1000', '1').toLowerCase();
  const sourceEntityId = digest(300);
  let env = createEmptyEnv('board-reseal-1000');
  env.runtimeId = signerId;
  registerSignerKey(env, signerId, deriveSignerKeySync('board-reseal-1000', '1'));
  let state = makeState(sourceEntityId, signerId, jurisdiction);
  state.timestamp = 10_000;
  state.crontabState = initCrontab();
  state.leaderState = { activeValidatorId: signerId, view: 0, changedAtHeight: 0 };
  for (let index = 0; index < 1_000; index += 1) {
    const fixture = await makeCertifiedCounterpartyAccount(
      env,
      sourceEntityId,
      signerId,
      BigInt(index + 1),
      digest(10_000 + index),
    );
    putCommittedAccount(state, fixture.counterpartyId, fixture.account);
  }
  installBoardResealHook(state, activation(sourceEntityId, 5));
  const sourceReplica = {
    entityId: sourceEntityId,
    signerId,
    state,
    mempool: [],
    isProposer: true,
  } as EntityReplica;
  env.state.eReplicas.set(`${sourceEntityId}:${signerId}`, sourceReplica);

  const delivered: string[] = [];
  let batches = 0;
  while (state.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)) {
    const hook = state.crontabState.hooks.get(BOARD_RESEAL_HOOK_ID);
    if (!hook || hook.type !== 'board_reseal') throw new Error('TEST_BOARD_RESEAL_1000_HOOK_INVALID');
    const nextIds = [...state.accounts.entries()]
      .filter(([counterpartyId, account]) =>
        counterpartyId > hook.data.afterCounterpartyId &&
        accountNeedsBoardResealForActivation(account, {
          jHeight: hook.data.activationJHeight,
          logIndex: hook.data.activationLogIndex,
        }))
      .map(([counterpartyId]) => counterpartyId)
      .sort()
      .slice(0, 32);
    state.timestamp = hook.triggerAt;
    const result = await handleScheduledWakeEntityTx(
      env,
      createEntityFrameCandidateState(state),
      scheduledWakeForHook(state, signerId),
      false,
    );
    expect(result.outputs.length).toBeGreaterThan(0);
    expect(result.accountChanges).toEqual(nextIds);
    expect(result.outputs.length).toBeLessThanOrEqual(32);
    expect(result.hashesToSign?.length).toBe(result.outputs.length);
    expect(Buffer.byteLength(safeStringify({ outputs: result.outputs, hashesToSign: result.hashesToSign })))
      .toBeLessThan(4 * 1024 * 1024);
    delivered.push(...result.outputs.map(output => output.entityId));
    state = result.newState;
    batches += 1;
    if (batches === 1) {
      const core = decodeBuffer<ReturnType<typeof projectEntityCoreDoc>>(
        encodeBuffer(projectEntityCoreDoc(state)),
      );
      const accounts = new Map([...state.accounts].map(([counterpartyId, account]) => [
        counterpartyId,
        decodeBuffer<ReturnType<typeof projectAccountDoc>>(encodeBuffer(projectAccountDoc(account))),
      ]));
      state = hydrateEntityStateFromStorage({ core, accounts, books: new Map() });
      sourceReplica.state = state;
      env.state.eReplicas.set(`${sourceEntityId}:${signerId}`, sourceReplica);
      expect(state.crontabState?.hooks.get(BOARD_RESEAL_HOOK_ID)).toEqual(
        result.newState.crontabState?.hooks.get(BOARD_RESEAL_HOOK_ID),
      );
      expect([...state.accounts.values()].filter(account => accountNeedsBoardResealForActivation(account, {
        jHeight: 44,
        logIndex: 5,
      })).length).toBe(968);
    }
  }

  expect(batches).toBe(32);
  expect(delivered).toEqual([...state.accounts.keys()].sort());
  expect([...state.accounts.values()].some(account => accountNeedsBoardResealForActivation(account, {
    jHeight: 44,
    logIndex: 5,
  }))).toBe(false);
});

test('missing counterparty reseal starts canonical dispute preparation after 24 hours', async () => {
  const signerId = deriveSignerAddressSync('counterparty-reseal-deadline', '1').toLowerCase();
  const sourceEntityId = digest(30_001);
  const counterpartyId = digest(30_002);
  const env = createEmptyEnv('counterparty-reseal-deadline');
  const state = makeState(sourceEntityId, signerId, jurisdiction);
  state.timestamp = 50_000;
  state.crontabState = initCrontab();
  putCommittedAccount(
    state,
    counterpartyId,
    makeCommittedAccount(sourceEntityId, counterpartyId, digest(30_003)),
  );
  const hookId = counterpartyBoardResealDeadlineHookId(counterpartyId, 44, 3);
  scheduleHook(state.crontabState, {
    id: hookId,
    triggerAt: state.timestamp + COUNTERPARTY_BOARD_RESEAL_DEADLINE_MS,
    type: 'counterparty_board_reseal_deadline',
    data: { accountId: counterpartyId, activationJHeight: 44, activationLogIndex: 3 },
  });
  state.timestamp += COUNTERPARTY_BOARD_RESEAL_DEADLINE_MS;

  const result = await handleScheduledWakeEntityTx(
    env,
    createEntityFrameCandidateState(state),
    scheduledWakeForId(state, signerId, hookId),
    false,
  );

  expect(result.outputs).toEqual([]);
  expect(result.approvedEntityTxs).toEqual([{
    type: 'prepareDispute',
    data: {
      counterpartyEntityId: counterpartyId,
      description: 'counterparty-board-reseal-deadline-expired',
    },
  }]);
  expect(result.newState.crontabState?.hooks.has(hookId)).toBe(false);
});

test('fresh counterparty reseal satisfies every older activation deadline', async () => {
  const signerId = deriveSignerAddressSync('counterparty-reseal-satisfied', '1').toLowerCase();
  const sourceEntityId = digest(31_001);
  const counterpartyId = digest(31_002);
  const env = createEmptyEnv('counterparty-reseal-satisfied');
  const state = makeState(sourceEntityId, signerId, jurisdiction);
  state.timestamp = 60_000;
  state.crontabState = initCrontab();
  const account = makeCommittedAccount(sourceEntityId, counterpartyId, digest(31_003));
  account.counterpartyBoardReseal = {
    activationJHeight: 45,
    activationLogIndex: 0,
    frameHeight: 1,
    frameHash: digest(31_003),
  };
  putCommittedAccount(state, counterpartyId, account);
  const hookId = counterpartyBoardResealDeadlineHookId(counterpartyId, 44, 9);
  scheduleHook(state.crontabState, {
    id: hookId,
    triggerAt: state.timestamp,
    type: 'counterparty_board_reseal_deadline',
    data: { accountId: counterpartyId, activationJHeight: 44, activationLogIndex: 9 },
  });

  const result = await handleScheduledWakeEntityTx(
    env,
    createEntityFrameCandidateState(state),
    scheduledWakeForId(state, signerId, hookId),
    false,
  );

  expect(result.outputs).toEqual([]);
  expect(result.approvedEntityTxs).toBeUndefined();
  expect(result.newState.crontabState?.hooks.has(hookId)).toBe(false);
});

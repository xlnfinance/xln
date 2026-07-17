import { expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { initCrontab, scheduleHook } from '../entity/scheduler';
import {
  BOARD_RESEAL_HOOK_ID,
  markBoardRotationResealsPending,
} from '../entity/tx/board-rotation-reseal';
import { buildQuorumHanko } from '../hanko/signing';
import { handleScheduledWakeEntityTx } from '../entity/tx/handlers/scheduled-wake';
import { safeStringify } from '../protocol/serialization';
import { createEmptyEnv } from '../runtime';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import {
  hydrateEntityStateFromStorage,
  projectAccountDoc,
  projectEntityCoreDoc,
} from '../storage/projections';
import type {
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JurisdictionConfig,
  JurisdictionEvent,
} from '../types';
import { addr, makeAccount, makeState } from './helpers/cross-j';

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
  env: Env,
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

test('bad board reseal account cannot block good output and retries from one bounded hook', async () => {
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
  bad.currentDisputeProofHanko = '0x03';
  state.accounts = new Map([[badId, bad], [goodId, good]]);
  installBoardResealHook(state, activation(sourceEntityId));

  const first = await handleScheduledWakeEntityTx(
    env,
    state,
    scheduledWakeForHook(state, signerId),
    false,
  );
  expect(first.outputs.map(output => output.entityId)).toEqual([goodId]);
  expect(first.hashesToSign).toEqual([expect.objectContaining({ hash: digest(202), type: 'accountFrame' })]);
  expect(first.newState.accounts.get(goodId)?.boardResealMigration).toBeUndefined();
  expect(first.newState.accounts.get(badId)?.boardResealMigration?.reason)
    .toBe('bilateral-dispute-uncertified');
  const retry = first.newState.crontabState?.hooks.get(BOARD_RESEAL_HOOK_ID);
  expect(retry).toMatchObject({
    type: 'board_reseal',
    triggerAt: 2_000,
    data: { activationJHeight: 44, activationLogIndex: 2, afterCounterpartyId: '' },
  });

  bad.counterpartyDisputeHash = bad.currentDisputeHash;
  bad.counterpartyDisputeProofBodyHash = bad.currentDisputeProofBodyHash;
  bad.counterpartyDisputeProofNonce = bad.currentDisputeProofNonce;
  bad.counterpartyDisputeProofHanko = '0x04';
  first.newState.timestamp = retry!.triggerAt;
  const second = await handleScheduledWakeEntityTx(
    env,
    first.newState,
    scheduledWakeForHook(first.newState, signerId),
    false,
  );
  expect(second.outputs.map(output => output.entityId)).toEqual([badId]);
  expect(second.hashesToSign?.map(entry => entry.hash).sort()).toEqual([digest(201), digest(211)].sort());
  expect(second.newState.accounts.get(badId)?.boardResealMigration).toBeUndefined();
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
    state.accounts.set(fixture.counterpartyId, fixture.account);
  }
  installBoardResealHook(state, activation(sourceEntityId, 5));
  const sourceReplica = {
    entityId: sourceEntityId,
    signerId,
    state,
    mempool: [],
    isProposer: true,
  } as EntityReplica;
  env.eReplicas.set(`${sourceEntityId}:${signerId}`, sourceReplica);

  const delivered: string[] = [];
  let batches = 0;
  while (state.crontabState?.hooks.has(BOARD_RESEAL_HOOK_ID)) {
    const hook = state.crontabState.hooks.get(BOARD_RESEAL_HOOK_ID);
    if (!hook || hook.type !== 'board_reseal') throw new Error('TEST_BOARD_RESEAL_1000_HOOK_INVALID');
    const nextIds = [...state.accounts.entries()]
      .filter(([counterpartyId, account]) =>
        counterpartyId > hook.data.afterCounterpartyId &&
        account.boardResealMigration?.activationJHeight === hook.data.activationJHeight &&
        account.boardResealMigration.activationLogIndex === hook.data.activationLogIndex)
      .map(([counterpartyId]) => counterpartyId)
      .sort()
      .slice(0, 32);
    state.timestamp = hook.triggerAt;
    const result = await handleScheduledWakeEntityTx(env, state, scheduledWakeForHook(state, signerId), false);
    expect(result.outputs.length).toBeGreaterThan(0);
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
      env.eReplicas.set(`${sourceEntityId}:${signerId}`, sourceReplica);
      expect(state.crontabState?.hooks.get(BOARD_RESEAL_HOOK_ID)).toEqual(
        result.newState.crontabState?.hooks.get(BOARD_RESEAL_HOOK_ID),
      );
      expect([...state.accounts.values()].filter(account => account.boardResealMigration).length).toBe(968);
    }
  }

  expect(batches).toBe(32);
  expect(delivered).toEqual([...state.accounts.keys()].sort());
  expect([...state.accounts.values()].some(account => account.boardResealMigration)).toBe(false);
});

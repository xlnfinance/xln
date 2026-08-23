import { expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../../account/crypto';
import { applyAccountInput } from '../../../account/consensus';
import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { generateLazyEntityId } from '../../../entity/factory';
import { initCrontab } from '../../../entity/scheduler';
import {
  applyBoardRotationResealMigrations,
  buildBoardRotationResealDrafts,
} from '../../../entity/tx/state-effects/board-rotation-reseal';
import { buildQuorumHanko } from '../../../hanko/signing';
import { createEmptyEnv } from '../../../runtime';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { hydrateAccountDocFromStorage } from '../../../storage/read/hydration';
import { projectAccountDoc } from '../../../storage/read/projections';
import type { AccountInput } from '../../../types/account';
import type { EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import {
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';
import { applyJEventRange } from '../../helpers/j-history';
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../../entity/state/persistent-account-map';
import {
  COUNTERPARTY_BOARD_RESEAL_DEADLINE_MS,
  counterpartyBoardResealDeadlineHookId,
} from '../../../entity/tx/j-events-board';
import { addr, makeAccount, makeState } from '../../helpers/cross-j';
import {
  accountInputFailureMessage,
} from '../../../account/consensus/result';
import type { AccountInputSecurityContext } from '../../../account/consensus/dispute/deadline-policy';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;

const putAccount = (state: EntityState, counterpartyId: string, account: ReturnType<typeof makeAccount>): void => {
  if (state.accounts instanceof EntityAccountCandidateMap) {
    state.accounts.set(counterpartyId, account);
    return;
  }
  if (!(state.accounts instanceof PersistentEntityAccountMap)) {
    throw new Error('TEST_PERSISTENT_ACCOUNT_MAP_REQUIRED');
  }
  state.accounts = state.accounts.updated(counterpartyId, account);
};

const certifiedResealContext = (
  env: ReturnType<typeof createEmptyEnv>,
  boardHash: string,
  activatedAtJHeight: number,
  logIndex: number,
): AccountInputSecurityContext => {
  const context = createAccountConsensusContext(env);
  return {
    entityTimestamp: env.state.timestamp,
    finalizedJHeight: env.state.jHeight,
    owningEntityIsHub: false,
    verifyHanko: context.verifyHanko,
    counterpartyCertifiedBoard: { boardHash, activatedAtJHeight, logIndex },
  };
};

test('board reseal replaces only the exact current counterparty Hanko', async () => {
  const env = createEmptyEnv('board-rotation-account-reseal');
  const signerId = deriveSignerAddressSync('board-rotation-account-reseal', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-rotation-account-reseal', '1'));
  const sourceEntityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const receiverEntityId = digest('77');
  const frameHash = digest('a1');
  const config = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
  };
  const frameHanko = await buildQuorumHanko(env, sourceEntityId, frameHash, [{
    signerId,
    signature: await signAccountFrame(env, signerId, frameHash),
  }], config);
  const account = makeAccount(receiverEntityId, sourceEntityId);
  account.currentHeight = 7;
  account.currentFrame = {
    ...account.currentFrame,
    height: 7,
    stateHash: frameHash,
  };
  account.counterpartyFrameHanko = '0x01';
  const beforeFrame = structuredClone(account.currentFrame);

  const input = {
    kind: 'board_reseal',
    fromEntityId: sourceEntityId,
    toEntityId: receiverEntityId,
    domain: { ...account.state.domain },
    disputeConfig: { ...account.state.disputeConfig },
    reseal: {
      height: 7,
      frameHash,
      frameHanko,
      boardActivationJHeight: 19,
      boardActivationLogIndex: 2,
    },
  } satisfies AccountInput;
  const baseContext = createAccountConsensusContext(env);
  const observedAuthorities: Array<Parameters<typeof baseContext.verifyHanko>[3]> = [];
  const applied = await applyAccountInput({
    ...baseContext,
    verifyHanko: async (hanko, hash, expectedEntityId, authority) => {
      observedAuthorities.push(authority);
      return baseContext.verifyHanko(hanko, hash, expectedEntityId, authority);
    },
  }, account, input, certifiedResealContext(env, sourceEntityId, 19, 2));

  expect(applied.ok, accountInputFailureMessage(applied)).toBe(true);
  expect(observedAuthorities[0]).toEqual({
    registeredBoardHash: sourceEntityId,
    allowPreviousBoard: false,
  });
  expect(account.counterpartyFrameHanko).toBe(frameHanko);
  expect(account.currentFrame).toEqual(beforeFrame);
  expect(account.currentHeight).toBe(7);
  expect(account.state.jNonce).toBe(0);
  expect(account.counterpartyBoardReseal).toEqual({
    activationJHeight: 19,
    activationLogIndex: 2,
    frameHeight: 7,
    frameHash,
  });
  const restored = hydrateAccountDocFromStorage(projectAccountDoc(account));
  expect(restored.counterpartyBoardReseal).toEqual(account.counterpartyBoardReseal);
  expect(restored.counterpartyFrameHanko).toBe(frameHanko);

  const beforeExactRetry = projectAccountDoc(account);
  expect((await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    structuredClone(input),
    certifiedResealContext(env, sourceEntityId, 19, 2),
  )).ok).toBe(true);
  expect(projectAccountDoc(account)).toEqual(beforeExactRetry);

  const sameBlockSuccessor = structuredClone(input);
  sameBlockSuccessor.reseal.boardActivationLogIndex = 3;
  const successorRejected = await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    sameBlockSuccessor,
    certifiedResealContext(env, sourceEntityId, 19, 2),
  );
  expect(successorRejected.ok).toBe(false);
  expect(accountInputFailureMessage(successorRejected)).toContain('ACCOUNT_BOARD_RESEAL_ACTIVATION_MISMATCH');

  const beforeRejected = projectAccountDoc(account);
  const tampered = structuredClone(input);
  tampered.reseal.boardActivationJHeight = Number.MAX_SAFE_INTEGER;
  tampered.reseal.boardActivationLogIndex = Number.MAX_SAFE_INTEGER;
  const rejected = await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    tampered,
    certifiedResealContext(env, sourceEntityId, 19, 2),
  );
  expect(rejected.ok).toBe(false);
  expect(accountInputFailureMessage(rejected)).toContain('ACCOUNT_BOARD_RESEAL_ACTIVATION_MISMATCH');
  expect(projectAccountDoc(account)).toEqual(beforeRejected);
});

test('ACK commit retains the counterparty Hanko needed for later board reseal', async () => {
  const env = createEmptyEnv('board-reseal-ack-retention');
  const peerSigner = deriveSignerAddressSync('board-reseal-ack-retention', '1').toLowerCase();
  registerSignerKey(env, peerSigner, deriveSignerKeySync('board-reseal-ack-retention', '1'));
  const peerEntityId = generateLazyEntityId([peerSigner], 1n).toLowerCase();
  const localEntityId = digest('66');
  const frameHash = digest('b1');
  const peerConfig = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [peerSigner],
    shares: { [peerSigner]: 1n },
  };
  const peerHanko = await buildQuorumHanko(env, peerEntityId, frameHash, [{
    signerId: peerSigner,
    signature: await signAccountFrame(env, peerSigner, frameHash),
  }], peerConfig);
  const account = makeAccount(localEntityId, peerEntityId);
  account.pendingFrame = {
    ...account.currentFrame,
    height: 1,
    timestamp: 1,
    prevFrameHash: digest('00'),
    accountStateRoot: computeAccountStateRoot(account.state),
    stateHash: frameHash,
  };

  const result = await applyAccountInput(createAccountConsensusContext(env), account, {
    kind: 'ack',
    fromEntityId: peerEntityId,
    toEntityId: localEntityId,
    domain: { ...account.state.domain },
    disputeConfig: { ...account.state.disputeConfig },
    ack: { height: 1, frameHash, frameHanko: peerHanko },
  });

  expect(result.ok, accountInputFailureMessage(result)).toBe(true);
  expect(account.currentHeight).toBe(1);
  expect(account.counterpartyFrameHanko).toBe(peerHanko);
});

test('board reseal routing is identical with sparse and populated validator topology', async () => {
  const targetSigner = deriveSignerAddressSync('board-reseal-topology-target', '1').toLowerCase();
  const targetKey = deriveSignerKeySync('board-reseal-topology-target', '1');
  const sourceSigner = deriveSignerAddressSync('board-reseal-topology-source', '1').toLowerCase();
  const targetConfig = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [targetSigner],
    shares: { [targetSigner]: 1n },
  };
  const targetEntityId = generateLazyEntityId([targetSigner], 1n).toLowerCase();
  const sourceEntityId = generateLazyEntityId([sourceSigner], 1n).toLowerCase();
  const frameHash = digest('f1');
  const populated = createEmptyEnv('board-reseal-topology-populated');
  registerSignerKey(populated, targetSigner, targetKey);
  const counterpartyHanko = await buildQuorumHanko(populated, targetEntityId, frameHash, [{
    signerId: targetSigner,
    signature: await signAccountFrame(populated, targetSigner, frameHash),
  }], targetConfig);
  const account = makeAccount(sourceEntityId, targetEntityId);
  account.currentHeight = 4;
  account.currentFrame = { ...account.currentFrame, height: 4, stateHash: frameHash };
  account.currentFrameHanko = '0x01';
  account.counterpartyFrameHanko = counterpartyHanko;
  const state = {
    entityId: sourceEntityId,
    timestamp: 1_000,
    accounts: new Map([[targetEntityId, account]]),
  } as unknown as EntityState;
  populated.state.eReplicas.set(`${targetEntityId}:${targetSigner}`, {
    entityId: targetEntityId,
    signerId: targetSigner,
    entityEncPubKey: '',
    state: makeState(targetEntityId, targetSigner),
    mempool: [],
    isProposer: true,
  } as EntityReplica);
  const sparse = createEmptyEnv('board-reseal-topology-sparse');
  const activation = {
    type: 'BoardActivated',
    blockNumber: 24,
    blockHash: digest('f2'),
    transactionHash: digest('f3'),
    logIndex: 2,
    data: {
      entityId: sourceEntityId,
      previousBoardHash: digest('f4'),
      newBoardHash: digest('f5'),
      previousBoardValidUntil: '1700604800',
    },
  } satisfies JurisdictionEvent;

  const populatedDraft = buildBoardRotationResealDrafts(structuredClone(state), populated, activation);
  const sparseDraft = buildBoardRotationResealDrafts(structuredClone(state), sparse, activation);

  expect(sparse.state.eReplicas.size).toBe(0);
  expect(sparseDraft).toEqual(populatedDraft);
  expect(sparseDraft.outputs).toEqual([
    expect.objectContaining({ entityId: targetEntityId, signerId: targetSigner }),
  ]);
  expect(sparseDraft.hashesToSign).toEqual([
    expect.objectContaining({ hash: frameHash, type: 'accountFrame' }),
  ]);
  expect(sparseDraft.accountMigrations).toEqual([{
    counterpartyId: targetEntityId,
    marker: {
      activationJHeight: 24,
      activationLogIndex: 2,
      reason: 'issued',
      issuedFrameHeight: 4,
      issuedFrameHash: frameHash,
    },
  }]);
});

test('one uncertified Account cannot block BoardActivated reseals for certified peers', async () => {
  const env = createEmptyEnv('board-reseal-missing-bilateral-hanko');
  const sourceEntityId = digest('91');
  const uncertifiedId = digest('90');
  const signerId = deriveSignerAddressSync('board-reseal-certified-peer', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-reseal-certified-peer', '1'));
  const certifiedId = generateLazyEntityId([signerId], 1n).toLowerCase();

  const uncertified = makeAccount(sourceEntityId, uncertifiedId);
  uncertified.currentHeight = 1;
  uncertified.currentFrame = { ...uncertified.currentFrame, height: 1, stateHash: digest('d1') };
  uncertified.currentFrameHanko = '0x01';
  const certified = makeAccount(sourceEntityId, certifiedId);
  certified.currentHeight = 2;
  certified.currentFrame = { ...certified.currentFrame, height: 2, stateHash: digest('d2') };
  certified.currentFrameHanko = '0x01';
  certified.counterpartyFrameHanko = await buildQuorumHanko(env, certifiedId, certified.currentFrame.stateHash, [{
    signerId,
    signature: await signAccountFrame(env, signerId, certified.currentFrame.stateHash),
  }], {
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
  });
  certified.boardResealMigration = {
    activationJHeight: 6,
    activationLogIndex: 9,
    reason: 'bilateral-frame-uncertified',
  };
  env.state.eReplicas.set(`${certifiedId}:${signerId}`, {
    entityId: certifiedId,
    signerId,
    entityEncPubKey: '',
    state: {
      entityId: certifiedId,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
      },
    },
  } as unknown as EntityReplica);
  const state = makeState(sourceEntityId, signerId);
  putAccount(state, uncertifiedId, uncertified);
  putAccount(state, certifiedId, certified);
  const accountsRootBeforeDraft = state.accounts.rootHash();
  const activation = {
    type: 'BoardActivated',
    blockNumber: 7,
    blockHash: digest('07'),
    transactionHash: digest('08'),
    logIndex: 0,
    data: {
      entityId: sourceEntityId,
      previousBoardHash: digest('a1'),
      newBoardHash: digest('a2'),
      previousBoardValidUntil: '1700604800',
    },
  } satisfies JurisdictionEvent;

  const result = buildBoardRotationResealDrafts(state, env, activation);
  expect(result.outputs).toHaveLength(1);
  expect(result.outputs[0]?.entityId).toBe(certifiedId);
  expect(result.hashesToSign).toEqual([expect.objectContaining({
    hash: digest('d2'),
    type: 'accountFrame',
  })]);
  expect(state.accounts.rootHash()).toBe(accountsRootBeforeDraft);
  expect(uncertified.currentHeight).toBe(1);
  expect(uncertified.currentFrame.stateHash).toBe(digest('d1'));
  expect(uncertified.state.jNonce).toBe(0);
  expect(result.accountMigrations).toEqual([
    {
      counterpartyId: uncertifiedId,
      marker: {
        activationJHeight: 7,
        activationLogIndex: 0,
        reason: 'bilateral-frame-uncertified',
      },
    },
    {
      counterpartyId: certifiedId,
      marker: {
        activationJHeight: 7,
        activationLogIndex: 0,
        reason: 'issued',
        issuedFrameHeight: 2,
        issuedFrameHash: digest('d2'),
      },
    },
  ].sort((left, right) => left.counterpartyId.localeCompare(right.counterpartyId)));
  const candidate = createEntityFrameCandidateState(state);
  applyBoardRotationResealMigrations(candidate, result.accountMigrations);
  const migratedUncertified = candidate.accounts.get(uncertifiedId)!;
  const migratedCertified = candidate.accounts.get(certifiedId)!;
  expect(migratedUncertified.boardResealMigration).toEqual(
    result.accountMigrations.find(update => update.counterpartyId === uncertifiedId)?.marker,
  );
  expect(migratedCertified.boardResealMigration).toEqual(
    result.accountMigrations.find(update => update.counterpartyId === certifiedId)?.marker,
  );
  expect(migratedUncertified.currentHeight).toBe(uncertified.currentHeight);
  expect(migratedUncertified.currentFrame).toEqual(uncertified.currentFrame);
  expect(migratedUncertified.state.jNonce).toBe(uncertified.state.jNonce);
  const restored = hydrateAccountDocFromStorage(projectAccountDoc(migratedUncertified));
  expect(restored.boardResealMigration).toEqual(migratedUncertified.boardResealMigration);
  expect(restored.currentFrame).toEqual(migratedUncertified.currentFrame);
  expect(restored.state.jNonce).toBe(migratedUncertified.state.jNonce);
});

test('partial bilateral dispute evidence never emits a frame-only board reseal', () => {
  const env = createEmptyEnv('board-reseal-partial-dispute');
  const sourceEntityId = digest('a4');
  const counterpartyId = digest('a5');
  const signerId = deriveSignerAddressSync('board-reseal-partial-dispute-peer', '1').toLowerCase();
  const account = makeAccount(sourceEntityId, counterpartyId);
  account.currentHeight = 3;
  account.currentFrame = { ...account.currentFrame, height: 3, stateHash: digest('e1') };
  account.currentFrameHanko = '0x01';
  account.counterpartyFrameHanko = '0x02';
  account.currentDisputeHash = digest('e2');
  account.currentDisputeProofBodyHash = digest('e3');
  account.currentDisputeProofNonce = 4;
  account.currentDisputeProofHanko = '0x03';
  env.state.eReplicas.set(`${counterpartyId}:${signerId}`, {
    entityId: counterpartyId,
    signerId,
    entityEncPubKey: '',
    state: {
      entityId: counterpartyId,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
      },
    },
  } as unknown as EntityReplica);
  const state = {
    entityId: sourceEntityId,
    accounts: new Map([[counterpartyId, account]]),
  } as unknown as EntityState;
  const activation = {
    type: 'BoardActivated',
    blockNumber: 8,
    blockHash: digest('08'),
    transactionHash: digest('09'),
    logIndex: 1,
    data: {
      entityId: sourceEntityId,
      previousBoardHash: digest('b1'),
      newBoardHash: digest('b2'),
      previousBoardValidUntil: '1700604800',
    },
  } satisfies JurisdictionEvent;

  const result = buildBoardRotationResealDrafts(state, env, activation);
  expect(result.outputs).toEqual([]);
  expect(result.hashesToSign).toEqual([]);
  expect(result.accountMigrations).toEqual([{
    counterpartyId,
    marker: {
      activationJHeight: 8,
      activationLogIndex: 1,
      reason: 'bilateral-dispute-uncertified',
    },
  }]);
});

test('one board reseal pass emits at most 32 deterministic Accounts', async () => {
  const env = createEmptyEnv('board-reseal-bounded-pass');
  const sourceEntityId = digest('b4');
  const signerId = deriveSignerAddressSync('board-reseal-bounded-pass-peer', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-reseal-bounded-pass-peer', '1'));
  const accounts = new Map<string, ReturnType<typeof makeAccount>>();
  for (let index = 0; index < 33; index += 1) {
    const weight = BigInt(index + 1);
    const counterpartyId = generateLazyEntityId([{ name: signerId, weight }], 1n).toLowerCase();
    const account = makeAccount(sourceEntityId, counterpartyId);
    account.currentHeight = 1;
    account.currentFrame = {
      ...account.currentFrame,
      height: 1,
      stateHash: `0x${(index + 101).toString(16).padStart(64, '0')}`,
    };
    account.currentFrameHanko = '0x01';
    account.counterpartyFrameHanko = await buildQuorumHanko(env, counterpartyId, account.currentFrame.stateHash, [{
      signerId,
      signature: await signAccountFrame(env, signerId, account.currentFrame.stateHash),
    }], {
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: weight },
    });
    accounts.set(counterpartyId, account);
    env.state.eReplicas.set(`${counterpartyId}:${signerId}`, {
      entityId: counterpartyId,
      signerId,
      entityEncPubKey: '',
      state: {
        entityId: counterpartyId,
        config: {
          mode: 'proposer-based',
          threshold: 1n,
          validators: [signerId],
          shares: { [signerId]: 1n },
        },
      },
    } as unknown as EntityReplica);
  }
  const state = { entityId: sourceEntityId, timestamp: 0, accounts } as unknown as EntityState;
  const activation = {
    type: 'BoardActivated',
    blockNumber: 9,
    blockHash: digest('09'),
    transactionHash: digest('0a'),
    logIndex: 0,
    data: {
      entityId: sourceEntityId,
      previousBoardHash: digest('c1'),
      newBoardHash: digest('c2'),
      previousBoardValidUntil: '1700604800',
    },
  } satisfies JurisdictionEvent;

  const result = buildBoardRotationResealDrafts(state, env, activation);
  expect(result.outputs).toHaveLength(32);
  expect(result.hashesToSign).toHaveLength(32);
  expect(result.outputs.map(output => output.entityId)).toEqual([...accounts.keys()].sort().slice(0, 32));
});

test('two board rotations in one finalized J range collapse to the latest reseal wake', async () => {
  const env = createEmptyEnv('board-reseal-same-range-rotations');
  const signerId = deriveSignerAddressSync('board-reseal-same-range-rotations', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-reseal-same-range-rotations', '1'));
  const sourceEntityId = `0x${'0'.repeat(63)}2`;
  const jurisdiction = {
    name: 'board-reseal-same-range',
    address: 'http://127.0.0.1:8545',
    chainId: 31_337,
    depositoryAddress: addr('d1'),
    entityProviderAddress: addr('e1'),
  } satisfies JurisdictionConfig;
  let state = makeState(sourceEntityId, signerId, jurisdiction);
  state.crontabState = initCrontab();
  state.leaderState = { activeValidatorId: signerId, view: 0, changedAtHeight: 0 };
  const foundation = {
    type: 'FoundationBootstrapped',
    blockNumber: 1,
    blockHash: digest('01'),
    transactionHash: digest('11'),
    logIndex: 0,
    data: {
      recipient: addr('f1'),
      boardHash: digest('31'),
      controlTokenId: '2',
      dividendTokenId: '3',
    },
  } satisfies JurisdictionEvent;
  state = (await applyJEventRange(state, {
    from: signerId,
    jurisdictionRef: '',
    event: foundation,
    observedAt: 1,
    blockNumber: 1,
    blockHash: foundation.blockHash,
  }, env)).newState;
  const registration = {
    type: 'EntityRegistered',
    blockNumber: 2,
    blockHash: digest('02'),
    transactionHash: digest('12'),
    logIndex: 0,
    data: { entityId: sourceEntityId, entityNumber: '2', boardHash: digest('32') },
  } satisfies JurisdictionEvent;
  state = (await applyJEventRange(state, {
    from: signerId,
    jurisdictionRef: '',
    event: registration,
    observedAt: 2,
    blockNumber: 2,
    blockHash: registration.blockHash,
  }, env)).newState;

  const counterpartyId = digest('71');
  const account = makeAccount(sourceEntityId, counterpartyId);
  account.currentHeight = 1;
  account.currentFrame = {
    ...account.currentFrame,
    height: 1,
    timestamp: 1,
    jHeight: 2,
    prevFrameHash: 'genesis',
    accountStateRoot: digest('d7'),
    stateHash: digest('d7'),
  };
  account.currentFrameHanko = '0x01';
  account.counterpartyFrameHanko = '0x02';
  putAccount(state, counterpartyId, account);
  env.state.eReplicas.set(`${counterpartyId}:${signerId}`, {
    entityId: counterpartyId,
    signerId,
    entityEncPubKey: '',
    state: makeState(counterpartyId, signerId, jurisdiction),
  } as unknown as EntityReplica);

  const rotations = [{
    type: 'BoardActivated',
    blockNumber: 3,
    blockHash: digest('03'),
    transactionHash: digest('13'),
    logIndex: 4,
    data: {
      entityId: sourceEntityId,
      previousBoardHash: digest('32'),
      newBoardHash: digest('33'),
      previousBoardValidUntil: '1700604800',
    },
  }, {
    type: 'BoardActivated',
    blockNumber: 3,
    blockHash: digest('03'),
    transactionHash: digest('14'),
    logIndex: 9,
    data: {
      entityId: sourceEntityId,
      previousBoardHash: digest('33'),
      newBoardHash: digest('34'),
      previousBoardValidUntil: '1700604801',
    },
  }] satisfies JurisdictionEvent[];
  const applied = await applyJEventRange(state, {
    from: signerId,
    jurisdictionRef: '',
    event: rotations[0]!,
    events: rotations,
    observedAt: 3,
    blockNumber: 3,
    blockHash: digest('03'),
  }, env);

  expect(applied.outputs).toEqual([]);
  expect(applied.hashesToSign).toBeUndefined();
  expect(applied.newState.accounts.get(counterpartyId)?.boardResealMigration).toEqual({
    activationJHeight: 3,
    activationLogIndex: 9,
    reason: 'pending',
  });
  expect([...(applied.newState.crontabState?.hooks.entries() ?? [])]).toEqual([['board-reseal', {
    id: 'board-reseal',
    triggerAt: state.timestamp,
    type: 'board_reseal',
    data: { activationJHeight: 3, activationLogIndex: 9, afterCounterpartyId: '' },
  }]]);
});

test('certified counterparty board activation arms an exact 24-hour reseal deadline', async () => {
  const env = createEmptyEnv('counterparty-board-reseal-deadline-event');
  const signerId = deriveSignerAddressSync('counterparty-board-reseal-deadline-event', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('counterparty-board-reseal-deadline-event', '1'));
  const ownerEntityId = digest('81');
  const counterpartyId = `0x${'0'.repeat(63)}2`;
  const jurisdiction = {
    name: 'counterparty-board-reseal-deadline-event',
    address: 'http://127.0.0.1:8545',
    chainId: 31_337,
    depositoryAddress: addr('d1'),
    entityProviderAddress: addr('e1'),
  } satisfies JurisdictionConfig;
  let state = makeState(ownerEntityId, signerId, jurisdiction);
  state.timestamp = 90_000;
  state.crontabState = initCrontab();
  const account = makeAccount(ownerEntityId, counterpartyId);
  account.currentHeight = 1;
  account.currentFrame = {
    ...account.currentFrame,
    height: 1,
    timestamp: 1,
    jHeight: 1,
    prevFrameHash: 'genesis',
    stateHash: digest('83'),
    accountStateRoot: digest('83'),
  };
  putAccount(state, counterpartyId, account);

  const foundation = {
    type: 'FoundationBootstrapped',
    blockNumber: 1,
    blockHash: digest('01'),
    transactionHash: digest('11'),
    logIndex: 0,
    data: {
      recipient: addr('f1'),
      boardHash: digest('31'),
      controlTokenId: '2',
      dividendTokenId: '3',
    },
  } satisfies JurisdictionEvent;
  state = (await applyJEventRange(state, {
    from: signerId,
    jurisdictionRef: '',
    event: foundation,
    observedAt: 1,
    blockNumber: 1,
    blockHash: foundation.blockHash,
  }, env)).newState;
  const registration = {
    type: 'EntityRegistered',
    blockNumber: 2,
    blockHash: digest('02'),
    transactionHash: digest('12'),
    logIndex: 0,
    data: { entityId: counterpartyId, entityNumber: '2', boardHash: digest('32') },
  } satisfies JurisdictionEvent;
  state = (await applyJEventRange(state, {
    from: signerId,
    jurisdictionRef: '',
    event: registration,
    observedAt: 2,
    blockNumber: 2,
    blockHash: registration.blockHash,
  }, env)).newState;
  const rotation = {
    type: 'BoardActivated',
    blockNumber: 3,
    blockHash: digest('03'),
    transactionHash: digest('13'),
    logIndex: 7,
    data: {
      entityId: counterpartyId,
      previousBoardHash: digest('32'),
      newBoardHash: digest('33'),
      previousBoardValidUntil: '1700604800',
    },
  } satisfies JurisdictionEvent;
  const applied = await applyJEventRange(state, {
    from: signerId,
    jurisdictionRef: '',
    event: rotation,
    observedAt: 3,
    blockNumber: 3,
    blockHash: rotation.blockHash,
  }, env);

  const hookId = counterpartyBoardResealDeadlineHookId(counterpartyId, 3, 7);
  expect(applied.newState.crontabState?.hooks.get(hookId)).toEqual({
    id: hookId,
    triggerAt: state.timestamp + COUNTERPARTY_BOARD_RESEAL_DEADLINE_MS,
    type: 'counterparty_board_reseal_deadline',
    data: { accountId: counterpartyId, activationJHeight: 3, activationLogIndex: 7 },
  });
  expect(applied.newState.accounts.get(counterpartyId)?.boardResealMigration).toBeUndefined();
});

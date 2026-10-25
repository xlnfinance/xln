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
  applyBoardRotationHankoRefreshMigrations,
  buildBoardRotationHankoRefreshDrafts,
} from '../../../entity/tx/state-effects/board-rotation-hanko-refresh';
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
  COUNTERPARTY_BOARD_HANKO_REFRESH_DEADLINE_MS,
  counterpartyBoardHankoRefreshDeadlineHookId,
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

const certifiedHankoRefreshContext = (
  env: ReturnType<typeof createEmptyEnv>,
  boardHash: string,
  boardEpoch: number,
): AccountInputSecurityContext => {
  const context = createAccountConsensusContext(env);
  return {
    entityTimestamp: env.state.timestamp,
    finalizedJHeight: env.state.jHeight,
    owningEntityIsHub: false,
    verifyHanko: context.verifyHanko,
    counterpartyCertifiedBoard: { boardHash, boardEpoch },
  };
};

/** Production resolves this epoch from the certified registry after BoardActivated. */
const epochActivation = (
  event: Extract<JurisdictionEvent, { type: 'BoardActivated' }>,
  boardEpoch = 1,
) => ({ entityId: event.data.entityId.toLowerCase(), boardEpoch });

test('board Hanko refresh replaces only the exact current counterparty Hanko', async () => {
  const env = createEmptyEnv('board-rotation-account-boardHankoRefresh');
  const signerId = deriveSignerAddressSync('board-rotation-account-boardHankoRefresh', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-rotation-account-boardHankoRefresh', '1'));
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
    kind: 'board_hanko_refresh',
    fromEntityId: sourceEntityId,
    toEntityId: receiverEntityId,
    domain: { ...account.state.domain },
    disputeConfig: { ...account.state.disputeConfig },
    boardHankoRefresh: {
      height: 7,
      frameHash,
      frameHanko,
      boardEpoch: 1,
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
  }, account, input, certifiedHankoRefreshContext(env, sourceEntityId, 1));

  expect(applied.ok, accountInputFailureMessage(applied)).toBe(true);
  expect(observedAuthorities[0]).toEqual({
    registeredBoardHash: sourceEntityId,
    allowPreviousBoard: false,
  });
  expect(account.counterpartyFrameHanko).toBe(frameHanko);
  expect(account.currentFrame).toEqual(beforeFrame);
  expect(account.currentHeight).toBe(7);
  expect(account.state.jNonce).toBe(0);
  expect(account.counterpartyBoardHankoRefresh).toEqual({
    boardEpoch: 1,
    frameHeight: 7,
    frameHash,
  });
  const restored = hydrateAccountDocFromStorage(projectAccountDoc(account));
  expect(restored.counterpartyBoardHankoRefresh).toEqual(account.counterpartyBoardHankoRefresh);
  expect(restored.counterpartyFrameHanko).toBe(frameHanko);

  const beforeExactRetry = projectAccountDoc(account);
  expect((await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    structuredClone(input),
    certifiedHankoRefreshContext(env, sourceEntityId, 1),
  )).ok).toBe(true);
  expect(projectAccountDoc(account)).toEqual(beforeExactRetry);

  const uncertifiedSuccessor = structuredClone(input);
  uncertifiedSuccessor.boardHankoRefresh.boardEpoch = 2;
  const successorRejected = await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    uncertifiedSuccessor,
    certifiedHankoRefreshContext(env, sourceEntityId, 1),
  );
  expect(successorRejected.ok).toBe(false);
  expect(accountInputFailureMessage(successorRejected)).toContain('ACCOUNT_BOARD_HANKO_REFRESH_BOARD_EPOCH_MISMATCH:2:1');

  const beforeRejected = projectAccountDoc(account);
  const tampered = structuredClone(input);
  tampered.boardHankoRefresh.boardEpoch = Number.MAX_SAFE_INTEGER;
  const rejected = await applyAccountInput(
    createAccountConsensusContext(env),
    account,
    tampered,
    certifiedHankoRefreshContext(env, sourceEntityId, 1),
  );
  expect(rejected.ok).toBe(false);
  expect(accountInputFailureMessage(rejected)).toContain('ACCOUNT_BOARD_HANKO_REFRESH_BOARD_EPOCH_MISMATCH');
  expect(projectAccountDoc(account)).toEqual(beforeRejected);
});

test('board Hanko refresh epoch is exact, starts after registration and never moves backwards', async () => {
  const env = createEmptyEnv('board-rotation-account-refresh-epoch-order');
  const signerId = deriveSignerAddressSync('board-rotation-account-refresh-epoch-order', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-rotation-account-refresh-epoch-order', '1'));
  const sourceEntityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const receiverEntityId = digest('78');
  const frameHash = digest('a2');
  const frameHanko = await buildQuorumHanko(env, sourceEntityId, frameHash, [{
    signerId,
    signature: await signAccountFrame(env, signerId, frameHash),
  }], {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
  });
  const account = makeAccount(receiverEntityId, sourceEntityId);
  account.currentHeight = 3;
  account.currentFrame = { ...account.currentFrame, height: 3, stateHash: frameHash };
  account.counterpartyFrameHanko = '0x01';
  const refresh = (boardEpoch: number) => ({
    kind: 'board_hanko_refresh',
    fromEntityId: sourceEntityId,
    toEntityId: receiverEntityId,
    domain: { ...account.state.domain },
    disputeConfig: { ...account.state.disputeConfig },
    boardHankoRefresh: { height: 3, frameHash, frameHanko, boardEpoch },
  } satisfies AccountInput);
  const apply = (boardEpoch: number, certifiedEpoch: number) => applyAccountInput(
    createAccountConsensusContext(env),
    account,
    refresh(boardEpoch),
    certifiedHankoRefreshContext(env, sourceEntityId, certifiedEpoch),
  );

  // Epoch 0 is the registration board; no BoardActivated refresh can claim it.
  const registration = await apply(0, 0);
  expect(registration.ok).toBe(false);
  expect(accountInputFailureMessage(registration)).toContain('ACCOUNT_BOARD_HANKO_REFRESH_BOARD_EPOCH_INVALID:0');
  expect(account.counterpartyBoardHankoRefresh).toBeUndefined();

  // A sender cannot pre-claim an epoch the receiver has not certified.
  const ahead = await apply(3, 2);
  expect(ahead.ok).toBe(false);
  expect(accountInputFailureMessage(ahead)).toContain('ACCOUNT_BOARD_HANKO_REFRESH_BOARD_EPOCH_MISMATCH:3:2');
  expect(account.counterpartyBoardHankoRefresh).toBeUndefined();

  const current = await apply(2, 2);
  expect(current.ok, accountInputFailureMessage(current)).toBe(true);
  expect(account.counterpartyBoardHankoRefresh?.boardEpoch).toBe(2);

  // An observer that still certifies epoch 1 cannot roll the installed epoch back.
  const beforeStale = projectAccountDoc(account);
  const stale = await apply(1, 1);
  expect(stale.ok).toBe(false);
  expect(accountInputFailureMessage(stale)).toContain('ACCOUNT_BOARD_HANKO_REFRESH_BOARD_EPOCH_ORDER_INVALID:1:2');
  expect(projectAccountDoc(account)).toEqual(beforeStale);
});

test('ACK commit retains the counterparty Hanko needed for later board Hanko refresh', async () => {
  const env = createEmptyEnv('board-hanko-refresh-ack-retention');
  const peerSigner = deriveSignerAddressSync('board-hanko-refresh-ack-retention', '1').toLowerCase();
  registerSignerKey(env, peerSigner, deriveSignerKeySync('board-hanko-refresh-ack-retention', '1'));
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

test('board Hanko refresh routing is identical with sparse and populated validator topology', async () => {
  const targetSigner = deriveSignerAddressSync('board-hanko-refresh-topology-target', '1').toLowerCase();
  const targetKey = deriveSignerKeySync('board-hanko-refresh-topology-target', '1');
  const sourceSigner = deriveSignerAddressSync('board-hanko-refresh-topology-source', '1').toLowerCase();
  const targetConfig = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [targetSigner],
    shares: { [targetSigner]: 1n },
  };
  const targetEntityId = generateLazyEntityId([targetSigner], 1n).toLowerCase();
  const sourceEntityId = generateLazyEntityId([sourceSigner], 1n).toLowerCase();
  const frameHash = digest('f1');
  const populated = createEmptyEnv('board-hanko-refresh-topology-populated');
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
  const sparse = createEmptyEnv('board-hanko-refresh-topology-sparse');
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
      boardEpoch: '1',
    },
  } satisfies JurisdictionEvent;

  const populatedDraft = buildBoardRotationHankoRefreshDrafts(structuredClone(state), populated, epochActivation(activation));
  const sparseDraft = buildBoardRotationHankoRefreshDrafts(structuredClone(state), sparse, epochActivation(activation));

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
      boardEpoch: 1,
      reason: 'issued',
      issuedFrameHeight: 4,
      issuedFrameHash: frameHash,
    },
  }]);
});

test('one uncertified Account cannot block BoardActivated Hanko refreshes for certified peers', async () => {
  const env = createEmptyEnv('board-hanko-refresh-missing-bilateral-hanko');
  const sourceEntityId = digest('91');
  const uncertifiedId = digest('90');
  const signerId = deriveSignerAddressSync('board-hanko-refresh-certified-peer', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-hanko-refresh-certified-peer', '1'));
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
  certified.boardHankoRefreshMigration = {
    boardEpoch: 1,
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
      boardEpoch: '1',
    },
  } satisfies JurisdictionEvent;

  const result = buildBoardRotationHankoRefreshDrafts(state, env, epochActivation(activation, 2));
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
        boardEpoch: 2,
        reason: 'bilateral-frame-uncertified',
      },
    },
    {
      counterpartyId: certifiedId,
      marker: {
        boardEpoch: 2,
        reason: 'issued',
        issuedFrameHeight: 2,
        issuedFrameHash: digest('d2'),
      },
    },
  ].sort((left, right) => left.counterpartyId.localeCompare(right.counterpartyId)));
  const candidate = createEntityFrameCandidateState(state);
  applyBoardRotationHankoRefreshMigrations(env, candidate, result.accountMigrations);
  const migratedUncertified = candidate.accounts.get(uncertifiedId)!;
  const migratedCertified = candidate.accounts.get(certifiedId)!;
  expect(migratedUncertified.boardHankoRefreshMigration).toEqual(
    result.accountMigrations.find(update => update.counterpartyId === uncertifiedId)?.marker,
  );
  expect(migratedCertified.boardHankoRefreshMigration).toEqual(
    result.accountMigrations.find(update => update.counterpartyId === certifiedId)?.marker,
  );
  expect(migratedUncertified.currentHeight).toBe(uncertified.currentHeight);
  expect(migratedUncertified.currentFrame).toEqual(uncertified.currentFrame);
  expect(migratedUncertified.state.jNonce).toBe(uncertified.state.jNonce);
  const restored = hydrateAccountDocFromStorage(projectAccountDoc(migratedUncertified));
  expect(restored.boardHankoRefreshMigration).toEqual(migratedUncertified.boardHankoRefreshMigration);
  expect(restored.currentFrame).toEqual(migratedUncertified.currentFrame);
  expect(restored.state.jNonce).toBe(migratedUncertified.state.jNonce);
});

test('partial bilateral dispute evidence never emits a frame-only board Hanko refresh', () => {
  const env = createEmptyEnv('board-hanko-refresh-partial-dispute');
  const sourceEntityId = digest('a4');
  const counterpartyId = digest('a5');
  const signerId = deriveSignerAddressSync('board-hanko-refresh-partial-dispute-peer', '1').toLowerCase();
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
      boardEpoch: '1',
    },
  } satisfies JurisdictionEvent;

  const result = buildBoardRotationHankoRefreshDrafts(state, env, epochActivation(activation));
  expect(result.outputs).toEqual([]);
  expect(result.hashesToSign).toEqual([]);
  expect(result.accountMigrations).toEqual([{
    counterpartyId,
    marker: {
      boardEpoch: 1,
      reason: 'bilateral-dispute-uncertified',
    },
  }]);
});

test('one board Hanko refresh pass emits at most 32 deterministic Accounts', async () => {
  const env = createEmptyEnv('board-hanko-refresh-bounded-pass');
  const sourceEntityId = digest('b4');
  const signerId = deriveSignerAddressSync('board-hanko-refresh-bounded-pass-peer', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-hanko-refresh-bounded-pass-peer', '1'));
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
      boardEpoch: '1',
    },
  } satisfies JurisdictionEvent;

  const result = buildBoardRotationHankoRefreshDrafts(state, env, epochActivation(activation));
  expect(result.outputs).toHaveLength(32);
  expect(result.hashesToSign).toHaveLength(32);
  expect(result.outputs.map(output => output.entityId)).toEqual([...accounts.keys()].sort().slice(0, 32));
});

test('two board rotations in one finalized J range collapse to the latest board Hanko refresh wake', async () => {
  const env = createEmptyEnv('board-hanko-refresh-same-range-rotations');
  const signerId = deriveSignerAddressSync('board-hanko-refresh-same-range-rotations', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('board-hanko-refresh-same-range-rotations', '1'));
  const sourceEntityId = `0x${'0'.repeat(63)}2`;
  const jurisdiction = {
    name: 'board-hanko-refresh-same-range',
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
      boardEpoch: '1',
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
      boardEpoch: '2',
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
  // Two activations in one J range certify epochs 1 then 2; only the latest wakes.
  expect(applied.newState.accounts.get(counterpartyId)?.boardHankoRefreshMigration).toEqual({
    boardEpoch: 2,
    reason: 'pending',
  });
  expect([...(applied.newState.crontabState?.hooks.entries() ?? [])]).toEqual([['board-hanko-refresh', {
    id: 'board-hanko-refresh',
    triggerAt: state.timestamp,
    type: 'board_hanko_refresh',
    data: { boardEpoch: 2, afterCounterpartyId: '' },
  }]]);
});

test('certified counterparty board activation arms an exact 24-hour board Hanko refresh deadline', async () => {
  const env = createEmptyEnv('counterparty-board-hanko-refresh-deadline-event');
  const signerId = deriveSignerAddressSync('counterparty-board-hanko-refresh-deadline-event', '1').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync('counterparty-board-hanko-refresh-deadline-event', '1'));
  const ownerEntityId = digest('81');
  const counterpartyId = `0x${'0'.repeat(63)}2`;
  const jurisdiction = {
    name: 'counterparty-board-hanko-refresh-deadline-event',
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
      boardEpoch: '1',
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

  const hookId = counterpartyBoardHankoRefreshDeadlineHookId(counterpartyId, 1);
  expect(applied.newState.crontabState?.hooks.get(hookId)).toEqual({
    id: hookId,
    triggerAt: state.timestamp + COUNTERPARTY_BOARD_HANKO_REFRESH_DEADLINE_MS,
    type: 'counterparty_board_hanko_refresh_deadline',
    data: { accountId: counterpartyId, boardEpoch: 1 },
  });
  expect(applied.newState.accounts.get(counterpartyId)?.boardHankoRefreshMigration).toBeUndefined();
});

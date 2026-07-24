import { expect, spyOn, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import { addToAccountMempool, proposeAccountFrame } from '../account/consensus';
import { createFrameHash } from '../account/consensus/frame';
import { prependUniqueMempoolTxs } from '../account/consensus/helpers';
import { computeAccountStateRoot, EMPTY_ACCOUNT_STATE_ROOT } from '../account/state-root';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { LIMITS } from '../constants';
import { applyEntityInput } from '../entity/consensus';
import { assertEntityAccountInsertionCapacity } from '../entity/account-capacity';
import { encodeBoard, generateLazyEntityId, hashBoard } from '../entity/factory';
import { isLeftEntity } from '../entity/id';
import { applyAccountInput } from '../entity/tx/handlers/account';
import { handleOpenAccountEntityTx } from '../entity/tx/handlers/open-account';
import { handleRollbackTimedOutFramesEntityTx } from '../entity/tx/handlers/htlc-direct';
import { createEmptyEnv } from '../runtime';
import { hydrateAccountDocFromStorage, hydrateEntityStateFromStorage } from '../storage/hydration';
import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';
import { signEntityHashes } from '../hanko/signing';
import type {
  AccountMachine,
  AccountTx,
  EntityReplica,
  EntityState,
  JurisdictionConfig,
} from '../types';
import { validateAccountMachine, validateEntityState } from '../validation-utils';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;
const watchSeed = `0x${'33'.repeat(32)}`;
const jurisdiction: JurisdictionConfig = {
  name: 'resource-bounds',
  address: 'http://localhost:8545',
  chainId: 31337,
  depositoryAddress: `0x${'44'.repeat(20)}`,
  entityProviderAddress: `0x${'55'.repeat(20)}`,
};

const makeAccount = (mempool: AccountTx[] = []): AccountMachine => ({
  leftEntity: entityId,
  rightEntity: counterpartyId,
  domain: {
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
  },
  watchSeed,
  status: 'active',
  mempool,
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
    deltas: [],
    stateHash: '',
    byLeft: true,
  },
  deltas: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  disputeConfig: { leftDisputeDelay: 576, rightDisputeDelay: 576 },
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  locks: new Map(),
  swapOffers: new Map(),
  pulls: new Map(),
  swapOrderHistory: new Map(),
  swapClosedOrders: new Map(),
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  lastFinalizedJHeight: 0,
  jNonce: 0,
});

const makeState = (): EntityState => ({
  entityId,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: ['signer'],
    shares: { signer: 1n },
    threshold: 1n,
    jurisdiction,
  },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: `0x${'66'.repeat(32)}`,
  entityEncPrivKey: `0x${'77'.repeat(32)}`,
  profile: { name: 'bounds', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
});

const fillAccounts = (state: EntityState, count: number): void => {
  const account = makeAccount();
  for (let index = 0; index < count; index += 1) {
    state.accounts.set(`account-${index}`, account);
  }
};

const memoTx = (index: number): AccountTx => ({
  type: 'add_delta',
  data: { tokenId: index + 1 },
});

test('Entity validation and storage hydration reject more than MAX_ACCOUNTS_PER_ENTITY', () => {
  const state = makeState();
  fillAccounts(state, LIMITS.MAX_ACCOUNTS_PER_ENTITY + 1);
  expect(() => validateEntityState(state, 'oversizedEntity')).toThrow(
    'ENTITY_ACCOUNT_LIMIT_EXCEEDED',
  );

  const core = projectEntityCoreDoc(makeState());
  const accountDoc = projectAccountDoc(makeAccount());
  const storedAccounts = new Map(
    Array.from({ length: LIMITS.MAX_ACCOUNTS_PER_ENTITY + 1 }, (_, index) => [
      `stored-${index}`,
      accountDoc,
    ]),
  );
  expect(() => hydrateEntityStateFromStorage({ core, accounts: storedAccounts, books: new Map() }))
    .toThrow('ENTITY_ACCOUNT_LIMIT_EXCEEDED');
});

test('Entity validation and storage hydration reject an unbounded generic output frontier', () => {
  const sequences = new Map(Array.from(
    { length: LIMITS.MAX_ACCOUNTS_PER_ENTITY + 1 },
    (_, index) => [
      `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`,
      { lastSequence: 1n, lastSemanticHash: `0x${'66'.repeat(32)}` },
    ],
  ));
  const state = { ...makeState(), certifiedOutputSequences: sequences };
  expect(() => validateEntityState(state, 'oversizedOutputFrontier')).toThrow(
    `certifiedOutputSequences exceeds ${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
  );
  expect(() => hydrateEntityStateFromStorage({
    core: { ...projectEntityCoreDoc(makeState()), certifiedOutputSequences: sequences },
    accounts: new Map(),
    books: new Map(),
  })).toThrow('STORAGE_CERTIFIED_OUTPUT_RELATIONSHIP_LIMIT_EXCEEDED');
});

test('account capacity counts only genuinely new normalized keys', () => {
  const accounts = new Map<string, unknown>();
  for (let index = 0; index < LIMITS.MAX_ACCOUNTS_PER_ENTITY; index += 1) {
    accounts.set(`account-${index}`, {});
  }
  accounts.delete('account-0');
  accounts.set(counterpartyId.toUpperCase(), {});

  expect(assertEntityAccountInsertionCapacity(accounts, counterpartyId, 'replacement')).toBe(false);
  expect(() => assertEntityAccountInsertionCapacity(accounts, `0x${'99'.repeat(32)}`, 'new'))
    .toThrow('ENTITY_ACCOUNT_LIMIT_EXCEEDED');
  expect(accounts).toHaveLength(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
});

test('local account opening rejects capacity overflow before cloning or insertion', () => {
  const state = makeState();
  fillAccounts(state, LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  const env = createEmptyEnv('local-account-capacity');
  env.eReplicas.set(`${counterpartyId}:peer`, {
    entityId: counterpartyId,
    signerId: 'peer',
    isProposer: true,
    mempool: [],
    state: { ...makeState(), entityId: counterpartyId },
  } as EntityReplica);

  expect(() => handleOpenAccountEntityTx(env, state, {
    type: 'openAccount',
    data: {
      targetEntityId: counterpartyId,
      watchSeed,
      accountDomain: {
        chainId: jurisdiction.chainId,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
    },
  })).toThrow('ENTITY_ACCOUNT_LIMIT_EXCEEDED');
  expect(state.accounts.size).toBe(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  expect(state.accounts.has(counterpartyId)).toBe(false);
});

test('inbound mirrored-account insertion rejects capacity overflow before state mutation', async () => {
  const state = makeState();
  fillAccounts(state, LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  const env = createEmptyEnv('inbound-account-capacity');
  env.eReplicas.set(`${counterpartyId}:peer`, {
    entityId: counterpartyId,
    signerId: 'peer',
    isProposer: true,
    mempool: [],
    state: { ...makeState(), entityId: counterpartyId },
  } as EntityReplica);

  await expect(applyAccountInput(state, {
    fromEntityId: counterpartyId,
    toEntityId: entityId,
    watchSeed,
  }, env)).rejects.toThrow('ENTITY_ACCOUNT_LIMIT_EXCEEDED');
  expect(state.accounts.size).toBe(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  expect(state.accounts.has(counterpartyId)).toBe(false);
});

test('only an accepted signed genesis can reserve an Account slot', async () => {
  const env = createEmptyEnv('rejected-account-genesis');
  env.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  const sourceSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'source').toLowerCase();
  const targetSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'target').toLowerCase();
  registerSignerKey(env, sourceSignerId, deriveSignerKeySync(env.runtimeSeed!, 'source'));
  registerSignerKey(env, targetSignerId, deriveSignerKeySync(env.runtimeSeed!, 'target'));
  const sourceEntityId = generateLazyEntityId([sourceSignerId], 1n).toLowerCase();
  const targetEntityId = generateLazyEntityId([targetSignerId], 1n).toLowerCase();
  env.jReplicas.set('resource-bounds', {
    name: 'resource-bounds',
    chainId: jurisdiction.chainId,
    rpcs: [],
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: `0x${'66'.repeat(20)}`,
      deltaTransformer: `0x${'77'.repeat(20)}`,
    },
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  });
  const entityState = (id: string, signerId: string): EntityState => ({
    ...makeState(),
    entityId: id,
    config: {
      ...makeState().config,
      validators: [signerId],
      shares: { [signerId]: 1n },
    },
  });
  const sourceState = entityState(sourceEntityId, sourceSignerId);
  const targetState = entityState(targetEntityId, targetSignerId);
  env.eReplicas.set(`${sourceEntityId}:${sourceSignerId}`, {
    entityId: sourceEntityId,
    signerId: sourceSignerId,
    isProposer: true,
    mempool: [],
    state: sourceState,
  });
  env.eReplicas.set(`${targetEntityId}:${targetSignerId}`, {
    entityId: targetEntityId,
    signerId: targetSignerId,
    isProposer: true,
    mempool: [],
    state: targetState,
  });

  const proposer = makeAccount([
    { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } },
  ]);
  proposer.leftEntity = isLeftEntity(sourceEntityId, targetEntityId) ? sourceEntityId : targetEntityId;
  proposer.rightEntity = isLeftEntity(sourceEntityId, targetEntityId) ? targetEntityId : sourceEntityId;
  proposer.currentFrame.byLeft = sourceEntityId === proposer.leftEntity;
  proposer.proofHeader = { fromEntity: sourceEntityId, toEntity: targetEntityId, nextProofNonce: 1 };
  proposer.currentFrame.accountStateRoot = computeAccountStateRoot(proposer);
  proposer.currentFrame.stateHash = proposer.currentFrame.accountStateRoot;

  const proposed = await proposeAccountFrame(env, proposer, env.timestamp, 0);
  if (!proposed.success || !proposed.accountInput?.proposal) {
    throw new Error(proposed.error || 'TEST_ACCOUNT_GENESIS_PROPOSAL_REQUIRED');
  }
  const invalidInput = structuredClone(proposed.accountInput);
  invalidInput.proposal.frame.accountStateRoot = `0x${'99'.repeat(32)}`;
  invalidInput.proposal.frame.stateHash = await createFrameHash(invalidInput.proposal.frame);
  const [frameHanko] = await signEntityHashes(
    env,
    sourceEntityId,
    sourceSignerId,
    [invalidInput.proposal.frame.stateHash],
  );
  invalidInput.proposal.frameHanko = frameHanko!;

  await applyAccountInput(targetState, invalidInput, env).catch(() => undefined);
  expect(targetState.accounts.has(sourceEntityId)).toBe(false);
  expect(targetState.accounts.size).toBe(0);

  await applyAccountInput(targetState, proposed.accountInput, env);
  expect(targetState.accounts.get(sourceEntityId)?.currentHeight).toBe(1);
  expect(targetState.accounts.size).toBe(1);
});

test('Account validation and storage hydration reject an undrainable mempool', () => {
  const account = makeAccount(
    Array.from({ length: LIMITS.ACCOUNT_MEMPOOL_SIZE + 1 }, (_, index) => memoTx(index)),
  );
  expect(() => validateAccountMachine(account, 'oversizedAccount')).toThrow(
    'ACCOUNT_MEMPOOL_LIMIT_EXCEEDED',
  );
  expect(() => hydrateAccountDocFromStorage(projectAccountDoc(account))).toThrow(
    'ACCOUNT_MEMPOOL_LIMIT_EXCEEDED',
  );
});

test('single and batch Account mempool enqueue reject atomically at the shared cap', () => {
  const full = makeAccount(
    Array.from({ length: LIMITS.ACCOUNT_MEMPOOL_SIZE }, (_, index) => memoTx(index)),
  );
  expect(() => addToAccountMempool(full, memoTx(20_000))).toThrow(
    'ACCOUNT_MEMPOOL_LIMIT_EXCEEDED',
  );
  expect(full.mempool).toHaveLength(LIMITS.ACCOUNT_MEMPOOL_SIZE);

  const nearlyFull = makeAccount(
    Array.from({ length: LIMITS.ACCOUNT_MEMPOOL_SIZE - 1 }, (_, index) => memoTx(index)),
  );
  const before = [...nearlyFull.mempool];
  expect(() => prependUniqueMempoolTxs(nearlyFull, [memoTx(30_000), memoTx(30_001)]))
    .toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
  expect(nearlyFull.mempool).toEqual(before);
});

test('timed-out frame rollback cannot partially restore an over-cap transaction batch', () => {
  const state = makeState();
  const account = makeAccount(
    Array.from({ length: LIMITS.ACCOUNT_MEMPOOL_SIZE - 1 }, (_, index) => memoTx(index)),
  );
  const pendingFrame = {
    height: 7,
    timestamp: 1_000,
    jHeight: 0,
    accountTxs: [memoTx(20_000), memoTx(20_001)],
    prevFrameHash: EMPTY_ACCOUNT_STATE_ROOT,
    accountStateRoot: EMPTY_ACCOUNT_STATE_ROOT,
    deltas: [],
    stateHash: EMPTY_ACCOUNT_STATE_ROOT,
    byLeft: true,
  };
  account.pendingFrame = pendingFrame;
  account.pendingAccountInput = {
    kind: 'frame',
    fromEntityId: entityId,
    toEntityId: counterpartyId,
    domain: structuredClone(account.domain),
    proposal: { frame: structuredClone(pendingFrame) },
  };
  account.pendingAccountInputSignerId = 'fixture-counterparty-signer';
  state.accounts.set(counterpartyId, account);

  expect(() => handleRollbackTimedOutFramesEntityTx(state, {
    type: 'rollbackTimedOutFrames',
    data: { timedOutAccounts: [{ counterpartyId, frameHeight: 7 }] },
  })).toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
  expect(account.mempool).toHaveLength(LIMITS.ACCOUNT_MEMPOOL_SIZE - 1);
  expect(account.pendingFrame?.height).toBe(7);
});

test('every committed Entity transition emits a size measurement without consumption changes', async () => {
  const env = createEmptyEnv('entity-size-every-commit');
  env.timestamp = 2_000;
  env.scenarioMode = true;
  const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'validator').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, 'validator'));
  const state = makeState();
  state.config = {
    ...state.config,
    validators: [signerId],
    shares: { [signerId]: 1n },
  };
  state.entityId = hashBoard(encodeBoard(state.config)).toLowerCase();
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId,
    state,
    mempool: [],
    isProposer: true,
  };
  env.eReplicas.set(`${state.entityId}:${signerId}`, replica);
  const previousLevel = process.env['XLN_LOG_LEVEL'];
  const previousScopes = process.env['XLN_LOG_SCOPES'];
  process.env['XLN_LOG_LEVEL'] = 'debug';
  process.env['XLN_LOG_SCOPES'] = 'entity';
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const result = await applyEntityInput(env, replica, {
      entityId: state.entityId,
      signerId,
      entityTxs: [{ type: 'chat', data: { from: signerId, message: 'measure me' } }],
    });
    expect(result.outcome.kind).toBe('committed');
    expect(log.mock.calls.flat().some((entry) => String(entry).includes('state.size'))).toBe(true);
  } finally {
    log.mockRestore();
    if (previousLevel === undefined) delete process.env['XLN_LOG_LEVEL'];
    else process.env['XLN_LOG_LEVEL'] = previousLevel;
    if (previousScopes === undefined) delete process.env['XLN_LOG_SCOPES'];
    else process.env['XLN_LOG_SCOPES'] = previousScopes;
  }
});

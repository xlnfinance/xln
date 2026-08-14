import { expect, spyOn, test } from 'bun:test';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus';
import { createFrameHash } from '../../../account/consensus/frame/hash';
import { prependUniqueMempoolTxs } from '../../../account/consensus/helpers';
import { createLocalAccountInput } from '../../../account/input';
import { computeAccountStateRoot, EMPTY_ACCOUNT_STATE_ROOT } from '../../../account/commitment/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { LIMITS } from '../../../config/constants';
import { createOrderbookExtState, DEFAULT_SPREAD_DISTRIBUTION } from '../../../orderbook';
import { applyEntityInput } from '../../../entity/consensus';
import { assertEntityAccountInsertionCapacity } from '../../../entity/account/account-capacity';
import { encodeBoard, generateLazyEntityId, hashBoard } from '../../../entity/factory';
import { provisionTestEntityEncryptionKey } from '../../helpers/cross-j';
import { isLeftEntity } from '../../../entity/id';
import { applyAccountInputToEntity } from '../../../entity/tx/handlers/account/index';
import { handleOpenAccountEntityTx } from '../../../entity/tx/handlers/account/lifecycle/open-account';
import { applyAccountSettledJEvent } from '../../../entity/tx/j-events-account-settled';
import { createEmptyEnv } from '../../../runtime';
import { hydrateAccountDocFromStorage, hydrateEntityStateFromStorage } from '../../../storage/read/hydration';
import { projectAccountDoc, projectEntityCoreDoc } from '../../../storage/read/projections';
import { validateStorageEntityCoreDocValue } from '../../../storage/schema/authoritative-schema';
import { signEntityHashes } from '../../../hanko/signing';
import type { AccountReplica, AccountTx } from '../../../types/account';
import type { EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { validateAccountReplica } from '../../../account/validation/state-validation';
import { validateEntityState } from '../../../entity/state/state-validation';
import { sealAccountDraftAsEntity } from '../../helpers/account-draft';
import {
  isProposedAccountFrame,
  proposeAccountFrameMessage,
} from '../../../account/consensus/result';

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

const makeAccount = (mempool: AccountTx[] = []): AccountReplica => ({
  state: {
    leftEntity: entityId,
    rightEntity: counterpartyId,
    domain: {
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    },
    watchSeed,
    deltas: new Map(),
    disputeConfig: { leftResponseSeconds: 576, rightResponseSeconds: 576 },
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    pulls: new Map(),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    jNonce: 0,
  },
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
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 1 },
  proofBody: { tokenIds: [], deltas: [] },
  pendingWithdrawals: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  swapOrderHistory: new Map(),
  swapClosedOrders: new Map(),
});

const makeState = (): EntityState => ({
  entityId,
  entityEncryptionPublicKey: `0x${'66'.repeat(32)}`,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
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
  profile: { name: 'bounds', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
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

test('storage hydration rejects an orderbook projection without its exact hub policy', () => {
  const core = {
    ...projectEntityCoreDoc(makeState()),
    orderbookReferrals: new Map(),
  };
  expect(() => hydrateEntityStateFromStorage({ core, accounts: new Map(), books: new Map() }))
    .toThrow(`STORAGE_ORDERBOOK_HUBPROFILE_MISSING:${entityId}`);
});

test('storage boundary rejects malformed committed orderbook pair dimensions', () => {
  const state = makeState();
  state.orderbookExt = createOrderbookExtState({
    entityId,
    name: 'bounds-hub',
    spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
    referenceTokenId: 1,
    usdQuoteAuthorityEntityId: entityId,
    minTradeSize: 1n,
    supportedPairs: ['1/2'],
  });
  state.orderbookExt.pairDimensions.set('1/2', {
    baseTokenDecimals: 18,
    quoteTokenDecimals: 6,
  });
  const core = projectEntityCoreDoc(state);
  expect(validateStorageEntityCoreDocValue(core).orderbookPairDimensions?.get('1/2'))
    .toEqual({ baseTokenDecimals: 18, quoteTokenDecimals: 6 });

  core.orderbookPairDimensions?.set('1/2', {
    baseTokenDecimals: 256,
    quoteTokenDecimals: 6,
  });
  expect(() => validateStorageEntityCoreDocValue(core))
    .toThrow('STORAGE_ENTITY_DOC_INVALID_ORDERBOOK_PAIR_DIMENSIONS_baseTokenDecimals');
});

test('account capacity uses the canonical counterparty key directly', () => {
  const accounts = new Map<string, unknown>();
  for (let index = 0; index < LIMITS.MAX_ACCOUNTS_PER_ENTITY; index += 1) {
    accounts.set(`account-${index}`, {});
  }
  accounts.delete('account-0');
  accounts.set(counterpartyId, {});

  expect(assertEntityAccountInsertionCapacity(accounts, counterpartyId, 'replacement')).toBe(false);
  expect(() => assertEntityAccountInsertionCapacity(accounts, `0x${'99'.repeat(32)}`, 'new'))
    .toThrow('ENTITY_ACCOUNT_LIMIT_EXCEEDED');
  expect(accounts).toHaveLength(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
});

test('local account opening rejects capacity overflow before cloning or insertion', () => {
  const state = makeState();
  fillAccounts(state, LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  const env = createEmptyEnv('local-account-capacity');
  env.state.eReplicas.set(`${counterpartyId}:peer`, {
    entityId: counterpartyId,
    signerId: 'peer',
    entityEncPubKey: '',
    isProposer: true,
    mempool: [],
    state: { ...makeState(), entityId: counterpartyId },
  } as EntityReplica);

  expect(() => handleOpenAccountEntityTx(state, {
    type: 'openAccount',
    data: {
      targetEntityId: counterpartyId,
      watchSeed,
      accountDomain: {
        chainId: jurisdiction.chainId,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    },
  }, createAccountConsensusContext(env))).toThrow('ENTITY_ACCOUNT_LIMIT_EXCEEDED');
  expect(state.accounts.size).toBe(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  expect(state.accounts.has(counterpartyId)).toBe(false);
});

test('ordinary openAccount cannot replace a permanently disputed Account', async () => {
  const state = makeState();
  const finalized = makeAccount();
  finalized.status = 'disputed';
  delete finalized.activeDispute;
  state.accounts.set(counterpartyId, finalized);
  const env = createEmptyEnv('closed-account-open-rejected');
  env.state.eReplicas.set(`${counterpartyId}:peer`, {
    entityId: counterpartyId,
    signerId: 'peer',
    entityEncPubKey: '',
    isProposer: true,
    mempool: [],
    state: { ...makeState(), entityId: counterpartyId },
  } as EntityReplica);

  await expect(handleOpenAccountEntityTx(state, {
    type: 'openAccount',
    data: {
      targetEntityId: counterpartyId,
      watchSeed,
      accountDomain: {
        chainId: jurisdiction.chainId,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    },
  }, createAccountConsensusContext(env))).rejects.toThrow('OPEN_ACCOUNT_ALREADY_EXISTS');
  expect(state.accounts.get(counterpartyId)).toBe(finalized);
  expect(finalized.status).toBe('disputed');
});

test('settlements update Entity reserve without filling a permanently closed Account', () => {
  const state = makeState();
  const finalized = makeAccount();
  finalized.status = 'disputed';
  delete finalized.activeDispute;
  state.accounts.set(counterpartyId, finalized);
  const env = createEmptyEnv('closed-account-settlement-drain');
  const accountTxs: Array<{ accountId: string; tx: AccountTx }> = [];
  const dirtyAccounts = new Set<string>();

  for (let index = 0; index < LIMITS.ACCOUNT_MEMPOOL_SIZE + 5; index += 1) {
    const reserve = BigInt(index + 1);
    const event: JurisdictionEvent = {
      blockNumber: index + 1,
      blockHash: `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`,
      transactionHash: `0x${BigInt(index + 2).toString(16).padStart(64, '0')}`,
      logIndex: 0,
      type: 'AccountSettled',
      data: {
        leftEntity: entityId,
        rightEntity: counterpartyId,
        tokenId: 1,
        leftReserve: reserve,
        rightReserve: 0n,
        collateral: reserve,
        ondelta: 0n,
        nonce: index + 1,
      },
    };
    applyAccountSettledJEvent({
      entityState: state,
      newState: state,
      event,
      env,
      accountConsensusContext: createAccountConsensusContext(env),
      blockNumber: index + 1,
      transactionHash: event.transactionHash,
      accountTxs,
      outputs: [],
      dirtyAccounts,
    }, []);
  }

  expect(state.reserves.get(1)).toBe(BigInt(LIMITS.ACCOUNT_MEMPOOL_SIZE + 5));
  expect(accountTxs).toEqual([]);
  expect(dirtyAccounts.size).toBe(0);
  expect(finalized.mempool).toEqual([]);
});

test('inbound peer capacity overflow is a deterministic no-op', async () => {
  const state = makeState();
  fillAccounts(state, LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  const env = createEmptyEnv('inbound-account-capacity');
  env.state.eReplicas.set(`${counterpartyId}:peer`, {
    entityId: counterpartyId,
    signerId: 'peer',
    entityEncPubKey: '',
    isProposer: true,
    mempool: [],
    state: { ...makeState(), entityId: counterpartyId },
  } as EntityReplica);

  await applyAccountInputToEntity(state, {
    kind: 'frame',
    fromEntityId: counterpartyId,
    toEntityId: entityId,
    domain: {
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    },
    watchSeed,
    proposal: {
      frame: {
        height: 1,
        timestamp: state.timestamp,
        jHeight: 0,
        accountTxs: [],
        prevFrameHash: 'genesis',
        accountStateRoot: `0x${'66'.repeat(32)}`,
        stateHash: `0x${'77'.repeat(32)}`,
        byLeft: false,
        deltas: [],
      },
      frameHanko: `0x${'88'.repeat(65)}`,
    },
  }, env, createAccountConsensusContext(env));
  expect(state.accounts.size).toBe(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  expect(state.accounts.has(counterpartyId)).toBe(false);
});

test('only an accepted signed genesis can reserve an Account slot', async () => {
  const env = createEmptyEnv('rejected-account-genesis');
  env.state.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  const sourceSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'source').toLowerCase();
  const targetSignerId = deriveSignerAddressSync(env.runtimeSeed!, 'target').toLowerCase();
  registerSignerKey(env, sourceSignerId, deriveSignerKeySync(env.runtimeSeed!, 'source'));
  registerSignerKey(env, targetSignerId, deriveSignerKeySync(env.runtimeSeed!, 'target'));
  const sourceEntityId = generateLazyEntityId([sourceSignerId], 1n).toLowerCase();
  const targetEntityId = generateLazyEntityId([targetSignerId], 1n).toLowerCase();
  env.state.jReplicas.set('resource-bounds', {
    name: 'resource-bounds',
    chainId: jurisdiction.chainId,
    rpcs: [],
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
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
  env.state.eReplicas.set(`${sourceEntityId}:${sourceSignerId}`, {
    entityId: sourceEntityId,
    signerId: sourceSignerId,
    entityEncPubKey: '',
    isProposer: true,
    mempool: [],
    state: sourceState,
  });
  env.state.eReplicas.set(`${targetEntityId}:${targetSignerId}`, {
    entityId: targetEntityId,
    signerId: targetSignerId,
    entityEncPubKey: '',
    isProposer: true,
    mempool: [],
    state: targetState,
  });

  const proposer = makeAccount([
    { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } },
  ]);
  proposer.state.leftEntity = isLeftEntity(sourceEntityId, targetEntityId) ? sourceEntityId : targetEntityId;
  proposer.state.rightEntity = isLeftEntity(sourceEntityId, targetEntityId) ? targetEntityId : sourceEntityId;
  proposer.currentFrame.byLeft = sourceEntityId === proposer.state.leftEntity;
  proposer.proofHeader = { fromEntity: sourceEntityId, toEntity: targetEntityId, nextProofNonce: 1 };
  proposer.currentFrame.accountStateRoot = computeAccountStateRoot(proposer.state);
  proposer.currentFrame.stateHash = proposer.currentFrame.accountStateRoot;

  const proposed = await proposeAccountFrame(createAccountConsensusContext(env), proposer, env.state.timestamp, 0);
  if (!isProposedAccountFrame(proposed) || !proposed.accountInput.proposal) {
    throw new Error(proposeAccountFrameMessage(proposed) || 'TEST_ACCOUNT_GENESIS_PROPOSAL_REQUIRED');
  }
  const sealedProposal = await sealAccountDraftAsEntity(
    env,
    sourceEntityId,
    sourceSignerId,
    proposed,
  );
  const invalidInput = structuredClone(sealedProposal);
  invalidInput.proposal.frame.accountStateRoot = `0x${'99'.repeat(32)}`;
  invalidInput.proposal.frame.stateHash = await createFrameHash(invalidInput.proposal.frame);
  const [frameHanko] = await signEntityHashes(
    env,
    sourceEntityId,
    sourceSignerId,
    [invalidInput.proposal.frame.stateHash],
  );
  invalidInput.proposal.frameHanko = frameHanko!;

  const accountConsensusContext = createAccountConsensusContext(env);
  await applyAccountInputToEntity(
    targetState,
    invalidInput,
    env,
    accountConsensusContext,
  ).catch(() => undefined);
  expect(targetState.accounts.has(sourceEntityId)).toBe(false);
  expect(targetState.accounts.size).toBe(0);

  await applyAccountInputToEntity(
    targetState,
    sealedProposal,
    env,
    accountConsensusContext,
  );
  expect(targetState.accounts.get(sourceEntityId)?.currentHeight).toBe(1);
  expect(targetState.accounts.size).toBe(1);
});

test('Account validation and storage hydration reject an undrainable mempool', () => {
  const account = makeAccount(
    Array.from({ length: LIMITS.ACCOUNT_MEMPOOL_SIZE + 1 }, (_, index) => memoTx(index)),
  );
  expect(() => validateAccountReplica(account, 'oversizedAccount')).toThrow(
    'ACCOUNT_MEMPOOL_LIMIT_EXCEEDED',
  );
  expect(() => hydrateAccountDocFromStorage(projectAccountDoc(account))).toThrow(
    'ACCOUNT_MEMPOOL_LIMIT_EXCEEDED',
  );
});

test('Account state decoding never repairs missing or malformed replica fields', () => {
  const missingSignatures = makeAccount();
  delete (missingSignatures as Partial<typeof missingSignatures>).pendingSignatures;
  expect(() => validateAccountReplica(missingSignatures, 'missingSignatures'))
    .toThrow('missingSignatures.pendingSignatures');

  const malformedTx = makeAccount([{
    type: 'direct_payment',
    data: { tokenId: 1, amount: 1n, extra: true },
  } as AccountTx]);
  expect(() => validateAccountReplica(malformedTx, 'malformedTx'))
    .toThrow('malformedTx.mempool_0_DATA_FIELDS');

  const fractionalHeight = makeAccount();
  fractionalHeight.currentHeight = 1.5;
  expect(() => validateAccountReplica(fractionalHeight, 'fractionalHeight'))
    .toThrow('fractionalHeight.currentHeight');
});

test('single and batch Account mempool enqueue reject atomically at the shared cap', async () => {
  const full = makeAccount(
    Array.from({ length: LIMITS.ACCOUNT_MEMPOOL_SIZE }, (_, index) => memoTx(index)),
  );
  const env = createEmptyEnv('account-resource-bounds');
  await expect(applyAccountInput(
    createAccountConsensusContext(env),
    full,
    createLocalAccountInput(full.state, entityId, [memoTx(20_000)]),
  )).rejects.toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
  expect(full.mempool).toHaveLength(LIMITS.ACCOUNT_MEMPOOL_SIZE);

  const nearlyFull = makeAccount(
    Array.from({ length: LIMITS.ACCOUNT_MEMPOOL_SIZE - 1 }, (_, index) => memoTx(index)),
  );
  const before = [...nearlyFull.mempool];
  expect(() => prependUniqueMempoolTxs(nearlyFull, [memoTx(30_000), memoTx(30_001)]))
    .toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
  expect(nearlyFull.mempool).toEqual(before);
});

test('every committed Entity transition emits a size measurement without consumption changes', async () => {
  const env = createEmptyEnv('entity-size-every-commit');
  env.state.timestamp = 2_000;
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
  state.entityEncryptionPublicKey = provisionTestEntityEncryptionKey(env, state.entityId);
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId,
    state,
    mempool: [],
    isProposer: true,
  };
  env.state.eReplicas.set(`${state.entityId}:${signerId}`, replica);
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

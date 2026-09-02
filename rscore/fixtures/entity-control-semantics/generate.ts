/** TypeScript production-reducer oracle for Entity control/governance semantics. */
import { createHash } from 'node:crypto';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../core/account/crypto';
import { computeEntityAccountValueHash, computeEntityConsensusSectionDigestsCold, computeCanonicalEntityConsensusStateHashCold } from '../../../core/entity/consensus/state-root';
import { readEntityFrameEvents, clearEntityFrameEvents } from '../../../core/entity/frame-events';
import { initCrontab } from '../../../core/entity/scheduler';
import { PersistentEntityAccountMap } from '../../../core/entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../../core/entity/state/persistent-collection-map';
import { applyEntityTx } from '../../../core/entity/tx/apply';
import type { EntityRuntimeContext } from '../../../core/entity/runtime-context';
import type { ConsensusConfig, EntityState } from '../../../core/entity/types';
import type { EntityTx } from '../../../core/types/entity-tx';
import { safeStringify } from '../../../core/protocol/serialization';
import { encodeCanonicalConsensusBytes } from '../../../core/protocol/serialization/binary-codec';
import { hashBoard, encodeBoard } from '../../../core/entity/factory';
import { buildSignedEntityCommand, assertSignedEntityCommand, advanceEntityCommandNonce } from '../../../core/entity/command';
import { createEmptyEnv } from '../../../core/runtime';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from '../../../core/jurisdiction/machine/board-registry';
import type { RuntimeReplica } from '../../../core/runtime/types';

const ENTITY = `0x${'11'.repeat(32)}`;
const QUOTE = `0x${'22'.repeat(32)}`;
const JURISDICTION = {
  name: 'EntityControlFixture',
  address: 'rpc://entity-control-fixture',
  chainId: 31_337,
  blockTimeMs: 1_000,
  depositoryAddress: `0x${'88'.repeat(20)}`,
  entityProviderAddress: `0x${'99'.repeat(20)}`,
};

const digest = (value: unknown): string =>
  `0x${createHash('sha256').update(encodeCanonicalConsensusBytes(value)).digest('hex')}`;

const env = (config?: ConsensusConfig): EntityRuntimeContext => {
  const runtimeSeed = 'entity-control-semantic-fixture';
  const context: EntityRuntimeContext = {
    state: { eReplicas: new Map(), jReplicas: new Map(), height: 0, timestamp: 2_000 },
    runtimeSeed,
    activeJurisdiction: JURISDICTION.name,
    infrastructure: { certifiedBoardNodes: new Map() },
    error: () => undefined,
    info: () => undefined,
  };
  context.state.jReplicas.set(JURISDICTION.name, {
    name: JURISDICTION.name,
    chainId: JURISDICTION.chainId,
    rpcs: [JURISDICTION.address],
    contracts: {
      depository: JURISDICTION.depositoryAddress,
      entityProvider: JURISDICTION.entityProviderAddress,
    },
    blockTimeMs: JURISDICTION.blockTimeMs,
  } as never);
  for (const signer of config?.validators ?? []) {
    if (!/^0x[0-9a-f]{40}$/.test(signer)) continue;
    const label = signer === config?.validators[0] ? 'alice' : 'bob';
    registerSignerKey(context, signer, deriveSignerKeySync(runtimeSeed, label));
  }
  return context;
};

const baseState = (config?: ConsensusConfig): EntityState => ({
  entityId: ENTITY,
  entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
  height: 0,
  timestamp: 2_000,
  nonces: new Map(),
  proposals: new Map(),
  config: config ?? {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [ENTITY],
    shares: { [ENTITY]: 1n },
    jurisdiction: JURISDICTION,
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(ENTITY, computeEntityAccountValueHash),
  lastFinalizedJHeight: 0,
  profile: { name: 'entity-kernel-fixture', isHub: true, avatar: '', bio: '', website: '' },
  paybook: { entries: PersistentEntityCollectionMap.empty('paybookHashlock'), feesEarned: 0n },
  crontabState: initCrontab(),
  hubRebalanceConfig: {
    matchingStrategy: 'amount',
    policyVersion: 1,
    routingFeePPM: 1,
    baseFee: 0n,
    swapTakerFeeBps: 1,
    rebalanceLiquidityFeeBps: 1n,
  },
});

const projectState = (state: EntityState) => ({
  root: computeCanonicalEntityConsensusStateHashCold(state),
  sections: computeEntityConsensusSectionDigestsCold(state),
});

const changedSections = (
  before: ReturnType<typeof projectState>,
  after: ReturnType<typeof projectState>,
): string[] => {
  const beforeByField = new Map(before.sections.map(({ field, digest }) => [field, digest]));
  return after.sections
    .filter(({ field, digest }) => beforeByField.get(field) !== digest)
    .map(({ field }) => field);
};

const setup = (state: EntityState) => ({
  entityId: state.entityId,
  config: state.config,
  timestamp: state.timestamp,
});

const canonicalJson = (value: unknown): unknown => JSON.parse(safeStringify(value));

const applyCase = async (
  name: string,
  tx: EntityTx,
  state = baseState(),
  context = env(state.config),
  options: Parameters<typeof applyEntityTx>[3] = { mutableFrameState: true },
) => {
  clearEntityFrameEvents(state);
  const before = projectState(state);
  const stateSetup = setup(state);
  const result = await applyEntityTx(context, state, tx, options);
  const after = projectState(result.newState);
  const evidence = {
    events: readEntityFrameEvents(result.newState),
    outputs: result.outputs,
    jOutputs: result.jOutputs ?? [],
    hashesToSign: result.hashesToSign ?? [],
    candidateEffects: result.candidateEffects,
    approvedEntityTxs: result.approvedEntityTxs ?? [],
  };
  return canonicalJson({
    name,
    tx,
    setup: stateSetup,
    before,
    after,
    changedSections: changedSections(before, after),
    evidence,
    evidenceDigest: digest(evidence),
  });
};

const simpleCases = async () => Promise.all([
  applyCase('chat', { type: 'chat', data: { from: ' Alice ', message: 'hello' } }),
  applyCase('chatMessage', { type: 'chatMessage', data: { message: 'ready', timestamp: 2_000 } }),
  applyCase('profile-update', { type: 'profile-update', data: { profile: {
    entityId: ENTITY, name: '  Example  ', entityKind: 'company', sectors: ['finance'],
    avatar: 'avatar', bio: 'bio', website: 'https://example.test',
  } } }),
  applyCase('initOrderbookExt', { type: 'initOrderbookExt', data: {
    name: 'H1',
    spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
    referenceTokenId: 1,
    usdQuoteAuthorityEntityId: QUOTE,
    minTradeSize: 10n,
    supportedPairs: ['1/2'],
  } }),
  applyCase('setHubConfig', { type: 'setHubConfig', data: {
    hubName: 'H1', matchingStrategy: 'fee', policyVersion: 2, routingFeePPM: 7,
    baseFee: 3n, swapTakerFeeBps: 9, disputeAutoFinalizeMode: 'ignore',
    minCollateralThreshold: 11n, rebalanceLiquidityFeeBps: 13n, rebalanceTimeoutMs: 17_000,
  } }),
  applyCase('mintReserves', { type: 'mintReserves', data: { tokenId: 7, amount: 19n } }),
]);

const proposalCases = async () => {
  const runtimeSeed = 'entity-control-semantic-fixture';
  const alice = deriveSignerAddressSync(runtimeSeed, 'alice').toLowerCase();
  const bob = deriveSignerAddressSync(runtimeSeed, 'bob').toLowerCase();
  const config: ConsensusConfig = {
    mode: 'proposer-based', threshold: 2n, validators: [alice, bob], shares: { [alice]: 1n, [bob]: 1n },
  };
  const makeState = () => {
    const state = baseState(config);
    state.entityId = hashBoard(encodeBoard(config));
    state.accounts = PersistentEntityAccountMap.empty(state.entityId, computeEntityAccountValueHash);
    return state;
  };
  const context = env(config);
  const propose: EntityTx = { type: 'propose', data: {
    proposer: alice,
    action: { type: 'collective_message', data: { message: 'ship' } },
  } };
  const proposed = await applyCase('propose', propose, makeState(), context);
  const applied = await applyEntityTx(context, makeState(), propose, { mutableFrameState: true });
  const proposalId = [...applied.newState.proposals.keys()][0];
  if (!proposalId) throw new Error('ENTITY_CONTROL_FIXTURE_PROPOSAL_MISSING');
  const voted = await applyCase('vote', {
    type: 'vote', data: { proposalId, voter: bob, choice: 'yes', comment: 'ok' },
  }, applied.newState, context);
  return [proposed, voted];
};

const entityCommandCase = async () => {
  const runtimeSeed = 'entity-control-semantic-fixture';
  const signer = deriveSignerAddressSync(runtimeSeed, 'alice').toLowerCase();
  const config: ConsensusConfig = {
    mode: 'proposer-based', threshold: 1n, validators: [signer], shares: { [signer]: 1n },
  };
  const state = baseState(config);
  state.entityId = hashBoard(encodeBoard(config));
  state.accounts = PersistentEntityAccountMap.empty(state.entityId, computeEntityAccountValueHash);
  const context = env(config);
  const inner: EntityTx = { type: 'chat', data: { from: signer, message: 'signed' } };
  const command = buildSignedEntityCommand(context, state, signer, [inner]);
  const before = projectState(state);
  const authorized = assertSignedEntityCommand(context, state, command);
  const applied = await applyEntityTx(context, state, authorized.txs[0]!, { mutableFrameState: true });
  const afterState = advanceEntityCommandNonce(applied.newState, authorized);
  const evidence = { events: readEntityFrameEvents(afterState), commandHash: command.txsHash };
  return canonicalJson({
    name: 'entityCommand', tx: { type: 'entityCommand', data: command }, setup: setup(state), before,
    after: projectState(afterState), changedSections: changedSections(before, projectState(afterState)),
    evidence, evidenceDigest: digest(evidence),
  });
};

const numberedEntityId = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;
const blockHash = (byte: string): string => `0x${byte.repeat(32)}`;

const applyBoardEvent = (
  context: RuntimeReplica,
  state: EntityState,
  event: Parameters<typeof applyCertifiedBoardRegistryEvent>[3],
) => {
  const applied = applyCertifiedBoardRegistryEvent(
    state.certifiedBoardState,
    getCertifiedBoardNodeStore(context),
    JURISDICTION,
    event,
  );
  cacheCertifiedBoardNodes(context, applied.newNodes);
  state.certifiedBoardState = applied.state;
};

const providerSetup = (label: string) => {
  const context = createEmptyEnv(`entity-control-provider:${label}`);
  context.state.timestamp = 2_000;
  context.activeJurisdiction = JURISDICTION.name;
  const signer = deriveSignerAddressSync(context.runtimeSeed!, 'validator').toLowerCase();
  registerSignerKey(context, signer, deriveSignerKeySync(context.runtimeSeed!, 'validator'));
  context.runtimeId = signer;
  const config: ConsensusConfig = {
    mode: 'proposer-based', threshold: 1n, validators: [signer], shares: { [signer]: 1n },
    jurisdiction: JURISDICTION,
  };
  const state = baseState(config);
  state.entityId = numberedEntityId(2n);
  state.accounts = PersistentEntityAccountMap.empty(state.entityId, computeEntityAccountValueHash);
  const boardHash = hashBoard(encodeBoard(config, context));
  applyBoardEvent(context, state, {
    type: 'FoundationBootstrapped',
    data: { recipient: signer, boardHash, controlTokenId: '2', dividendTokenId: '3' },
    blockNumber: 1, blockHash: blockHash('11'), transactionHash: blockHash('21'), logIndex: 0,
  });
  applyBoardEvent(context, state, {
    type: 'EntityRegistered',
    data: { entityId: state.entityId, entityNumber: '2', boardHash },
    blockNumber: 2, blockHash: blockHash('12'), transactionHash: blockHash('22'), logIndex: 0,
  });
  context.state.jReplicas.set(JURISDICTION.name, {
    name: JURISDICTION.name,
    chainId: JURISDICTION.chainId,
    contracts: { depository: JURISDICTION.depositoryAddress, entityProvider: JURISDICTION.entityProviderAddress },
  } as never);
  return { context, state, signer };
};

const installProviderTarget = (fixture: ReturnType<typeof providerSetup>) => {
  const targetEntityId = numberedEntityId(3n);
  const initialBoardHash = hashBoard(encodeBoard(fixture.state.config, fixture.context));
  applyBoardEvent(fixture.context, fixture.state, {
    type: 'EntityRegistered',
    data: { entityId: targetEntityId, entityNumber: '3', boardHash: initialBoardHash },
    blockNumber: 3, blockHash: blockHash('13'), transactionHash: blockHash('23'), logIndex: 0,
  });
  applyBoardEvent(fixture.context, fixture.state, {
    type: 'BoardActivated',
    data: { entityId: targetEntityId, previousBoardHash: initialBoardHash,
      newBoardHash: blockHash('55'), previousBoardValidUntil: '1700604800' },
    blockNumber: 4, blockHash: blockHash('14'), transactionHash: blockHash('24'), logIndex: 0,
  });
  return targetEntityId;
};

const providerCases = async () => {
  const transfer = providerSetup('transfer');
  const release = providerSetup('release');
  const cancel = providerSetup('cancel');
  const pending = await applyEntityTx(cancel.context, cancel.state, {
    type: 'entityProviderTransfer', data: { to: `0x${'b1'.repeat(20)}`, tokenId: 7n, amount: 11n },
  }, { mutableFrameState: true });
  const pendingHash = pending.newState.entityProviderActionState?.pending?.actionHash;
  if (!pendingHash) throw new Error('ENTITY_CONTROL_FIXTURE_PENDING_ACTION_MISSING');
  const propose = providerSetup('propose-board');
  const proposeTarget = installProviderTarget(propose);
  const activate = providerSetup('activate-board');
  const activateTarget = installProviderTarget(activate);
  return Promise.all([
    applyCase('entityProviderTransfer', {
      type: 'entityProviderTransfer', data: { to: `0x${'b1'.repeat(20)}`, tokenId: 7n, amount: 11n },
    }, transfer.state, transfer.context),
    applyCase('entityProviderReleaseControlShares', {
      type: 'entityProviderReleaseControlShares', data: {
        recipientAddress: `0x${'b2'.repeat(20)}`, controlAmount: 5n, dividendAmount: 7n, purpose: 'fixture',
      },
    }, release.state, release.context),
    applyCase('entityProviderCancelAction', {
      type: 'entityProviderCancelAction', data: { actionHash: pendingHash },
    }, pending.newState, cancel.context),
    applyCase('entityProviderProposeControlBoard', {
      type: 'entityProviderProposeControlBoard', data: {
        targetEntityId: proposeTarget, newBoardHash: blockHash('7a'), actionNonce: 7n,
      },
    }, propose.state, propose.context),
    applyCase('entityProviderActivateBoard', {
      type: 'entityProviderActivateBoard', data: { targetEntityId: activateTarget },
    }, activate.state, activate.context),
  ]);
};

const boardHandoverCase = async () => {
  const fixture = providerSetup('board-handover');
  const nextSigner = deriveSignerAddressSync(fixture.context.runtimeSeed!, 'next').toLowerCase();
  registerSignerKey(
    fixture.context,
    nextSigner,
    deriveSignerKeySync(fixture.context.runtimeSeed!, 'next'),
  );
  const nextConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [nextSigner],
    shares: { [nextSigner]: 1n },
    jurisdiction: JURISDICTION,
  };
  const previousBoardHash = hashBoard(encodeBoard(fixture.state.config, fixture.context));
  const nextBoardHash = hashBoard(encodeBoard(nextConfig, fixture.context));
  applyBoardEvent(fixture.context, fixture.state, {
    type: 'BoardActivated',
    data: {
      entityId: fixture.state.entityId,
      previousBoardHash,
      newBoardHash: nextBoardHash,
      previousBoardValidUntil: '1700604800',
    },
    blockNumber: 3, blockHash: blockHash('15'), transactionHash: blockHash('25'), logIndex: 0,
  });
  const board = {
    mode: nextConfig.mode,
    threshold: nextConfig.threshold,
    validators: nextConfig.validators,
    shares: nextConfig.shares,
  };
  return applyCase(
    'boardHandover',
    { type: 'boardHandover', data: { board } },
    fixture.state,
    fixture.context,
    { mutableFrameState: true, authorizedBoardHandoverConfig: nextConfig },
  );
};

const fixture = {
  version: 1,
  canonicalSource: 'TypeScript production Entity control reducers',
  cases: [
    ...await simpleCases(),
    ...await proposalCases(),
    await entityCommandCase(),
    ...await providerCases(),
    await boardHandoverCase(),
  ],
};

await Bun.write(new URL('./group-b-v1.json', import.meta.url), `${safeStringify(fixture, 2)}\n`);

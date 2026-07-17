import { describe, expect, test } from 'bun:test';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account/crypto';
import { applyEntityFrame, applyEntityInput } from '../entity/consensus';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { createEntityFrameHash } from '../entity/consensus/frame';
import { buildEntityHashesToSign } from '../entity/consensus/hanko-witness';
import { generateLazyEntityId } from '../entity/factory';
import { hasEntityLeaderWork } from '../entity/consensus/leader';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { EMPTY_J_HISTORY_ROOT } from '../jurisdiction/history-consensus';
import {
  assertFrameJPrefix,
  buildJPrefixCertificate,
  buildLocalJPrefixAttestation,
  hashJPrefixAttestation,
  mergeJPrefixAttestations,
  restoreJPrefixRound,
  selectHighestWeightedCommonJPrefix,
  verifyJPrefixCertificate,
} from '../jurisdiction/j-prefix-consensus';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { createEmptyEnv, hasRuntimeWork } from '../runtime';
import type {
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JurisdictionEvent,
  ProposedEntityFrame,
  ValidatorJHistory,
} from '../types';

let entityId = `0x${'91'.repeat(32)}`;
const depositoryAddress = `0x${'92'.repeat(20)}`;
const jurisdictionRef = `stack:31337:${depositoryAddress}`;
const blockHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;

const makeState = (validators: string[]): EntityState => ({
  entityId,
  height: 0,
  prevFrameHash: 'genesis',
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    // Runtime rejects 2-of-3 because two such quorums can intersect only in a
    // Byzantine signer. Three unit shares therefore require threshold 3.
    threshold: 3n,
    validators,
    shares: Object.fromEntries(validators.map(validator => [validator, 1n])),
    jurisdiction: {
      name: 'JPrefixTestnet',
      address: 'http://127.0.0.1:8545',
      chainId: 31337,
      depositoryAddress,
      entityProviderAddress: `0x${'97'.repeat(20)}`,
      registrationBlock: 10,
    },
  },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 10,
  jBlockChain: [],
  jHistoryFinality: {
    jurisdictionRef,
    baseHeight: 0,
    finalizedThroughHeight: 10,
    tipBlockHash: blockHash(10),
    eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
    proposerSignerId: validators[0]!,
    proposerSignature: '0xgenesis',
    entityHeight: 0,
  },
  entityEncPubKey: 'pub',
  entityEncPrivKey: 'priv',
  profile: { name: 'J prefix', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const disputeStarted = (): JurisdictionEvent => ({
  blockNumber: 11,
  blockHash: blockHash(11),
  transactionHash: `0x${'93'.repeat(32)}`,
  logIndex: 0,
  type: 'DisputeStarted',
  data: {
    sender: entityId,
    counterentity: `0x${'94'.repeat(32)}`,
    nonce: '1',
    proofbodyHash: `0x${'95'.repeat(32)}`,
    watchSeed: `0x${'96'.repeat(32)}`,
    starterInitialArguments: '0x',
    starterIncrementedArguments: '0x',
    disputeTimeout: 5_760,
  },
});

const reserveUpdatedAt = (height: number, amount: bigint): JurisdictionEvent => ({
  blockNumber: height,
  blockHash: blockHash(height),
  transactionHash: `0x${'a4'.repeat(32)}`,
  logIndex: 0,
  type: 'ReserveUpdated',
  data: { entity: entityId, tokenId: 1, newBalance: amount.toString() },
});

const hubConfigTx = (routingFeePPM: number): EntityTx => ({
  type: 'setHubConfig',
  data: { routingFeePPM, baseFee: 123n },
});

const observedThrough = (height: number, includeDispute: boolean): ValidatorJHistory => {
  const event = disputeStarted();
  return recordValidatorJHistory(undefined, {
    jurisdictionRef,
    scannedThroughHeight: height,
    tipBlockHash: blockHash(height),
    headers: Array.from({ length: Math.max(0, height - 9) }, (_, index) => {
      const jHeight = 10 + index;
      return { jHeight, jBlockHash: blockHash(jHeight) };
    }),
    blocks: includeDispute
      ? [
          {
            jurisdictionRef,
            jHeight: 11,
            jBlockHash: blockHash(11),
            eventsHash: canonicalJurisdictionEventsHash([event]),
            events: [event],
          },
        ]
      : [],
  });
};

const installOwnKey = (env: Env, label: string): string => {
  const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, label));
  return signerId;
};

const buildOrdinaryProposal = async (
  env: Env,
  state: EntityState,
  proposerSignerId: string,
  timestamp: number,
): Promise<ProposedEntityFrame> => {
  const userTxs: EntityTx[] = [
    {
      type: 'chat',
      data: { from: proposerSignerId, message: `ordinary-${timestamp}` },
    },
  ];
  const txs: EntityTx[] = [signedEntityCommandTx(buildSignedEntityCommand(env, state, proposerSignerId, userTxs))];
  const replay = await applyEntityFrame(env, state, txs, timestamp);
  const postState: EntityState = {
    ...replay.newState,
    entityId: state.entityId,
    height: state.height + 1,
    timestamp,
    leaderState: {
      activeValidatorId: proposerSignerId,
      view: 0,
      changedAtHeight: 0,
    },
  };
  const hash = await createEntityFrameHash(
    state.prevFrameHash ?? 'genesis',
    postState.height,
    timestamp,
    txs,
    postState,
  );
  const hashesToSign = buildEntityHashesToSign(entityId, postState.height, hash, []);
  return {
    height: postState.height,
    parentFrameHash: state.prevFrameHash ?? 'genesis',
    stateRoot: computeCanonicalEntityConsensusStateHash(postState),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(postState)),
    timestamp,
    txs,
    hash,
    leader: { proposerSignerId, view: 0 },
    hashesToSign,
    collectedSigs: new Map([
      [proposerSignerId, hashesToSign.map(({ hash: digest }) => signAccountFrame(env, proposerSignerId, digest))],
    ]),
  };
};

describe('validator J-prefix consensus', () => {
  test('locally derives a pending-event prefix before finalizing a lazy single-validator collective action', async () => {
    const env = createEmptyEnv('j-prefix-on-demand-lazy-event');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'on-demand-lazy-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    state.config.shares = { [validatorId]: 1n };
    delete state.config.jurisdiction!.registrationBlock;
    delete state.jHistoryFinality;
    state.lastFinalizedJHeight = 0;
    state.jBlockChain = [];

    const event = reserveUpdatedAt(1, 100n);
    const history = recordValidatorJHistory(
      undefined,
      {
        jurisdictionRef,
        scannedThroughHeight: 1,
        tipBlockHash: blockHash(1),
        headers: [{ jHeight: 1, jBlockHash: blockHash(1) }],
        blocks: [
          {
            jurisdictionRef,
            jHeight: 1,
            jBlockHash: blockHash(1),
            eventsHash: canonicalJurisdictionEventsHash([event]),
            events: [event],
          },
        ],
      },
      state,
    );
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: history,
    };

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId: validatorId,
      entityTxs: [hubConfigTx(777)],
    });

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.mempool.some(tx => tx.type === 'entityCommand')).toBe(false);
    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.state.lastFinalizedJHeight).toBe(1);
    expect(result.workingReplica.state.reserves.get(1)).toBe(100n);
    expect(result.workingReplica.state.hubRebalanceConfig?.routingFeePPM).toBe(777);
    const frame = result.workingReplica.certifiedFrameLineage?.at(-1)?.frame;
    expect(frame?.jPrefixCertificate?.attestations.has(validatorId)).toBe(true);
    expect(frame?.jPrefixCertificate?.selected.scannedThroughHeight).toBe(1);
  });

  test('locally derives an empty prefix before finalizing a registered single-validator collective action', async () => {
    const env = createEmptyEnv('j-prefix-on-demand-registered-empty');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'on-demand-registered-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    state.config.shares = { [validatorId]: 1n };
    const history = recordValidatorJHistory(
      undefined,
      {
        jurisdictionRef,
        scannedThroughHeight: 11,
        tipBlockHash: blockHash(11),
        headers: [10, 11].map(jHeight => ({ jHeight, jBlockHash: blockHash(jHeight) })),
        blocks: [],
      },
      state,
    );
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: history,
    };

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId: validatorId,
      entityTxs: [hubConfigTx(888)],
    });

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.mempool.some(tx => tx.type === 'entityCommand')).toBe(false);
    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.state.lastFinalizedJHeight).toBe(11);
    expect(result.workingReplica.state.hubRebalanceConfig?.routingFeePPM).toBe(888);
    const frame = result.workingReplica.certifiedFrameLineage?.at(-1)?.frame;
    expect(frame?.jPrefixCertificate?.attestations.has(validatorId)).toBe(true);
    expect(frame?.jPrefixCertificate?.selected.scannedThroughHeight).toBe(11);
    expect(frame?.jPrefixCertificate?.selected.blocks).toEqual([]);
  });

  test('does not spin empty Runtime frames while a parked command waits for missing authenticated headers', () => {
    const env = createEmptyEnv('j-prefix-incomplete-history-no-spin');
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'incomplete-history-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    state.config.shares = { [validatorId]: 1n };
    delete state.config.jurisdiction!.registrationBlock;
    delete state.jHistoryFinality;
    state.lastFinalizedJHeight = 0;
    state.jBlockChain = [];
    const event = reserveUpdatedAt(100, 100n);
    const history = recordValidatorJHistory(
      undefined,
      {
        jurisdictionRef,
        scannedThroughHeight: 100,
        tipBlockHash: blockHash(100),
        headers: [{ jHeight: 100, jBlockHash: blockHash(100) }],
        blocks: [
          {
            jurisdictionRef,
            jHeight: 100,
            jBlockHash: blockHash(100),
            eventsHash: canonicalJurisdictionEventsHash([event]),
            events: [event],
          },
        ],
      },
      state,
    );
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [hubConfigTx(999)],
      isProposer: true,
      jHistory: history,
    };
    env.eReplicas.set(`${entityId}:${validatorId}`, replica);

    expect(hasEntityLeaderWork(replica)).toBe(true);
    expect(hasRuntimeWork(env)).toBe(false);
  });

  test('certifies the highest contiguous prefix while a sparse later event remains pending', async () => {
    const env = createEmptyEnv('j-prefix-sparse-event-contiguous-catch-up');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'sparse-event-contiguous-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    state.config.shares = { [validatorId]: 1n };
    delete state.config.jurisdiction!.registrationBlock;
    delete state.jHistoryFinality;
    state.lastFinalizedJHeight = 0;
    state.jBlockChain = [];

    const laterEvent = reserveUpdatedAt(100, 100n);
    const sparseHistory = recordValidatorJHistory(
      undefined,
      {
        jurisdictionRef,
        scannedThroughHeight: 100,
        tipBlockHash: blockHash(100),
        headers: [{ jHeight: 100, jBlockHash: blockHash(100) }],
        blocks: [
          {
            jurisdictionRef,
            jHeight: 100,
            jBlockHash: blockHash(100),
            eventsHash: canonicalJurisdictionEventsHash([laterEvent]),
            events: [laterEvent],
          },
        ],
      },
      state,
    );
    const caughtUpHistory = recordValidatorJHistory(
      sparseHistory,
      {
        jurisdictionRef,
        scannedThroughHeight: 25,
        tipBlockHash: blockHash(25),
        headers: Array.from({ length: 25 }, (_, index) => ({
          jHeight: index + 1,
          jBlockHash: blockHash(index + 1),
        })),
        blocks: [],
      },
      state,
    );
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: caughtUpHistory,
    };

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId: validatorId,
      entityTxs: [hubConfigTx(999)],
    });

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.state.lastFinalizedJHeight).toBe(25);
    expect(result.workingReplica.state.hubRebalanceConfig?.routingFeePPM).toBe(999);
    expect(result.workingReplica.state.reserves.has(1)).toBe(false);
    expect(result.workingReplica.jHistory?.scannedThroughHeight).toBe(100);
    expect(result.workingReplica.jHistory?.eventBlocks.has(100)).toBe(true);
    const frame = result.workingReplica.certifiedFrameLineage?.at(-1)?.frame;
    expect(frame?.jPrefixCertificate?.selected.scannedThroughHeight).toBe(25);
  });

  test('waits for an authenticated successor before the first certified anchor and then forms quorum', () => {
    const proposerEnv = createEmptyEnv('j-prefix-first-anchor-proposer');
    const validatorEnv = createEmptyEnv('j-prefix-first-anchor-validator');
    const thirdEnv = createEmptyEnv('j-prefix-first-anchor-third');
    const proposerId = installOwnKey(proposerEnv, 'first-anchor-proposer');
    const validatorId = installOwnKey(validatorEnv, 'first-anchor-validator');
    const thirdId = installOwnKey(thirdEnv, 'first-anchor-third');
    const validators = [proposerId, validatorId, thirdId];
    entityId = generateLazyEntityId(validators, 3n);
    const state = makeState(validators);
    state.config.jurisdiction!.entityProviderDeploymentBlock = 11;
    delete state.jHistoryFinality;

    const historyAt = (scannedThroughHeight: number): ValidatorJHistory =>
      recordValidatorJHistory(
        undefined,
        {
          jurisdictionRef,
          scannedThroughHeight,
          tipBlockHash: blockHash(scannedThroughHeight),
          headers: Array.from({ length: scannedThroughHeight - state.lastFinalizedJHeight + 1 }, (_, index) => {
            const jHeight = state.lastFinalizedJHeight + index;
            return { jHeight, jBlockHash: blockHash(jHeight) };
          }),
          blocks: [],
        },
        state,
      );
    const makeReplica = (signerId: string, history: ValidatorJHistory, isProposer: boolean): EntityReplica => ({
      entityId,
      signerId,
      state: structuredClone(state),
      mempool: [],
      isProposer,
      jHistory: history,
    });

    expect(buildLocalJPrefixAttestation(proposerEnv, makeReplica(proposerId, historyAt(10), true))).toBeNull();

    const heads = [
      [proposerId, buildLocalJPrefixAttestation(proposerEnv, makeReplica(proposerId, historyAt(11), true))!],
      [validatorId, buildLocalJPrefixAttestation(validatorEnv, makeReplica(validatorId, historyAt(11), false))!],
      [thirdId, buildLocalJPrefixAttestation(thirdEnv, makeReplica(thirdId, historyAt(11), false))!],
    ] as const;
    let round: EntityReplica['jPrefixRound'];
    for (const [index, [signerId, head]] of heads.entries()) {
      round = mergeJPrefixAttestations(proposerEnv, state, round, new Map([[signerId, head]]));
      expect(Boolean(round.certificate)).toBe(index === heads.length - 1);
    }
    expect(round?.certificate?.selected.scannedThroughHeight).toBe(11);
    expect(round?.certificate?.attestations.size).toBe(3);
  });

  test('tips H14/H12/H10 select the highest weighted exact quorum-common prefix H12', () => {
    const proposerEnv = createEmptyEnv('j-prefix-h14-runtime');
    const validatorEnv = createEmptyEnv('j-prefix-h12-runtime');
    const laggingEnv = createEmptyEnv('j-prefix-h10-runtime');
    const proposerId = installOwnKey(proposerEnv, 'proposer-2');
    const validatorId = installOwnKey(validatorEnv, 'validator-2');
    const laggingId = installOwnKey(laggingEnv, 'lagging-1');
    const validators = [proposerId, validatorId, laggingId];
    entityId = generateLazyEntityId(
      [
        { name: proposerId, weight: 2 },
        { name: validatorId, weight: 2 },
        { name: laggingId, weight: 1 },
      ],
      4n,
    );
    const baseState = makeState(validators);
    baseState.config.threshold = 4n;
    baseState.config.shares = { [proposerId]: 2n, [validatorId]: 2n, [laggingId]: 1n };
    const makeReplica = (signerId: string, history: ValidatorJHistory, isProposer: boolean): EntityReplica => ({
      entityId,
      signerId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer,
      jHistory: history,
    });
    const proposerHead = buildLocalJPrefixAttestation(
      proposerEnv,
      makeReplica(proposerId, observedThrough(14, true), true),
    )!;
    const validatorHead = buildLocalJPrefixAttestation(
      validatorEnv,
      makeReplica(validatorId, observedThrough(12, true), false),
    )!;
    const laggingHead = buildLocalJPrefixAttestation(
      laggingEnv,
      makeReplica(laggingId, observedThrough(10, false), false),
    )!;
    const heads = new Map([
      [proposerId, proposerHead],
      [validatorId, validatorHead],
      [laggingId, laggingHead],
    ]);

    const selection = selectHighestWeightedCommonJPrefix(baseState, heads);
    expect(selection?.claim.scannedThroughHeight).toBe(12);
    expect(selection?.signerIds).toEqual([proposerId, validatorId].sort());
    expect(selection?.claim.tipBlockHash).toBe(blockHash(12));
    const certificate = buildJPrefixCertificate(baseState, heads);
    expect(certificate).not.toBeNull();
    expect(verifyJPrefixCertificate(proposerEnv, baseState, certificate!).selected.scannedThroughHeight).toBe(12);
  });

  test('three isolated validators independently sign and route one J-prefix head into a real quorum certificate', async () => {
    const proposerEnv = createEmptyEnv('j-prefix-isolated-proposer');
    const validatorEnv = createEmptyEnv('j-prefix-isolated-validator');
    const thirdEnv = createEmptyEnv('j-prefix-isolated-third');
    for (const env of [proposerEnv, validatorEnv, thirdEnv]) {
      env.timestamp = 2_000;
      env.quietRuntimeLogs = true;
    }
    const proposerId = installOwnKey(proposerEnv, 'isolated-proposer');
    const validatorId = installOwnKey(validatorEnv, 'isolated-validator');
    const thirdId = installOwnKey(thirdEnv, 'isolated-third');
    const validators = [proposerId, validatorId, thirdId];
    expect(new Set(validators).size).toBe(3);

    entityId = generateLazyEntityId(validators, 3n);
    const baseState = makeState(validators);
    const makeReplica = (signerId: string, isProposer: boolean): EntityReplica => ({
      entityId,
      signerId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer,
      jHistory: observedThrough(11, true),
    });
    let proposerReplica = makeReplica(proposerId, true);
    const validatorReplica = makeReplica(validatorId, false);
    const thirdReplica = makeReplica(thirdId, false);

    const started = await applyEntityInput(proposerEnv, proposerReplica, {
      entityId,
      signerId: proposerId,
      entityTxs: [
        {
          type: 'chat',
          data: { from: proposerId, message: 'independent-j-prefix-signing' },
        },
      ],
    });
    expect(started.outcome).toEqual({ kind: 'committed' });
    proposerReplica = started.workingReplica;
    expect([...proposerReplica.jPrefixRound!.attestations.keys()]).toEqual([proposerId]);
    expect(proposerReplica.proposal).toBeUndefined();

    const proposerHead = proposerReplica.jPrefixRound!.attestations.get(proposerId)!;
    const { signature: _proposerSignature, ...proposerUnsigned } = proposerHead;
    const proposerDigest = hashJPrefixAttestation(proposerUnsigned);
    expect(() => signAccountFrame(proposerEnv, validatorId, proposerDigest)).toThrow('MISSING_SIGNER_KEY');
    expect(() => signAccountFrame(proposerEnv, thirdId, proposerDigest)).toThrow('MISSING_SIGNER_KEY');

    const routedHead = (outputs: typeof started.outputs, targetSignerId: string, sourceSignerId: string) =>
      outputs.find(
        output =>
          output.signerId === targetSignerId &&
          output.jPrefixAttestations?.size === 1 &&
          output.jPrefixAttestations.has(sourceSignerId),
      );
    const toValidator = routedHead(started.outputs, validatorId, proposerId);
    const toThird = routedHead(started.outputs, thirdId, proposerId);
    expect(toValidator).toBeDefined();
    expect(toThird).toBeDefined();

    const validatorSigned = await applyEntityInput(validatorEnv, validatorReplica, toValidator!);
    const thirdSigned = await applyEntityInput(thirdEnv, thirdReplica, toThird!);
    expect(validatorSigned.outcome).toEqual({ kind: 'committed' });
    expect(thirdSigned.outcome).toEqual({ kind: 'committed' });
    expect([...validatorSigned.workingReplica.jPrefixRound!.attestations.keys()].sort()).toEqual(
      [proposerId, validatorId].sort(),
    );
    expect([...thirdSigned.workingReplica.jPrefixRound!.attestations.keys()].sort()).toEqual(
      [proposerId, thirdId].sort(),
    );

    const validatorHead = validatorSigned.workingReplica.jPrefixRound!.attestations.get(validatorId)!;
    const thirdHead = thirdSigned.workingReplica.jPrefixRound!.attestations.get(thirdId)!;
    const claimWithoutSigner = ({ validatorId: _validatorId, signature: _signature, ...claim }: typeof proposerHead) =>
      claim;
    expect(claimWithoutSigner(validatorHead)).toEqual(claimWithoutSigner(proposerHead));
    expect(claimWithoutSigner(thirdHead)).toEqual(claimWithoutSigner(proposerHead));
    expect(
      buildJPrefixCertificate(
        baseState,
        new Map([
          [proposerId, proposerHead],
          [validatorId, validatorHead],
        ]),
      ),
    ).toBeNull();

    const validatorToProposer = routedHead(validatorSigned.outputs, proposerId, validatorId);
    const thirdToProposer = routedHead(thirdSigned.outputs, proposerId, thirdId);
    expect(validatorToProposer).toBeDefined();
    expect(thirdToProposer).toBeDefined();

    const mergedValidator = await applyEntityInput(proposerEnv, proposerReplica, validatorToProposer!);
    expect(mergedValidator.workingReplica.proposal).toBeUndefined();
    const completed = await applyEntityInput(proposerEnv, mergedValidator.workingReplica, thirdToProposer!);
    const certificate = completed.workingReplica.proposal?.jPrefixCertificate;
    expect(certificate).toBeDefined();
    expect([...certificate!.attestations.keys()].sort()).toEqual([...validators].sort());
    expect(verifyJPrefixCertificate(proposerEnv, baseState, certificate!).selected).toMatchObject({
      scannedThroughHeight: 11,
      tipBlockHash: blockHash(11),
    });
  });

  test('finds a common H12 below divergent H14/H13 tips instead of stalling at tip candidates', () => {
    const leftEnv = createEmptyEnv('j-prefix-fork-left');
    const rightEnv = createEmptyEnv('j-prefix-fork-right');
    const observerEnv = createEmptyEnv('j-prefix-fork-observer');
    const leftId = installOwnKey(leftEnv, 'fork-left');
    const rightId = installOwnKey(rightEnv, 'fork-right');
    const observerId = installOwnKey(observerEnv, 'fork-observer');
    const validators = [leftId, rightId, observerId];
    entityId = generateLazyEntityId(
      [
        { name: leftId, weight: 2 },
        { name: rightId, weight: 2 },
        { name: observerId, weight: 1 },
      ],
      4n,
    );
    const baseState = makeState(validators);
    baseState.config.threshold = 4n;
    baseState.config.shares = { [leftId]: 2n, [rightId]: 2n, [observerId]: 1n };
    const forkHash = `0x${'f3'.repeat(32)}`;
    const rightHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 13,
      tipBlockHash: forkHash,
      headers: [10, 11, 12]
        .map(jHeight => ({ jHeight, jBlockHash: blockHash(jHeight) }))
        .concat([{ jHeight: 13, jBlockHash: forkHash }]),
      blocks: [
        {
          jurisdictionRef,
          jHeight: 11,
          jBlockHash: blockHash(11),
          eventsHash: canonicalJurisdictionEventsHash([disputeStarted()]),
          events: [disputeStarted()],
        },
      ],
    });
    const replica = (signerId: string, history: ValidatorJHistory): EntityReplica => ({
      entityId,
      signerId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer: signerId === leftId,
      jHistory: history,
    });
    const left = buildLocalJPrefixAttestation(leftEnv, replica(leftId, observedThrough(14, true)))!;
    const right = buildLocalJPrefixAttestation(rightEnv, replica(rightId, rightHistory))!;

    const selected = selectHighestWeightedCommonJPrefix(
      baseState,
      new Map([
        [leftId, left],
        [rightId, right],
      ]),
    );
    expect(selected?.claim.scannedThroughHeight).toBe(12);
    expect(selected?.claim.tipBlockHash).toBe(blockHash(12));
  });

  test('forked empty heads sharing only the certified base authorize zero J events', () => {
    const leftEnv = createEmptyEnv('j-prefix-base-left');
    const rightEnv = createEmptyEnv('j-prefix-base-right');
    const observerEnv = createEmptyEnv('j-prefix-base-observer');
    const leftId = installOwnKey(leftEnv, 'base-left');
    const rightId = installOwnKey(rightEnv, 'base-right');
    const observerId = installOwnKey(observerEnv, 'base-observer');
    const validators = [leftId, rightId, observerId];
    entityId = generateLazyEntityId(
      [
        { name: leftId, weight: 2 },
        { name: rightId, weight: 2 },
        { name: observerId, weight: 1 },
      ],
      4n,
    );
    const baseState = makeState(validators);
    baseState.config.threshold = 4n;
    baseState.config.shares = { [leftId]: 2n, [rightId]: 2n, [observerId]: 1n };
    const history = (tipBlockHash: string): ValidatorJHistory =>
      recordValidatorJHistory(undefined, {
        jurisdictionRef,
        scannedThroughHeight: 11,
        tipBlockHash,
        headers: [
          { jHeight: 10, jBlockHash: blockHash(10) },
          { jHeight: 11, jBlockHash: tipBlockHash },
        ],
        blocks: [],
      });
    const leftReplica: EntityReplica = {
      entityId,
      signerId: leftId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer: true,
      jHistory: history(`0x${'a1'.repeat(32)}`),
    };
    const rightReplica: EntityReplica = {
      entityId,
      signerId: rightId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer: false,
      jHistory: history(`0x${'b2'.repeat(32)}`),
    };
    const heads = new Map([
      [leftId, buildLocalJPrefixAttestation(leftEnv, leftReplica)!],
      [rightId, buildLocalJPrefixAttestation(rightEnv, rightReplica)!],
    ]);
    const certificate = buildJPrefixCertificate(baseState, heads)!;
    expect(certificate.selected.scannedThroughHeight).toBe(10);
    expect(certificate.selected.tipBlockHash).toBe(blockHash(10));
    const frame = {
      height: 1,
      parentFrameHash: 'genesis',
      leader: { proposerSignerId: leftId, view: 0 },
      txs: [],
      jPrefixCertificate: certificate,
    };
    expect(() =>
      assertFrameJPrefix(leftEnv, leftReplica, {
        ...frame,
        jPrefixCertificate: undefined,
      }),
    ).toThrow('J_PREFIX_CERTIFICATE_REQUIRED_FOR_REGISTERED_ENTITY');
    expect(() => assertFrameJPrefix(leftEnv, leftReplica, frame)).not.toThrow();
    expect(() =>
      assertFrameJPrefix(leftEnv, leftReplica, {
        ...frame,
        txs: [{ type: 'j_event', data: {} } as never],
      }),
    ).toThrow('J_PREFIX_RANGE_COUNT_INVALID:1');

    const unregisteredState = structuredClone(baseState);
    delete unregisteredState.jHistoryFinality;
    delete unregisteredState.config.jurisdiction;
    unregisteredState.lastFinalizedJHeight = 0;
    const unregisteredReplica = {
      ...leftReplica,
      state: unregisteredState,
      jHistory: undefined,
      jPrefixRound: undefined,
    };
    expect(() =>
      assertFrameJPrefix(leftEnv, unregisteredReplica, {
        ...frame,
        txs: [],
        jPrefixCertificate: undefined,
      }),
    ).not.toThrow();
  });

  test('rejects a validator-signed base claim that conflicts with the Entity-certified anchor', () => {
    const env = createEmptyEnv('j-prefix-corrupt-base');
    const validatorId = installOwnKey(env, 'corrupt-base-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: observedThrough(10, false),
    };
    const honest = buildLocalJPrefixAttestation(env, replica)!;
    const { signature: _signature, ...unsigned } = honest;
    const conflictingUnsigned = { ...unsigned, tipBlockHash: `0x${'fe'.repeat(32)}` };
    const conflicting = {
      ...conflictingUnsigned,
      signature: signAccountFrame(env, validatorId, hashJPrefixAttestation(conflictingUnsigned)),
    };

    expect(() => mergeJPrefixAttestations(env, state, undefined, new Map([[validatorId, conflicting]]))).toThrow(
      'J_PREFIX_BASE_ATTESTATION_CONFLICT',
    );
  });

  test('authenticates stale votes as terminal no-ops, rejects forged stale votes, and defers future votes', async () => {
    const env = createEmptyEnv('j-prefix-stale-terminal');
    env.quietRuntimeLogs = true;
    const receiverId = installOwnKey(env, 'stale-receiver');
    const sourceId = installOwnKey(env, 'stale-source');
    entityId = generateLazyEntityId([receiverId, sourceId], 1n);
    const preState = makeState([receiverId, sourceId]);
    preState.config.threshold = 1n;
    preState.config.shares = { [receiverId]: 1n, [sourceId]: 1n };
    const history = observedThrough(10, false);
    const sourceReplica: EntityReplica = {
      entityId,
      signerId: sourceId,
      state: preState,
      mempool: [],
      isProposer: false,
      jHistory: history,
    };
    const stale = buildLocalJPrefixAttestation(env, sourceReplica)!;
    const committedState = {
      ...structuredClone(preState),
      height: 1,
      prevFrameHash: `0x${'a7'.repeat(32)}`,
    };
    const receiverReplica: EntityReplica = {
      entityId,
      signerId: receiverId,
      state: committedState,
      mempool: [],
      isProposer: true,
      jHistory: history,
    };

    const staleResult = await applyEntityInput(env, receiverReplica, {
      entityId,
      signerId: receiverId,
      jPrefixAttestations: new Map([[sourceId, stale]]),
    });
    expect(staleResult.outcome).toEqual({ kind: 'committed' });
    expect(staleResult.workingReplica.state).toEqual(committedState);
    expect(staleResult.workingReplica.jPrefixRound).toBeUndefined();
    expect(staleResult.outputs).toEqual([]);

    const forged = { ...stale, signature: `${stale.signature.slice(0, -2)}ff` };
    const forgedResult = await applyEntityInput(env, receiverReplica, {
      entityId,
      signerId: receiverId,
      jPrefixAttestations: new Map([[sourceId, forged]]),
    });
    expect(forgedResult.outcome).toEqual({ kind: 'rejected', code: 'J_PREFIX_ATTESTATION_REJECTED' });
    expect(forgedResult.workingReplica.state).toEqual(committedState);

    const { signature: _signature, ...staleUnsigned } = stale;
    const futureUnsigned = {
      ...staleUnsigned,
      targetEntityHeight: 3,
      parentFrameHash: `0x${'b8'.repeat(32)}`,
    };
    const future = {
      ...futureUnsigned,
      signature: signAccountFrame(env, sourceId, hashJPrefixAttestation(futureUnsigned)),
    };
    const futureResult = await applyEntityInput(env, receiverReplica, {
      entityId,
      signerId: receiverId,
      jPrefixAttestations: new Map([[sourceId, future]]),
    });
    expect(futureResult.outcome).toEqual({ kind: 'deferred', reason: 'J_PREFIX_FUTURE_HEIGHT' });
    expect(futureResult.workingReplica.state).toEqual(committedState);
  });

  test('rolls one frozen base round, keeps a scheduled wake first while finalizing the J suffix, then stops', async () => {
    const env = createEmptyEnv('j-prefix-frozen-base-roll');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'frozen-base-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const baseState = makeState([validatorId]);
    baseState.config.threshold = 1n;
    baseState.config.shares = { [validatorId]: 1n };
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state: baseState,
      mempool: [],
      isProposer: true,
      jHistory: observedThrough(10, false),
    };
    const frozenBaseHead = buildLocalJPrefixAttestation(env, replica)!;
    replica.jPrefixRound = mergeJPrefixAttestations(
      env,
      baseState,
      undefined,
      new Map([[validatorId, frozenBaseHead]]),
    );

    const reserveEvent: JurisdictionEvent = {
      blockNumber: 11,
      blockHash: blockHash(11),
      transactionHash: `0x${'a8'.repeat(32)}`,
      logIndex: 0,
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    replica.jHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 11,
      tipBlockHash: blockHash(11),
      headers: [10, 11].map(jHeight => ({ jHeight, jBlockHash: blockHash(jHeight) })),
      blocks: [
        {
          jurisdictionRef,
          jHeight: 11,
          jBlockHash: blockHash(11),
          eventsHash: canonicalJurisdictionEventsHash([reserveEvent]),
          events: [reserveEvent],
        },
      ],
    });
    env.eReplicas.set(`${entityId}:${validatorId}`, replica);
    expect(replica.mempool).toEqual([]);
    expect(hasEntityLeaderWork(replica)).toBe(true);
    expect(hasRuntimeWork(env)).toBe(true);

    const rolled = await applyEntityInput(env, replica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });
    expect(rolled.outcome).toEqual({ kind: 'committed' });
    expect(rolled.workingReplica.state.height).toBe(1);
    expect(rolled.workingReplica.state.lastFinalizedJHeight).toBe(10);
    expect(rolled.workingReplica.certifiedFrameLineage?.at(-1)?.frame.txs).toEqual([]);
    expect(rolled.workingReplica.jPrefixRound?.targetEntityHeight).toBe(2);
    expect(rolled.workingReplica.jPrefixRound?.certificate?.selected.scannedThroughHeight).toBe(11);

    env.timestamp = 3_000;
    rolled.workingReplica.mempool.push({
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: validatorId,
        dueAt: 2_500,
        jobs: [{ kind: 'task', id: 'j-prefix-order-regression', dueAt: 2_500 }],
      },
    });
    const finalized = await applyEntityInput(env, rolled.workingReplica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });
    expect(finalized.outcome).toEqual({ kind: 'committed' });
    expect(finalized.workingReplica.state.height).toBe(2);
    expect(finalized.workingReplica.state.lastFinalizedJHeight).toBe(11);
    expect(finalized.workingReplica.state.reserves.get(1)).toBe(100n);
    expect(finalized.workingReplica.certifiedFrameLineage?.at(-1)?.frame.txs.map(tx => tx.type)).toEqual([
      'scheduledWake',
      'j_event',
    ]);

    env.timestamp = 4_000;
    const idle = await applyEntityInput(env, finalized.workingReplica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });
    expect(idle.workingReplica.state.height).toBe(2);
    expect(idle.workingReplica.state.prevFrameHash).toBe(finalized.workingReplica.state.prevFrameHash);
    expect(idle.outputs).toEqual([]);
    env.eReplicas.set(`${entityId}:${validatorId}`, idle.workingReplica);
    expect(hasEntityLeaderWork(idle.workingReplica)).toBe(false);
    expect(hasRuntimeWork(env)).toBe(false);
  });

  test('accepts only an empty common-base roll when its local round already has a stronger prefix', () => {
    const signerEnvs = [
      createEmptyEnv('j-prefix-exact-base-1'),
      createEmptyEnv('j-prefix-exact-base-2'),
      createEmptyEnv('j-prefix-exact-base-3'),
      createEmptyEnv('j-prefix-event-ahead-4'),
    ];
    const validators = signerEnvs.map((env, index) => installOwnKey(env, `exact-base-${index + 1}`));
    entityId = generateLazyEntityId(validators, 3n);
    const state = makeState(validators);
    const heads = new Map(
      validators.map((signerId, index) => {
        const history = index === 0 ? observedThrough(10, false) : observedThrough(11, true);
        const attestation = buildLocalJPrefixAttestation(signerEnvs[index]!, {
          entityId,
          signerId,
          state: structuredClone(state),
          mempool: [],
          isProposer: index === 0,
          jHistory: history,
        })!;
        return [signerId, attestation] as const;
      }),
    );
    const incomingRound = mergeJPrefixAttestations(
      signerEnvs[0]!,
      state,
      undefined,
      new Map(Array.from(heads.entries()).slice(0, 3)),
    );
    expect(incomingRound.certificate?.selected.scannedThroughHeight).toBe(10);
    const localRound = mergeJPrefixAttestations(signerEnvs[0]!, state, undefined, heads);
    expect(localRound.certificate?.selected.scannedThroughHeight).toBe(11);
    const aheadReplica: EntityReplica = {
      entityId,
      signerId: validators[3]!,
      state,
      mempool: [],
      isProposer: false,
      jHistory: observedThrough(11, true),
      jPrefixRound: localRound,
    };
    const emptyRoll = {
      height: 1,
      parentFrameHash: 'genesis',
      leader: { proposerSignerId: validators[0]!, view: 0 },
      txs: [],
      jPrefixCertificate: incomingRound.certificate,
    };

    expect(() => assertFrameJPrefix(signerEnvs[0]!, aheadReplica, emptyRoll)).not.toThrow();
    expect(() =>
      assertFrameJPrefix(signerEnvs[0]!, aheadReplica, {
        ...emptyRoll,
        txs: [{ type: 'chat', data: { from: validators[0]!, message: 'must wait for J prefix' } }],
      }),
    ).toThrow('J_PREFIX_STRONGER_LOCAL_CERTIFICATE');
  });

  test('rolls a frozen base round when the authenticated empty suffix reaches the liveness boundary', async () => {
    const env = createEmptyEnv('j-prefix-frozen-empty-liveness-roll');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'frozen-empty-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const baseState = makeState([validatorId]);
    baseState.config.threshold = 1n;
    baseState.config.shares = { [validatorId]: 1n };
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state: baseState,
      mempool: [],
      isProposer: true,
      jHistory: observedThrough(10, false),
    };
    const frozenBaseHead = buildLocalJPrefixAttestation(env, replica)!;
    replica.jPrefixRound = mergeJPrefixAttestations(
      env,
      baseState,
      undefined,
      new Map([[validatorId, frozenBaseHead]]),
    );

    replica.jHistory = observedThrough(110, false);
    env.eReplicas.set(`${entityId}:${validatorId}`, replica);

    expect(hasEntityLeaderWork(replica)).toBe(true);
    expect(hasRuntimeWork(env)).toBe(true);

    const rolled = await applyEntityInput(env, replica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });
    expect(rolled.outcome).toEqual({ kind: 'committed' });
    expect(rolled.workingReplica.state.lastFinalizedJHeight).toBe(10);
    expect(rolled.workingReplica.certifiedFrameLineage?.at(-1)?.frame.txs).toEqual([]);
    expect(rolled.workingReplica.jPrefixRound?.certificate?.selected.scannedThroughHeight).toBe(110);

    const finalized = await applyEntityInput(env, rolled.workingReplica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });
    expect(finalized.outcome).toEqual({ kind: 'committed' });
    expect(finalized.workingReplica.state.lastFinalizedJHeight).toBe(110);

    env.eReplicas.set(`${entityId}:${validatorId}`, finalized.workingReplica);
    expect(hasEntityLeaderWork(finalized.workingReplica)).toBe(false);
    expect(hasRuntimeWork(env)).toBe(false);
  });

  test('freezes H11 vote, preserves a semantic H12 event, then automatically finalizes H12 next round', async () => {
    const env = createEmptyEnv('j-prefix-next-round-carry');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'next-round-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    state.config.shares = { [validatorId]: 1n };
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: observedThrough(11, false),
    };
    const head11 = buildLocalJPrefixAttestation(env, replica)!;
    replica.jPrefixRound = mergeJPrefixAttestations(env, state, undefined, new Map([[validatorId, head11]]));

    const reserveEvent = reserveUpdatedAt(12, 120n);
    replica.jHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 12,
      tipBlockHash: blockHash(12),
      headers: [10, 11, 12].map(jHeight => ({ jHeight, jBlockHash: blockHash(jHeight) })),
      blocks: [{
        jurisdictionRef,
        jHeight: 12,
        jBlockHash: blockHash(12),
        eventsHash: canonicalJurisdictionEventsHash([reserveEvent]),
        events: [reserveEvent],
      }],
    });
    const sameRoundHead12 = buildLocalJPrefixAttestation(env, replica)!;
    expect(() =>
      mergeJPrefixAttestations(env, state, replica.jPrefixRound, new Map([[validatorId, sameRoundHead12]])),
    ).toThrow('J_PREFIX_ATTESTATION_EQUIVOCATION');
    expect(replica.jPrefixRound.attestations.get(validatorId)?.scannedThroughHeight).toBe(11);
    expect(replica.jHistory.scannedThroughHeight).toBe(12);

    const first = await applyEntityInput(env, replica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });
    expect(first.outcome).toEqual({ kind: 'committed' });
    expect(first.workingReplica.state.lastFinalizedJHeight).toBe(11);
    expect(first.workingReplica.jPrefixRound?.targetEntityHeight).toBe(2);
    expect(first.workingReplica.jPrefixRound?.attestations.get(validatorId)?.scannedThroughHeight).toBe(12);
    expect(
      first.outputs.some(
        output => output.entityId === entityId && output.signerId === validatorId && output.entityTxs?.length === 0,
      ),
    ).toBe(true);

    const restoredRound = restoreJPrefixRound(
      env,
      first.workingReplica.state,
      structuredClone(first.workingReplica.jPrefixRound!),
    );
    expect(restoredRound).toEqual(first.workingReplica.jPrefixRound!);

    env.timestamp = 3_000;
    const second = await applyEntityInput(env, first.workingReplica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });
    expect(second.outcome).toEqual({ kind: 'committed' });
    expect(second.workingReplica.state.lastFinalizedJHeight).toBe(12);
    expect(second.workingReplica.state.reserves.get(1)).toBe(120n);
    expect(second.workingReplica.jPrefixRound).toBeUndefined();

    env.timestamp = 4_000;
    const third = await applyEntityInput(env, second.workingReplica, {
      entityId,
      signerId: validatorId,
      entityTxs: [
        {
          type: 'profile-update',
          data: { profile: { entityId, name: 'unchanged-J-height' } },
        },
      ],
    });
    expect(third.outcome).toEqual({ kind: 'committed' });
    expect(third.workingReplica.state.height).toBe(3);
    expect(third.workingReplica.state.lastFinalizedJHeight).toBe(12);
    expect(third.workingReplica.jPrefixRound).toBeUndefined();
    expect(
      third.workingReplica.certifiedFrameLineage?.at(-1)?.frame.jPrefixCertificate?.selected.scannedThroughHeight,
    ).toBe(12);
  });

  test('does not auto-roll a header-only head observed after the current vote before liveness is due', async () => {
    const env = createEmptyEnv('j-prefix-header-only-no-post-commit-roll');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'header-only-no-post-commit-roll-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    state.config.shares = { [validatorId]: 1n };
    const replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: observedThrough(11, false),
    };
    const signedHead11 = buildLocalJPrefixAttestation(env, replica)!;
    replica.jPrefixRound = mergeJPrefixAttestations(
      env,
      state,
      undefined,
      new Map([[validatorId, signedHead11]]),
    );

    // The watcher learns one more authenticated empty block after this round's
    // immutable vote. That local evidence must remain available for the next
    // real Entity frame, but must not manufacture an otherwise-empty frame.
    replica.jHistory = observedThrough(12, false);
    const committed = await applyEntityInput(env, replica, {
      entityId,
      signerId: validatorId,
      entityTxs: [],
    });

    expect(committed.outcome).toEqual({ kind: 'committed' });
    expect(committed.workingReplica.state.height).toBe(1);
    expect(committed.workingReplica.state.lastFinalizedJHeight).toBe(11);
    expect(committed.workingReplica.jPrefixRound).toBeUndefined();
    expect(
      committed.outputs.some(
        output => output.entityId === entityId && output.signerId === validatorId && output.entityTxs?.length === 0,
      ),
    ).toBe(false);

    env.eReplicas.set(`${entityId}:${validatorId}`, committed.workingReplica);
    expect(hasEntityLeaderWork(committed.workingReplica)).toBe(false);
    expect(hasRuntimeWork(env)).toBe(false);
  });

  test('single signer finalizes an arbitrarily long empty J-prefix without a timer wake', async () => {
    const env = createEmptyEnv('j-prefix-budgeted-empty-catch-up');
    env.timestamp = 2_000;
    env.quietRuntimeLogs = true;
    const validatorId = installOwnKey(env, 'budgeted-empty-validator');
    entityId = generateLazyEntityId([validatorId], 1n);
    const state = makeState([validatorId]);
    state.config.threshold = 1n;
    state.config.shares = { [validatorId]: 1n };
    let replica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: observedThrough(5_783, false),
    };
    const firstHead = buildLocalJPrefixAttestation(env, replica)!;
    replica.jPrefixRound = mergeJPrefixAttestations(
      env,
      state,
      undefined,
      new Map([[validatorId, firstHead]]),
    );

    let frames = 0;
    while (replica.state.lastFinalizedJHeight < 5_783 && frames < 10) {
      const result = await applyEntityInput(env, replica, {
        entityId,
        signerId: validatorId,
        entityTxs: [],
      });
      expect(result.outcome).toEqual({ kind: 'committed' });
      replica = result.workingReplica;
      frames += 1;
      if (replica.state.lastFinalizedJHeight < 5_783) {
        expect(result.outputs.some((output) =>
          output.entityId === entityId && output.signerId === validatorId && output.entityTxs?.length === 0
        )).toBe(true);
      }
      env.timestamp += 1;
    }

    expect(replica.state.lastFinalizedJHeight).toBe(5_783);
    expect(frames).toBe(1);
    expect(replica.jPrefixRound).toBeUndefined();
  });

  test('an active proposer cannot censor an observed DisputeStarted before or after timeout', async () => {
    // Three runtimes intentionally own only their validator key. A single
    // process holding every private key would hide proposer-controlled signing.
    const proposerEnv = createEmptyEnv('j-prefix-proposer-runtime');
    const validatorEnv = createEmptyEnv('j-prefix-validator-runtime');
    const laggingEnv = createEmptyEnv('j-prefix-lagging-runtime');
    const proposerId = installOwnKey(proposerEnv, 'proposer');
    const validatorId = installOwnKey(validatorEnv, 'validator');
    const laggingId = installOwnKey(laggingEnv, 'lagging');
    const validators = [proposerId, validatorId, laggingId];
    entityId = generateLazyEntityId(validators, 3n);
    const baseState = makeState(validators);

    const proposerReplica: EntityReplica = {
      entityId,
      signerId: proposerId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer: true,
      jHistory: observedThrough(11, true),
    };
    const validatorReplica: EntityReplica = {
      entityId,
      signerId: validatorId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer: false,
      jHistory: observedThrough(11, true),
    };
    const laggingReplica: EntityReplica = {
      entityId,
      signerId: laggingId,
      state: structuredClone(baseState),
      mempool: [],
      isProposer: false,
      jHistory: observedThrough(10, false),
    };
    proposerEnv.eReplicas.set(`${entityId}:${proposerId}`, proposerReplica);
    validatorEnv.eReplicas.set(`${entityId}:${validatorId}`, validatorReplica);
    laggingEnv.eReplicas.set(`${entityId}:${laggingId}`, laggingReplica);

    for (const timestamp of [2_000, 62_001]) {
      proposerEnv.timestamp = timestamp;
      validatorEnv.timestamp = timestamp;
      const proposal = await buildOrdinaryProposal(proposerEnv, proposerReplica.state, proposerId, timestamp);
      const result = await applyEntityInput(validatorEnv, validatorReplica, {
        entityId,
        signerId: validatorId,
        proposedFrame: proposal,
      });

      expect(result.outcome).toEqual({ kind: 'rejected', code: 'PROPOSAL_J_RANGE_MISMATCH' });
      expect(result.outputs).toHaveLength(0);
      expect(result.workingReplica.lockedFrame).toBeUndefined();
    }
  });
});

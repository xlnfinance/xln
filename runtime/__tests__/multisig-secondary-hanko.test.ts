import { describe, expect, test } from 'bun:test';

import { accountInputProposal } from '../account/consensus/flush';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { createSettlementWorkspaceHash } from '../account/tx/handlers/settle-transition';
import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import {
  applyEntityFrame,
  applyEntityInput,
  attachTargetConsumptionProofs,
} from '../entity/consensus';
import {
  assertCertifiedEntityOutputWitnesses,
  assignCertifiedOutputIdentities,
  buildCertifiedEntityOutputHashes,
  hashCertifiedEntityOutput,
  hashCertifiedEntityOutputSemantic,
  isNonMutatingEntityWakeOutput,
} from '../entity/consensus/output-certification';
import {
  attachHankoWitnessToOutputs,
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from '../entity/consensus/hanko-witness';
import { generateLazyEntityId } from '../entity/factory';
import { handleExtendCreditEntityTx } from '../entity/tx/handlers/account-admin';
import { buildQuorumHanko, verifyHankoForHash } from '../hanko/signing';
import { createEmptyEnv } from '../runtime';
import { safeStringify } from '../protocol/serialization';
import { LIMITS } from '../constants';
import { hydrateEntityStateFromStorage, projectEntityCoreDoc } from '../storage/projections';
import { getConsumptionNodeStore } from '../entity/consumption-store';
import {
  createConsumptionProof,
  getConsumptionKey,
  verifyConsumptionProof,
} from '../entity/consumption-accumulator';
import type {
  AccountMachine,
  AccountInput,
  AccountTx,
  CrossJurisdictionSwapRoute,
  ConsensusOutputOrigin,
  EntityInput,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JReplica,
  JurisdictionConfig,
} from '../types';

const seed = 'multisig-secondary-hanko alpha beta gamma';
const signerLabels = ['1', '2', '3'];
const validators = signerLabels.map(label => deriveSignerAddressSync(seed, label).toLowerCase());
const counterpartySigner = deriveSignerAddressSync(seed, '4').toLowerCase();
const threshold = 3n;
const digest = (hex: string): string => `0x${hex.repeat(64)}`;
const mutateHexTail = (value: string): string =>
  `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;

const buildGenericOrigin = (
  sourceEntityId: string,
  targetEntityId: string,
  entityTxs: EntityTx[],
  sequence: bigint,
  height: number,
  frameHash: string,
  outputIndex: number,
): ConsensusOutputOrigin => ({
  sourceEntityId,
  lane: 'generic',
  sequence,
  semanticHash: hashCertifiedEntityOutputSemantic(
    sourceEntityId,
    targetEntityId,
    'generic',
    sequence,
    entityTxs,
  ),
  height,
  frameHash,
  outputIndex,
});

const buildCertifiedRemovalTx = (
  sourceEntityId: string,
  targetEntityId: string,
  reason: string,
): EntityTx => {
  const route = {
    orderId: `certified-remove-${sourceEntityId.slice(-8)}-${targetEntityId.slice(-8)}`,
    routeHash: digest('e'),
    bookOwnerEntityId: targetEntityId,
    makerEntityId: sourceEntityId,
    hubEntityId: targetEntityId,
    source: {
      jurisdiction: 'source-j', entityId: sourceEntityId,
      counterpartyEntityId: targetEntityId, tokenId: 1, amount: 1n,
    },
    target: {
      jurisdiction: 'target-j', entityId: targetEntityId,
      counterpartyEntityId: sourceEntityId, tokenId: 2, amount: 1n,
    },
    status: 'resting',
    createdAt: 1,
    updatedAt: 1,
  } satisfies CrossJurisdictionSwapRoute;
  return {
    type: 'removeCrossJurisdictionBookOrder',
    data: { orderId: route.orderId, sourceEntityId, route, reason },
  };
};

const registerOnly = (env: Env, signerId: string) => {
  clearSignerKeys(env);
  const label = signerLabels[validators.indexOf(signerId)] ?? '4';
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, label));
};

const createMultisigAccountState = (
  localSignerId = validators[0]!,
  authority: { validators: string[]; threshold: bigint } = { validators, threshold },
) => {
  const env = createEmptyEnv(`${seed}:runtime:${localSignerId}`);
  registerOnly(env, localSignerId);
  env.timestamp = 10_000;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  const entityId = generateLazyEntityId(authority.validators, authority.threshold).toLowerCase();
  const counterpartyId = generateLazyEntityId([counterpartySigner], 1n).toLowerCase();
  const [leftEntity, rightEntity] = [entityId, counterpartyId].sort();
  const jurisdiction: JurisdictionConfig = {
    name: 'MultisigHanko',
    address: 'rpc://multisig-hanko',
    chainId: 31_337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  };
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    chainId: jurisdiction.chainId,
    rpcs: [jurisdiction.address!],
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: `0x${'98'.repeat(20)}`,
      deltaTransformer: `0x${'99'.repeat(20)}`,
    },
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  } satisfies JReplica);
  const account = {
    leftEntity,
    rightEntity,
    domain: {
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.depositoryAddress,
    },
    status: 'active',
    mempool: [{ type: 'add_delta', data: { tokenId: 1 } }],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: '',
      byLeft: entityId === leftEntity,
    },
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    watchSeed: `0x${'f1'.repeat(32)}`,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
  } as AccountMachine;
  const state = {
    entityId,
    height: 0,
    timestamp: env.timestamp,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: authority.threshold,
      validators: authority.validators,
      shares: Object.fromEntries(authority.validators.map(validator => [validator, 1n])),
      jurisdiction,
    },
    reserves: new Map(),
    accounts: new Map([[counterpartyId, account]]),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'11'.repeat(32)}`,
    entityEncPrivKey: `0x${'22'.repeat(32)}`,
    profile: { name: 'Multisig entity', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
  } as EntityState;
  const replica: EntityReplica = {
    entityId,
    signerId: localSignerId,
    mempool: [],
    isProposer: localSignerId === authority.validators[0],
    state,
  };
  env.eReplicas.set(`${entityId}:${localSignerId}`, replica);
  env.eReplicas.set(`${counterpartyId}:${counterpartySigner}`, {
    entityId: counterpartyId,
    signerId: counterpartySigner,
    mempool: [],
    isProposer: true,
    state: {
      ...structuredClone(state),
      entityId: counterpartyId,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [counterpartySigner],
        shares: { [counterpartySigner]: 1n },
        jurisdiction,
      },
      accounts: new Map(),
    },
  });
  return { env, state, replica, entityId, counterpartyId };
};

const buildExactQuorumHanko = async (
  setup: ReturnType<typeof createMultisigAccountState>,
  hash: string,
): Promise<string> => {
  const signatures = validators.map(signerId => {
    const signerEnv = createEmptyEnv(`${seed}:quorum:${signerId}`);
    registerOnly(signerEnv, signerId);
    return { signerId, signature: signAccountFrame(signerEnv, signerId, hash) };
  });
  return buildQuorumHanko(setup.env, setup.entityId, hash, signatures, setup.state.config);
};

describe('multisig secondary Hanko production', () => {
  test('prepare cross-j output binds exact payload and requires real source-board quorum', async () => {
    const source = createMultisigAccountState(validators[0]);
    const route = {
      orderId: 'certified-prepare-cross-j',
      routeHash: digest('9'),
      bookOwnerEntityId: source.counterpartyId,
      makerEntityId: source.entityId,
      hubEntityId: source.counterpartyId,
      source: {
        jurisdiction: 'source-j',
        entityId: source.entityId,
        counterpartyEntityId: source.counterpartyId,
        tokenId: 1,
        amount: 10n,
      },
      target: {
        jurisdiction: 'target-j',
        entityId: digest('8'),
        counterpartyEntityId: digest('7'),
        tokenId: 2,
        amount: 20n,
      },
      status: 'intent',
      createdAt: 1,
      updatedAt: 1,
    } satisfies CrossJurisdictionSwapRoute;
    const entityTxs: EntityTx[] = [{
      type: 'prepareCrossJurisdictionSwap',
      data: { route },
    }];
    const origin = buildGenericOrigin(
      source.entityId,
      source.counterpartyId,
      entityTxs,
      1n,
      1,
      digest('6'),
      0,
    );
    const exactHash = hashCertifiedEntityOutput(origin, source.counterpartyId, entityTxs);
    const quorumHanko = await buildExactQuorumHanko(source, exactHash);
    expect((await verifyHankoForHash(
      quorumHanko,
      exactHash,
      source.entityId,
      source.env,
    )).valid).toBe(true);

    const tampered = structuredClone(entityTxs);
    if (tampered[0]?.type !== 'prepareCrossJurisdictionSwap') {
      throw new Error('TEST_PREPARE_CROSS_J_TX_MISSING');
    }
    tampered[0].data.route.target.amount += 1n;
    const tamperedHash = hashCertifiedEntityOutput(origin, source.counterpartyId, tampered);
    expect(tamperedHash).not.toBe(exactHash);
    expect((await verifyHankoForHash(
      quorumHanko,
      tamperedHash,
      source.entityId,
      source.env,
    )).valid).toBe(false);

    registerOnly(source.env, validators[0]!);
    const proposerSignature = signAccountFrame(source.env, validators[0]!, exactHash);
    await expect(buildQuorumHanko(
      source.env,
      source.entityId,
      exactHash,
      [{ signerId: validators[0]!, signature: proposerSignature }],
      source.state.config,
    )).rejects.toThrow('BUILD_QUORUM_HANKO_INSUFFICIENT_QUORUM');
  });

  test('single-signer certifies the exact cross-Entity Account output before target replay', async () => {
    const source = createMultisigAccountState(validators[0], {
      validators: [validators[0]!],
      threshold: 1n,
    });
    const target = source.env.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`);
    const sharedGenesis = source.state.accounts.get(source.counterpartyId);
    if (!target || !sharedGenesis) throw new Error('TEST_SINGLE_SIGNER_ACCOUNT_PAIR_MISSING');
    const targetGenesis = structuredClone(sharedGenesis);
    targetGenesis.proofHeader = {
      ...targetGenesis.proofHeader,
      fromEntity: source.counterpartyId,
      toEntity: source.entityId,
    };
    targetGenesis.currentFrame.byLeft = source.counterpartyId === targetGenesis.leftEntity;
    target.state.accounts.set(source.entityId, targetGenesis);

    const committed = await applyEntityInput(source.env, source.replica, {
      entityId: source.entityId,
      signerId: validators[0]!,
    });
    expect(committed.workingReplica.state.height).toBe(1);
    const outbound = committed.outputs.find(output =>
      output.entityId === source.counterpartyId && output.entityTxs?.length,
    );
    if (!outbound) throw new Error('TEST_SINGLE_SIGNER_ACCOUNT_OUTPUT_MISSING');
    const certifiedTx = outbound.entityTxs?.[0];
    if (certifiedTx?.type !== 'consensusOutput') {
      throw new Error(`TEST_SINGLE_SIGNER_OUTPUT_NOT_CERTIFIED:${certifiedTx?.type ?? 'missing'}`);
    }
    expect(certifiedTx.data.consumptionProof).toBeUndefined();
    expect(certifiedTx.data.targetEntityId).toBe(source.counterpartyId);
    const exactOutputHash = hashCertifiedEntityOutput(
      certifiedTx.data.origin,
      certifiedTx.data.targetEntityId,
      certifiedTx.data.entityTxs,
    );
    expect((await verifyHankoForHash(
      certifiedTx.data.outputHanko,
      exactOutputHash,
      source.entityId,
      source.env,
    )).valid).toBe(true);
    const [targetPrepared] = attachTargetConsumptionProofs(source.env, target.state, [certifiedTx]);
    if (targetPrepared?.type !== 'consensusOutput') throw new Error('TEST_TARGET_PROOF_MISSING');
    expect(targetPrepared.data.consumptionProof).toBeDefined();
    expect(hashCertifiedEntityOutput(
      targetPrepared.data.origin,
      targetPrepared.data.targetEntityId,
      targetPrepared.data.entityTxs,
    )).toBe(exactOutputHash);
    expect(getConsumptionNodeStore(source.env).size).toBe(0);

    registerOnly(source.env, counterpartySigner);
    const accepted = await applyEntityInput(source.env, target, structuredClone(outbound));
    expect(accepted.outcome.kind).toBe('committed');
    expect(accepted.workingReplica.state.consumptionAccumulator?.count).toBe(1n);
    expect(getConsumptionNodeStore(source.env).size).toBe(1);
  });

  test('target proposer builds sequential proofs without publishing speculative CAS nodes', async () => {
    const source = createMultisigAccountState(validators[0]);
    const target = source.env.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`);
    if (!target) throw new Error('TEST_TARGET_REPLICA_MISSING');
    const rawOutputs: EntityTx[] = [];
    for (let outputIndex = 0; outputIndex < 2; outputIndex += 1) {
      const entityTxs = [buildCertifiedRemovalTx(
        source.entityId,
        source.counterpartyId,
        `sequential-${outputIndex}`,
      )];
      const origin = buildGenericOrigin(
        source.entityId,
        source.counterpartyId,
        entityTxs,
        BigInt(outputIndex + 1),
        1,
        digest('d'),
        outputIndex,
      );
      const outputHash = hashCertifiedEntityOutput(origin, source.counterpartyId, entityTxs);
      rawOutputs.push({
        type: 'consensusOutput',
        data: {
          origin,
          outputHanko: await buildExactQuorumHanko(source, outputHash),
          targetEntityId: source.counterpartyId,
          entityTxs,
        },
      });
    }

    expect(getConsumptionNodeStore(source.env).size).toBe(0);
    const proposedTxs = attachTargetConsumptionProofs(source.env, target.state, rawOutputs);
    expect(proposedTxs.every(tx => tx.type === 'consensusOutput' && tx.data.consumptionProof)).toBe(true);
    expect(getConsumptionNodeStore(source.env).size).toBe(0);

    const replay = await applyEntityFrame(source.env, target.state, proposedTxs, source.env.timestamp + 1);
    expect(replay.newState.consumptionAccumulator?.count).toBe(1n);
    expect(replay.consumptionNodeChanges?.newNodes).toHaveLength(1);
    expect(getConsumptionNodeStore(source.env).size).toBe(0);
  });

  test('keeps a sequence gap durable, then applies it after the missing output commits', async () => {
    const source = createMultisigAccountState(validators[0]);
    const target = source.env.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`);
    if (!target) throw new Error('TEST_TARGET_REPLICA_MISSING');
    const certifiedOutput = async (sequence: bigint, reason: string): Promise<EntityTx> => {
      const entityTxs = [buildCertifiedRemovalTx(source.entityId, source.counterpartyId, reason)];
      const origin = buildGenericOrigin(
        source.entityId,
        source.counterpartyId,
        entityTxs,
        sequence,
        1,
        digest('d'),
        Number(sequence - 1n),
      );
      const outputHash = hashCertifiedEntityOutput(origin, source.counterpartyId, entityTxs);
      return {
        type: 'consensusOutput',
        data: {
          origin,
          outputHanko: await buildExactQuorumHanko(source, outputHash),
          targetEntityId: source.counterpartyId,
          entityTxs,
        },
      };
    };
    const sequenceTwo = await certifiedOutput(2n, 'gap-two');
    const sequenceOne = await certifiedOutput(1n, 'gap-one');
    registerOnly(source.env, counterpartySigner);

    const deferred = await applyEntityInput(source.env, target, {
      entityId: source.counterpartyId,
      signerId: counterpartySigner,
      entityTxs: [sequenceTwo],
    });
    expect(deferred.workingReplica.state.consumptionAccumulator).toBeUndefined();
    expect(deferred.workingReplica.mempool).toEqual([sequenceTwo]);

    const gapFilled = await applyEntityInput(source.env, deferred.workingReplica, {
      entityId: source.counterpartyId,
      signerId: counterpartySigner,
      entityTxs: [sequenceOne],
    });
    expect(gapFilled.workingReplica.mempool).toHaveLength(0);
    const accumulator = gapFilled.workingReplica.state.consumptionAccumulator;
    if (!accumulator) throw new Error('TEST_CONSUMPTION_ACCUMULATOR_MISSING');
    const key = getConsumptionKey({
      sourceEntityId: source.entityId,
      targetEntityId: source.counterpartyId,
      lane: 'generic',
    });
    const proof = createConsumptionProof(getConsumptionNodeStore(source.env), accumulator.root, key);
    expect(verifyConsumptionProof(accumulator.root, key, proof)).toEqual({
      status: 'member',
      value: expect.objectContaining({ lastContiguousSeq: 2n, count: 2n }),
    });
  });

  test('permits only a typed empty wake to bypass output certification', () => {
    const setup = createMultisigAccountState();
    const wake = {
      entityId: `0x${'11'.repeat(32)}`,
      signerId: validators[0]!,
      entityTxs: [],
    } satisfies EntityInput;
    expect(isNonMutatingEntityWakeOutput(wake)).toBe(true);
    expect(buildCertifiedEntityOutputHashes(setup.state, setup.env, 1, digest('a'), [wake])).toEqual([]);

    const protocolMessage = {
      ...wake,
      hashPrecommitFrame: { height: 1, frameHash: digest('b') },
      hashPrecommits: new Map([[validators[0]!, [digest('c')]]]),
    } satisfies EntityInput;
    expect(isNonMutatingEntityWakeOutput(protocolMessage)).toBe(false);
    expect(() => buildCertifiedEntityOutputHashes(setup.state, setup.env, 1, digest('a'), [protocolMessage]))
      .toThrow('CONSENSUS_OUTPUT_RECEIVER_DEDUP_UNAVAILABLE');

    const mutation = {
      ...wake,
      entityTxs: [{ type: 'chat', data: { from: 'source', message: 'certify me' } }],
    } satisfies EntityInput;
    expect(isNonMutatingEntityWakeOutput(mutation)).toBe(false);
    const assignedState = assignCertifiedOutputIdentities(setup.state, [mutation]);
    expect(buildCertifiedEntityOutputHashes(assignedState, setup.env, 1, digest('a'), [mutation]))
      .toHaveLength(1);

    const mixedReliable = {
      ...wake,
      entityTxs: [{
        type: 'accountInput',
        data: {
          kind: 'ack',
          fromEntityId: setup.state.entityId,
          toEntityId: setup.counterpartyId,
          ack: { height: 1, frameHash: digest('e'), frameHanko: '0x01' },
        },
      }, mutation.entityTxs[0]!],
    } as EntityInput;
    expect(() => buildCertifiedEntityOutputHashes(
      setup.state,
      setup.env,
      1,
      digest('f'),
      [mixedReliable],
    )).toThrow('CONSENSUS_OUTPUT_RELIABLE_PAYLOAD_MUST_BE_ATOMIC');

    const realTrigger = handleExtendCreditEntityTx(setup.state, {
      type: 'extendCredit',
      data: { counterpartyEntityId: setup.counterpartyId, tokenId: 1, amount: 5n },
    }).outputs;
    expect(realTrigger).toHaveLength(1);
    expect(isNonMutatingEntityWakeOutput(realTrigger[0]!)).toBe(true);
    expect(buildCertifiedEntityOutputHashes(setup.state, setup.env, 1, digest('d'), realTrigger)).toEqual([]);
  });

  test('bounds generic source target frontiers while allowing an existing relationship to advance', () => {
    const setup = createMultisigAccountState(validators[0]);
    const frontierEntries = Array.from({ length: LIMITS.MAX_ACCOUNTS_PER_ENTITY }, (_, index) => [
      `0x${BigInt(index + 1).toString(16).padStart(64, '0')}`,
      { lastSequence: 1n, lastSemanticHash: digest('a') },
    ] as const);
    const fullState: EntityState = {
      ...setup.state,
      certifiedOutputSequences: new Map(frontierEntries),
    };
    const existingTarget = frontierEntries[0]![0];
    const existingPayload = [buildCertifiedRemovalTx(setup.entityId, existingTarget, 'existing')];
    const advancedOutputs: EntityInput[] = [{
      entityId: existingTarget,
      signerId: validators[0]!,
      entityTxs: existingPayload,
    }];
    const advanced = assignCertifiedOutputIdentities(fullState, advancedOutputs);
    expect(advanced.certifiedOutputSequences?.size).toBe(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
    expect(advanced.certifiedOutputSequences?.get(existingTarget)?.lastSequence).toBe(2n);

    const newTarget = `0x${BigInt(LIMITS.MAX_ACCOUNTS_PER_ENTITY + 1).toString(16).padStart(64, '0')}`;
    const overflowOutputs: EntityInput[] = [{
      entityId: newTarget,
      signerId: validators[0]!,
      entityTxs: [buildCertifiedRemovalTx(setup.entityId, newTarget, 'overflow')],
    }];
    expect(() => assignCertifiedOutputIdentities(fullState, overflowOutputs)).toThrow(
      `CONSENSUS_OUTPUT_SOURCE_RELATIONSHIP_LIMIT_EXCEEDED:` +
      `${LIMITS.MAX_ACCOUNTS_PER_ENTITY}:${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
    );
    expect(fullState.certifiedOutputSequences?.size).toBe(LIMITS.MAX_ACCOUNTS_PER_ENTITY);
  });

  test('outbound proposals expose no proposer state or entity encryption secret', async () => {
    const setup = createMultisigAccountState(validators[0]);
    const proposed = await applyEntityInput(setup.env, setup.replica, {
      entityId: setup.entityId,
      signerId: validators[0]!,
    });
    const outbound = proposed.outputs.find(output => output.proposedFrame)?.proposedFrame;
    if (!outbound) throw new Error('TEST_OUTBOUND_ENTITY_PROPOSAL_MISSING');

    const wireJson = safeStringify(outbound);
    expect(wireJson).not.toContain(setup.state.entityEncPrivKey);
    expect(wireJson).not.toContain('entityEncPrivKey');
    expect(wireJson).not.toContain('"newState"');
    expect(wireJson).not.toContain('"outputs"');
    expect(wireJson).not.toContain('"jOutputs"');
  });

  test('rejects proposer-supplied side effects outside the signed local replay', async () => {
    const proposer = createMultisigAccountState(validators[0]);
    const proposed = await applyEntityInput(proposer.env, proposer.replica, {
      entityId: proposer.entityId,
      signerId: validators[0]!,
    });
    const proposal = proposed.workingReplica.proposal;
    if (!proposal) throw new Error('TEST_ENTITY_PROPOSAL_MISSING');

    const validator = createMultisigAccountState(validators[1]);
    const rejected = await applyEntityInput(validator.env, validator.replica, {
      entityId: validator.entityId,
      signerId: validators[1]!,
      proposedFrame: {
        ...structuredClone(proposal),
        outputs: [{
          entityId: validator.counterpartyId,
          signerId: counterpartySigner,
          entityTxs: [{
            type: 'chat',
            data: { from: validator.entityId, message: 'proposer-controlled side effect' },
          }],
        }],
      } as never,
    });
    expect(rejected.outcome).toEqual({ kind: 'rejected', code: 'ENTITY_INPUT_INVALID' });
    expect(rejected.outputs).toEqual([]);
    expect(validator.replica.state.height).toBe(0);

    const secretRejected = await applyEntityInput(validator.env, validator.replica, {
      entityId: validator.entityId,
      signerId: validators[1]!,
      proposedFrame: {
        ...structuredClone(proposal),
        entityEncPrivKey: validator.state.entityEncPrivKey,
      } as never,
    });
    expect(secretRejected.outcome).toEqual({ kind: 'rejected', code: 'ENTITY_INPUT_INVALID' });
    expect(secretRejected.outputs).toEqual([]);
  });

  test('account proposal produces unsigned drafts for the Entity quorum to seal', async () => {
    const { env, state, counterpartyId } = createMultisigAccountState();

    const result = await applyEntityFrame(env, state, [], env.timestamp);
    const proposedAccount = result.newState.accounts.get(counterpartyId);
    if (!proposedAccount?.pendingFrame || !proposedAccount.pendingAccountInput) {
      throw new Error('TEST_MULTISIG_ACCOUNT_PROPOSAL_MISSING');
    }
    const outboundProposal = accountInputProposal(proposedAccount.pendingAccountInput);
    if (!outboundProposal) throw new Error('TEST_MULTISIG_ACCOUNT_OUTPUT_MISSING');

    expect(result.collectedHashes.map(({ type }) => type)).toEqual(['accountFrame', 'dispute']);
    expect(proposedAccount.currentFrameHanko).toBeUndefined();
    expect(proposedAccount.currentDisputeProofHanko).toBeUndefined();
    expect(outboundProposal.frameHanko).toBeUndefined();
    expect(outboundProposal.disputeSeal?.hanko).toBeUndefined();
  });

  test('isolated validators replay, sign, and quorum-seal the exact Account draft', async () => {
    const proposerSetup = createMultisigAccountState(validators[0]);
    const proposed = await applyEntityInput(proposerSetup.env, proposerSetup.replica, {
      entityId: proposerSetup.entityId,
      signerId: validators[0]!,
    });
    const proposal = proposed.workingReplica.proposal;
    if (!proposal) throw new Error('TEST_ENTITY_PROPOSAL_MISSING');
    const proposalManifest = proposal.hashesToSign ?? [];
    expect(proposalManifest[0]?.type).toBe('entityFrame');
    expect(proposalManifest.slice(1).map(({ type }) => type).sort()).toEqual([
      'accountFrame',
      'dispute',
      'entityOutput',
    ]);
    const secondaryHashes = proposalManifest.slice(1).map(({ hash }) => hash);
    expect(secondaryHashes).toEqual([...secondaryHashes].sort());

    const validatorPrecommits = [];
    for (const signerId of validators.slice(1)) {
      const validatorSetup = createMultisigAccountState(signerId);
      const replayed = await applyEntityInput(validatorSetup.env, validatorSetup.replica, {
        entityId: validatorSetup.entityId,
        signerId,
        proposedFrame: structuredClone(proposal),
      });
      expect(replayed.workingReplica.lockedFrame?.hash).toBe(proposal.hash);
      const precommit = replayed.outputs.find(output => output.signerId === validators[0] && output.hashPrecommits);
      if (!precommit) throw new Error(`TEST_PRECOMMIT_MISSING:${signerId}`);
      expect(Array.from(precommit.hashPrecommits?.keys() ?? [])).toEqual([signerId]);
      validatorPrecommits.push(structuredClone(precommit));
    }

    registerOnly(proposerSetup.env, validators[0]!);
    let leader = proposed;
    for (const [index, precommit] of validatorPrecommits.entries()) {
      leader = await applyEntityInput(proposerSetup.env, leader.workingReplica, precommit);
      if (index === 0) {
        expect(leader.workingReplica.state.height).toBe(0);
        expect(leader.workingReplica.proposal?.collectedSigs?.size).toBe(2);
      }
    }
    expect(leader.workingReplica.state.height).toBe(1);

    const outbound = leader.outputs
      .flatMap(output => output.entityTxs ?? [])
      .flatMap(tx => tx.type === 'consensusOutput' ? tx.data.entityTxs : [tx])
      .find(tx => tx.type === 'accountInput');
    const sealedProposal = outbound?.type === 'accountInput' ? accountInputProposal(outbound.data) : undefined;
    if (!sealedProposal?.frameHanko || !sealedProposal.disputeSeal?.hanko) {
      throw new Error('TEST_QUORUM_SEALED_OUTPUT_MISSING');
    }
    const persisted = leader.workingReplica.state.accounts.get(proposerSetup.counterpartyId);
    expect(persisted?.currentFrameHanko).toBe(sealedProposal.frameHanko);
    expect(persisted?.currentDisputeProofHanko).toBe(sealedProposal.disputeSeal.hanko);
    expect(accountInputProposal(persisted?.pendingAccountInput)?.frameHanko).toBe(sealedProposal.frameHanko);

    expect((await verifyHankoForHash(
      sealedProposal.frameHanko,
      sealedProposal.frame.stateHash,
      proposerSetup.entityId,
      proposerSetup.env,
    )).valid).toBe(true);
    expect((await verifyHankoForHash(
      sealedProposal.disputeSeal.hanko,
      sealedProposal.disputeSeal.hash,
      proposerSetup.entityId,
      proposerSetup.env,
    )).valid).toBe(true);
  });

  test('same-hash quorum notice commits the proposer from its local execution bundle', async () => {
    const proposer = createMultisigAccountState(validators[0]);
    const proposed = await applyEntityInput(proposer.env, proposer.replica, {
      entityId: proposer.entityId,
      signerId: validators[0]!,
    });
    const proposal = proposed.workingReplica.proposal;
    if (!proposal) throw new Error('TEST_ENTITY_PROPOSAL_MISSING');

    const second = createMultisigAccountState(validators[1]);
    const secondPrepared = await applyEntityInput(second.env, second.replica, {
      entityId: second.entityId,
      signerId: validators[1]!,
      proposedFrame: structuredClone(proposal),
    });
    const third = createMultisigAccountState(validators[2]);
    const thirdPrepared = await applyEntityInput(third.env, third.replica, {
      entityId: third.entityId,
      signerId: validators[2]!,
      proposedFrame: structuredClone(proposal),
    });
    const thirdPrecommitForSecond = thirdPrepared.outputs.find(output =>
      output.signerId === validators[1] && output.hashPrecommits,
    );
    if (!thirdPrecommitForSecond) throw new Error('TEST_THIRD_PRECOMMIT_FOR_SECOND_MISSING');

    registerOnly(second.env, validators[1]!);
    const followerCommit = await applyEntityInput(
      second.env,
      secondPrepared.workingReplica,
      structuredClone(thirdPrecommitForSecond),
    );
    expect(followerCommit.workingReplica.state.height).toBe(1);
    const followerSideEffect = followerCommit.outputs.find(output => output.entityTxs?.length);
    if (!followerSideEffect) throw new Error('TEST_FOLLOWER_SIDE_EFFECT_MISSING');
    expect(followerSideEffect.entityTxs?.[0]?.type).toBe('consensusOutput');
    const noticeForProposer = followerCommit.outputs.find(output =>
      output.signerId === validators[0] && output.proposedFrame?.hankos?.length,
    );
    if (!noticeForProposer) throw new Error('TEST_QUORUM_NOTICE_FOR_PROPOSER_MISSING');

    registerOnly(proposer.env, validators[0]!);
    const caughtUp = await applyEntityInput(
      proposer.env,
      proposed.workingReplica,
      structuredClone(noticeForProposer),
    );
    expect(caughtUp.workingReplica.state.height).toBe(1);
    expect(caughtUp.workingReplica.proposal).toBeUndefined();
    expect(caughtUp.workingReplica.validatorExecution).toBeUndefined();
    const proposerSideEffect = caughtUp.outputs.find(output => output.entityTxs?.length);
    if (!proposerSideEffect) throw new Error('TEST_PROPOSER_SIDE_EFFECT_MISSING');
    expect(safeStringify(proposerSideEffect.entityTxs)).toBe(safeStringify(followerSideEffect.entityTxs));

    const emittedCertifiedTx = followerSideEffect.entityTxs?.[0];
    if (emittedCertifiedTx?.type !== 'consensusOutput') {
      throw new Error('TEST_EMITTED_CERTIFIED_OUTPUT_MISSING');
    }
    const emittedOutputHash = hashCertifiedEntityOutput(
      emittedCertifiedTx.data.origin,
      emittedCertifiedTx.data.targetEntityId,
      emittedCertifiedTx.data.entityTxs,
    );
    expect((await verifyHankoForHash(
      emittedCertifiedTx.data.outputHanko,
      emittedOutputHash,
      proposer.entityId,
      proposer.env,
    )).valid).toBe(true);
    const witnessTamperedTxs = structuredClone(emittedCertifiedTx.data.entityTxs);
    const witnessInput = witnessTamperedTxs.find(tx => tx.type === 'accountInput');
    const witnessProposal = witnessInput?.type === 'accountInput'
      ? accountInputProposal(witnessInput.data)
      : undefined;
    if (!witnessProposal?.frameHanko) throw new Error('TEST_OUTPUT_WITNESS_MISSING');
    witnessProposal.frameHanko = mutateHexTail(witnessProposal.frameHanko);
    expect(hashCertifiedEntityOutput(
      emittedCertifiedTx.data.origin,
      emittedCertifiedTx.data.targetEntityId,
      witnessTamperedTxs,
    )).toBe(emittedOutputHash);
    await expect(assertCertifiedEntityOutputWitnesses(
      witnessTamperedTxs,
      proposer.entityId,
      proposer.env,
    )).rejects.toThrow(/CONSENSUS_OUTPUT_WITNESS_HANKO_INVALID/);

    const dedupEntityTxs: EntityTx[] = [buildCertifiedRemovalTx(
      proposer.entityId,
      proposer.counterpartyId,
      'provider-alpha',
    )];
    const dedupOrigin = buildGenericOrigin(
      proposer.entityId,
      proposer.counterpartyId,
      dedupEntityTxs,
      1n,
      proposal.height,
      proposal.hash,
      99,
    );
    const dedupHash = hashCertifiedEntityOutput(
      dedupOrigin,
      proposer.counterpartyId,
      dedupEntityTxs,
    );
    const dedupHanko = await buildExactQuorumHanko(proposer, dedupHash);
    const providerTamperedTxs = structuredClone(dedupEntityTxs);
    const providerTamperedRemoval = providerTamperedTxs[0];
    if (providerTamperedRemoval?.type !== 'removeCrossJurisdictionBookOrder') {
      throw new Error('TEST_CERTIFIED_REMOVAL_MISSING');
    }
    providerTamperedRemoval.data.reason = 'provider-beta';
    const providerTamperedOrigin: ConsensusOutputOrigin = {
      ...dedupOrigin,
      semanticHash: hashCertifiedEntityOutputSemantic(
        proposer.entityId,
        proposer.counterpartyId,
        'generic',
        dedupOrigin.sequence,
        providerTamperedTxs,
      ),
    };
    const providerTamperedHash = hashCertifiedEntityOutput(
      providerTamperedOrigin,
      proposer.counterpartyId,
      providerTamperedTxs,
    );
    expect(providerTamperedHash).not.toBe(dedupHash);
    const providerTamperedHanko = await buildExactQuorumHanko(proposer, providerTamperedHash);
    const certifiedInput = {
      entityId: proposer.counterpartyId,
      signerId: counterpartySigner,
      entityTxs: [{
        type: 'consensusOutput' as const,
        data: {
          origin: dedupOrigin,
          outputHanko: dedupHanko,
          targetEntityId: proposer.counterpartyId,
          entityTxs: dedupEntityTxs,
        },
      }],
    };
    const targetKey = `${proposer.counterpartyId}:${counterpartySigner}`;
    const targetReplica = proposer.env.eReplicas.get(targetKey);
    if (!targetReplica) throw new Error('TEST_TARGET_REPLICA_MISSING');
    registerOnly(proposer.env, counterpartySigner);
    const firstDelivery = await applyEntityInput(proposer.env, targetReplica, structuredClone(certifiedInput));
    const accountAfterFirst = structuredClone(firstDelivery.workingReplica.state.accounts);
    const messagesAfterFirst = structuredClone(firstDelivery.workingReplica.state.messages);
    const restoredState = hydrateEntityStateFromStorage({
      core: projectEntityCoreDoc(firstDelivery.workingReplica.state),
      accounts: new Map(),
      books: new Map(),
    });
    expect(restoredState.consumptionAccumulator).toEqual(
      firstDelivery.workingReplica.state.consumptionAccumulator,
    );
    const duplicateDelivery = await applyEntityInput(
      proposer.env,
      { ...firstDelivery.workingReplica, state: restoredState },
      structuredClone(certifiedInput),
    );
    expect(duplicateDelivery.workingReplica.state.consumptionAccumulator?.count).toBe(1n);
    expect(safeStringify(duplicateDelivery.workingReplica.state.accounts)).toBe(safeStringify(accountAfterFirst));
    expect(safeStringify(duplicateDelivery.workingReplica.state.messages)).toBe(safeStringify(messagesAfterFirst));
    const quarantinedDelivery = await applyEntityInput(proposer.env, duplicateDelivery.workingReplica, {
      ...structuredClone(certifiedInput),
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin: providerTamperedOrigin,
          outputHanko: providerTamperedHanko,
          targetEntityId: proposer.counterpartyId,
          entityTxs: providerTamperedTxs,
        },
      }],
    });
    expect(quarantinedDelivery.outcome.kind).toBe('committed');
    expect(safeStringify(quarantinedDelivery.workingReplica.state.accounts)).toBe(safeStringify(accountAfterFirst));
    expect(safeStringify(quarantinedDelivery.workingReplica.state.messages)).toBe(safeStringify(messagesAfterFirst));
    expect(quarantinedDelivery.workingReplica.state.consumptionAccumulator?.count).toBe(1n);
    const quarantinedAccumulator = quarantinedDelivery.workingReplica.state.consumptionAccumulator;
    if (!quarantinedAccumulator) throw new Error('TEST_QUARANTINED_ACCUMULATOR_MISSING');
    const quarantinedKey = getConsumptionKey({
      sourceEntityId: proposer.entityId,
      targetEntityId: proposer.counterpartyId,
      lane: 'generic',
    });
    const quarantinedProof = createConsumptionProof(
      getConsumptionNodeStore(proposer.env),
      quarantinedAccumulator.root,
      quarantinedKey,
    );
    expect(verifyConsumptionProof(
      quarantinedAccumulator.root,
      quarantinedKey,
      quarantinedProof,
    )).toEqual({
      status: 'member',
      value: expect.objectContaining({
        lastSemanticHash: dedupOrigin.semanticHash,
        lastOutputHash: dedupHash,
        lastOutputHanko: dedupHanko,
        quarantine: {
          sequence: 1n,
          conflictingSemanticHash: providerTamperedOrigin.semanticHash,
          conflictingOutputHash: providerTamperedHash,
          conflictingOutputHanko: providerTamperedHanko,
        },
      }),
    });
    await expect(applyEntityFrame(
      proposer.env,
      quarantinedDelivery.workingReplica.state,
      [{
        type: 'consensusOutput',
        data: {
          origin: providerTamperedOrigin,
          outputHanko: providerTamperedHanko,
          targetEntityId: proposer.counterpartyId,
          entityTxs: providerTamperedTxs,
          consumptionProof: quarantinedProof,
        },
      }],
      proposer.env.timestamp + 1,
    )).rejects.toThrow(/CONSENSUS_OUTPUT_RELATIONSHIP_QUARANTINED/);

    const assertTamperRejected = async (
      mutate: (tx: Extract<EntityTx, { type: 'consensusOutput' }>) => void,
      error: RegExp,
    ): Promise<void> => {
      const tampered = structuredClone(certifiedInput);
      const certifiedTx = tampered.entityTxs?.[0];
      if (certifiedTx?.type !== 'consensusOutput') throw new Error('TEST_CERTIFIED_OUTPUT_MISSING');
      mutate(certifiedTx);
      await expect(applyEntityInput(
        proposer.env,
        duplicateDelivery.workingReplica,
        tampered,
      )).rejects.toThrow(error);
    };
    await assertTamperRejected(
      tx => { tx.data.targetEntityId = proposer.entityId; },
      /CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH/,
    );
    await assertTamperRejected(
      tx => { tx.data.origin.outputIndex += 1; },
      /CONSENSUS_OUTPUT_HANKO_INVALID/,
    );
    await assertTamperRejected(
      tx => {
        const removal = tx.data.entityTxs[0];
        if (removal?.type !== 'removeCrossJurisdictionBookOrder') throw new Error('TEST_CERTIFIED_REMOVAL_MISSING');
        removal.data.reason = 'tampered';
      },
      /CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH/,
    );
    await assertTamperRejected(
      tx => {
        const removal = tx.data.entityTxs[0];
        if (removal?.type !== 'removeCrossJurisdictionBookOrder') throw new Error('TEST_CERTIFIED_REMOVAL_MISSING');
        removal.data.reason = 'provider-beta';
      },
      /CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH/,
    );
    await assertTamperRejected(
      tx => { tx.data.outputHanko = mutateHexTail(tx.data.outputHanko); },
      /HANKO/,
    );
  });

  test('certified output survives transport rerouting to another target validator', async () => {
    const source = createMultisigAccountState(validators[0]);
    const targetSeed = 'certified-output-target-validator alpha beta gamma';
    const targetValidators = ['1', '2'].map(slot =>
      deriveSignerAddressSync(targetSeed, slot).toLowerCase());
    const targetEntityId = generateLazyEntityId(targetValidators, 2n).toLowerCase();
    const targetConfig = {
      mode: 'proposer-based' as const,
      threshold: 2n,
      validators: targetValidators,
      shares: Object.fromEntries(targetValidators.map(signerId => [signerId, 1n])),
      jurisdiction: source.state.config.jurisdiction,
    };
    const targetTemplate: EntityState = {
      ...structuredClone(source.env.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`)!.state),
      entityId: targetEntityId,
      config: targetConfig,
      accounts: new Map(),
      leaderState: { activeValidatorId: targetValidators[0]!, view: 0, changedAtHeight: 0 },
    };
    const targetLeader: EntityReplica = {
      entityId: targetEntityId,
      signerId: targetValidators[0]!,
      state: structuredClone(targetTemplate),
      mempool: [],
      isProposer: true,
    };
    const targetFollower: EntityReplica = {
      entityId: targetEntityId,
      signerId: targetValidators[1]!,
      state: structuredClone(targetTemplate),
      mempool: [],
      isProposer: false,
    };
    source.env.eReplicas.set(`${targetEntityId}:${targetValidators[0]}`, targetLeader);
    source.env.eReplicas.set(`${targetEntityId}:${targetValidators[1]}`, targetFollower);

    const entityTxs: EntityTx[] = [buildCertifiedRemovalTx(
      source.entityId,
      targetEntityId,
      'route-independent certificate',
    )];
    const origin = buildGenericOrigin(
      source.entityId,
      targetEntityId,
      entityTxs,
      1n,
      1,
      digest('a'),
      0,
    );
    const outputHash = hashCertifiedEntityOutput(origin, targetEntityId, entityTxs);
    const outputHanko = await buildExactQuorumHanko(source, outputHash);
    const certifiedInput = {
      entityId: targetEntityId,
      signerId: targetValidators[0]!,
      entityTxs: [{
        type: 'consensusOutput' as const,
        data: { origin, outputHanko, targetEntityId, entityTxs },
      }],
    };

    clearSignerKeys(source.env);
    registerSignerKey(source.env, targetValidators[1]!, deriveSignerKeySync(targetSeed, '2'));
    const rerouted = await applyEntityInput(source.env, targetFollower, {
      ...structuredClone(certifiedInput),
      signerId: targetValidators[1]!,
    });
    expect(rerouted.outcome.kind).toBe('committed');
    const forwarded = rerouted.outputs.find(output =>
      output.entityId === targetEntityId &&
      output.signerId === targetValidators[0] &&
      output.entityTxs?.[0]?.type === 'consensusOutput',
    );
    if (!forwarded) throw new Error('TEST_REROUTED_CERTIFIED_OUTPUT_NOT_FORWARDED');

    clearSignerKeys(source.env);
    registerSignerKey(source.env, targetValidators[0]!, deriveSignerKeySync(targetSeed, '1'));
    const targetProposal = await applyEntityInput(source.env, targetLeader, forwarded);
    const proposalForFollower = targetProposal.outputs.find(output =>
      output.signerId === targetValidators[1] && output.proposedFrame,
    );
    if (!proposalForFollower) throw new Error('TEST_TARGET_PROPOSAL_MISSING');
    expect(targetProposal.workingReplica.state.height).toBe(0);
    expect(proposalForFollower.proposedFrame?.collectedSigs?.size).toBe(1);

    clearSignerKeys(source.env);
    registerSignerKey(source.env, targetValidators[1]!, deriveSignerKeySync(targetSeed, '2'));
    const replayed = await applyEntityInput(source.env, targetFollower, proposalForFollower);
    expect(replayed.outcome.kind).toBe('committed');
    expect(replayed.workingReplica.state.height).toBe(1);
    expect(replayed.workingReplica.state.consumptionAccumulator?.count).toBe(1n);
    expect(replayed.workingReplica.state.messages.some(message =>
      message.includes('route-independent certificate'),
    )).toBe(true);
  });

  test('rejects a valid source-A output Hanko whose nested account input claims source C', async () => {
    const source = createMultisigAccountState(validators[0]);
    const targetReplica = source.env.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`);
    if (!targetReplica) throw new Error('TEST_TARGET_REPLICA_MISSING');
    const forgedSource = digest('c');
    const entityTxs: EntityTx[] = [{
      type: 'accountInput',
      data: {
        kind: 'settle',
        fromEntityId: forgedSource,
        toEntityId: source.counterpartyId,
        settleAction: { type: 'reject', memo: 'must not mutate target' },
      },
    }];
    const origin = buildGenericOrigin(
      source.entityId,
      source.counterpartyId,
      entityTxs,
      1n,
      1,
      digest('d'),
      0,
    );
    const outputHash = hashCertifiedEntityOutput(origin, source.counterpartyId, entityTxs);
    const outputHanko = await buildExactQuorumHanko(source, outputHash);

    await expect(applyEntityFrame(source.env, targetReplica.state, [{
      type: 'consensusOutput',
      data: { origin, outputHanko, targetEntityId: source.counterpartyId, entityTxs },
    }], source.env.timestamp + 1)).rejects.toThrow(
      `CONSENSUS_OUTPUT_SEMANTIC_SOURCE_MISMATCH:accountInput:${source.entityId}`,
    );
    expect(targetReplica.state.height).toBe(0);
    expect(targetReplica.state.accounts.size).toBe(0);
  });

  test('validator rejects a source-certified output frame without a target consumption proof', async () => {
    const source = createMultisigAccountState(validators[0]);
    const targetReplica = source.env.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`);
    if (!targetReplica) throw new Error('TEST_TARGET_REPLICA_MISSING');
    const entityTxs: EntityTx[] = [buildCertifiedRemovalTx(
      source.entityId,
      source.counterpartyId,
      'proof required',
    )];
    const origin = buildGenericOrigin(
      source.entityId,
      source.counterpartyId,
      entityTxs,
      1n,
      1,
      digest('e'),
      0,
    );
    const outputHash = hashCertifiedEntityOutput(origin, source.counterpartyId, entityTxs);
    const outputHanko = await buildExactQuorumHanko(source, outputHash);

    await expect(applyEntityFrame(source.env, targetReplica.state, [{
      type: 'consensusOutput',
      data: { origin, outputHanko, targetEntityId: source.counterpartyId, entityTxs },
    }], source.env.timestamp + 1)).rejects.toThrow('CONSUMPTION_PROOF_REQUIRED');
  });

  test('rejects malformed, unknown, and case-duplicate precommit signers at the EntityInput boundary', async () => {
    const setup = createMultisigAccountState(validators[0]);
    const proposed = await applyEntityInput(setup.env, setup.replica, {
      entityId: setup.entityId,
      signerId: validators[0]!,
    });
    if (!proposed.workingReplica.proposal) throw new Error('TEST_ENTITY_PROPOSAL_MISSING');
    const validSignature = proposed.workingReplica.proposal.collectedSigs?.get(validators[0]!)?.[0];
    if (!validSignature) throw new Error('TEST_PROPOSER_SIGNATURE_MISSING');
    const upper = `0x${validators[0]!.slice(2).toUpperCase()}`;
    const cases: Array<[Map<string, string[]>, string]> = [
      [new Map([[counterpartySigner, [validSignature]]]), 'PRECOMMIT_BUNDLE_REJECTED'],
      [new Map([[validators[0]!, [validSignature]], [upper, [validSignature]]]), 'PRECOMMIT_BUNDLE_REJECTED'],
      [new Map([[validators[1]!, 'not-an-array' as unknown as string[]]]), 'ENTITY_INPUT_INVALID'],
    ];

    for (const [hashPrecommits, code] of cases) {
      const result = await applyEntityInput(setup.env, proposed.workingReplica, {
        entityId: setup.entityId,
        signerId: validators[0]!,
        hashPrecommitFrame: {
          height: proposed.workingReplica.proposal.height,
          frameHash: proposed.workingReplica.proposal.hash,
        },
        hashPrecommits,
      });
      expect(result.outcome).toEqual({ kind: 'rejected', code });
      expect(result.workingReplica.state.height).toBe(0);
    }
    const wrongFrame = await applyEntityInput(setup.env, proposed.workingReplica, {
      entityId: setup.entityId,
      signerId: validators[0]!,
      hashPrecommitFrame: {
        height: proposed.workingReplica.proposal.height,
        frameHash: digest('f'),
      },
      hashPrecommits: new Map([[validators[1]!, ['0xwrong-frame-signature']]]),
    });
    expect(wrongFrame.outcome).toEqual({ kind: 'rejected', code: 'PRECOMMIT_FRAME_MISMATCH' });
    expect(wrongFrame.workingReplica.state.height).toBe(0);
  });

  test('seals ACK and next proposal drafts in semantic order with exact frame and dispute Hankos', async () => {
    const setup = createMultisigAccountState();
    const account = setup.state.accounts.get(setup.counterpartyId);
    if (!account) throw new Error('TEST_ACCOUNT_MISSING');
    const ackFrameHash = digest('a');
    const proposalFrameHash = digest('b');
    const ackDisputeHash = digest('c');
    const proposalDisputeHash = digest('d');
    account.currentFrame = { ...account.currentFrame, height: 1, stateHash: ackFrameHash };
    account.currentHeight = 1;
    const combined: Extract<AccountInput, { kind: 'frame_ack' }> = {
      kind: 'frame_ack',
      fromEntityId: setup.entityId,
      toEntityId: setup.counterpartyId,
      ack: {
        height: 1,
        frameHash: ackFrameHash,
        disputeSeal: {
          hash: ackDisputeHash,
          proofBodyHash: digest('1'),
          proofNonce: 1,
        },
      },
      proposal: {
        frame: { ...account.currentFrame, height: 2, stateHash: proposalFrameHash },
        disputeSeal: {
          hash: proposalDisputeHash,
          proofBodyHash: digest('2'),
          proofNonce: 2,
        },
      },
    };
    account.lastOutboundFrameAck = {
      height: 1,
      counterpartyEntityId: setup.counterpartyId,
      response: {
        kind: 'ack',
        fromEntityId: setup.entityId,
        toEntityId: setup.counterpartyId,
        ack: { height: 1, frameHash: ackFrameHash },
      },
    };
    account.pendingFrame = structuredClone(combined.proposal.frame);
    account.pendingAccountInput = combined;
    account.pendingAccountInputSignerId = counterpartySigner;

    const hankos = new Map<string, HankoWitnessEntry>();
    for (const [hash, type] of [
      [ackFrameHash, 'accountFrame'],
      [proposalFrameHash, 'accountFrame'],
      [ackDisputeHash, 'dispute'],
      [proposalDisputeHash, 'dispute'],
    ] as const) {
      hankos.set(hash, {
        hanko: await buildExactQuorumHanko(setup, hash),
        type,
        entityHeight: 1,
        createdAt: setup.env.timestamp,
      });
    }

    const routed = structuredClone(combined);
    const outputs = [{
      entityId: setup.counterpartyId,
      signerId: counterpartySigner,
      entityTxs: [{ type: 'accountInput' as const, data: routed }],
    }];
    expect(attachHankoWitnessToOutputs(outputs, [], hankos, 1, setup.state)).toBe(4);
    expect(routed.ack.frameHanko).toBe(hankos.get(ackFrameHash)?.hanko);
    expect(routed.proposal.frameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);
    expect(routed.ack.disputeSeal?.hanko).toBe(hankos.get(ackDisputeHash)?.hanko);
    expect(routed.proposal.disputeSeal?.hanko).toBe(hankos.get(proposalDisputeHash)?.hanko);

    sealHankoWitnessInState(setup.state, hankos, 1);
    expect(account.lastOutboundFrameAck.response.ack.frameHanko).toBe(hankos.get(ackFrameHash)?.hanko);
    expect(account.pendingAccountInput.proposal.frameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);
    expect(account.currentFrameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);
    expect(account.currentDisputeProofHanko).toBe(hankos.get(proposalDisputeHash)?.hanko);

    // A later Entity frame may leave the same already-certified ACK/proposal in
    // state. It must reuse that exact older witness instead of pretending the
    // secondary hash was signed again at the new Entity height.
    expect(() => sealHankoWitnessInState(setup.state, hankos, 2)).not.toThrow();
    expect(account.lastOutboundFrameAck.response.ack.frameHanko).toBe(hankos.get(ackFrameHash)?.hanko);
    expect(account.pendingAccountInput.proposal.frameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);

    const originalAckWitness = hankos.get(ackFrameHash);
    if (!originalAckWitness) throw new Error('TEST_ACK_WITNESS_MISSING');
    hankos.set(ackFrameHash, {
      ...originalAckWitness,
      hanko: `${originalAckWitness.hanko}00` as HankoWitnessEntry['hanko'],
    });
    expect(() => sealHankoWitnessInState(setup.state, hankos, 2))
      .toThrow('HANKO_WITNESS_VALUE_MISMATCH');
    hankos.set(ackFrameHash, { ...originalAckWitness, entityHeight: 3 });
    expect(() => sealHankoWitnessInState(setup.state, hankos, 2))
      .toThrow('HANKO_WITNESS_BINDING_MISMATCH');
    hankos.set(ackFrameHash, originalAckWitness);
  });

  test('binds two same-height settlement drafts to their distinct exact digests', async () => {
    const setup = createMultisigAccountState();
    const firstAccount = setup.state.accounts.get(setup.counterpartyId);
    if (!firstAccount) throw new Error('TEST_ACCOUNT_MISSING');
    const secondSigner = deriveSignerAddressSync(seed, '5').toLowerCase();
    const secondCounterpartyId = generateLazyEntityId([secondSigner], 1n).toLowerCase();
    const [secondLeft, secondRight] = [setup.entityId, secondCounterpartyId].sort();
    const secondAccount = structuredClone(firstAccount);
    secondAccount.leftEntity = secondLeft;
    secondAccount.rightEntity = secondRight;
    secondAccount.proofHeader = {
      ...secondAccount.proofHeader,
      fromEntity: setup.entityId,
      toEntity: secondCounterpartyId,
    };
    setup.state.accounts.set(secondCounterpartyId, secondAccount);

    const firstHash = digest('e');
    const secondHash = digest('f');
    const workspace = (account: AccountMachine) => {
      const value = {
      workspaceHash: '',
      ops: [{ type: 'r2r' as const, tokenId: 1, amount: 1n }],
      lastModifiedByLeft: true,
      status: 'awaiting_counterparty' as const,
      version: 1,
      createdAt: setup.env.timestamp,
      lastUpdatedAt: setup.env.timestamp,
      // Make the local Entity the non-executor on both accounts, so its exact
      // settlement digest and post-proof digest are both quorum-signed.
      executorIsLeft: setup.entityId.toLowerCase() !== account.leftEntity.toLowerCase(),
      };
      value.workspaceHash = createSettlementWorkspaceHash(account, value);
      return value;
    };
    firstAccount.settlementWorkspace = workspace(firstAccount);
    secondAccount.settlementWorkspace = workspace(secondAccount);
    const firstPostHash = digest('1');
    const secondPostHash = digest('2');
    const settlementSeal = (
      account: AccountMachine,
      settlementHash: string,
      disputeHash: string,
    ): Extract<AccountTx, { type: 'settle_transition' }> => ({
      type: 'settle_transition',
      data: {
        kind: 'seal',
        version: 1,
        workspaceHash: account.settlementWorkspace!.workspaceHash,
        settlementNonce: 1,
        settlementHash,
        postProof: {
          nonce: 2,
          proofBodyHash: digest('0'),
          disputeHash,
        },
      },
    });
    const firstSeal = settlementSeal(firstAccount, firstHash, firstPostHash);
    const secondSeal = settlementSeal(secondAccount, secondHash, secondPostHash);
    firstAccount.mempool.push(firstSeal);
    secondAccount.mempool.push(secondSeal);
    const witness = new Map<string, HankoWitnessEntry>();
    for (const [hash, type] of [
      [firstHash, 'settlement'],
      [firstPostHash, 'dispute'],
      [secondHash, 'settlement'],
      [secondPostHash, 'dispute'],
    ] as const) {
      witness.set(hash, {
        hanko: await buildExactQuorumHanko(setup, hash),
        type,
        entityHeight: 1,
        createdAt: setup.env.timestamp,
      });
    }

    expect(sealHankoWitnessInState(setup.state, witness, 1)).toBe(4);
    if (firstSeal.data.kind !== 'seal' || secondSeal.data.kind !== 'seal') {
      throw new Error('TEST_SETTLEMENT_SEAL_INVALID');
    }
    expect(firstSeal.data.settlementHanko).toBe(witness.get(firstHash)?.hanko);
    expect(secondSeal.data.settlementHanko).toBe(witness.get(secondHash)?.hanko);
    expect(firstSeal.data.settlementHanko).not.toBe(secondSeal.data.settlementHanko);
    expect(firstSeal.data.postProof.hanko).toBe(witness.get(firstPostHash)?.hanko);
    expect(secondSeal.data.postProof.hanko).toBe(witness.get(secondPostHash)?.hanko);
    expect(firstAccount.settlementWorkspace.leftHanko).toBeUndefined();
    expect(firstAccount.settlementWorkspace.rightHanko).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import {
  advanceEntityCommandNonce,
  assertSignedEntityCommand,
  buildSignedEntityCommand,
} from '../entity/command';
import {
  hashEntityCommand,
  hashEntityCommandTxs,
  MAX_ENTITY_COMMAND_BYTES,
  mergeEntityCommandTransactions,
  signedEntityCommandTx,
} from '../entity/command-codec';
import {
  assertCertifiedEntityOutputAuthorization,
  assertRuntimeOutputAuthorization,
  buildCollectiveEntityProposalTx,
  buildEntityTransactionProposalAction,
  hashEntityProposalAction,
} from '../entity/authorization';
import { applyEntityFrame, applyEntityInput } from '../entity/consensus';
import {
  buildCertifiedEntityOutputHashes,
  hashCertifiedEntityOutputSemantic,
} from '../entity/consensus/output-certification';
import { handleReissueCertifiedOutputEntityTx } from '../entity/tx/handlers/basic';
import {
  assertEntityFrameTxByteBudget,
  MAX_ENTITY_FRAME_TX_BYTES,
  selectEntityFrameTxByteBudget,
} from '../entity/consensus/frame';
import { deriveLocalEntityCryptoKeys } from '../entity/crypto';
import { encodeBoard, hashBoard } from '../entity/factory';
import {
  buildCrossJurisdictionPullBinding,
  withCanonicalCrossJurisdictionRouteHash,
} from '../extensions/cross-j';
import { handleInboundP2PEntityInput } from '../machine/entity-routing';
import {
  buildValidatorEncryptionBoard,
  createLocalValidatorEncryptionAttestation,
} from '../networking/profile-encryption';
import { requireCompleteValidatorEncryptionManifest } from '../protocol/htlc/validator-encryption';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from '../jurisdiction/board-registry';
import { applyRuntimeInput, createEmptyEnv, enqueueRuntimeInput, process as processRuntime } from '../runtime';
import { buildQuorumHanko, verifyHankoForHash } from '../hanko/signing';
import { hydrateEntityStateFromStorage } from '../storage/hydration';
import { projectEntityCoreDoc } from '../storage/projections';
import type {
  ConsensusConfig,
  CrossJurisdictionSwapRoute,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JurisdictionEvent,
  Proposal,
  RoutedEntityInput,
} from '../types';

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

const jurisdiction = {
  address: address('a1'),
  name: 'SignedCommandTest',
  chainId: 31_337,
  depositoryAddress: address('a2'),
  entityProviderAddress: address('a3'),
};

const setup = (label: string) => {
  const seed = `signed-command:${label}`;
  const env = createEmptyEnv(seed);
  env.scenarioMode = true;
  env.timestamp = 1_000;
  const privateKey = deriveSignerKeySync(seed, 'validator');
  const signerId = deriveSignerAddressSync(seed, 'validator').toLowerCase();
  registerSignerKey(env, signerId, privateKey);
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction,
  };
  const id = hashBoard(encodeBoard(config)).toLowerCase();
  const state: EntityState = {
    entityId: id,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config,
    reserves: new Map(),
    accounts: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'01'.repeat(32)}`,
    entityEncPrivKey: `0x${'02'.repeat(32)}`,
    profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
  };
  const replica: EntityReplica = {
    entityId: id,
    signerId,
    state,
    mempool: [],
    isProposer: true,
  };
  env.eReplicas.set(`${id}:${signerId}`, replica);
  return { env, signerId, state, replica };
};

const hubCommand = (): EntityTx => ({
  type: 'setHubConfig',
  data: { routingFeePPM: 777, baseFee: 123n },
});

const chatCommand = (signerId: string, message = 'signed command'): EntityTx => ({
  type: 'chat',
  data: { from: signerId, message },
});

const setupNumericAliasBoard = () => {
  const seed = 'signed-command:numeric-aliases';
  const env = createEmptyEnv(seed);
  env.scenarioMode = true;
  const proposer = deriveSignerAddressSync(seed, '1').toLowerCase();
  const validators = [proposer, '2'];
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 2n,
    validators,
    shares: { [proposer]: 1n, '2': 1n },
    jurisdiction,
  };
  const id = hashBoard(encodeBoard(config, env)).toLowerCase();
  const base = setup('alias-template').state;
  const state: EntityState = { ...base, entityId: id, config };
  env.eReplicas.clear();
  for (const signerId of validators) {
    const keys = deriveLocalEntityCryptoKeys(env, id, signerId);
    env.eReplicas.set(`${id}:${signerId}`, {
      entityId: id,
      signerId,
      state: { ...structuredClone(state), entityEncPubKey: keys.publicKey, entityEncPrivKey: keys.privateKey },
      mempool: [],
      isProposer: signerId === proposer,
    });
  }
  const board = buildValidatorEncryptionBoard(env, state);
  const attestations = validators.map(signerId => createLocalValidatorEncryptionAttestation(env, state, signerId));
  state.profileEncryptionManifest = requireCompleteValidatorEncryptionManifest(board, attestations);
  return { env, state, authorSignerId: validators[1]! };
};

const setupNoJurisdictionMultisig = () => {
  const env = createEmptyEnv('signed-command:no-j-multisig');
  env.scenarioMode = true;
  env.timestamp = 2_000;
  const signers = ['a', 'b'].map(label => {
    const signer = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
    registerSignerKey(env, signer, deriveSignerKeySync(env.runtimeSeed!, label));
    return signer;
  });
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 2n,
    validators: signers,
    shares: { [signers[0]!]: 1n, [signers[1]!]: 1n },
  };
  const template = setup('no-j-template').state;
  const state: EntityState = {
    ...template,
    entityId: hashBoard(encodeBoard(config)).toLowerCase(),
    config,
  };
  delete state.entityCommandNonces;
  return { env, state, signers };
};

const installCertifiedBoardEvents = (
  env: Env,
  state: EntityState,
  events: JurisdictionEvent[],
): void => {
  for (const event of events) {
    const applied = applyCertifiedBoardRegistryEvent(
      state.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      jurisdiction,
      event,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    state.certifiedBoardState = applied.state;
  }
};

const certifiedBoardEvent = (
  type: 'FoundationBootstrapped' | 'EntityRegistered' | 'BoardActivated',
  boardHash: string,
  options: { height: number; logIndex?: number; entityId?: string; previousBoardHash?: string } = { height: 1 },
): JurisdictionEvent => {
  const blockHash = entityId(options.height.toString(16).padStart(2, '0'));
  const transactionHash = entityId((options.height + 64).toString(16).padStart(2, '0'));
  const metadata = {
    blockNumber: options.height,
    blockHash,
    transactionHash,
    logIndex: options.logIndex ?? 0,
  };
  if (type === 'FoundationBootstrapped') {
    return {
      ...metadata,
      type,
      data: { recipient: address('fa'), boardHash, controlTokenId: '2', dividendTokenId: '3' },
    };
  }
  const registeredEntityId = options.entityId ?? entityId('91');
  if (type === 'EntityRegistered') {
    return {
      ...metadata,
      type,
      data: { entityId: registeredEntityId, entityNumber: BigInt(registeredEntityId).toString(), boardHash },
    };
  }
  return {
    ...metadata,
    type,
    data: {
      entityId: registeredEntityId,
      previousBoardHash: options.previousBoardHash ?? entityId('00'),
      newBoardHash: boardHash,
      previousBoardValidUntil: '1700604800',
    },
  };
};

describe('signed Entity command admission', () => {
  test('signs a local collective command before WAL apply and executes it through proposal quorum', async () => {
    const { env, signerId, state } = setup('local-runtime-admission');
    state.profile = { ...state.profile, name: 'Local command admission' };
    env.runtimeConfig = { storage: { enabled: false } };
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: state.entityId,
        signerId,
        entityTxs: [hubCommand()],
      }],
    });

    await processRuntime(env, []);

    const committed = Array.from(env.eReplicas.values()).find(
      replica => replica.entityId === state.entityId && replica.signerId === signerId,
    );
    expect(committed?.state.hubRebalanceConfig?.routingFeePPM).toBe(777);
    expect(Array.from(committed?.state.proposals.values() ?? []).at(-1)?.status).toBe('executed');
    expect(committed?.state.entityCommandNonces?.bySigner.get(signerId)?.nonce).toBe(1n);
  });

  test('persists an Entity frame committed from internal mempool on an empty Runtime input', async () => {
    const { env, signerId, state, replica } = setup('internal-mempool-runtime-commit');
    state.profile = { ...state.profile, name: 'Internal mempool commit' };
    env.runtimeConfig = { storage: { enabled: false } };
    replica.mempool = [signedEntityCommandTx(buildSignedEntityCommand(
      env,
      state,
      signerId,
      [chatCommand(signerId, 'durable internal commit')],
    ))];

    const applied = await applyRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: state.entityId,
        signerId,
        entityTxs: [],
      }],
    });

    const committed = env.eReplicas.get(`${state.entityId}:${signerId}`);
    expect(committed?.state.height).toBe(1);
    expect(committed?.state.messages).toContain(`${signerId}: durable internal commit`);
    expect(env.height).toBe(1);
    expect(applied.appliedRuntimeInput.entityInputs).toEqual([{
      entityId: state.entityId,
      signerId,
      entityTxs: [],
    }]);
  });

  test('rejects an unsigned user EntityTx received from another runtime', () => {
    const targetEntityId = entityId('11');
    const targetSignerId = address('22');
    const enqueued: RoutedEntityInput[] = [];
    const env = {
      runtimeId: address('33'),
      eReplicas: new Map([[
        `${targetEntityId}:${targetSignerId}`,
        { entityId: targetEntityId, signerId: targetSignerId },
      ]]),
      runtimeState: { entityRuntimeHints: new Map() },
      warn: () => {},
      info: () => {},
      error: () => {},
    } as unknown as Env;

    expect(() => handleInboundP2PEntityInput(env, address('44'), {
      entityId: targetEntityId,
      signerId: targetSignerId,
      entityTxs: [{
        type: 'setHubConfig',
        data: { isHub: true, routingFeePPM: 777, baseFee: 123n },
      }],
    }, {
      ensureRuntimeState: target => target.runtimeState!,
      enqueueRuntimeInputs: (_target, inputs) => enqueued.push(...(inputs ?? [])),
      extractEntityId: key => String(key).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => true,
      resolveSoleLocalSignerForEntity: () => targetSignerId,
      getP2P: () => null,
    })).toThrow('INBOUND_ENTITY_UNSIGNED_USER_COMMAND');
    expect(enqueued).toHaveLength(0);
  });

  test('admits an exact signed command and overwrites peer-supplied transport provenance', () => {
    const { env, signerId, state } = setup('network-green');
    const command = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId)]);
    const enqueued: RoutedEntityInput[] = [];
    const peer = address('44');
    const result = handleInboundP2PEntityInput(env, peer, {
      entityId: state.entityId,
      signerId,
      from: address('55'),
      entityTxs: [signedEntityCommandTx(command)],
    }, {
      ensureRuntimeState: target => target.runtimeState!,
      enqueueRuntimeInputs: (_target, inputs) => enqueued.push(...(inputs ?? [])),
      extractEntityId: key => String(key).split(':')[0] || '',
      hasLocalSignerForEntity: () => true,
      hasLocalSignerForEntitySigner: () => true,
      resolveSoleLocalSignerForEntity: () => signerId,
      getP2P: () => null,
    });
    expect(result).toEqual({ kind: 'queued' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.from).toBe(peer);
  });

  test('binds entity, stack, board epoch, author EOA, nonce, tx bytes, and signature', () => {
    const { env, signerId, state } = setup('bindings');
    const command = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId)]);
    expect(assertSignedEntityCommand(env, state, command)).toEqual(command);
    const { signature: _signature, ...nonceBody } = { ...command, nonce: 2n };
    const wrongNonce = {
      ...nonceBody,
      signature: signAccountFrame(env, signerId, hashEntityCommand(nonceBody)).toLowerCase(),
    };

    const cases: Array<[string, object, string]> = [
      ['entity', { entityId: entityId('ef') }, 'ENTITY_COMMAND_ENTITY_MISMATCH'],
      ['stack', { stackKey: entityId('ee') }, 'ENTITY_COMMAND_STACK_MISMATCH'],
      ['board', { boardHash: entityId('ed') }, 'ENTITY_COMMAND_BOARD_MISMATCH'],
      ['board-epoch', { boardEpoch: 1 }, 'ENTITY_COMMAND_EPOCH_MISMATCH'],
      ['author-id', { authorSignerId: address('ec') }, 'ENTITY_COMMAND_AUTHOR_NOT_ON_BOARD'],
      ['author-eoa', { authorSigner: address('eb') }, 'ENTITY_COMMAND_AUTHOR_EOA_MISMATCH'],
      ['nonce', wrongNonce, 'ENTITY_COMMAND_NONCE_MISMATCH'],
      ['tx-hash', { txsHash: entityId('ea') }, 'ENTITY_COMMAND_TXS_HASH_MISMATCH'],
      ['signature', { signature: `0x${'00'.repeat(65)}` }, 'ENTITY_COMMAND_SIGNATURE_MISMATCH'],
    ];
    for (const [label, mutation, error] of cases) {
      expect(() => assertSignedEntityCommand(env, state, { ...command, ...mutation }), label).toThrow(error);
    }
    expect(() => assertSignedEntityCommand(
      env,
      state,
      { ...command, txs: [chatCommand(signerId, 'tampered bytes')] },
    )).toThrow('ENTITY_COMMAND_TXS_HASH_MISMATCH');
    const { signature: _commandSignature, ...body } = command;
    expect(hashEntityCommand({ ...body, boardEpoch: body.boardEpoch + 1 })).not.toBe(hashEntityCommand(body));
  });

  test('accepts exact committed retry but rejects same-nonce different bytes', () => {
    const { env, signerId, state } = setup('replay');
    const command = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId)]);
    const advanced = advanceEntityCommandNonce(state, assertSignedEntityCommand(env, state, command));
    expect(assertSignedEntityCommand(env, advanced, command)).toEqual(command);
    expect(advanceEntityCommandNonce(advanced, command)).toBe(advanced);

    const conflicting = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId, 'equivocation')]);
    expect(() => assertSignedEntityCommand(env, advanced, conflicting))
      .toThrow(`ENTITY_COMMAND_NONCE_EQUIVOCATION:${signerId}:1`);
  });

  test('rejects an older command after a later nonce is committed', () => {
    const { env, signerId, state } = setup('stale');
    const first = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId, 'first')]);
    const afterFirst = advanceEntityCommandNonce(state, assertSignedEntityCommand(env, state, first));
    const second = buildSignedEntityCommand(env, afterFirst, signerId, [chatCommand(signerId, 'second')]);
    const afterSecond = advanceEntityCommandNonce(afterFirst, assertSignedEntityCommand(env, afterFirst, second));
    expect(() => assertSignedEntityCommand(env, afterSecond, first))
      .toThrow(`ENTITY_COMMAND_NONCE_STALE:${signerId}:1:2`);
  });

  test('uses a certified alias-to-EOA binding on an independent validator runtime', () => {
    const { env: authorEnv, state, authorSignerId } = setupNumericAliasBoard();
    const command = buildSignedEntityCommand(authorEnv, state, authorSignerId, [chatCommand(authorSignerId)]);
    const verifierEnv = createEmptyEnv('signed-command:independent-validator');
    verifierEnv.scenarioMode = true;
    expect(command.authorSignerId).toBe('2');
    expect(command.authorSigner).not.toBe('2');
    expect(assertSignedEntityCommand(verifierEnv, structuredClone(state), command)).toEqual(command);
  });

  test('supports a trusted no-J domain and invalidates it after registration', () => {
    const { env, state, signers } = setupNoJurisdictionMultisig();
    const author = signers[0]!;
    const command = buildSignedEntityCommand(env, state, author, [chatCommand(author, 'lazy entity')]);
    const verifierEnv = createEmptyEnv('signed-command:no-j-independent-verifier');
    verifierEnv.scenarioMode = true;
    expect(assertSignedEntityCommand(verifierEnv, structuredClone(state), command)).toEqual(command);

    const registered = structuredClone(state);
    registered.config = { ...registered.config, jurisdiction };
    expect(() => assertSignedEntityCommand(verifierEnv, registered, command))
      .toThrow('ENTITY_COMMAND_STACK_MISMATCH');
  });

  test('executes a collective action only after independent weighted proposal quorum', async () => {
    const { env, state, signers } = setupNoJurisdictionMultisig();
    const [proposer, voter] = signers as [string, string];
    const proposalTx = buildCollectiveEntityProposalTx(proposer, [hubCommand()]);
    const proposalCommand = buildSignedEntityCommand(env, state, proposer, [proposalTx]);
    const proposed = await applyEntityFrame(env, state, [signedEntityCommandTx(proposalCommand)], 2_001);
    expect(proposed.newState.hubRebalanceConfig).toBeUndefined();
    const proposal = Array.from(proposed.newState.proposals.values())[0];
    expect(proposal?.status).toBe('pending');
    expect(proposal?.actionHash).toBe(hashEntityProposalAction(
      buildEntityTransactionProposalAction([hubCommand()]),
    ));

    const voteTx: EntityTx = {
      type: 'vote',
      data: { proposalId: proposal!.id, voter, choice: 'yes' },
    };
    const voteCommand = buildSignedEntityCommand(env, proposed.newState, voter, [voteTx]);
    const committed = await applyEntityFrame(
      env,
      proposed.newState,
      [signedEntityCommandTx(voteCommand)],
      2_002,
    );
    expect(committed.newState.hubRebalanceConfig?.routingFeePPM).toBe(777);
    expect(committed.newState.proposals.get(proposal!.id)?.status).toBe('executed');

    const retry = await applyEntityFrame(
      env,
      committed.newState,
      [signedEntityCommandTx(voteCommand)],
      2_003,
    );
    expect(retry.newState.hubRebalanceConfig).toEqual(committed.newState.hubRebalanceConfig);
  });

  test('keeps separate same-action proposal intents from distinct signed command nonces', async () => {
    const { env, state, signerId: proposer } = setup('same-action-proposal-intents');
    const proposalTx = buildCollectiveEntityProposalTx(proposer, [hubCommand()]);
    const first = buildSignedEntityCommand(env, state, proposer, [proposalTx]);
    const afterFirstNonce = advanceEntityCommandNonce(state, first);
    const second = buildSignedEntityCommand(env, afterFirstNonce, proposer, [proposalTx]);

    const applied = await applyEntityFrame(
      env,
      state,
      [signedEntityCommandTx(first), signedEntityCommandTx(second)],
      2_001,
    );

    expect(applied.newState.proposals.size).toBe(2);
    expect(new Set(applied.newState.proposals.keys()).size).toBe(2);
    expect(applied.newState.entityCommandNonces?.bySigner.get(proposer)?.nonce).toBe(2n);
  });

  test('reissues only the stored semantic frontier through proposal quorum and exact output Hanko', async () => {
    const { env, state: initialState, signers } = setupNoJurisdictionMultisig();
    const [proposer, voter] = signers as [string, string];
    const targetEntityId = initialState.entityId;
    const payload = [hubCommand()];
    const semanticHash = hashCertifiedEntityOutputSemantic(
      initialState.entityId,
      targetEntityId,
      'generic',
      1n,
      payload,
    );
    const state: EntityState = {
      ...initialState,
      certifiedOutputSequences: new Map([[
        targetEntityId,
        { lastSequence: 1n, lastSemanticHash: semanticHash },
      ]]),
    };
    env.eReplicas.set(`${targetEntityId}:${proposer}`, {
      entityId: targetEntityId,
      signerId: proposer,
      isProposer: true,
      mempool: [],
      state,
    } as EntityReplica);
    const reissue: EntityTx = {
      type: 'reissueCertifiedOutput',
      data: { targetEntityId, targetSignerId: proposer, sequence: 1n, semanticHash, entityTxs: payload },
    };
    const proposed = await applyEntityFrame(env, state, [signedEntityCommandTx(
      buildSignedEntityCommand(env, state, proposer, [buildCollectiveEntityProposalTx(proposer, [reissue])]),
    )], 2_001);
    expect(proposed.outputs).toHaveLength(0);
    const proposal = Array.from(proposed.newState.proposals.values())[0];
    expect(proposal?.status).toBe('pending');

    const vote: EntityTx = {
      type: 'vote',
      data: { proposalId: proposal!.id, voter, choice: 'yes' },
    };
    const committed = await applyEntityFrame(env, proposed.newState, [signedEntityCommandTx(
      buildSignedEntityCommand(env, proposed.newState, voter, [vote]),
    )], 2_002);
    expect(committed.newState.proposals.get(proposal!.id)?.status).toBe('executed');
    expect(committed.outputs).toHaveLength(1);
    expect(committed.outputs[0]?.certifiedOutputIdentity).toEqual({
      lane: 'generic',
      sequence: 1n,
      semanticHash,
    });
    expect(committed.newState.certifiedOutputSequences).toEqual(state.certifiedOutputSequences);

    const hashes = buildCertifiedEntityOutputHashes(
      committed.newState,
      env,
      2,
      entityId('ab'),
      committed.outputs,
    );
    expect(hashes).toHaveLength(1);
    const outputHash = hashes[0]!.hash;
    const signatures = signers.map(signerId => ({
      signerId,
      signature: signAccountFrame(env, signerId, outputHash),
    }));
    const hanko = await buildQuorumHanko(
      env,
      state.entityId,
      outputHash,
      signatures,
      state.config,
    );
    expect((await verifyHankoForHash(hanko, outputHash, state.entityId, env)).valid).toBe(true);
  });

  test('reissue routing is identical with or without local target topology', () => {
    const { state } = setup('reissue-routing-purity');
    const targetEntityId = entityId('bc');
    const targetSignerId = address('cd');
    const staleTopologySigner = address('ef');
    const payload = [hubCommand()];
    const semanticHash = hashCertifiedEntityOutputSemantic(
      state.entityId,
      targetEntityId,
      'generic',
      1n,
      payload,
    );
    const sourceState: EntityState = {
      ...state,
      certifiedOutputSequences: new Map([[
        targetEntityId,
        { lastSequence: 1n, lastSemanticHash: semanticHash },
      ]]),
    };
    const reissue = {
      type: 'reissueCertifiedOutput',
      data: {
        targetEntityId,
        targetSignerId,
        sequence: 1n,
        semanticHash,
        entityTxs: payload,
      },
    } as EntityTx;
    const empty = createEmptyEnv('reissue-routing-empty');
    const populated = createEmptyEnv('reissue-routing-populated');
    populated.eReplicas.set(`${targetEntityId}:${staleTopologySigner}`, {
      entityId: targetEntityId,
      signerId: staleTopologySigner,
      mempool: [],
      isProposer: true,
      state: {
        ...structuredClone(state),
        entityId: targetEntityId,
        config: {
          ...state.config,
          threshold: 1n,
          validators: [staleTopologySigner],
          shares: { [staleTopologySigner]: 1n },
        },
      },
    });

    const withoutTopology = handleReissueCertifiedOutputEntityTx(empty, sourceState, reissue).outputs;
    const withStaleTopology = handleReissueCertifiedOutputEntityTx(populated, sourceState, reissue).outputs;
    expect(withoutTopology).toEqual(withStaleTopology);
    expect(withoutTopology[0]?.signerId).toBe(targetSignerId);
    expect(withoutTopology[0]?.certifiedOutputIdentity?.semanticHash).toBe(semanticHash);
  });

  test('rejects direct collective signatures, duplicate votes, and unknown authors', async () => {
    const { env, state, signers } = setupNoJurisdictionMultisig();
    const [proposer, unknownBoardPeer] = signers as [string, string];
    const valid = buildSignedEntityCommand(env, state, proposer, [chatCommand(proposer)]);
    const collectiveTxs = [hubCommand()];
    const unsignedCollective = {
      ...valid,
      txs: collectiveTxs,
      txsHash: hashEntityCommandTxs(collectiveTxs),
    };
    const { signature: _oldSignature, ...collectiveBody } = unsignedCollective;
    const directCollective = {
      ...collectiveBody,
      signature: signAccountFrame(env, proposer, hashEntityCommand(collectiveBody)).toLowerCase(),
    };
    expect(() => assertSignedEntityCommand(env, state, directCollective))
      .toThrow('ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:setHubConfig');

    const proposalTx = buildCollectiveEntityProposalTx(proposer, [hubCommand()]);
    const proposalCommand = buildSignedEntityCommand(env, state, proposer, [proposalTx]);
    const proposed = await applyEntityFrame(env, state, [signedEntityCommandTx(proposalCommand)], 2_001);
    const proposal = Array.from(proposed.newState.proposals.values())[0]!;
    const duplicateVote: EntityTx = {
      type: 'vote',
      data: { proposalId: proposal.id, voter: proposer, choice: 'yes' },
    };
    const duplicateCommand = buildSignedEntityCommand(env, proposed.newState, proposer, [duplicateVote]);
    await expect(applyEntityFrame(
      env,
      proposed.newState,
      [signedEntityCommandTx(duplicateCommand)],
      2_002,
    )).rejects.toThrow('ENTITY_PROPOSAL_DUPLICATE_VOTE');

    const unknownSeed = 'signed-command:unknown-author';
    const unknown = deriveSignerAddressSync(unknownSeed, 'validator').toLowerCase();
    registerSignerKey(env, unknown, deriveSignerKeySync(unknownSeed, 'validator'));
    const unknownBody = { ...valid, authorSignerId: unknown, authorSigner: unknown };
    const { signature: _knownSignature, ...unknownUnsigned } = unknownBody;
    const unknownCommand = {
      ...unknownUnsigned,
      signature: signAccountFrame(env, unknown, hashEntityCommand(unknownUnsigned)).toLowerCase(),
    };
    expect(() => assertSignedEntityCommand(env, state, unknownCommand))
      .toThrow(`ENTITY_COMMAND_AUTHOR_NOT_ON_BOARD:${unknown}`);
    expect(unknownBoardPeer).not.toBe(unknown);
  });

  test('independent validator replays the exact signed frame without the author private key', async () => {
    const { env: authorEnv, state, authorSignerId } = setupNumericAliasBoard();
    const command = buildSignedEntityCommand(authorEnv, state, authorSignerId, [chatCommand(authorSignerId)]);
    const verifierEnv = createEmptyEnv('signed-command:independent-frame-validator');
    verifierEnv.scenarioMode = true;

    const { newState: nextState } = await applyEntityFrame(
      verifierEnv,
      structuredClone(state),
      [signedEntityCommandTx(command)],
      1_001,
    );

    expect(nextState.messages.some(message => message.includes('signed command'))).toBe(true);
    expect(nextState.entityCommandNonces?.bySigner.get(authorSignerId)?.nonce).toBe(1n);
  });

  test('committed exact retry is a no-op across frames', async () => {
    const { env, signerId, state } = setup('retry-no-op');
    const tx = chatCommand(signerId, 'apply exactly once');
    const command = buildSignedEntityCommand(env, state, signerId, [tx]);
    const first = await applyEntityFrame(env, state, [signedEntityCommandTx(command)], 1_001);
    const retry = await applyEntityFrame(env, first.newState, [signedEntityCommandTx(command)], 1_002);
    expect(first.newState.messages.filter(message => message.includes('apply exactly once'))).toHaveLength(1);
    expect(retry.newState.messages.filter(message => message.includes('apply exactly once'))).toHaveLength(1);
    expect(retry.outputs).toHaveLength(0);
    expect(retry.jOutputs).toHaveLength(0);
  });

  test('persists the command nonce and restores exact-retry semantics', () => {
    const { env, signerId, state } = setup('retry-persistence');
    const command = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId)]);
    const advanced = advanceEntityCommandNonce(state, assertSignedEntityCommand(env, state, command));
    const restored = hydrateEntityStateFromStorage({
      core: projectEntityCoreDoc(advanced),
      accounts: new Map(),
      books: new Map(),
    });
    expect(restored.entityCommandNonces).toEqual(advanced.entityCommandNonces);
    expect(assertSignedEntityCommand(env, restored, command)).toEqual(command);
    expect(advanceEntityCommandNonce(restored, command)).toBe(restored);
  });

  test('resets only the bounded nonce namespace on a certified board rotation', async () => {
    const { env, signerId, state } = setup('board-rotation');
    const registered: EntityState = { ...state, entityId: entityId('92') };
    const boardA = hashBoard(encodeBoard(registered.config)).toLowerCase();
    installCertifiedBoardEvents(env, registered, [
      certifiedBoardEvent('FoundationBootstrapped', entityId('f1'), { height: 1 }),
      certifiedBoardEvent('EntityRegistered', boardA, { height: 2, entityId: registered.entityId }),
    ]);
    const first = buildSignedEntityCommand(env, registered, signerId, [chatCommand(signerId)]);
    const advanced = advanceEntityCommandNonce(
      registered,
      assertSignedEntityCommand(env, registered, first),
    );
    const nextSeed = 'signed-command:board-rotation-next';
    const nextSigner = deriveSignerAddressSync(nextSeed, 'validator').toLowerCase();
    registerSignerKey(env, nextSigner, deriveSignerKeySync(nextSeed, 'validator'));
    const rotated: EntityState = {
      ...advanced,
      config: {
        ...advanced.config,
        validators: [nextSigner],
        shares: { [nextSigner]: 1n },
      },
    };
    const boardB = hashBoard(encodeBoard(rotated.config)).toLowerCase();
    installCertifiedBoardEvents(env, rotated, [
      certifiedBoardEvent('BoardActivated', boardB, {
        height: 3,
        entityId: rotated.entityId,
        previousBoardHash: boardA,
      }),
    ]);
    const next = buildSignedEntityCommand(env, rotated, nextSigner, [chatCommand(nextSigner)]);
    expect(next.nonce).toBe(1n);
    const replay = await applyEntityFrame(env, rotated, [signedEntityCommandTx(next)], 1_001);
    expect(replay.newState.entityCommandNonces?.bySigner.size).toBe(1);
    expect(replay.newState.entityCommandNonces?.bySigner.get(nextSigner)?.nonce).toBe(1n);
    expect(replay.newState.entityCommandNonces?.bySigner.has(signerId)).toBe(false);
  });

  test('certified A0 -> B1 -> A2 rejects an epoch-zero command and keeps proposal namespaces distinct', async () => {
    const { env, state, signers } = setupNoJurisdictionMultisig();
    const registeredEntityId = entityId('91');
    const registered: EntityState = {
      ...state,
      entityId: registeredEntityId,
      config: { ...state.config, jurisdiction },
    };
    const boardA = hashBoard(encodeBoard(registered.config)).toLowerCase();
    const boardB = entityId('b2');
    installCertifiedBoardEvents(env, registered, [
      certifiedBoardEvent('FoundationBootstrapped', entityId('f1'), { height: 1 }),
      certifiedBoardEvent('EntityRegistered', boardA, { height: 2, entityId: registeredEntityId }),
    ]);

    const proposer = signers[0]!;
    const action = { type: 'collective_message', data: { message: 'same intent across epochs' } } as const;
    const epochZeroCommand = buildSignedEntityCommand(env, registered, proposer, [{
      type: 'propose',
      data: { proposer, action },
    }]);
    const epochZeroApplied = await applyEntityFrame(
      env,
      registered,
      [signedEntityCommandTx(epochZeroCommand)],
      2_001,
    );
    const epochZeroProposal = Array.from(epochZeroApplied.newState.proposals.values())[0]!;
    expect(epochZeroProposal.status).toBe('pending');
    const voter = signers[1]!;
    const epochZeroVote = buildSignedEntityCommand(env, epochZeroApplied.newState, voter, [{
      type: 'vote',
      data: { proposalId: epochZeroProposal.id, voter, choice: 'yes' },
    }]);

    const epochTwo = structuredClone(epochZeroApplied.newState);
    installCertifiedBoardEvents(env, epochTwo, [
      certifiedBoardEvent('BoardActivated', boardB, {
        height: 3,
        logIndex: 4,
        entityId: registeredEntityId,
        previousBoardHash: boardA,
      }),
      certifiedBoardEvent('BoardActivated', boardA, {
        height: 3,
        logIndex: 9,
        entityId: registeredEntityId,
        previousBoardHash: boardB,
      }),
    ]);

    expect(() => assertSignedEntityCommand(env, epochTwo, epochZeroCommand))
      .toThrow('ENTITY_COMMAND_EPOCH_MISMATCH');
    expect(() => assertSignedEntityCommand(env, epochTwo, epochZeroVote))
      .toThrow('ENTITY_COMMAND_EPOCH_MISMATCH');
    expect((epochZeroCommand as { boardEpoch?: number }).boardEpoch).toBe(0);
    expect((epochZeroProposal as Proposal & { boardEpoch?: number }).boardEpoch).toBe(0);

    const epochTwoCommand = buildSignedEntityCommand(env, epochTwo, proposer, [{
      type: 'propose',
      data: { proposer, action },
    }]);
    expect((epochTwoCommand as { boardEpoch?: number }).boardEpoch).toBe(2);
    expect(mergeEntityCommandTransactions([
      signedEntityCommandTx(epochZeroCommand),
      signedEntityCommandTx(epochTwoCommand),
    ])).toHaveLength(2);
    const epochTwoApplied = await applyEntityFrame(
      env,
      epochTwo,
      [signedEntityCommandTx(epochTwoCommand)],
      2_002,
    );
    const proposals = Array.from(epochTwoApplied.newState.proposals.values());
    const oldProposal = proposals.find(proposal => proposal.id === epochZeroProposal.id)!;
    const newProposal = proposals.find(proposal => proposal.id !== epochZeroProposal.id)!;
    expect(oldProposal.status).toBe('rejected');
    expect((oldProposal as Proposal & { boardEpoch?: number }).boardEpoch).toBe(0);
    expect(newProposal.status).toBe('pending');
    expect((newProposal as Proposal & { boardEpoch?: number }).boardEpoch).toBe(2);
    expect(newProposal.id).not.toBe(epochZeroProposal.id);
    const epochTwoVote = buildSignedEntityCommand(env, epochTwoApplied.newState, voter, [{
      type: 'vote',
      data: { proposalId: newProposal.id, voter, choice: 'yes' },
    }]);
    const executed = await applyEntityFrame(
      env,
      epochTwoApplied.newState,
      [signedEntityCommandTx(epochTwoVote)],
      2_003,
    );
    expect(executed.newState.proposals.get(epochZeroProposal.id)?.status).toBe('rejected');
    expect(executed.newState.proposals.get(newProposal.id)?.status).toBe('executed');
  });

  test('rejects signed impersonation in every identity-bearing user transaction', () => {
    const { env, signerId, state } = setup('identity-spoof');
    const other = address('ef');
    const spoofedTxs: EntityTx[] = [
      { type: 'chat', data: { from: other, message: 'spoof' } },
      { type: 'propose', data: { proposer: other, action: { type: 'collective_message', data: { message: 'spoof' } } } },
      { type: 'vote', data: { proposalId: entityId('aa'), voter: other, choice: 'yes' } },
    ];
    for (const spoofedTx of spoofedTxs) {
      const valid = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId)]);
      const txs = [spoofedTx];
      const unsigned = {
        ...valid,
        txs,
        txsHash: hashEntityCommandTxs(txs),
      };
      const { signature: _oldSignature, ...body } = unsigned;
      const signed = {
        ...body,
        signature: signAccountFrame(env, signerId, hashEntityCommand(body)).toLowerCase(),
      };
      expect(() => assertSignedEntityCommand(env, state, signed))
        .toThrow('ENTITY_COMMAND_AUTHOR_FIELD_MISMATCH');
    }
  });

  test('rejects a canonical command payload over the frame byte cap', () => {
    const { env, signerId, state } = setup('byte-limit');
    expect(() => buildSignedEntityCommand(env, state, signerId, [{
      type: 'chat',
      data: { from: signerId, message: 'x'.repeat(MAX_ENTITY_COMMAND_BYTES + 1) },
    }])).toThrow('ENTITY_COMMAND_BYTE_LIMIT_EXCEEDED');
  });

  test('rejects a raw user transaction even when injected directly into frame replay', async () => {
    const { env, state } = setup('raw-frame-rejection');
    await expect(applyEntityFrame(env, state, [hubCommand()], 1_001))
      .rejects.toThrow('ENTITY_COMMAND_REQUIRED:setHubConfig');
  });

  test('recomputes stack and current board from local state instead of command claims', () => {
    const { env, signerId, state } = setup('trusted-authority');
    const command = buildSignedEntityCommand(env, state, signerId, [chatCommand(signerId)]);
    const wrongStackState = structuredClone(state);
    wrongStackState.config.jurisdiction = { ...jurisdiction, chainId: jurisdiction.chainId + 1 };
    expect(() => assertSignedEntityCommand(env, wrongStackState, command)).toThrow('ENTITY_COMMAND_STACK_MISMATCH');

    const rotatedState = structuredClone(state);
    const nextSeed = 'signed-command:rotated-board';
    const nextSigner = deriveSignerAddressSync(nextSeed, 'validator').toLowerCase();
    registerSignerKey(env, nextSigner, deriveSignerKeySync(nextSeed, 'validator'));
    rotatedState.config = {
      ...rotatedState.config,
      validators: [nextSigner],
      shares: { [nextSigner]: 1n },
    };
    expect(() => assertSignedEntityCommand(env, rotatedState, command))
      .toThrow('ENTITY_COMMAND_CERTIFIED_BOARD_REQUIRED');
  });

  test('bounds chat and terminal proposal history to the deterministic newest 100', async () => {
    const { env, signerId, state } = setup('bounded-chat-proposals');
    const chats = Array.from({ length: 101 }, (_, index) => chatCommand(signerId, `chat-${index}`));
    const chatBatch = buildSignedEntityCommand(env, state, signerId, chats);
    const chatted = await applyEntityFrame(env, state, [signedEntityCommandTx(chatBatch)], 1_001);
    expect(chatted.newState.messages).toHaveLength(100);
    expect(chatted.newState.messages[0]).toContain('chat-1');
    expect(chatted.newState.messages.at(-1)).toContain('chat-100');
    expect(chatted.newState.nonces.size).toBe(0);

    const proposalTxs: EntityTx[] = Array.from({ length: 101 }, (_, index) => ({
      type: 'propose',
      data: {
        proposer: signerId,
        action: { type: 'collective_message', data: { message: `terminal-${index}` } },
      },
    }));
    const proposalBatch = buildSignedEntityCommand(env, chatted.newState, signerId, proposalTxs);
    const proposed = await applyEntityFrame(
      env,
      chatted.newState,
      [signedEntityCommandTx(proposalBatch)],
      1_002,
    );
    expect(proposed.newState.proposals.size).toBe(100);
    expect(Array.from(proposed.newState.proposals.values()).every(proposal => proposal.status === 'executed')).toBe(true);
    expect(proposed.newState.messages).toHaveLength(100);
    expect(proposed.newState.messages[0]).toContain('terminal-1');
    expect(proposed.newState.messages.at(-1)).toContain('terminal-100');
  });

  test('limits each proposer to one pending proposal', async () => {
    const { env, state, signers } = setupNoJurisdictionMultisig();
    const proposer = signers[0]!;
    const firstTx: EntityTx = {
      type: 'propose',
      data: {
        proposer,
        action: { type: 'collective_message', data: { message: 'pending-1' } },
      },
    };
    const first = buildSignedEntityCommand(env, state, proposer, [firstTx]);
    const pending = await applyEntityFrame(env, state, [signedEntityCommandTx(first)], 2_001);
    expect(Array.from(pending.newState.proposals.values())).toHaveLength(1);
    expect(Array.from(pending.newState.proposals.values())[0]?.status).toBe('pending');

    const spam = buildSignedEntityCommand(env, pending.newState, proposer, [{
      type: 'propose',
      data: {
        proposer,
        action: { type: 'collective_message', data: { message: 'pending-2' } },
      },
    }]);
    await expect(applyEntityFrame(
      env,
      pending.newState,
      [signedEntityCommandTx(spam)],
      2_002,
    )).rejects.toThrow('ENTITY_PROPOSAL_PROPOSER_PENDING_LIMIT');
    expect(pending.newState.proposals.size).toBe(1);
  });

  test('weighted no quorum rejects a proposal and frees proposer capacity', async () => {
    const env = createEmptyEnv('signed-command:no-quorum');
    env.scenarioMode = true;
    env.timestamp = 3_000;
    const signers = ['a', 'b', 'c'].map(label => {
      const signer = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
      registerSignerKey(env, signer, deriveSignerKeySync(env.runtimeSeed!, label));
      return signer;
    });
    const template = setup('no-quorum-template').state;
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: signers,
      shares: Object.fromEntries(signers.map(signer => [signer, 1n])),
    };
    const state: EntityState = { ...template, entityId: hashBoard(encodeBoard(config)).toLowerCase(), config };
    const [proposer, noVoter] = signers as [string, string, string];
    const proposalCommand = buildSignedEntityCommand(env, state, proposer, [{
      type: 'propose',
      data: { proposer, action: { type: 'collective_message', data: { message: 'reject me' } } },
    }]);
    const proposed = await applyEntityFrame(env, state, [signedEntityCommandTx(proposalCommand)], 3_001);
    const proposal = Array.from(proposed.newState.proposals.values())[0]!;

    const blockingNo = buildSignedEntityCommand(env, proposed.newState, noVoter, [{
      type: 'vote', data: { proposalId: proposal.id, voter: noVoter, choice: 'no' },
    }]);
    const rejected = await applyEntityFrame(env, proposed.newState, [signedEntityCommandTx(blockingNo)], 3_002);
    expect(rejected.newState.proposals.get(proposal.id)?.status).toBe('rejected');

    const replacement = buildSignedEntityCommand(env, rejected.newState, proposer, [{
      type: 'propose',
      data: { proposer, action: { type: 'collective_message', data: { message: 'capacity is free' } } },
    }]);
    const replaced = await applyEntityFrame(env, rejected.newState, [signedEntityCommandTx(replacement)], 3_003);
    expect(Array.from(replaced.newState.proposals.values()).filter(item => item.status === 'pending')).toHaveLength(1);
  });

  test('board rotation rejects old pending proposals before accepting new-board governance', async () => {
    const { env, state, signers } = setupNoJurisdictionMultisig();
    const registered: EntityState = {
      ...state,
      entityId: entityId('93'),
      config: { ...state.config, jurisdiction },
    };
    const boardA = hashBoard(encodeBoard(registered.config)).toLowerCase();
    installCertifiedBoardEvents(env, registered, [
      certifiedBoardEvent('FoundationBootstrapped', entityId('f1'), { height: 1 }),
      certifiedBoardEvent('EntityRegistered', boardA, { height: 2, entityId: registered.entityId }),
    ]);
    const oldProposer = signers[0]!;
    const pendingCommand = buildSignedEntityCommand(env, registered, oldProposer, [{
      type: 'propose',
      data: { proposer: oldProposer, action: { type: 'collective_message', data: { message: 'old board' } } },
    }]);
    const pending = await applyEntityFrame(env, registered, [signedEntityCommandTx(pendingCommand)], 2_001);
    const oldProposal = Array.from(pending.newState.proposals.values())[0]!;

    const nextSeed = 'signed-command:proposal-rotation';
    const nextSigner = deriveSignerAddressSync(nextSeed, 'validator').toLowerCase();
    registerSignerKey(env, nextSigner, deriveSignerKeySync(nextSeed, 'validator'));
    const rotated: EntityState = {
      ...pending.newState,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [nextSigner],
        shares: { [nextSigner]: 1n },
        jurisdiction,
      },
    };
    const boardB = hashBoard(encodeBoard(rotated.config)).toLowerCase();
    installCertifiedBoardEvents(env, rotated, [
      certifiedBoardEvent('BoardActivated', boardB, {
        height: 3,
        entityId: rotated.entityId,
        previousBoardHash: boardA,
      }),
    ]);
    const nextCommand = buildSignedEntityCommand(env, rotated, nextSigner, [{
      type: 'propose',
      data: { proposer: nextSigner, action: { type: 'collective_message', data: { message: 'new board' } } },
    }]);
    const applied = await applyEntityFrame(env, rotated, [signedEntityCommandTx(nextCommand)], 2_002);
    expect(applied.newState.proposals.get(oldProposal.id)?.status).toBe('rejected');
    expect(Array.from(applied.newState.proposals.values()).some(proposal =>
      proposal.proposer === nextSigner && proposal.status === 'executed')).toBe(true);
  });

  test('canonicalizes mixed-case EOA board shares for proposer and voter power', async () => {
    const { env, state, signers } = setupNoJurisdictionMultisig();
    const mixed = (signer: string): string => `0x${signer.slice(2).toUpperCase()}`;
    const [proposer, voter] = signers as [string, string];
    const mixedProposer = mixed(proposer);
    const mixedVoter = mixed(voter);
    const mixedState: EntityState = {
      ...state,
      config: {
        ...state.config,
        validators: [mixedProposer, mixedVoter],
        shares: { [mixedProposer]: 1n, [mixedVoter]: 1n },
      },
    };
    const proposalCommand = buildSignedEntityCommand(env, mixedState, proposer, [
      buildCollectiveEntityProposalTx(proposer, [hubCommand()]),
    ]);
    const proposed = await applyEntityFrame(env, mixedState, [signedEntityCommandTx(proposalCommand)], 2_001);
    const proposal = Array.from(proposed.newState.proposals.values())[0]!;
    expect(proposal.status).toBe('pending');
    const voteCommand = buildSignedEntityCommand(env, proposed.newState, voter, [{
      type: 'vote', data: { proposalId: proposal.id, voter, choice: 'yes' },
    }]);
    const executed = await applyEntityFrame(env, proposed.newState, [signedEntityCommandTx(voteCommand)], 2_002);
    expect(executed.newState.hubRebalanceConfig?.routingFeePPM).toBe(777);
  });

  test('caps the aggregate canonical Entity frame before replay or signing', () => {
    const payload = 'x'.repeat(Math.floor(MAX_ENTITY_FRAME_TX_BYTES / 2) + 1_024);
    const txs: EntityTx[] = [
      { type: 'chatMessage', data: { message: payload, timestamp: 1 } },
      { type: 'chatMessage', data: { message: payload, timestamp: 2 } },
    ];
    expect(() => assertEntityFrameTxByteBudget(txs)).toThrow('ENTITY_FRAME_TX_BYTE_LIMIT_EXCEEDED');
    expect(selectEntityFrameTxByteBudget(txs)).toEqual([txs[0]]);
  });

  test('binds trusted cross-j runtime outputs to the two exact sibling edges', () => {
    const sourceUser = entityId('11');
    const sourceHub = entityId('12');
    const targetHub = entityId('13');
    const targetUser = entityId('14');
    const attacker = entityId('16');
    const orderId = 'semantic-order';
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId,
      bookOwnerEntityId: targetHub,
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      source: {
        jurisdiction: `stack:8453:0x${'11'.repeat(20)}`,
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 10n,
      },
      target: {
        jurisdiction: `stack:1:0x${'12'.repeat(20)}`,
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 20n,
      },
      sourcePull: {
        pullId: 'source-pull', tokenId: 1, amount: 10n, signedAmount: 10n,
        revealedUntilTimestamp: 10_000, fullHash: entityId('18'), partialRoot: entityId('19'),
      },
      targetPull: {
        pullId: 'target-pull', tokenId: 2, amount: 20n, signedAmount: 20n,
        revealedUntilTimestamp: 10_000, fullHash: entityId('1a'), partialRoot: entityId('1b'),
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    } satisfies CrossJurisdictionSwapRoute);
    const routeHash = route.routeHash!;
    const sourceReceipt = {
      receiptHash: entityId('20'),
      leg: 'source' as const,
      orderId,
      routeHash,
      hubEntityId: sourceHub,
      counterpartyEntityId: sourceUser,
      pullId: 'source-pull',
      tokenId: 1,
      signedAmount: 10n,
      revealedUntilTimestamp: 10_000,
      fullHash: entityId('18'),
      partialRoot: entityId('19'),
      committedAt: 1,
    };
    const targetReceipt = {
      receiptHash: entityId('22'),
      leg: 'target' as const,
      orderId,
      routeHash,
      hubEntityId: targetHub,
      counterpartyEntityId: targetUser,
      pullId: 'target-pull',
      tokenId: 2,
      signedAmount: 20n,
      revealedUntilTimestamp: 10_000,
      fullHash: entityId('1a'),
      partialRoot: entityId('1b'),
      committedAt: 1,
    };
    const targetLockedRoute = {
      ...route,
      status: 'target_locked' as const,
      targetReceipt,
    };
    const baseState = structuredClone(setup('runtime-semantic-roles').state);
    baseState.crossJurisdictionSwaps = new Map([[orderId, route]]);
    baseState.crossJurisdictionBookAdmissions = new Map([['admission', {
      orderId,
      routeHash,
      sourceEntityId: sourceUser,
      bookOwnerEntityId: targetHub,
      status: 'admitted',
      route,
      sourceReceipt,
      updatedAt: 1,
    }]]);
    const stateFor = (entityIdValue: string) => {
      const state = structuredClone(baseState);
      state.entityId = entityIdValue;
      return state;
    };
    const closeProof = {
      orderId,
      routeHash,
      sourcePullId: 'source-pull',
      targetPullId: 'target-pull',
      fillRatio: 1,
      cumulativeSourceAmount: 1n,
      cumulativeTargetAmount: 2n,
      binaryHash: entityId('21'),
      closeMode: 'partial_cancel_remainder' as const,
    };
    const targetPullLock: EntityTx = {
      type: 'pullLock',
      data: {
        counterpartyEntityId: targetUser,
        pullId: route.targetPull.pullId,
        tokenId: route.targetPull.tokenId,
        amount: route.targetPull.signedAmount,
        revealedUntilTimestamp: route.targetPull.revealedUntilTimestamp,
        fullHash: route.targetPull.fullHash,
        partialRoot: route.targetPull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      },
    };
    const targetRegistration: EntityTx = {
      type: 'registerCrossJurisdictionSwap', data: { route },
    };
    const targetReceiptRegistration: EntityTx = {
      type: 'registerCrossJurisdictionSwap', data: { route: targetLockedRoute },
    };
    const forcedSourceDispute: EntityTx = {
      type: 'disputeStart',
      data: {
        counterpartyEntityId: sourceHub,
        crossJurisdictionRouteId: orderId,
      },
    };
    const variants: Array<{
      source: string;
      target: string;
      txs: EntityTx[];
    }> = [
      {
        source: sourceHub,
        target: targetHub,
        txs: [targetRegistration, targetPullLock],
      },
      {
        source: targetHub,
        target: sourceHub,
        txs: [targetReceiptRegistration],
      },
      {
        source: targetUser,
        target: sourceUser,
        txs: [{
          type: 'commitCrossJurisdictionSwap',
          data: { route: targetLockedRoute, targetReceipt },
        }],
      },
      {
        source: sourceHub,
        target: targetHub,
        txs: [{
          type: 'admitCrossJurisdictionBookOrder',
          data: { route, receipt: sourceReceipt },
        }],
      },
      {
        source: sourceHub,
        target: targetHub,
        txs: [{
          type: 'applyCrossJurisdictionBookProgress',
          data: {
            orderId, sourceEntityId: sourceUser, fillSeq: 1,
            incrementalSourceAmount: 1n, incrementalTargetAmount: 2n,
            cumulativeSourceAmount: 1n, cumulativeTargetAmount: 2n,
            cumulativeFillRatio: 1,
          },
        }],
      },
      {
        source: targetHub,
        target: sourceHub,
        txs: [{
          type: 'crossJurisdictionFillNotice',
          data: {
            orderId, routeHash, fillSeq: 1,
            incrementalSourceAmount: 1n, incrementalTargetAmount: 2n,
            cumulativeSourceAmount: 1n, cumulativeTargetAmount: 2n,
            cumulativeFillRatio: 1, pairId: '1/2',
          },
        }],
      },
      {
        source: sourceUser,
        target: targetUser,
        txs: [{
          type: 'crossPullClose',
          data: {
            counterpartyEntityId: targetHub,
            pullId: 'target-pull', binary: '01', proof: closeProof, route,
          },
        }],
      },
      {
        source: sourceHub,
        target: targetHub,
        txs: [{
          type: 'removeCrossJurisdictionBookOrder',
          data: { orderId, sourceEntityId: sourceUser, route },
        }],
      },
      {
        source: targetHub,
        target: sourceHub,
        txs: [{ type: 'requestCrossJurisdictionClear', data: { orderId, route } }],
      },
      {
        source: sourceUser,
        target: targetUser,
        txs: [{
          type: 'crossJurisdictionSalvage',
          data: {
            routeId: orderId,
            binary: '0x01',
            fillRatio: 1,
            sourceEntityId: sourceUser,
            sourceCounterpartyEntityId: sourceHub,
          },
        }],
      },
      {
        source: targetUser,
        target: sourceUser,
        txs: [forcedSourceDispute],
      },
    ];
    for (const variant of variants) {
      expect(() => assertRuntimeOutputAuthorization(
        variant.source,
        variant.target,
        variant.txs,
        stateFor(variant.target),
      ), variant.txs.map(tx => tx.type).join(',')).not.toThrow();
      expect(() => assertRuntimeOutputAuthorization(
        attacker,
        variant.target,
        variant.txs,
        stateFor(variant.target),
      ), variant.txs.map(tx => tx.type).join(',')).toThrow('RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN');
    }
    const accountInput: EntityTx = {
      type: 'accountInput',
      data: {
        kind: 'settle', fromEntityId: sourceUser, toEntityId: sourceHub,
        settleAction: { type: 'reject' },
      },
    };
    expect(() => assertCertifiedEntityOutputAuthorization(
      sourceUser,
      sourceHub,
      [accountInput],
      stateFor(sourceHub),
    )).not.toThrow();
    expect(() => assertCertifiedEntityOutputAuthorization(
      sourceHub,
      targetHub,
      [targetRegistration],
      stateFor(targetHub),
    )).toThrow('CONSENSUS_OUTPUT_CROSS_ENTITY_TX_FORBIDDEN:registerCrossJurisdictionSwap');
    expect(() => assertCertifiedEntityOutputAuthorization(
      targetUser,
      sourceUser,
      [forcedSourceDispute],
      stateFor(sourceUser),
    )).toThrow('CONSENSUS_OUTPUT_CROSS_ENTITY_TX_FORBIDDEN:disputeStart');
    expect(() => assertRuntimeOutputAuthorization(
      sourceUser,
      sourceHub,
      [targetRegistration],
      stateFor(sourceHub),
    )).toThrow('RUNTIME_OUTPUT_NON_SIBLING_FORBIDDEN');
    expect(() => assertRuntimeOutputAuthorization(
      sourceUser,
      targetUser,
      [{ type: 'prepareCrossJurisdictionSwap', data: { route } }],
      stateFor(targetUser),
    )).toThrow('RUNTIME_OUTPUT_CROSS_J_INTENT_MUST_USE_ACCOUNT');
    expect(() => assertRuntimeOutputAuthorization(
      sourceUser,
      targetUser,
      [accountInput],
      stateFor(targetUser),
    )).toThrow('RUNTIME_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN:accountInput');
    expect(() => assertRuntimeOutputAuthorization(
      targetHub,
      targetHub,
      [targetRegistration],
      stateFor(targetHub),
    )).toThrow('RUNTIME_OUTPUT_SELF_FORBIDDEN');
    const tamperedPull = structuredClone(targetPullLock);
    if (tamperedPull.type !== 'pullLock') throw new Error('TEST_TARGET_PULL_TYPE_INVALID');
    tamperedPull.data.amount += 1n;
    expect(() => assertRuntimeOutputAuthorization(
      sourceHub,
      targetHub,
      [targetRegistration, tamperedPull],
      stateFor(targetHub),
    )).toThrow('CONSENSUS_OUTPUT_CROSS_J_TARGET_PULL_MISMATCH');
  });

  test('turns local raw user txs into a signed frame command and commits its nonce', async () => {
    const { env, state, replica } = setup('local-custody');
    const result = await applyEntityInput(env, replica, {
      entityId: state.entityId,
      signerId: replica.signerId,
      entityTxs: [hubCommand()],
    });
    expect(result.outcome.kind).toBe('committed');
    expect(result.newState.hubRebalanceConfig?.routingFeePPM).toBe(777);
    expect(Array.from(result.newState.proposals.values())[0]?.status).toBe('executed');
    expect(result.newState.entityCommandNonces?.bySigner.get(replica.signerId)?.nonce).toBe(1n);
  });

  test('does not consume a command nonce when nested execution fails', async () => {
    const { env, state, replica } = setup('failed-frame');
    const invalidTx = { type: 'notARealEntityTx', data: {} } as unknown as EntityTx;
    await expect(applyEntityInput(env, replica, {
      entityId: state.entityId,
      signerId: replica.signerId,
      entityTxs: [invalidTx],
    })).rejects.toThrow('ENTITY_FRAME_TX_FAILED');
    expect(replica.state.entityCommandNonces).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';
import { accountInputProposal } from '../../../account/consensus/flush';
import { replaceLocalDisputeDraft } from '../../../account/consensus/dispute/hanko';
import { createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { createSettlementWorkspaceHash } from '../../../account/tx/handlers/settlement/transition';
import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../../account/crypto';
import { applyEntityInput } from '../../../entity/consensus';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';
import {
  attachHankoWitnessToOutputs,
  attachHankoWitnessesToState,
  type HankoWitnessEntry,
} from '../../../entity/consensus/input/hanko-witness';
import { generateLazyEntityId } from '../../../entity/factory';
import { provisionTestEntityEncryptionKey } from '../../helpers/cross-j';
import { buildQuorumHanko, verifyHankoForHash } from '../../../hanko/signing';
import { createEmptyEnv } from '../../../runtime';
import { safeStringify } from '../../../protocol/serialization';
import type { AccountReplica, AccountInput, AccountTx } from '../../../types/account';
import type { EntityTx } from '../../../types/entity-tx';
import type { EntityInput, EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap ,
  getEntityAccountForWrite,
  putEntityAccountCandidate,
} from '../../../entity/state/persistent-account-map';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import {
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';

const seed = 'multisig-secondary-hanko alpha beta gamma';
const signerLabels = ['1', '2', '3'];
const validators = signerLabels.map(label => deriveSignerAddressSync(seed, label).toLowerCase());
const counterpartySigner = deriveSignerAddressSync(seed, '4').toLowerCase();
const threshold = 3n;
const digest = (hex: string): string => `0x${hex.repeat(64)}`;
const putCommittedAccount = (
  state: EntityState,
  counterpartyId: string,
  account: AccountReplica,
): void => {
  if (!(state.accounts instanceof PersistentEntityAccountMap)) {
    throw new Error('TEST_PERSISTENT_ACCOUNT_MAP_REQUIRED');
  }
  state.accounts = state.accounts.updated(counterpartyId, account);
};

const buildUnverifiedBoardHankoRefreshTx = (
  sourceEntityId: string,
  targetEntityId: string,
  sequence: bigint = 1n,
): EntityTx => ({
  type: 'accountInput',
  data: {
    kind: 'board_hanko_refresh',
    fromEntityId: sourceEntityId,
    toEntityId: targetEntityId,
    domain: {
      chainId: 31_337,
      depositoryAddress: `0x${'dd'.repeat(20)}`,
    },
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    boardHankoRefresh: {
      height: 1,
      frameHash: digest('0'),
      frameHanko: '0x01',
      boardActivationJHeight: 1,
      boardActivationLogIndex: Number(sequence),
    },
  },
});

const registerOnly = (env: RuntimeReplica, signerId: string) => {
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
  env.state.timestamp = 10_000;
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
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    chainId: jurisdiction.chainId,
    rpcs: [jurisdiction.address!],
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
  const account: AccountReplica = {
    state: {
      leftEntity,
      rightEntity,
      domain: {
        chainId: jurisdiction.chainId,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
      deltas: PersistentAccountStateMap.empty('deltas'),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      watchSeed: `0x${'f1'.repeat(32)}`,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
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
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  };
  const state = {
    entityId,
    height: 0,
    timestamp: env.state.timestamp,
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: authority.threshold,
      validators: authority.validators,
      shares: Object.fromEntries(authority.validators.map(validator => [validator, 1n])),
      jurisdiction,
    },
    reserves: new Map(),
    accounts: PersistentEntityAccountMap.fromMap(
      new Map([[counterpartyId, account]]),
      entityId,
      computeEntityAccountValueHash,
    ),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    profile: { name: 'Multisig entity', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
  } as EntityState;
  state.entityEncryptionPublicKey = provisionTestEntityEncryptionKey(env, entityId);
  const replica: EntityReplica = {
    entityId,
    signerId: localSignerId,
    mempool: [],
    isProposer: localSignerId === authority.validators[0],
    state,
  };
  env.state.eReplicas.set(`${entityId}:${localSignerId}`, replica);
  const counterpartyEncryptionPublicKey = provisionTestEntityEncryptionKey(env, counterpartyId);
  env.state.eReplicas.set(`${counterpartyId}:${counterpartySigner}`, {
    entityId: counterpartyId,
    signerId: counterpartySigner,
    entityEncPubKey: '',
    mempool: [],
    isProposer: true,
    state: {
      ...structuredClone(state),
      entityId: counterpartyId,
      entityEncryptionPublicKey: counterpartyEncryptionPublicKey,
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [counterpartySigner],
        shares: { [counterpartySigner]: 1n },
        jurisdiction,
      },
      accounts: PersistentEntityAccountMap.empty(counterpartyId, computeEntityAccountValueHash),
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

const installTargetAccount = (
  source: ReturnType<typeof createMultisigAccountState>,
  targetState: EntityState,
  targetEntityId: string,
): AccountReplica => {
  const existing = targetState.accounts.get(source.entityId);
  if (existing) return existing;
  const sourceAccount = source.state.accounts.get(source.counterpartyId);
  if (!sourceAccount) throw new Error('TEST_SOURCE_ACCOUNT_MISSING');
  const account = forkAccountReplicaShell(sourceAccount);
  const [leftEntity, rightEntity] = [source.entityId, targetEntityId].sort();
  account.state.leftEntity = leftEntity;
  account.state.rightEntity = rightEntity;
  account.proofHeader = {
    ...account.proofHeader,
    fromEntity: targetEntityId,
    toEntity: source.entityId,
  };
  account.currentHeight = 1;
  account.currentFrame = {
    ...account.currentFrame,
    height: 1,
    timestamp: 1,
    accountTxs: [],
    prevFrameHash: digest('f'),
    accountStateRoot: digest('0'),
    stateHash: digest('0'),
    byLeft: targetEntityId === leftEntity,
  };
  account.mempool = [];
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  putCommittedAccount(targetState, source.entityId, account);
  return account;
};

describe('multisig secondary Hanko production', () => {
  test('invalidates the old Hanko when replacing a local dispute draft', () => {
    const setup = createMultisigAccountState();
    const account = forkAccountReplicaShell(setup.state.accounts.get(setup.counterpartyId)!);
    if (!account) throw new Error('TEST_ACCOUNT_MISSING');
    account.currentDisputeHash = digest('a');
    account.currentDisputeProofBodyHash = digest('b');
    account.currentDisputeProofNonce = 7;
    account.currentDisputeProofHanko = '0xcafe';

    replaceLocalDisputeDraft(account, {
      hash: digest('c'),
      proofBodyHash: digest('d'),
      nonce: 8,
    });

    expect(account.currentDisputeHash).toBe(digest('c'));
    expect(account.currentDisputeProofBodyHash).toBe(digest('d'));
    expect(account.currentDisputeProofNonce).toBe(8);
    expect(account.currentDisputeProofHanko).toBeUndefined();
  });

  test('single-signer routes the exact Hanko-certified Account output before target replay', async () => {
    const source = createMultisigAccountState(validators[0], {
      validators: [validators[0]!],
      threshold: 1n,
    });
    const target = source.env.state.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`);
    const sharedGenesis = source.state.accounts.get(source.counterpartyId);
    if (!target || !sharedGenesis) throw new Error('TEST_SINGLE_SIGNER_ACCOUNT_PAIR_MISSING');
    const targetGenesis = forkAccountReplicaShell(sharedGenesis);
    targetGenesis.proofHeader = {
      ...targetGenesis.proofHeader,
      fromEntity: source.counterpartyId,
      toEntity: source.entityId,
    };
    targetGenesis.currentFrame.byLeft = source.counterpartyId === targetGenesis.state.leftEntity;
    putCommittedAccount(target.state, source.entityId, targetGenesis);

    const committed = await applyEntityInput(source.env, source.replica, {
      entityId: source.entityId,
      signerId: validators[0]!,
    });
    expect(committed.workingReplica.state.height).toBe(1);
    const outbound = committed.outputs.find(output =>
      output.entityId === source.counterpartyId && output.entityTxs?.length,
    );
    if (!outbound) throw new Error('TEST_SINGLE_SIGNER_ACCOUNT_OUTPUT_MISSING');
    const accountTx = outbound.entityTxs?.[0];
    if (accountTx?.type !== 'accountInput') {
      throw new Error(`TEST_SINGLE_SIGNER_OUTPUT_NOT_ACCOUNT_INPUT:${accountTx?.type ?? 'missing'}`);
    }
    expect(accountTx.data.toEntityId).toBe(source.counterpartyId);
    const proposal = accountInputProposal(accountTx.data);
    if (!proposal?.frameHanko) throw new Error('TEST_SINGLE_SIGNER_FRAME_HANKO_MISSING');
    expect((await verifyHankoForHash(
      proposal.frameHanko,
      proposal.frame.stateHash,
      source.entityId,
      source.env,
    )).valid).toBe(true);
    registerOnly(source.env, counterpartySigner);
    const accepted = await applyEntityInput(source.env, target, structuredClone(outbound));
    expect(accepted.outcome.kind).toBe('committed');
    expect(accepted.workingReplica.state.accounts.get(source.entityId)?.currentHeight).toBe(1);
  });

  test('applies a raw Hanko-certified heightless dispute through the target Entity frame', async () => {
    const source = createMultisigAccountState(validators[0]);
    const target = source.env.state.eReplicas.get(`${source.counterpartyId}:${counterpartySigner}`);
    if (!target) throw new Error('TEST_TARGET_REPLICA_MISSING');
    installTargetAccount(
      source,
      target.state,
      source.counterpartyId,
    );
    target.state = createEntityFrameCandidateState(target.state);
    const account = getEntityAccountForWrite(target.state.accounts, source.entityId);
    if (!account) throw new Error('TEST_TARGET_ACCOUNT_MISSING');
    const proofBodyHash = digest('b');
    const proofNonce = 1;
    const proposerIsLeft = source.entityId === account.state.leftEntity;
    const disputeHash = createDisputeProofHashWithNonce(
      account.state,
      proofBodyHash,
      account.state.domain,
      proofNonce,
      proposerIsLeft,
    );
    account.currentDisputeHash = disputeHash;
    account.currentDisputeProofBodyHash = proofBodyHash;
    account.currentDisputeProofNonce = proofNonce;
    account.currentDisputeProofProposerIsLeft = proposerIsLeft;
    const entityTxs: EntityTx[] = [{
      type: 'accountInput',
      data: {
        kind: 'dispute',
        fromEntityId: source.entityId,
        toEntityId: source.counterpartyId,
        domain: account.state.domain,
        disputeConfig: account.state.disputeConfig,
        watchSeed: account.state.watchSeed,
        disputeHanko: {
          hanko: await buildExactQuorumHanko(source, disputeHash),
          hash: disputeHash,
          proofBodyHash,
          proofNonce,
          proposerIsLeft,
        },
      },
    }];
    const applied = await applyEntityFrameWithMaterializedTestInfraContext(
      source.env,
      target.state,
      entityTxs,
      source.env.state.timestamp + 1,
    );
    const appliedAccount = applied.newState.accounts.get(source.entityId);
    expect(appliedAccount?.counterpartyDisputeProofNonce).toBe(proofNonce);
    expect(appliedAccount?.counterpartyDisputeProofBodyHash).toBe(proofBodyHash);
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
        // Replica-local secrets are never valid Entity frame fields. Inject one
        // explicitly so transport validation proves it cannot cross consensus.
        entityEncryptionPrivateKey: `0x${'42'.repeat(32)}`,
      } as never,
    });
    expect(secretRejected.outcome).toEqual({ kind: 'rejected', code: 'ENTITY_INPUT_INVALID' });
    expect(secretRejected.outputs).toEqual([]);
  });

  test('account proposal produces unsigned drafts for the Entity quorum to certify', async () => {
    const { env, state, counterpartyId } = createMultisigAccountState();

    const result = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [], env.state.timestamp);
    const proposedAccount = result.newState.accounts.get(counterpartyId);
    if (!proposedAccount?.pendingFrame || !proposedAccount.pendingAccountInput) {
      throw new Error('TEST_MULTISIG_ACCOUNT_PROPOSAL_MISSING');
    }
    const outboundProposal = accountInputProposal(proposedAccount.pendingAccountInput);
    if (!outboundProposal) throw new Error('TEST_MULTISIG_ACCOUNT_OUTPUT_MISSING');

    expect(result.collectedHashes.map(({ type }) => type)).toEqual(['accountFrame', 'dispute', 'profile']);
    expect(proposedAccount.currentFrameHanko).toBeUndefined();
    expect(proposedAccount.currentDisputeProofHanko).toBeUndefined();
    expect(outboundProposal.frameHanko).toBeUndefined();
    expect(outboundProposal.disputeHanko?.hanko).toBeUndefined();
  });

  test('isolated validators replay, sign, and quorum-certify the exact Account draft', async () => {
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
      'profile',
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
    expect(leader.workingReplica.certifiedFrameHead?.frame.hankos).toHaveLength(1);

    const outbound = leader.outputs
      .flatMap(output => output.entityTxs ?? [])
      .find(tx => tx.type === 'accountInput');
    const hankoAttachedProposal = outbound?.type === 'accountInput' ? accountInputProposal(outbound.data) : undefined;
    if (!hankoAttachedProposal?.frameHanko || !hankoAttachedProposal.disputeHanko?.hanko) {
      throw new Error('TEST_QUORUM_HANKO_OUTPUT_MISSING');
    }
    const persisted = leader.workingReplica.state.accounts.get(proposerSetup.counterpartyId);
    expect(persisted?.currentFrameHanko).toBe(hankoAttachedProposal.frameHanko);
    expect(persisted?.currentDisputeProofHanko).toBe(hankoAttachedProposal.disputeHanko.hanko);
    expect(accountInputProposal(persisted?.pendingAccountInput)?.frameHanko).toBe(hankoAttachedProposal.frameHanko);

    expect((await verifyHankoForHash(
      hankoAttachedProposal.frameHanko,
      hankoAttachedProposal.frame.stateHash,
      proposerSetup.entityId,
      proposerSetup.env,
    )).valid).toBe(true);
    expect((await verifyHankoForHash(
      hankoAttachedProposal.disputeHanko.hanko,
      hankoAttachedProposal.disputeHanko.hash,
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
    expect(followerSideEffect.entityTxs?.[0]?.type).toBe('accountInput');
    const noticeForProposer = followerCommit.outputs.find(output =>
      output.signerId === validators[0] && output.proposedFrame?.hankos?.length,
    );
    if (!noticeForProposer) throw new Error('TEST_QUORUM_NOTICE_FOR_PROPOSER_MISSING');
    expect(noticeForProposer.proposedFrame?.hankos).toHaveLength(1);

    registerOnly(proposer.env, validators[0]!);
    const caughtUp = await applyEntityInput(
      proposer.env,
      proposed.workingReplica,
      structuredClone(noticeForProposer),
    );
    expect(caughtUp.workingReplica.state.height).toBe(1);
    expect(caughtUp.workingReplica.proposal).toBeUndefined();
    expect(caughtUp.workingReplica.candidate).toBeUndefined();
    const proposerSideEffect = caughtUp.outputs.find(output => output.entityTxs?.length);
    if (!proposerSideEffect) throw new Error('TEST_PROPOSER_SIDE_EFFECT_MISSING');
    expect(safeStringify(proposerSideEffect.entityTxs)).toBe(safeStringify(followerSideEffect.entityTxs));

  });

  test('rejects malformed, unknown, and case-duplicate precommit signers at the EntityInput boundary', async () => {
    const setup = createMultisigAccountState(validators[0]);
    const proposed = await applyEntityInput(setup.env, setup.replica, {
      entityId: setup.entityId,
      signerId: validators[0]!,
    });
    if (!proposed.workingReplica.proposal) throw new Error('TEST_ENTITY_PROPOSAL_MISSING');
    if (!proposed.workingReplica.candidate) throw new Error('TEST_ENTITY_CANDIDATE_MISSING');
    const candidateBeforeRejections = safeStringify(proposed.workingReplica.candidate);
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
      expect(safeStringify(result.workingReplica.candidate)).toBe(candidateBeforeRejections);
      expect(safeStringify(proposed.workingReplica.candidate)).toBe(candidateBeforeRejections);
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
    expect(safeStringify(wrongFrame.workingReplica.candidate)).toBe(candidateBeforeRejections);
    expect(safeStringify(proposed.workingReplica.candidate)).toBe(candidateBeforeRejections);
  });

  test('attaches ACK and next proposal Hankos in semantic order', async () => {
    const setup = createMultisigAccountState();
    setup.state = createEntityFrameCandidateState(setup.state);
    setup.replica.state = setup.state;
    const account = getEntityAccountForWrite(setup.state.accounts, setup.counterpartyId);
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
      domain: account.state.domain,
      disputeConfig: account.state.disputeConfig,
      ack: {
        height: 1,
        frameHash: ackFrameHash,
        disputeHanko: {
          hash: ackDisputeHash,
          proofBodyHash: digest('1'),
          proofNonce: 1,
        },
      },
      proposal: {
        frame: { ...account.currentFrame, height: 2, stateHash: proposalFrameHash },
        disputeHanko: {
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
        createdAt: setup.env.state.timestamp,
      });
    }

    const routed = structuredClone(combined);
    const outputs = [{
      entityId: setup.counterpartyId,
      signerId: counterpartySigner,
      entityTxs: [{ type: 'accountInput' as const, data: routed }],
    }];
    expect(attachHankoWitnessToOutputs(outputs, [], hankos, 1, setup.state)).toBe(4);
    const hankoAttachedTx = outputs[0]?.entityTxs?.[0];
    if (hankoAttachedTx?.type !== 'accountInput') throw new Error('TEST_HANKO_ATTACHED_ACCOUNT_OUTPUT_MISSING');
    const hankoAttachedRouted = hankoAttachedTx.data;
    if (hankoAttachedRouted.kind !== 'frame_ack') throw new Error('TEST_HANKO_ATTACHED_FRAME_ACK_MISSING');
    expect(routed.ack.frameHanko).toBeUndefined();
    expect(hankoAttachedRouted.ack.frameHanko).toBe(hankos.get(ackFrameHash)?.hanko);
    expect(hankoAttachedRouted.proposal.frameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);
    expect(hankoAttachedRouted.ack.disputeHanko?.hanko).toBe(hankos.get(ackDisputeHash)?.hanko);
    expect(hankoAttachedRouted.proposal.disputeHanko?.hanko).toBe(hankos.get(proposalDisputeHash)?.hanko);

    attachHankoWitnessesToState(setup.state, hankos, 1, [setup.counterpartyId]);
    expect(account.lastOutboundFrameAck.response.ack.frameHanko).toBe(hankos.get(ackFrameHash)?.hanko);
    expect(account.pendingAccountInput.proposal.frameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);
    expect(account.currentFrameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);
    expect(account.currentDisputeProofHanko).toBe(hankos.get(proposalDisputeHash)?.hanko);

    // A later Entity frame may leave the same already-certified ACK/proposal in
    // state. It must reuse that exact older witness instead of pretending the
    // secondary hash was signed again at the new Entity height.
    expect(() => attachHankoWitnessesToState(setup.state, hankos, 2, [setup.counterpartyId])).not.toThrow();
    expect(account.lastOutboundFrameAck.response.ack.frameHanko).toBe(hankos.get(ackFrameHash)?.hanko);
    expect(account.pendingAccountInput.proposal.frameHanko).toBe(hankos.get(proposalFrameHash)?.hanko);

    const originalAckWitness = hankos.get(ackFrameHash);
    if (!originalAckWitness) throw new Error('TEST_ACK_WITNESS_MISSING');
    hankos.set(ackFrameHash, {
      ...originalAckWitness,
      hanko: `${originalAckWitness.hanko}00` as HankoWitnessEntry['hanko'],
    });
    expect(() => attachHankoWitnessesToState(setup.state, hankos, 2, [setup.counterpartyId]))
      .toThrow('HANKO_WITNESS_VALUE_MISMATCH');
    hankos.set(ackFrameHash, { ...originalAckWitness, entityHeight: 3 });
    expect(() => attachHankoWitnessesToState(setup.state, hankos, 2, [setup.counterpartyId]))
      .toThrow('HANKO_WITNESS_BINDING_MISMATCH');
    hankos.set(ackFrameHash, originalAckWitness);
  });

  test('binds two same-height settlement drafts to their distinct exact digests', async () => {
    const setup = createMultisigAccountState();
    setup.state = createEntityFrameCandidateState(setup.state);
    setup.replica.state = setup.state;
    const firstAccount = getEntityAccountForWrite(setup.state.accounts, setup.counterpartyId);
    if (!firstAccount) throw new Error('TEST_ACCOUNT_MISSING');
    const secondSigner = deriveSignerAddressSync(seed, '5').toLowerCase();
    const secondCounterpartyId = generateLazyEntityId([secondSigner], 1n).toLowerCase();
    const [secondLeft, secondRight] = [setup.entityId, secondCounterpartyId].sort();
    const secondAccount = forkAccountReplicaShell(firstAccount);
    secondAccount.state.leftEntity = secondLeft;
    secondAccount.state.rightEntity = secondRight;
    secondAccount.proofHeader = {
      ...secondAccount.proofHeader,
      fromEntity: setup.entityId,
      toEntity: secondCounterpartyId,
    };
    putEntityAccountCandidate(setup.state.accounts, secondCounterpartyId, secondAccount);

    const firstHash = digest('e');
    const secondHash = digest('f');
    const workspace = (account: AccountState) => {
      const value = {
      workspaceHash: '',
      ops: [{ type: 'r2r' as const, tokenId: 1, amount: 1n }],
      lastModifiedByLeft: true,
      status: 'awaiting_counterparty' as const,
      version: 1,
      createdAt: setup.env.state.timestamp,
      lastUpdatedAt: setup.env.state.timestamp,
      // Make the local Entity the non-executor on both accounts, so its exact
      // settlement digest and post-proof digest are both quorum-signed.
      executorIsLeft: setup.entityId.toLowerCase() !== account.state.leftEntity.toLowerCase(),
      };
      value.workspaceHash = createSettlementWorkspaceHash(account.state, value);
      return value;
    };
    firstAccount.state.settlementWorkspace = workspace(firstAccount);
    secondAccount.state.settlementWorkspace = workspace(secondAccount);
    const firstPostHash = digest('1');
    const secondPostHash = digest('2');
    const settlementHanko = (
      account: AccountState,
      settlementHash: string,
      disputeHash: string,
    ): Extract<AccountTx, { type: 'settle_transition' }> => ({
      type: 'settle_transition',
      data: {
        kind: 'hanko',
        revision: 1,
        workspaceHash: account.state.settlementWorkspace!.workspaceHash,
        settlementNonce: 1,
        settlementHash,
        postProof: {
          nonce: 2,
          proofBodyHash: digest('0'),
          disputeHash,
        },
      },
    });
    const firstHankoTx = settlementHanko(firstAccount, firstHash, firstPostHash);
    const secondHankoTx = settlementHanko(secondAccount, secondHash, secondPostHash);
    firstAccount.mempool.push(firstHankoTx);
    secondAccount.mempool.push(secondHankoTx);
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
        createdAt: setup.env.state.timestamp,
      });
    }

    expect(attachHankoWitnessesToState(
      setup.state,
      witness,
      1,
      [setup.counterpartyId, secondCounterpartyId],
    )).toBe(4);
    if (firstHankoTx.data.kind !== 'hanko' || secondHankoTx.data.kind !== 'hanko') {
      throw new Error('TEST_SETTLEMENT_HANKO_INVALID');
    }
    expect(firstHankoTx.data.settlementHanko).toBe(witness.get(firstHash)?.hanko);
    expect(secondHankoTx.data.settlementHanko).toBe(witness.get(secondHash)?.hanko);
    expect(firstHankoTx.data.settlementHanko).not.toBe(secondHankoTx.data.settlementHanko);
    expect(firstHankoTx.data.postProof.hanko).toBe(witness.get(firstPostHash)?.hanko);
    expect(secondHankoTx.data.postProof.hanko).toBe(witness.get(secondPostHash)?.hanko);
    expect(firstAccount.state.settlementWorkspace.leftHanko).toBeUndefined();
    expect(firstAccount.state.settlementWorkspace.rightHanko).toBeUndefined();
  });
});

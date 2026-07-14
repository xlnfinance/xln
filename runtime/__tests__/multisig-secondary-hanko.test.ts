import { describe, expect, test } from 'bun:test';

import { accountInputProposal } from '../account/consensus/flush';
import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import { applyEntityFrame } from '../entity/consensus';
import { applyEntityInput } from '../entity/consensus';
import {
  attachHankoWitnessToOutputs,
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from '../entity/consensus/hanko-witness';
import { generateLazyEntityId } from '../entity/factory';
import { buildQuorumHanko, verifyHankoForHash } from '../hanko/signing';
import { createEmptyEnv } from '../runtime';
import type {
  AccountMachine,
  AccountInput,
  EntityReplica,
  EntityState,
  JurisdictionConfig,
} from '../types';

const seed = 'multisig-secondary-hanko alpha beta gamma';
const signerLabels = ['1', '2', '3'];
const validators = signerLabels.map(label => deriveSignerAddressSync(seed, label).toLowerCase());
const counterpartySigner = deriveSignerAddressSync(seed, '4').toLowerCase();
const threshold = 3n;
const digest = (hex: string): string => `0x${hex.repeat(64)}`;

const registerOnly = (signerId: string) => {
  clearSignerKeys();
  const label = signerLabels[validators.indexOf(signerId)] ?? '4';
  registerSignerKey(signerId, deriveSignerKeySync(seed, label));
};

const createMultisigAccountState = (localSignerId = validators[0]!) => {
  registerOnly(localSignerId);
  const env = createEmptyEnv(seed);
  env.timestamp = 10_000;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  const entityId = generateLazyEntityId(validators, threshold).toLowerCase();
  const counterpartyId = generateLazyEntityId([counterpartySigner], 1n).toLowerCase();
  const [leftEntity, rightEntity] = [entityId, counterpartyId].sort();
  const jurisdiction: JurisdictionConfig = {
    name: 'MultisigHanko',
    address: 'rpc://multisig-hanko',
    chainId: 31_337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  };
  const account = {
    leftEntity,
    rightEntity,
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
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
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
      threshold,
      validators,
      shares: Object.fromEntries(validators.map(validator => [validator, 1n])),
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
    isProposer: localSignerId === validators[0],
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
    registerOnly(signerId);
    return { signerId, signature: signAccountFrame(setup.env, signerId, hash) };
  });
  registerOnly(validators[0]!);
  return buildQuorumHanko(setup.env, setup.entityId, hash, signatures, setup.state.config);
};

describe('multisig secondary Hanko production', () => {
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
    expect(proposal.hashesToSign?.map(({ type }) => type)).toEqual(['entityFrame', 'accountFrame', 'dispute']);

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

    registerOnly(validators[0]!);
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
        hashPrecommits,
      });
      expect(result.outcome).toEqual({ kind: 'rejected', code });
      expect(result.workingReplica.state.height).toBe(0);
    }
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
        ack: { height: 1 },
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
    const workspace = (settlementHash: string) => ({
      ops: [],
      lastModifiedByLeft: true,
      status: 'ready_to_submit' as const,
      version: 1,
      createdAt: setup.env.timestamp,
      lastUpdatedAt: setup.env.timestamp,
      executorIsLeft: true,
      settlementHash,
    });
    firstAccount.settlementWorkspace = workspace(firstHash);
    secondAccount.settlementWorkspace = workspace(secondHash);
    const settlementInput = (toEntityId: string, settlementHash: string): AccountInput => ({
      kind: 'settle',
      fromEntityId: setup.entityId,
      toEntityId,
      settleAction: { type: 'approve', settlementHash, version: 1, nonceAtSign: 0 },
    });
    const firstInput = settlementInput(setup.counterpartyId, firstHash);
    const secondInput = settlementInput(secondCounterpartyId, secondHash);
    const outputs = [
      {
        entityId: setup.counterpartyId,
        signerId: counterpartySigner,
        entityTxs: [{ type: 'accountInput' as const, data: firstInput }],
      },
      {
        entityId: secondCounterpartyId,
        signerId: secondSigner,
        entityTxs: [{ type: 'accountInput' as const, data: secondInput }],
      },
    ];
    const witness = new Map<string, HankoWitnessEntry>();
    for (const hash of [firstHash, secondHash]) {
      witness.set(hash, {
        hanko: await buildExactQuorumHanko(setup, hash),
        type: 'settlement',
        entityHeight: 1,
        createdAt: setup.env.timestamp,
      });
    }

    expect(attachHankoWitnessToOutputs(outputs, [], witness, 1, setup.state)).toBe(2);
    if (firstInput.kind !== 'settle' || secondInput.kind !== 'settle') throw new Error('TEST_SETTLEMENT_INPUT_INVALID');
    expect(firstInput.settleAction.hanko).toBe(witness.get(firstHash)?.hanko);
    expect(secondInput.settleAction.hanko).toBe(witness.get(secondHash)?.hanko);
    expect(firstInput.settleAction.hanko).not.toBe(secondInput.settleAction.hanko);

    expect(sealHankoWitnessInState(setup.state, witness, 1)).toBe(2);
    const firstStoredHanko = setup.entityId === firstAccount.leftEntity
      ? firstAccount.settlementWorkspace.leftHanko
      : firstAccount.settlementWorkspace.rightHanko;
    const secondStoredHanko = setup.entityId === secondAccount.leftEntity
      ? secondAccount.settlementWorkspace.leftHanko
      : secondAccount.settlementWorkspace.rightHanko;
    expect(firstStoredHanko).toBe(witness.get(firstHash)?.hanko);
    expect(secondStoredHanko).toBe(witness.get(secondHash)?.hanko);
  });
});

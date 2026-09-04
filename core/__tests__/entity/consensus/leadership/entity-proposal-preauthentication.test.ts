import { describe, expect, test } from 'bun:test';

import { applyEntityInput } from '../../../../entity/consensus';
import { createEntityProposalFixture } from '../../../helpers/entity-proposal-fixture';

const {
  bindMutatedFrame,
  buildHonestProposal,
  createValidator,
  entityId,
  mutateNestedCommand,
} = createEntityProposalFixture('entity-proposal-preauthentication');
const singleSignerQuorum = createEntityProposalFixture(
  'entity-proposal-preauthentication:single-signer-quorum',
  1n,
);
const fourSignerQuorum = createEntityProposalFixture(
  'entity-proposal-preauthentication:active-duplicate',
  4n,
  ['1', '2', '3', '4'],
);

describe('Entity proposal pre-authentication', () => {
  test('rejects a proposal with no active proposer signature before replay', async () => {
    const { frame } = await buildHonestProposal();
    frame.collectedSigs = new Map();
    const validator = createValidator('2');

    const result = await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_PROPOSER_SIGNATURE_REQUIRED',
    });
    expect(result.workingReplica).toEqual(validator.replica);
    expect(result.outputs).toEqual([]);
    expect(result.candidateEffects).toEqual([]);
    expect(result.storageChanges).toEqual([]);
  });

  test('rejects a captured proposer signature after the frame body is rebound', async () => {
    const { frame, proposer } = await buildHonestProposal();
    mutateNestedCommand(frame);
    bindMutatedFrame(frame, proposer, true);
    const validator = createValidator('2');

    const result = await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_PROPOSER_SIGNATURE_INVALID',
    });
    expect(result.workingReplica).toEqual(validator.replica);
  });

  test('atomically rejects an authenticated proposal with an invalid nested command', async () => {
    const { frame, proposer } = await buildHonestProposal();
    mutateNestedCommand(frame);
    bindMutatedFrame(frame, proposer, false);
    const validator = createValidator('2');

    const result = await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_ENTITY_COMMAND_REJECTED',
    });
    expect(result.workingReplica).toEqual(validator.replica);
    expect(result.outputs).toEqual([]);
    expect(result.jOutputs).toEqual([]);
    expect(result.candidateEffects).toEqual([]);
    expect(result.storageChanges).toEqual([]);
  });

  test('treats a state-mismatched nested command as typed proposal rejection', async () => {
    const { frame, proposer } = await buildHonestProposal();
    const command = frame.txs[0];
    if (command?.type !== 'entityCommand') {
      throw new Error('TEST_ENTITY_COMMAND_MISSING');
    }
    frame.txs[0] = {
      ...command,
      data: {
        ...command.data,
        entityId: `0x${'ff'.repeat(32)}`,
      },
    };
    bindMutatedFrame(frame, proposer, false);
    const validator = createValidator('2');

    const result = await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_ENTITY_COMMAND_REJECTED',
    });
    expect(result.workingReplica).toEqual(validator.replica);
  });

  test('rejects non-canonical and parent-mismatched envelopes before replay', async () => {
    const validator = createValidator('2');
    const canonical = await buildHonestProposal();
    canonical.frame.parentFrameHash = `0x${'ab'.repeat(32)}`;
    canonical.frame.entityContext.parentFrameHash = canonical.frame.parentFrameHash;
    expect((await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: canonical.frame,
    })).outcome).toEqual({ kind: 'rejected', code: 'PROPOSAL_PARENT_MISMATCH' });

    const digest = await buildHonestProposal();
    digest.frame.hash = digest.frame.hash.toUpperCase().replace('0X', '0x');
    expect((await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: digest.frame,
    })).outcome).toEqual({ kind: 'rejected', code: 'COMMIT_DIGEST_NON_CANONICAL' });
  });

  test('rejects a signed Entity proposal beyond receiver clock allowance before replay', async () => {
    const { frame, proposer } = await buildHonestProposal();
    const validator = createValidator('2');
    frame.timestamp = validator.env.state.timestamp + 30_001;
    bindMutatedFrame(frame, proposer, false);

    const result = await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_TIMESTAMP_FUTURE',
    });
    expect(result.workingReplica).toEqual(validator.replica);
    expect(result.outputs).toEqual([]);
    expect(result.candidateEffects).toEqual([]);
    expect(result.storageChanges).toEqual([]);
  });

  test('exact active proposal duplicate preserves accumulated precommits', async () => {
    const { frame } = await fourSignerQuorum.buildHonestProposal();
    const validator2 = fourSignerQuorum.createValidator('2');
    const validator3 = fourSignerQuorum.createValidator('3');
    const validator4 = fourSignerQuorum.createValidator('4');
    const proposalInput = (signerId: string) => ({
      entityId: fourSignerQuorum.entityId,
      signerId,
      proposedFrame: structuredClone(frame),
    });
    const [prepared2, prepared3, prepared4] = await Promise.all([
      applyEntityInput(validator2.env, validator2.replica, proposalInput(validator2.signerId)),
      applyEntityInput(validator3.env, validator3.replica, proposalInput(validator3.signerId)),
      applyEntityInput(validator4.env, validator4.replica, proposalInput(validator4.signerId)),
    ]);
    const precommitFor = (
      result: typeof prepared2,
      signerId: string,
    ) => {
      const output = result.outputs.find(candidate =>
        candidate.signerId === signerId && candidate.hashPrecommits);
      if (!output) throw new Error(`TEST_ENTITY_PRECOMMIT_MISSING:${signerId}`);
      return output;
    };
    const withThirdSignature = await applyEntityInput(
      validator2.env,
      prepared2.workingReplica,
      precommitFor(prepared3, validator2.signerId),
    );
    const signersBeforeDuplicate = Array.from(
      withThirdSignature.workingReplica.lockedFrame?.collectedSigs?.keys() ?? [],
    ).sort();
    const cachedLocalPrecommit = withThirdSignature.workingReplica.lockedFrame
      ?.collectedSigs?.get(validator2.signerId);
    if (!cachedLocalPrecommit) throw new Error('TEST_ENTITY_LOCAL_PRECOMMIT_MISSING');
    expect(signersBeforeDuplicate).toHaveLength(3);

    const duplicate = await applyEntityInput(
      validator2.env,
      withThirdSignature.workingReplica,
      proposalInput(validator2.signerId),
    );
    expect(duplicate.outcome).toEqual({
      kind: 'noop',
      reason: 'PROPOSAL_ALREADY_PRECOMMITTED',
    });
    expect(duplicate.workingReplica).toEqual(withThirdSignature.workingReplica);
    expect(Array.from(
      duplicate.workingReplica.lockedFrame?.collectedSigs?.keys() ?? [],
    ).sort()).toEqual(signersBeforeDuplicate);
    expect(duplicate.outputs).toHaveLength(3);
    expect(duplicate.outputs.every(output =>
      output.hashPrecommits?.size === 1 &&
      output.hashPrecommits.get(validator2.signerId)?.every(
        (signature, index) => signature === cachedLocalPrecommit[index],
      ) === true,
    )).toBe(true);

    const committed = await applyEntityInput(
      validator2.env,
      duplicate.workingReplica,
      precommitFor(prepared4, validator2.signerId),
    );
    expect(committed.workingReplica.state.height).toBe(1);
  });

  test('replays and signs a certificate-installed lock missing local execution', async () => {
    const { frame } = await fourSignerQuorum.buildHonestProposal();
    const validator = fourSignerQuorum.createValidator('2');
    validator.replica.lockedFrame = structuredClone(frame);

    const result = await applyEntityInput(validator.env, validator.replica, {
      entityId: fourSignerQuorum.entityId,
      signerId: validator.signerId,
      proposedFrame: structuredClone(frame),
    });

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.candidate?.frameHash).toBe(frame.hash);
    expect(
      result.workingReplica.lockedFrame?.collectedSigs?.has(
        validator.signerId,
      ),
    ).toBe(true);
    expect(result.outputs).toHaveLength(3);
    expect(
      result.outputs.every(
        output =>
          output.hashPrecommitFrame?.frameHash === frame.hash &&
          output.hashPrecommits?.has(validator.signerId) === true,
      ),
    ).toBe(true);
  });

  test('requires the certified leader and exact Entity manifest head', async () => {
    const validator = createValidator('2');
    const invalidLeader = await buildHonestProposal();
    invalidLeader.frame.leader.proposerSignerId = createValidator('3').signerId;
    invalidLeader.frame.entityContext.proposerSignerId = invalidLeader.frame.leader.proposerSignerId;
    invalidLeader.frame.entityContext.proposerReplicaId =
      `${entityId}:${invalidLeader.frame.leader.proposerSignerId}`;
    expect((await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: invalidLeader.frame,
    })).outcome).toEqual({ kind: 'rejected', code: 'PROPOSAL_LEADER_INVALID' });

    const invalidManifest = await buildHonestProposal();
    invalidManifest.frame.hashesToSign = invalidManifest.frame.hashesToSign?.map(
      (entry, index) => index === 0
        ? { ...entry, context: `${entry.context}:mutated` }
        : entry,
    );
    expect((await applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: invalidManifest.frame,
    })).outcome).toEqual({ kind: 'rejected', code: 'PROPOSAL_FRAME_MANIFEST_INVALID' });
  });

  test('keeps impossible committed-state corruption fatal', async () => {
    const { frame } = await buildHonestProposal();
    const validator = createValidator('2');
    validator.replica.state.entityCommandNonces = {
      version: 2,
      boardHash: `0x${'00'.repeat(32)}`,
      boardEpoch: 0,
      bySigner: new Map(),
    } as never;

    await expect(applyEntityInput(validator.env, validator.replica, {
      entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    })).rejects.toThrow('ENTITY_COMMAND_NONCE_STATE_INVALID');
  });

  test('atomically rejects the same invalid command on the immediate commit path', async () => {
    const { frame, proposer } = await singleSignerQuorum.buildHonestProposal();
    singleSignerQuorum.mutateNestedCommand(frame);
    singleSignerQuorum.bindMutatedFrame(frame, proposer, false);
    const validator = singleSignerQuorum.createValidator('2');

    const result = await applyEntityInput(validator.env, validator.replica, {
      entityId: singleSignerQuorum.entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      code: 'COMMIT_ENTITY_COMMAND_REJECTED',
    });
    expect(result.workingReplica).toEqual(validator.replica);
    expect(result.outputs).toEqual([]);
    expect(result.candidateEffects).toEqual([]);
    expect(result.storageChanges).toEqual([]);
  });
});

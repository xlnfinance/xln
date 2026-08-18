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

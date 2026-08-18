import { afterEach, describe, expect, test } from 'bun:test';

import {
  signAccountFrame,
} from '../../../../account/crypto';
import { applyEntityInput } from '../../../../entity/consensus';
import {
  buildEntityLeaderVoteBody,
  hashEntityLeaderVoteBody,
} from '../../../../entity/consensus/leader';
import { getAccountJClaimNodeStore } from '../../../../entity/account/account-j-claim-node-store';
import { getConsumptionNodeStore } from '../../../../entity/consumption/consumption-store';
import {
  handleInboundP2PEntityInputs,
  processRuntime,
  readPersistedFrameJournal,
  createEmptyEnv,
} from '../../../../runtime';
import { signRuntimeEntityInputsEnvelope } from '../../../../runtime/admit/entity-input-envelope-auth.ts';
import {
  buildAuthenticatedInvalidProposal,
  buildMalformedBoardHandoverProposal,
  cleanupPersistedProposalFixtures,
  deliverEncryptedProposal,
  durableProposalFixture,
  installPersistedProposalValidator,
  proposalRuntimeFixture,
  restartPersistedProposalValidator,
} from '../../../helpers/entity-proposal-runtime-fixture';

afterEach(async () => {
  await cleanupPersistedProposalFixtures();
});

describe('Entity proposal Runtime isolation', () => {
  test('honest proposal reaches precommit and quorum on the exact frame', async () => {
    const { frame, proposer, proposerReplica } = await proposalRuntimeFixture.buildHonestProposal();
    const validator = proposalRuntimeFixture.createValidator('2');
    const precommitted = await applyEntityInput(validator.env, validator.replica, {
      entityId: proposalRuntimeFixture.entityId,
      signerId: validator.signerId,
      proposedFrame: frame,
    });
    expect(precommitted.outcome).toEqual({ kind: 'committed' });
    expect(precommitted.newState.height).toBe(1);
    expect(precommitted.newState.prevFrameHash).toBe(frame.hash);
    const commitNotice = precommitted.outputs.find(output =>
      output.signerId === proposer.signerId &&
      output.proposedFrame?.hash === frame.hash &&
      output.proposedFrame.hankos?.length);
    if (!commitNotice) throw new Error('TEST_PROPOSER_COMMIT_NOTICE_MISSING');

    const quorum = await applyEntityInput(
      proposer.env,
      proposerReplica,
      commitNotice,
    );
    expect(quorum.outcome).toEqual({ kind: 'committed' });
    expect(quorum.newState.height).toBe(1);
    expect(quorum.newState.prevFrameHash).toBe(frame.hash);
    expect(quorum.workingReplica.proposal).toBeUndefined();
    expect(quorum.workingReplica.candidate).toBeUndefined();
  });

  test('encrypted wire rejection leaves no frame, candidate, CAS, or restart residue', async () => {
    const { env, signerId } = await installPersistedProposalValidator();
    expect(env.state.height).toBe(1);
    const frame = await buildAuthenticatedInvalidProposal(env, signerId);
    const { inboundResults, remoteRuntimeId, remoteEnv } = await deliverEncryptedProposal(env, frame);
    expect(inboundResults).toEqual([expect.objectContaining({ kind: 'queued' })]);

    const consumptionBefore = getConsumptionNodeStore(env).size;
    const claimsBefore = getAccountJClaimNodeStore(env).size;
    await processRuntime(env, []);
    const replica = env.state.eReplicas.get(`${durableProposalFixture.entityId}:${signerId}`)!;
    expect(env.state.height).toBe(1);
    expect(env.infrastructure?.halted).toBe(false);
    expect(replica.state.height).toBe(0);
    expect(replica.proposal).toBeUndefined();
    expect(replica.candidate).toBeUndefined();
    expect(getConsumptionNodeStore(env).size).toBe(consumptionBefore);
    expect(getAccountJClaimNodeStore(env).size).toBe(claimsBefore);
    expect(env.infrastructure?.pendingConsumptionNodes?.size ?? 0).toBe(0);
    expect(env.infrastructure?.pendingAccountJClaimNodes?.size ?? 0).toBe(0);
    expect(await readPersistedFrameJournal(env, 2)).toBeNull();

    const voterId = durableProposalFixture.validators[0]!;
    const voteBody = buildEntityLeaderVoteBody(replica.state);
    const vote = {
      ...voteBody,
      voterId,
      signature: signAccountFrame(env, voterId, hashEntityLeaderVoteBody(voteBody)),
    };
    expect(handleInboundP2PEntityInputs(env, remoteRuntimeId, signRuntimeEntityInputsEnvelope(remoteEnv, env.runtimeId!, {
      sourceRuntimeId: remoteRuntimeId,
      sourceRuntimeHeight: 2,
      sourceRuntimeTimestamp: 2_000,
      entityInputs: [{
        entityId: durableProposalFixture.entityId,
        signerId,
        runtimeId: env.runtimeId!,
        leaderTimeoutVote: vote,
      }],
    })).kind).toBe('queued');
    await processRuntime(env, []);
    expect(env.state.height).toBe(2);
    const durableFrame = await readPersistedFrameJournal(env, 2);
    expect(durableFrame?.runtimeInput.entityInputs).toHaveLength(1);
    expect(durableFrame?.runtimeInput.entityInputs[0]?.proposedFrame).toBeUndefined();

    const restored = await restartPersistedProposalValidator(env);
    const restoredReplica = restored.state.eReplicas.get(
      `${durableProposalFixture.entityId}:${signerId}`,
    )!;
    expect(restored.state.height).toBe(2);
    expect(restoredReplica.state.height).toBe(0);
    expect(restoredReplica.proposal).toBeUndefined();
    expect(restoredReplica.candidate).toBeUndefined();
    expect(restoredReplica.leaderVotes?.has(voterId)).toBe(true);
    expect(getConsumptionNodeStore(restored).size).toBe(consumptionBefore);
    expect(getAccountJClaimNodeStore(restored).size).toBe(claimsBefore);
  }, 30_000);

  test('remote duplicate board handover is discarded without halting Runtime', async () => {
    const { env, signerId } = await installPersistedProposalValidator();
    const frame = await buildMalformedBoardHandoverProposal(env, signerId);
    const remoteEnv = createEmptyEnv('duplicate-board-handover-remote');
    const remoteRuntimeId = remoteEnv.runtimeId!;
    const inbound = handleInboundP2PEntityInputs(
      env,
      remoteRuntimeId,
      signRuntimeEntityInputsEnvelope(remoteEnv, env.runtimeId!, {
        sourceRuntimeId: remoteRuntimeId,
        sourceRuntimeHeight: 1,
        sourceRuntimeTimestamp: 1_000,
        entityInputs: [{
          entityId: durableProposalFixture.entityId,
          signerId,
          runtimeId: env.runtimeId!,
          proposedFrame: frame,
        }],
      }),
    );
    expect(inbound.kind).toBe('queued');

    await processRuntime(env, []);
    const replica = env.state.eReplicas.get(`${durableProposalFixture.entityId}:${signerId}`)!;
    expect(env.infrastructure?.halted).toBe(false);
    expect(env.state.height).toBe(1);
    expect(replica.state.height).toBe(0);
    expect(replica.proposal).toBeUndefined();
    expect(replica.candidate).toBeUndefined();
    expect(await readPersistedFrameJournal(env, 2)).toBeNull();
  }, 30_000);

  test('remote raw board handover cannot enter mempool or stall honest frames', async () => {
    const { env, signerId } = await installPersistedProposalValidator();
    const replicaKey = `${durableProposalFixture.entityId}:${signerId}`;
    const before = env.state.eReplicas.get(replicaKey)!;
    const remoteEnv = createEmptyEnv('raw-board-handover-remote');
    const remoteRuntimeId = remoteEnv.runtimeId!;
    const config = before.state.config;
    expect(() => handleInboundP2PEntityInputs(
      env,
      remoteRuntimeId,
      signRuntimeEntityInputsEnvelope(remoteEnv, env.runtimeId!, {
        sourceRuntimeId: remoteRuntimeId,
        sourceRuntimeHeight: 1,
        sourceRuntimeTimestamp: 1_000,
        entityInputs: [{
          entityId: durableProposalFixture.entityId,
          signerId,
          runtimeId: env.runtimeId!,
          entityTxs: [{
            type: 'boardHandover',
            data: {
              board: {
                mode: config.mode,
                threshold: config.threshold,
                validators: [...config.validators],
                shares: { ...config.shares },
              },
            },
          }],
        }],
      }),
    )).toThrow('INBOUND_ENTITY_UNSIGNED_USER_COMMAND');
    const after = env.state.eReplicas.get(replicaKey)!;
    expect(env.infrastructure?.halted).toBe(false);
    expect(env.state.height).toBe(1);
    expect(after.state.height).toBe(before.state.height);
    expect(after.mempool).toEqual([]);
    expect(await readPersistedFrameJournal(env, 2)).toBeNull();
  }, 30_000);
});

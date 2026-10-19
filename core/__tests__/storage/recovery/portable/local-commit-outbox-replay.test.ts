import { expect, test } from 'bun:test';
import { closeInfraDb, closeRuntimeDb, enqueueRuntimeInput, loadEnvFromDB, processRuntime } from '../../../../runtime';
import { generateLazyEntityId } from '../../../../entity/factory';
import { createTestEntityImportRuntimeTx } from '../../../../qa/entity-creation-fixture';
import { bootScenario, resolveScenarioBoardSigner } from '../../../../scenarios/harness/boot';
import { getLiveJAdapterEntries } from '../../../../runtime/j-submit/live-jadapters';
import { applyEntityInput } from '../../../../entity/consensus';
import type { EntityInput } from '../../../../entity/types';
import { safeStringify } from '../../../../protocol/serialization';
import { prepareLocallyAuthoredEntityTxs } from '../../../../entity/command';
import { resetPerfPhases, snapshotPerfPhases } from '../../../../support/performance/profile';

test('already-certified local Entity commits drain after WAL reopen without appending a frame', async () => {
  const seed = `local-commit-outbox-${process.pid}-${Date.now()}`;
  const boot = await bootScenario({
    name: 'local-commit-outbox',
    seed,
    signerIds: ['1', '2'],
    mode: 'browservm',
    storageEnabled: true,
  });
  let env = boot.env;
  env.quietRuntimeLogs = true;
  const validators = ['1', '2'].map(alias => resolveScenarioBoardSigner(env, alias));
  const entityId = generateLazyEntityId(validators, 2n, env).toLowerCase();
  try {
    enqueueRuntimeInput(env, {
      runtimeTxs: validators.map((signerId, index) =>
        createTestEntityImportRuntimeTx(env, {
          entityId,
          signerId,
          data: {
            isProposer: index === 0,
            config: {
              mode: 'proposer-based',
              threshold: 2n,
              validators,
              shares: Object.fromEntries(validators.map(id => [id, 1n])),
              jurisdiction: boot.jurisdiction,
            },
          },
        }),
      ),
      entityInputs: [],
    });
    await processRuntime(env);
    const signerId = validators[0];
    if (!signerId) throw new Error('TEST_SIGNER_MISSING');
    await processRuntime(env, [
      {
        entityId,
        signerId,
        entityTxs: [
          { type: 'chatMessage', data: { message: 'certified before local delivery', timestamp: env.state.timestamp } },
        ],
      },
    ]);
    let precommit: EntityInput | undefined;
    for (let round = 0; round < 20; round++) {
      precommit ??= env.pendingNetworkOutputs?.find(output => output.hashPrecommits?.size);
      if (
        [...env.state.eReplicas.values()].every(replica => replica.state.height === 1) &&
        env.pendingNetworkOutputs?.some(output => output.proposedFrame?.collectedSigs?.size)
      )
        break;
      await processRuntime(env);
    }
    expect([...env.state.eReplicas.values()].map(replica => replica.state.height)).toEqual([1, 1]);
    expect(env.pendingNetworkOutputs?.some(output => output.proposedFrame?.collectedSigs?.size)).toBe(true);
    const height = env.state.height;
    const heads = [...env.state.eReplicas.values()].map(replica => replica.state.prevFrameHash);
    const runtimeId = env.runtimeId;
    if (!runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    await boot.jadapter.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    const previousProfile = process.env['XLN_RUNTIME_PROCESS_PROFILE'];
    process.env['XLN_RUNTIME_PROCESS_PROFILE'] = '1';
    resetPerfPhases();
    let restored: Awaited<ReturnType<typeof loadEnvFromDB>>;
    try {
      restored = await loadEnvFromDB(runtimeId, seed);
    } finally {
      if (previousProfile === undefined) delete process.env['XLN_RUNTIME_PROCESS_PROFILE'];
      else process.env['XLN_RUNTIME_PROCESS_PROFILE'] = previousProfile;
    }
    if (!restored) throw new Error('TEST_WAL_RESTORE_MISSING');
    env = restored;
    // Selecting the checkpoint and replaying its tail share one verified WAL
    // handle. Reopening it repeats the same integrity decode before any work.
    expect(snapshotPerfPhases().phases['storage.open.verifyWalTail']?.count).toBe(1);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    for (let round = 0; round < 4; round++) await processRuntime(env);
    expect(env.pendingNetworkOutputs).toEqual([]);
    expect(env.runtimeMempool.entityInputs).toEqual([]);
    expect(env.state.height).toBe(height);
    expect([...env.state.eReplicas.values()].map(replica => replica.state.prevFrameHash)).toEqual(heads);
    if (!precommit?.hashPrecommitFrame || !precommit.hashPrecommits) throw new Error('TEST_SIGNED_PRECOMMIT_MISSING');
    const replica = env.state.eReplicas.get(`${entityId}:${precommit.signerId}`);
    if (!replica) throw new Error('TEST_PRECOMMIT_RECIPIENT_MISSING');
    const before = safeStringify(replica.state);
    const input = {
      entityId,
      signerId: precommit.signerId,
      hashPrecommitFrame: precommit.hashPrecommitFrame,
      hashPrecommits: precommit.hashPrecommits,
    };
    const duplicate = await applyEntityInput(env, replica, input);
    expect(duplicate.outcome).toEqual({ kind: 'noop', reason: 'PRECOMMIT_ALREADY_APPLIED' });
    expect(duplicate.outputs).toEqual([]);
    expect(duplicate.jOutputs).toEqual([]);
    expect(safeStringify(duplicate.newState)).toBe(before);
    const conflicting = await applyEntityInput(env, replica, {
      ...input,
      hashPrecommitFrame: { ...input.hashPrecommitFrame, frameHash: `0x${'ee'.repeat(32)}` },
    });
    expect(conflicting.outcome).toEqual({ kind: 'rejected', code: 'PRECOMMIT_FRAME_NOT_ACTIVE' });
    expect(safeStringify(conflicting.newState)).toBe(before);
    const proposalId = replica.state.proposals.keys().next().value;
    const voter = validators[1];
    if (!proposalId || !voter) throw new Error('TEST_GOVERNANCE_VOTE_MISSING');
    const vote = prepareLocallyAuthoredEntityTxs(env, replica.state, voter, [
      { type: 'vote', data: { proposalId, voter, choice: 'yes' } },
    ]);
    await processRuntime(env, [{ entityId, signerId, entityTxs: vote }]);
    const next = env.state.eReplicas.get(`${entityId}:${signerId}`);
    if (!next?.proposal) throw new Error('TEST_SUCCESSOR_PROPOSAL_MISSING');
    expect(next.proposal.height).toBe(2);
    const inFlight = safeStringify(next);
    const late = await applyEntityInput(env, next, { ...input, signerId });
    expect(late.outcome).toEqual({ kind: 'noop', reason: 'PRECOMMIT_ALREADY_APPLIED' });
    expect(safeStringify(next)).toBe(inFlight);
  } finally {
    for (const { adapter } of getLiveJAdapterEntries(env)) await adapter.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
}, 20_000);

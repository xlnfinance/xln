import {
  removeRejectedCrossJAccountInputsByIndex,
} from './entity-routing';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import {
  accountInputAck,
  accountInputProposal,
} from '../account/consensus/flush';
import type { RoutedEntityInput, RuntimeReplica } from './types';
import { commitEntityFrameCandidateState } from '../entity/state-clone';
import {
  isCommittedEntityInput,
  RuntimeEntityInputApplyError,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
  type RuntimeEntityInputBatchContext,
} from './entity-input-contract';
import {
  applyExternalEntityInput,
  collectCommittedAccountFrames,
  collectStagedEntityInput,
  publishStagedEntityNodeChanges,
  stageExternalEntityInput,
  type StagedEntityInput,
} from './entity-input-staging';
import { safeStringify } from '../protocol/serialization';

export const atomicPairInputsMatch = (
  first: RoutedEntityInput,
  second: RoutedEntityInput | undefined,
): second is RoutedEntityInput => {
  const left = first.atomicCrossJurisdictionPair;
  const right = second?.atomicCrossJurisdictionPair;
  return Boolean(
    left &&
      right &&
      left.phase === right.phase &&
      left.pairKey === right.pairKey,
  );
};

const expectedAtomicAccountFrame = (
  input: RoutedEntityInput,
): {
  counterpartyEntityId: string;
  height: number;
  stateHash: string;
} | null => {
  const phase = input.atomicCrossJurisdictionPair?.phase;
  const expected = getEffectiveEntityInputTxs(input).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    if (phase === 'proposal') {
      const frame = accountInputProposal(tx.data)?.frame;
      return frame
        ? [{
            counterpartyEntityId: tx.data.fromEntityId.toLowerCase(),
            height: frame.height,
            stateHash: String(frame.stateHash || '').toLowerCase(),
          }]
        : [];
    }
    const ack = accountInputAck(tx.data);
    return ack
      ? [{
          counterpartyEntityId: tx.data.fromEntityId.toLowerCase(),
          height: ack.height,
          stateHash: String(ack.frameHash || '').toLowerCase(),
        }]
      : [];
  });
  return expected.length === 1 ? expected[0]! : null;
};

const stagedAtomicLegCommitted = (staged: StagedEntityInput): boolean => {
  if (
    !isCommittedEntityInput(staged.result.outcome) ||
    !staged.result.entityFrameCommitted
  ) {
    return false;
  }
  const expected = expectedAtomicAccountFrame(staged.input);
  if (!expected) return false;
  return collectCommittedAccountFrames(
    staged.input,
    staged.result.nextReplica,
  ).some(frame =>
    frame.counterpartyEntityId === expected.counterpartyEntityId &&
    frame.height === expected.height &&
    frame.stateHash === expected.stateHash,
  );
};

const stagedAtomicLegHasSimultaneousProposal = (
  env: RuntimeReplica,
  staged: StagedEntityInput,
): boolean => {
  const proposals = getEffectiveEntityInputTxs(staged.input).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data)?.frame;
    return proposal ? [{ counterpartyEntityId: tx.data.fromEntityId.toLowerCase(), proposal }] : [];
  });
  if (proposals.length !== 1) return false;
  const { counterpartyEntityId, proposal } = proposals[0]!;
  const priorReplica = env.state.eReplicas.get(staged.replicaKey);
  const priorAccount = priorReplica?.state.accounts.get(counterpartyEntityId);
  const pending = priorAccount?.pendingFrame;
  return Boolean(
    pending &&
      pending.height === proposal.height &&
      String(pending.stateHash || '').toLowerCase() !==
        String(proposal.stateHash || '').toLowerCase(),
  );
};

const summarizeStagedAtomicLeg = (
  env: RuntimeReplica,
  staged: StagedEntityInput,
) => {
  const expected = expectedAtomicAccountFrame(staged.input);
  const priorReplica = env.state.eReplicas.get(staged.replicaKey);
  const priorAccount = expected
    ? priorReplica?.state.accounts.get(expected.counterpartyEntityId)
    : undefined;
  const nextAccount = expected
    ? staged.result.nextReplica.state.accounts.get(expected.counterpartyEntityId)
    : undefined;
  return {
    inputIndex: staged.inputIndex,
    entityId: staged.input.entityId,
    outcome: staged.result.outcome,
    entityFrameCommitted: staged.result.entityFrameCommitted,
    expected,
    prior: priorAccount
      ? {
          currentHeight: priorAccount.currentFrame.height,
          currentStateHash: priorAccount.currentFrame.stateHash,
          pendingHeight: priorAccount.pendingFrame?.height ?? null,
          pendingStateHash: priorAccount.pendingFrame?.stateHash ?? null,
        }
      : null,
    next: nextAccount
      ? {
          currentHeight: nextAccount.currentFrame.height,
          currentStateHash: nextAccount.currentFrame.stateHash,
          pendingHeight: nextAccount.pendingFrame?.height ?? null,
          pendingStateHash: nextAccount.pendingFrame?.stateHash ?? null,
        }
      : null,
    committedAccountFrames: collectCommittedAccountFrames(
      staged.input,
      staged.result.nextReplica,
    ),
  };
};

const atomicPairProtocolRejection = (
  error: unknown,
): RuntimeEntityInputApplyError | null => {
  if (
    !(error instanceof RuntimeEntityInputApplyError) ||
    !error.isRemoteIngress
  ) {
    return null;
  }
  if (error.failureKind === 'malformed-ingress') return error;
  const detail =
    error.cause instanceof Error
      ? error.cause.message
      : String(error.cause ?? '');
  const invalidPrefixes = [
    'CONSENSUS_OUTPUT_WITNESS_HANKO_INVALID',
    'CONSENSUS_OUTPUT_HANKO_INVALID',
    'CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH',
    'CONSENSUS_OUTPUT_SEMANTIC_SOURCE_MISMATCH',
  ];
  return invalidPrefixes.some(prefix => detail.startsWith(prefix))
    ? error
    : null;
};

const recordAtomicPairRejection = (
  context: RuntimeEntityInputBatchContext,
  inputIndexes: [number, number],
  code: RuntimeEntityInputApplyResult['rejectedAtomicPairs'][number]['code'],
  detail: string,
): void => {
  context.rejectedAtomicPairs.push({ inputIndexes, code, detail });
  for (const inputIndex of inputIndexes) {
    context.inputOutcomes.push({
      inputIndex,
      outcome: { kind: 'rejected', code },
      entityFrameCommitted: false,
      committedAccountFrames: [],
    });
  }
};

const applyRetainedNonAtomicInputs = async (
  env: RuntimeReplica,
  pair: readonly [RoutedEntityInput, RoutedEntityInput],
  indexes: readonly [number, number],
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  for (const [pairIndex, input] of pair.entries()) {
    const retained = removeRejectedCrossJAccountInputsByIndex(
      env,
      [input],
      new Set([0]),
    )[0];
    if (!retained) continue;
    await applyExternalEntityInput(
      env,
      retained,
      indexes[pairIndex]!,
      options,
      context,
    );
  }
};

const summarizeAtomicCollisionTx = (
  tx: ReturnType<typeof getEffectiveEntityInputTxs>[number],
) => {
  if (tx.type !== 'accountInput') return { type: tx.type };
  const proposal = accountInputProposal(tx.data);
  const ack = accountInputAck(tx.data);
  return {
    type: tx.type,
    kind: tx.data.kind,
    fromEntityId: tx.data.fromEntityId,
    toEntityId: tx.data.toEntityId,
    proposalHeight: proposal?.frame.height ?? null,
    proposalHash: proposal?.frame.stateHash ?? null,
    ackHeight: ack?.height ?? null,
    ackHash: ack?.frameHash ?? null,
  };
};

const summarizeAtomicReplicaCollisionLeg = (entry: StagedEntityInput) => ({
  inputIndex: entry.inputIndex,
  entityId: entry.input.entityId,
  signerId: entry.input.signerId,
  resolvedReplicaKey: entry.replicaKey,
  from: entry.input.from ?? null,
  sourceRuntimeFrame: entry.input.sourceRuntimeFrame ?? null,
  proposedFrame: entry.input.proposedFrame
    ? { height: entry.input.proposedFrame.height, hash: entry.input.proposedFrame.hash }
    : null,
  entityTxCount: getEffectiveEntityInputTxs(entry.input).length,
  entityTxSamples: getEffectiveEntityInputTxs(entry.input)
    .slice(0, 8)
    .map(summarizeAtomicCollisionTx),
  phase: entry.input.atomicCrossJurisdictionPair?.phase,
  pairKeyPrefix: entry.input.atomicCrossJurisdictionPair?.pairKey.slice(0, 160),
  pairKeyLength: entry.input.atomicCrossJurisdictionPair?.pairKey.length,
});

const atomicReplicaCollisionError = (
  staged: readonly [StagedEntityInput, StagedEntityInput],
): Error => new Error(
  'RUNTIME_CROSS_J_ATOMIC_PAIR_REPLICA_COLLISION:' + safeStringify({
    replicaKey: staged[0].replicaKey,
    legs: staged.map(summarizeAtomicReplicaCollisionLeg),
  }),
);

export const applyAtomicEntityInputPair = async (
  env: RuntimeReplica,
  pair: readonly [RoutedEntityInput, RoutedEntityInput],
  firstInputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  const indexes: [number, number] = [
    firstInputIndex,
    firstInputIndex + 1,
  ];
  let staged: [StagedEntityInput, StagedEntityInput];
  try {
    staged = [
      await stageExternalEntityInput(env, pair[0], indexes[0], options, false),
      await stageExternalEntityInput(env, pair[1], indexes[1], options, false),
    ];
  } catch (error) {
    const rejection = atomicPairProtocolRejection(error);
    if (!rejection || options.isReplay) throw error;
    recordAtomicPairRejection(
      context,
      indexes,
      'CROSS_J_ACCOUNT_PAIR_PROTOCOL_REJECTED',
      rejection.message,
    );
    await applyRetainedNonAtomicInputs(env, pair, indexes, options, context);
    return;
  }

  if (staged[0].replicaKey === staged[1].replicaKey) {
    throw atomicReplicaCollisionError(staged);
  }
  const committedLegs = staged.map(stagedAtomicLegCommitted);
  if (!committedLegs.every(Boolean)) {
    if (options.isReplay) {
      throw new Error('RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED');
    }
    const deferredBySimultaneousProposal = staged.every((entry, index) =>
      committedLegs[index] || stagedAtomicLegHasSimultaneousProposal(env, entry));
    const detail = safeStringify({
      reason: deferredBySimultaneousProposal
        ? 'simultaneous-account-proposal'
        : 'stale-or-rejected-account-leg',
      legs: staged.map(entry => summarizeStagedAtomicLeg(env, entry)),
    });
    recordAtomicPairRejection(
      context,
      indexes,
      deferredBySimultaneousProposal
        ? 'CROSS_J_ACCOUNT_PAIR_DEFERRED'
        : 'CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED',
      detail,
    );
    await applyRetainedNonAtomicInputs(env, pair, indexes, options, context);
    return;
  }

  // No effect escapes before both touched Account candidates are committable.
  for (const entry of staged) {
    commitEntityFrameCandidateState(entry.result.nextReplica.state);
  }
  for (const entry of staged) {
    collectStagedEntityInput(env, entry, options, context);
  }
  publishStagedEntityNodeChanges(env, staged);
};

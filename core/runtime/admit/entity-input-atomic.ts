import {
  normalizeEntityKey,
  removeRejectedCrossJAccountInputsByIndex,
} from '../delivery/topology/entity-routing.ts';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';
import {
  accountInputAck,
  accountInputProposal,
} from '../../account/consensus/flush.ts';
import type { RoutedEntityInput, RuntimeReplica } from '../types.ts';
import { commitEntityFrameCandidateState, committedEntityStateRoot } from '../../entity/state-clone.ts';
import {
  isCommittedEntityInput,
  RuntimeEntityInputApplyError,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
  type RuntimeEntityInputBatchContext,
} from './entity-input-contract.ts';
import {
  applyExternalEntityInput,
  collectCommittedAccountFrames,
  collectStagedEntityInput,
  publishStagedEntityNodeChanges,
  stageExternalEntityInput,
  type StagedEntityInput,
} from './entity-input-staging.ts';
import { safeStringify } from '../../protocol/serialization';

export const atomicPairInputsMatch = (
  first: RoutedEntityInput,
  second: RoutedEntityInput | undefined,
): second is RoutedEntityInput => {
  const left = first.atomicCrossJurisdictionPair;
  const right = second?.atomicCrossJurisdictionPair;
  if (!left || !right) return false;
  if (left.phase !== right.phase || left.pairKey !== right.pairKey) return false;
  // Sibling legs are distinct Entities that happen to share a Runtime, and
  // buildCrossJProposalFrameCandidate only ever pairs candidates that target
  // different ones. This re-pairing walks adjacent inputs by their stamped
  // {phase, pairKey} alone, so a batch that puts two same-Entity inputs of one
  // pairKey side by side would otherwise form a pair the router never would.
  //
  // Two legs on one replica need no cross-Entity atomicity: they land in the
  // same Entity frame and already commit or abort together. Declining the pair
  // routes them through the ordinary path instead of failing the Runtime frame.
  return normalizeEntityKey(first.entityId) !== normalizeEntityKey(second.entityId);
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

const describeStagedAtomicLeg = (staged: StagedEntityInput): Record<string, unknown> => {
  const expected = expectedAtomicAccountFrame(staged.input);
  const account = expected
    ? staged.result.nextReplica.state.accounts.get(expected.counterpartyEntityId)
    : undefined;
  return {
    entityId: staged.input.entityId,
    signerId: staged.input.signerId,
    sourceRuntimeFrame: staged.input.sourceRuntimeFrame ?? null,
    marker: staged.input.atomicCrossJurisdictionPair ?? null,
    expected,
    outcome: staged.result.outcome,
    entityFrameCommitted: staged.result.entityFrameCommitted,
    entityHeight: staged.result.nextReplica.state.height,
    account: account
      ? {
          currentHeight: account.currentFrame.height,
          currentHash: account.currentFrame.stateHash,
          pendingHeight: account.pendingFrame?.height ?? null,
          pendingHash: account.pendingFrame?.stateHash ?? null,
          mempoolTxs: account.mempool.length,
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
  return null;
};

const recordAtomicPairRejection = (
  context: RuntimeEntityInputBatchContext,
  inputIndexes: [number, number],
  code: RuntimeEntityInputApplyResult['rejectedAtomicPairs'][number]['code'],
  detail: string,
  entityIds: [string, string],
): void => {
  context.rejectedAtomicPairs.push({ inputIndexes, code, detail, entityIds });
  for (const inputIndex of inputIndexes) {
    context.inputOutcomes.push({
      inputIndex,
      outcome: { kind: 'rejected', code },
      entityFrameCommitted: false,
      committedAccountFrames: [],
    });
  }
};

/**
 * Both Account legs of a failed atomic cohort are cancelled together. Any other
 * Entity payload in those inputs is re-applied without the violating
 * accountInputs — never a one-sided Account settle of the broken pair.
 */
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

export const applyAtomicEntityInputPair = async (
  env: RuntimeReplica,
  pair: readonly [RoutedEntityInput, RoutedEntityInput],
  firstInputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  // This path is reached only via atomicPairInputsMatch, which requires both
  // legs to carry a matching atomicCrossJurisdictionPair stamp — a plain
  // payment input is never tagged and never routes here. Assert it directly
  // at the entry point rather than trusting the caller's filter transitively,
  // so a future router bug that mis-pairs a payment input surfaces loudly
  // instead of silently entangling payment state with cross-J atomicity.
  if (!pair[0].atomicCrossJurisdictionPair || !pair[1].atomicCrossJurisdictionPair) {
    throw new Error(
      `RUNTIME_ATOMIC_PAIR_MISSING_CROSS_J_STAMP:${pair[0].entityId}:${pair[1].entityId}`,
    );
  }
  const entityIds: [string, string] = [pair[0].entityId, pair[1].entityId];
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
      entityIds,
    );
    await applyRetainedNonAtomicInputs(env, pair, indexes, options, context);
    return;
  }

  if (staged[0].replicaKey === staged[1].replicaKey) {
    throw new Error(
      `RUNTIME_CROSS_J_ATOMIC_PAIR_REPLICA_COLLISION:${staged[0].replicaKey}`,
    );
  }
  if (!staged.every(stagedAtomicLegCommitted)) {
    if (options.isReplay) {
      throw new Error('RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED');
    }
    recordAtomicPairRejection(
      context,
      indexes,
      'CROSS_J_ACCOUNT_PAIR_NOT_COMMITTED',
      safeStringify({
        reason: 'One or both signed Account legs were stale or rejected',
        legs: staged.map(describeStagedAtomicLeg),
      }),
      entityIds,
    );
    await applyRetainedNonAtomicInputs(env, pair, indexes, options, context);
    return;
  }

  // No effect escapes before both touched Account candidates are committable.
  for (const entry of staged) {
    commitEntityFrameCandidateState(
      entry.result.nextReplica.state,
      committedEntityStateRoot(entry.result.nextReplica),
    );
  }
  for (const entry of staged) {
    collectStagedEntityInput(env, entry, options, context);
  }
  publishStagedEntityNodeChanges(env, staged);
};

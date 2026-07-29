import {
  removeRejectedCrossJAccountInputsByIndex,
} from './entity-routing';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import {
  accountInputAck,
  accountInputProposal,
} from '../account/consensus/flush';
import type { RoutedEntityInput, RuntimeState } from '../types';
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
  stageExternalEntityInput,
  type StagedEntityInput,
} from './entity-input-staging';

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
  env: RuntimeState,
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
  env: RuntimeState,
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
      'One or both signed Account legs were stale or rejected',
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
};

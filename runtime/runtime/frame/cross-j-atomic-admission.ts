import { createStructuredLogger } from '../../infra/logger';
import { safeStringify } from '../../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import type { RuntimeReplica, RoutedEntityInput } from '../types';
import type { RuntimeEntityInputApplyResult } from '../entity-inputs';
import {
  selectMatchedCrossJAccountInputPairs,
  selectPotentialCrossJAccountInputPairs,
} from '../entity-routing';
import {
  recordRejectedAtomicCrossJInputs,
  summarizeAtomicCrossJAccountInput,
} from './cross-j-evidence';

const runtimeLog = createStructuredLogger('runtime');
const MAX_CROSS_J_LOG_SAMPLES = 8;

type CrossJSelection = ReturnType<typeof selectMatchedCrossJAccountInputPairs>;
type CrossJPair = CrossJSelection['pairs'][number];
type EntityInputOutcomes = RuntimeEntityInputApplyResult['inputOutcomes'];

type AtomicProposalRetryCohort = Readonly<{
  indexes: readonly [number, number];
  frameHeight: number;
  frameTimestamp: number;
}>;

const compareAtomicProposalRetryCohorts = (
  left: AtomicProposalRetryCohort,
  right: AtomicProposalRetryCohort,
): number =>
  left.frameHeight - right.frameHeight ||
  left.frameTimestamp - right.frameTimestamp;

/**
 * Transport may retry one already-signed proposal cohort in a later Runtime
 * envelope. Deduplicate only the complete pair: choosing legs independently
 * could synthesize a cohort that no sender ever authenticated. Account-frame
 * Full routed leg bytes, including Account evidence, must match. Only the outer
 * source Runtime frame may advance during a transport retry; changed evidence
 * remains ambiguous and is rejected by strict Account verification.
 */
const coalesceExactAtomicProposalRetries = (
  inputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => {
  const winners = new Map<string, AtomicProposalRetryCohort>();
  const dropped = new Set<number>();
  for (const pair of selectPotentialCrossJAccountInputPairs(inputs)) {
    const indexes = [pair.sourceInputIndex, pair.targetInputIndex] as const;
    const legs = indexes.map(index => inputs[index]!);
    const markers = legs.map(leg => leg.atomicCrossJurisdictionPair);
    if (!markers.every(marker =>
      marker?.phase === 'proposal' && marker.pairKey === pair.pairKey)) continue;
    const frame = legs[0]!.sourceRuntimeFrame;
    if (!frame) continue;
    const semanticKey = safeStringify(legs.map(leg => {
      const { sourceRuntimeFrame: _retryEnvelope, ...exactLeg } = leg;
      return safeStringify(exactLeg);
    }).sort());
    const candidate: AtomicProposalRetryCohort = {
      indexes,
      frameHeight: frame.height,
      frameTimestamp: frame.timestamp,
    };
    const winner = winners.get(semanticKey);
    if (!winner) {
      winners.set(semanticKey, candidate);
      continue;
    }
    if (compareAtomicProposalRetryCohorts(candidate, winner) > 0) {
      winner.indexes.forEach(index => dropped.add(index));
      winners.set(semanticKey, candidate);
    } else {
      candidate.indexes.forEach(index => dropped.add(index));
    }
  }
  return inputs.filter((_input, index) => !dropped.has(index));
};

export const selectPotentialAtomicCrossJInputIndexes = (
  inputs: readonly RoutedEntityInput[],
): Set<number> =>
  new Set(
    selectPotentialCrossJAccountInputPairs(inputs)
      .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]),
  );

export const selectPotentialAtomicCrossJInputPairs = (
  inputs: readonly RoutedEntityInput[],
) => selectPotentialCrossJAccountInputPairs(inputs);

export const atomicCrossJPairIndexesThatDidNotCommit = (
  pairs: CrossJSelection['pairs'],
  outcomes: EntityInputOutcomes,
): Set<number> => {
  const committed = new Map(
    outcomes
      .filter(entry => entry.outcome.kind === 'committed' && entry.entityFrameCommitted)
      .map(entry => [entry.inputIndex, entry]),
  );
  const accountFrameCommitted = (
    inputIndex: number,
    expected: CrossJPair['sourceAccountFrame'],
  ): boolean =>
    committed
      .get(inputIndex)
      ?.committedAccountFrames.some(
        frame =>
          frame.counterpartyEntityId === expected.counterpartyEntityId.toLowerCase() &&
          frame.height === expected.height &&
          frame.stateHash === expected.stateHash.toLowerCase(),
      ) === true;
  return new Set(
    pairs
      .filter(
        pair =>
          !accountFrameCommitted(pair.sourceInputIndex, pair.sourceAccountFrame) ||
          !accountFrameCommitted(pair.targetInputIndex, pair.targetAccountFrame),
      )
      .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]),
  );
};

const groupAtomicPairsFirst = (
  env: RuntimeReplica,
  selection: CrossJSelection,
): CrossJSelection => {
  if (selection.pairs.length === 0) return selection;
  const orderedPairs = [...selection.pairs].sort(
    (left, right) =>
      Math.min(left.sourceInputIndex, left.targetInputIndex) -
      Math.min(right.sourceInputIndex, right.targetInputIndex),
  );
  const pairedIndexes = new Set(orderedPairs.flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]));
  if (pairedIndexes.size !== orderedPairs.length * 2) {
    throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_INPUT_OVERLAP');
  }
  const groupedInputs = [
    ...orderedPairs.flatMap(pair =>
      [pair.sourceInputIndex, pair.targetInputIndex]
        .sort((left, right) => left - right)
        .map(inputIndex => selection.inputs[inputIndex]!),
    ),
    ...selection.inputs.filter((_input, inputIndex) => !pairedIndexes.has(inputIndex)),
  ];
  const grouped = selectMatchedCrossJAccountInputPairs(env, groupedInputs);
  if (grouped.rejectedLegs.length > 0 || grouped.pairs.length !== selection.pairs.length) {
    throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_GROUPING_DIVERGED');
  }
  const markers = new Map<number, RoutedEntityInput['atomicCrossJurisdictionPair']>();
  for (const pair of grouped.pairs) {
    const marker = { phase: pair.phase, pairKey: pair.pairKey };
    markers.set(pair.sourceInputIndex, marker);
    markers.set(pair.targetInputIndex, marker);
  }
  return {
    ...grouped,
    inputs: grouped.inputs.map((input, inputIndex) => {
      const marker = markers.get(inputIndex);
      return marker
        ? { ...input, atomicCrossJurisdictionPair: { ...marker } }
        : input;
    }),
  };
};

export const admitAtomicCrossJAccountInputs = (
  env: RuntimeReplica,
  inputs: readonly RoutedEntityInput[],
  isReplay: boolean,
): { inputs: RoutedEntityInput[]; pairs: CrossJSelection['pairs'] } => {
  const coalescedInputs = coalesceExactAtomicProposalRetries(inputs);
  const initial = selectMatchedCrossJAccountInputPairs(env, coalescedInputs);
  if (initial.pairs.length > 0) {
    runtimeLog.info('crossj.atomic_pair_admission', {
      inputCount: coalescedInputs.length,
      pairCount: initial.pairs.length,
      pairs: initial.pairs.slice(0, MAX_CROSS_J_LOG_SAMPLES).map(pair => ({
        sourceInputIndex: pair.sourceInputIndex,
        targetInputIndex: pair.targetInputIndex,
        sourceHeight: pair.sourceAccountFrame.height,
        targetHeight: pair.targetAccountFrame.height,
      })),
    });
  }
  if (initial.rejectedLegs.length > 0) {
    const rejectedInputIndexes = [...new Set(
      initial.rejectedLegs.map(leg => leg.inputIndex),
    )];
    if (isReplay) throw new Error('RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_INVALID');
    env.warn('network', 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH', {
      received: coalescedInputs.length,
      rejectedCount: rejectedInputIndexes.length,
      rejectedSamples: rejectedInputIndexes
        .slice(0, MAX_CROSS_J_LOG_SAMPLES)
        .map(inputIndex => ({
          inputIndex,
          evidenceHash: keccak256(toUtf8Bytes(safeStringify(
            summarizeAtomicCrossJAccountInput(coalescedInputs[inputIndex]!, inputIndex),
          ))),
        })),
    });
    recordRejectedAtomicCrossJInputs(
      env,
      'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH',
      'A cross-j Account leg arrived without its exact atomic sibling leg and was ignored',
    );
  }
  const structurallyRetained = initial.rejectedLegs.length > 0
    ? selectMatchedCrossJAccountInputPairs(env, initial.inputs)
    : initial;
  const selection = groupAtomicPairsFirst(env, structurallyRetained);
  if (selection.rejectedLegs.length > 0) {
    throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_SELECTION_UNSTABLE');
  }
  return selection;
};

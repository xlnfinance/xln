import { createStructuredLogger } from '../../infra/logger';
import { safeStringify } from '../../protocol/serialization';
import type { RuntimeState, RoutedEntityInput } from '../types';
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

type CrossJSelection = ReturnType<typeof selectMatchedCrossJAccountInputPairs>;
type CrossJPair = CrossJSelection['pairs'][number];
type EntityInputOutcomes = RuntimeEntityInputApplyResult['inputOutcomes'];

export const selectPotentialAtomicCrossJInputIndexes = (
  inputs: readonly RoutedEntityInput[],
): Set<number> =>
  new Set(
    selectPotentialCrossJAccountInputPairs(inputs)
      .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]),
  );

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
  env: RuntimeState,
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
  env: RuntimeState,
  inputs: readonly RoutedEntityInput[],
  isReplay: boolean,
): { inputs: RoutedEntityInput[]; pairs: CrossJSelection['pairs'] } => {
  const initial = selectMatchedCrossJAccountInputPairs(env, inputs);
  if (initial.pairs.length > 0) {
    runtimeLog.info('crossj.atomic_pair_admission', {
      inputCount: inputs.length,
      pairCount: initial.pairs.length,
      pairs: initial.pairs.map(pair => ({
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
      received: inputs.length,
      rejectedInputIndexes,
      inputSummary: safeStringify(inputs.map(summarizeAtomicCrossJAccountInput)),
    });
    recordRejectedAtomicCrossJInputs(
      env,
      inputs,
      rejectedInputIndexes,
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

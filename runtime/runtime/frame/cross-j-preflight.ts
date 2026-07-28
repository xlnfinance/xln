import { getEffectiveEntityInputTxs } from '../../entity/consensus/output-envelope';
import { createStructuredLogger } from '../../infra/logger';
import { safeStringify } from '../../protocol/serialization';
import type { RuntimeState, JInput, RoutedEntityInput } from '../../types';
import {
  applyMergedEntityInputs,
  RuntimeEntityInputApplyError,
} from '../entity-inputs';
import {
  selectMatchedCrossJAccountInputPairs,
  selectPotentialCrossJAccountInputPairs,
  type RuntimeEntityRoutingDeps,
} from '../entity-routing';
import { cloneRuntimeFrameWorkingEnv } from './clone';
import {
  recordRejectedAtomicCrossJInputs,
  summarizeAtomicCrossJAccountInput,
} from './cross-j-evidence';

const runtimeLog = createStructuredLogger('runtime');

type CrossJSelection = ReturnType<typeof selectMatchedCrossJAccountInputPairs>;
type CrossJPair = CrossJSelection['pairs'][number];
type EntityInputOutcomes = Awaited<ReturnType<typeof applyMergedEntityInputs>>['inputOutcomes'];

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

const accountFrameMatches = (
  env: RuntimeState,
  expected: CrossJPair['sourceAccountFrame'],
): boolean => {
  const replica = [...env.eReplicas.values()].find(
    candidate =>
      candidate.entityId.toLowerCase() === expected.entityId.toLowerCase() &&
      candidate.signerId.toLowerCase() === expected.signerId.toLowerCase(),
  );
  const account = [...(replica?.state.accounts.entries() ?? [])].find(
    ([counterpartyId]) => counterpartyId.toLowerCase() === expected.counterpartyEntityId.toLowerCase(),
  )?.[1];
  return (
    account?.currentFrame.height === expected.height &&
    String(account.currentFrame.stateHash || '').toLowerCase() === expected.stateHash.toLowerCase()
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
  if (grouped.droppedInputIndexes.length > 0 || grouped.pairs.length !== selection.pairs.length) {
    throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_GROUPING_DIVERGED');
  }
  return grouped;
};

const describeFailedPreview = (
  preview: Awaited<ReturnType<typeof applyMergedEntityInputs>>,
  failedIndexes: Set<number>,
): string =>
  failedIndexes.size === 0 ? '' : safeStringify({
    outcomes: preview.inputOutcomes.map(entry => ({
      inputIndex: entry.inputIndex,
      kind: entry.outcome.kind,
      entityFrameCommitted: entry.entityFrameCommitted,
      committedAccountFrames: entry.committedAccountFrames,
    })),
    localCrossJurisdictionEvents: preview.localCrossJurisdictionEventTrace.map(input => ({
      entityId: input.entityId,
      txTypes: getEffectiveEntityInputTxs(input).map(tx => tx.type),
    })),
  });

const previewAtomicPairs = async (
  env: RuntimeState,
  selection: CrossJSelection,
  initialJOutbox: JInput[],
  routingDeps: RuntimeEntityRoutingDeps,
): Promise<{ failedIndexes: Set<number>; failureDetail: string }> => {
  try {
    const preview = await applyMergedEntityInputs(
      cloneRuntimeFrameWorkingEnv(env),
      selection.inputs,
      initialJOutbox,
      { isReplay: false, routingDeps },
    );
    const failedIndexes = atomicCrossJPairIndexesThatDidNotCommit(
      selection.pairs,
      preview.inputOutcomes,
    );
    return {
      failedIndexes,
      failureDetail: describeFailedPreview(preview, failedIndexes),
    };
  } catch (error) {
    if (!(error instanceof RuntimeEntityInputApplyError) || !error.isRemoteIngress) throw error;
    const failedInputIndex = selection.inputs.findIndex(
      input =>
        input.entityId.toLowerCase() === error.entityId.toLowerCase() &&
        input.signerId.toLowerCase() === error.signerId.toLowerCase() &&
        String(input.from ?? '').trim().toLowerCase() === error.sourceRuntimeId.toLowerCase() &&
        input.sourceRuntimeFrame?.height === error.sourceRuntimeHeight &&
        input.sourceRuntimeFrame?.timestamp === error.sourceRuntimeTimestamp,
    );
    const failedPair = selection.pairs.find(
      pair => pair.sourceInputIndex === failedInputIndex || pair.targetInputIndex === failedInputIndex,
    );
    // A malformed exact two-leg remote cohort is a protocol rejection. Any
    // unrelated exception is a programming/storage fault and must halt.
    if (!failedPair) throw error;
    return {
      failedIndexes: new Set([failedPair.sourceInputIndex, failedPair.targetInputIndex]),
      failureDetail: error.message,
    };
  }
};

const addAlreadyCommittedPairIndexes = (
  env: RuntimeState,
  selection: CrossJSelection,
  failedIndexes: Set<number>,
): void => {
  for (const pair of selection.pairs) {
    if (
      accountFrameMatches(env, pair.sourceAccountFrame) ||
      accountFrameMatches(env, pair.targetAccountFrame)
    ) {
      failedIndexes.add(pair.sourceInputIndex);
      failedIndexes.add(pair.targetInputIndex);
    }
  }
};

const rejectedPairIndexes = (
  selection: CrossJSelection,
  failedIndexes: Set<number>,
): number[] =>
  selection.pairs.flatMap(pair => {
    const indexes = [pair.sourceInputIndex, pair.targetInputIndex];
    return indexes.some(inputIndex => failedIndexes.has(inputIndex)) ? indexes : [];
  });

export const prepareAtomicCrossJAccountInputs = async (
  env: RuntimeState,
  inputs: readonly RoutedEntityInput[],
  initialJOutbox: JInput[],
  isReplay: boolean,
  routingDeps: RuntimeEntityRoutingDeps,
): Promise<{ inputs: RoutedEntityInput[]; pairs: CrossJSelection['pairs'] }> => {
  const initial = selectMatchedCrossJAccountInputPairs(env, inputs);
  if (initial.pairs.length > 0) {
    runtimeLog.info('crossj.atomic_pair_preflight', {
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
  if (initial.droppedInputIndexes.length > 0) {
    if (isReplay) throw new Error('RUNTIME_REPLAY_CROSS_J_ACCOUNT_PAIR_INVALID');
    env.warn('network', 'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH', {
      received: inputs.length,
      droppedInputIndexes: initial.droppedInputIndexes,
      inputSummary: safeStringify(inputs.map(summarizeAtomicCrossJAccountInput)),
    });
    recordRejectedAtomicCrossJInputs(
      env,
      inputs,
      initial.droppedInputIndexes,
      'CROSS_J_ACCOUNT_PAIR_STRUCTURAL_MISMATCH',
      'A cross-j Account leg arrived without its exact atomic sibling leg and was ignored',
    );
  }

  let retained = initial.inputs;
  for (let attempt = 0; attempt <= initial.pairs.length; attempt += 1) {
    const selection = groupAtomicPairsFirst(env, selectMatchedCrossJAccountInputPairs(env, retained));
    if (selection.droppedInputIndexes.length > 0) {
      throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_SELECTION_UNSTABLE');
    }
    if (isReplay || selection.pairs.length === 0) return selection;

    const pairedCount = selection.pairs.length * 2;
    const paired = selectMatchedCrossJAccountInputPairs(env, selection.inputs.slice(0, pairedCount));
    if (paired.droppedInputIndexes.length > 0 || paired.pairs.length !== selection.pairs.length) {
      throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_PREFLIGHT_GROUP_INVALID');
    }
    const preview = await previewAtomicPairs(env, paired, initialJOutbox, routingDeps);
    addAlreadyCommittedPairIndexes(env, paired, preview.failedIndexes);
    if (preview.failedIndexes.size === 0) return selection;

    env.warn('network', 'CROSS_J_ACCOUNT_PAIR_PREVIEW_REJECTED', {
      attempt,
      pairCount: paired.pairs.length,
      droppedInputIndexes: [...preview.failedIndexes].sort((left, right) => left - right),
      failureDetail: preview.failureDetail,
    });
    recordRejectedAtomicCrossJInputs(
      env,
      paired.inputs,
      rejectedPairIndexes(paired, preview.failedIndexes),
      'CROSS_J_ACCOUNT_PAIR_PREVIEW_REJECTED',
      'A signed cross-j Account pair failed atomic scratch-state validation and was ignored',
    );
    retained = selection.inputs.filter((_input, inputIndex) => !preview.failedIndexes.has(inputIndex));
  }
  throw new Error('RUNTIME_CROSS_J_ACCOUNT_PAIR_PREFLIGHT_DID_NOT_CONVERGE');
};

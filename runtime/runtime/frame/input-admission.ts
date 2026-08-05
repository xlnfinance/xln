import { createStructuredLogger, logError, shortId } from '../../infra/logger';
import { normalizeRuntimeId } from '../../network/p2p/runtime-id';
import { safeStringify } from '../../protocol/serialization';
import { decodeRoutedEntityInput } from '../routing-validation';
import { validateJInputs } from '../../storage/wal/runtime-machine-schema/j';
import type {
  PendingReliableIngress,
  RuntimeReplica,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeTx,
} from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import {
  getInputReliableIdentity,
  registerReliableIngress,
} from '../reliable-delivery';
import type { ReliableIngressRegistration } from '../reliable-ingress-registration';
import { ensureReliableIngressState } from '../reliable-ingress-state';
import { compareReliableIdentityPosition } from '../reliable-frontier';
import {
  validateExternalEntityInputTargets,
  RuntimeEntityInputApplyError,
} from '../entity-inputs';
import { splitRoutedOutputByDeliveryLane } from '../output-routing';
import { assertScheduledWakeTxAuthorized } from '../scheduled-wake';
import { validateRuntimeInputShapeAndLimits } from '../input-validation';
import {
  selectPotentialAtomicCrossJInputIndexes,
  selectPotentialAtomicCrossJInputPairs,
} from './cross-j-atomic-admission';

const runtimeLog = createStructuredLogger('runtime');

export type RuntimeInputAdmissionDeps = {
  normalizeEntityInput(
    env: RuntimeReplica,
    input: RoutedEntityInput,
    context: string,
  ): RoutedEntityInput;
};

export type PreparedRuntimeIngress = {
  runtimeTxs: RuntimeTx[];
  entityInputs: RoutedEntityInput[];
  jOutbox: JInput[];
  immediateReliableReceipts: Array<{
    runtimeId: string;
    receipt: ReliableDeliveryReceipt;
  }>;
};

/**
 * A transport retry can enqueue one signed proposal envelope while its first
 * copy is still waiting in the Runtime mempool. Collapse only byte-identical
 * proposal legs. Any changed provenance, evidence, or transaction bytes keep
 * separate indexes and fail the atomic-overlap invariant below.
 */
export const coalesceExactAtomicProposalIngressRetries = (
  inputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => {
  const seen = new Set<string>();
  return inputs.filter(input => {
    if (input.atomicCrossJurisdictionPair?.phase !== 'proposal') return true;
    const key = safeStringify(input);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const rejectRuntimeInput = (message: string): never => {
  runtimeLog.error('input.rejected', { message });
  throw new Error(message);
};

const collectJOutbox = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
): JInput[] => {
  if (!runtimeInput.jInputs?.length) return [];
  const inputs = validateJInputs(runtimeInput.jInputs, 'RUNTIME_INPUT_J');
  runtimeLog.debug('joutbox.incoming', { jInputs: inputs.length });
  for (const input of inputs) {
    if (!env.state.jReplicas.has(input.jurisdictionName)) {
      rejectRuntimeInput(`Unknown J jurisdiction: ${input.jurisdictionName}`);
    }
    runtimeLog.debug('joutbox.collect', {
      jurisdictionName: input.jurisdictionName,
      jTxs: input.jTxs.length,
      types: input.jTxs.map(tx => tx.type),
    });
  }
  return inputs;
};

const validateEntityInputs = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  isReplay: boolean,
  deps: RuntimeInputAdmissionDeps,
): RoutedEntityInput[] =>
  runtimeInput.entityInputs.map((input, index) => {
    try {
      for (const tx of input.entityTxs ?? []) {
        assertScheduledWakeTxAuthorized(tx, isReplay);
      }
      return deps.normalizeEntityInput(
        env,
        decodeRoutedEntityInput(input),
        `runtimeInput[${index}]`,
      );
    } catch (error) {
      logError(
        'RUNTIME_TICK',
        `🚨 CRITICAL FINANCIAL ERROR: Invalid EntityInput[${index}] before merge!`,
        {
          error: error instanceof Error ? error.message : String(error),
          entityId: shortId(input?.entityId, 12),
          signerId: shortId(input?.signerId, 12),
          sourceRuntimeId: shortId(input?.from, 12),
          sourceRuntimeHeight:
            (input as Partial<RoutedEntityInput>).sourceRuntimeFrame?.height ?? null,
          entityTxTypes: Array.isArray(input?.entityTxs)
            ? input.entityTxs.map(tx => tx?.type)
            : [],
        },
      );
      if (!isReplay && String(input?.from || '').trim()) {
        throw new RuntimeEntityInputApplyError(
          input,
          false,
          error,
          'malformed-ingress',
        );
      }
      throw error;
    }
  });

/**
 * Transport arrival order is not consensus order.
 *
 * Reorder only positions from the same authenticated Runtime and protocol
 * lane. This lets H settle before H+1 without moving unrelated Entity inputs
 * or breaking an atomic cross-J cohort's position relative to other work.
 */
export const orderReliableEntityInputsWithinSourceLanes = (
  inputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => {
  const ordered = [...inputs];
  const positionsByLane = new Map<string, number[]>();
  ordered.forEach((input, index) => {
    const sourceRuntimeId = normalizeRuntimeId(input.from);
    // Locally scheduled consensus intents are not transport ingress yet. Some
    // intentionally lack the sender signature that their routed form must
    // carry, so reliable identity decoding begins only after provenance exists.
    if (!sourceRuntimeId) return;
    const identity = getInputReliableIdentity(input);
    if (!identity) return;
    const key = `${sourceRuntimeId}:${identity.laneKey}`;
    const positions = positionsByLane.get(key) ?? [];
    positions.push(index);
    positionsByLane.set(key, positions);
  });
  for (const positions of positionsByLane.values()) {
    if (positions.length < 2) continue;
    const lane = positions
      .map((position, stableIndex) => ({
        input: ordered[position]!,
        identity: getInputReliableIdentity(ordered[position]!)!,
        stableIndex,
      }))
      .sort((left, right) =>
        compareReliableIdentityPosition(left.identity, right.identity) ||
        left.stableIndex - right.stableIndex)
      .map(entry => entry.input);
    positions.forEach((position, index) => {
      ordered[position] = lane[index]!;
    });
  }
  return ordered;
};

const clonePendingReliableIngress = (
  env: RuntimeReplica,
): Map<string, PendingReliableIngress> =>
  new Map(
    [...(ensureReliableIngressState(env).pendingReliableIngress?.entries() ?? [])]
      .map(([key, pending]) => [key, {
        identity: pending.identity,
        targetRuntimeIds: new Set(pending.targetRuntimeIds),
      }]),
  );

const registerOneReliableEntityInput = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  allowContiguousPendingAccountAck: boolean,
): { sourceRuntimeId: string; registration: ReliableIngressRegistration } => {
  const sourceRuntimeId = normalizeRuntimeId(input.from);
  if (!sourceRuntimeId || !getInputReliableIdentity(input)) {
    return { sourceRuntimeId, registration: { kind: 'ordinary' } };
  }
  return {
    sourceRuntimeId,
    registration: registerReliableIngress(env, sourceRuntimeId, input, {
      allowContiguousPendingAccountAck,
    }),
  };
};

const summarizeAtomicReliableInput = (
  input: RoutedEntityInput,
  inputIndex: number,
) => {
  const identity = getInputReliableIdentity(input);
  const marker = input.atomicCrossJurisdictionPair;
  return {
    inputIndex,
    entityId: input.entityId,
    signerId: input.signerId,
    from: input.from,
    sourceRuntimeFrame: input.sourceRuntimeFrame,
    atomicCrossJurisdictionPair: marker ? {
      phase: marker.phase,
      pairKeyPrefix: marker.pairKey.slice(0, 160),
      pairKeyLength: marker.pairKey.length,
    } : null,
    reliableIdentity: identity ? {
      kind: identity.kind,
      height: identity.height,
      frameHash: identity.frameHash,
      laneKey: identity.laneKey,
      logicalKey: identity.logicalKey,
    } : null,
  };
};

const indexAtomicReliablePairs = (
  inputs: readonly RoutedEntityInput[],
): {
  pairByFirstIndex: Map<number, readonly [number, number]>;
  trailingIndexes: Set<number>;
} => {
  const pairs = selectPotentialAtomicCrossJInputPairs(inputs);
  const pairByFirstIndex = new Map<number, readonly [number, number]>();
  const trailingIndexes = new Set<number>();
  for (const pair of pairs) {
    const indexes = [pair.sourceInputIndex, pair.targetInputIndex]
      .sort((left, right) => left - right) as [number, number];
    if (
      pairByFirstIndex.has(indexes[0]) ||
      trailingIndexes.has(indexes[0]) ||
      pairByFirstIndex.has(indexes[1]) ||
      trailingIndexes.has(indexes[1])
    ) {
      throw new Error('RELIABLE_INGRESS_ATOMIC_PAIR_OVERLAP:' + safeStringify({
        overlappingPair: { pairKey: pair.pairKey, indexes },
        pairs: pairs.map(candidate => ({
          pairKey: candidate.pairKey,
          indexes: [candidate.sourceInputIndex, candidate.targetInputIndex],
        })),
        inputs: inputs.map(summarizeAtomicReliableInput),
      }));
    }
    pairByFirstIndex.set(indexes[0], indexes);
    trailingIndexes.add(indexes[1]);
  }
  return { pairByFirstIndex, trailingIndexes };
};

/**
 * Reliable identities are per Account lane, but a cross-j envelope is one
 * authenticated two-Account unit. If a preceding plain ACK fences either leg,
 * reserve neither leg: admitting its sibling alone would turn ordinary
 * transport ordering into a false structural-security incident.
 */
export const registerReliableEntityInputs = (
  env: RuntimeReplica,
  inputs: RoutedEntityInput[],
  isReplay: boolean,
): Pick<PreparedRuntimeIngress, 'entityInputs' | 'immediateReliableReceipts'> => {
  const coalescedInputs = coalesceExactAtomicProposalIngressRetries(inputs);
  const atomicIndexes = selectPotentialAtomicCrossJInputIndexes(coalescedInputs);
  const entityInputs: RoutedEntityInput[] = [];
  const immediateReliableReceipts: PreparedRuntimeIngress['immediateReliableReceipts'] = [];
  const {
    pairByFirstIndex: atomicPairByFirstIndex,
    trailingIndexes: atomicPairTrailingIndexes,
  } = indexAtomicReliablePairs(coalescedInputs);

  for (const [inputIndex, input] of coalescedInputs.entries()) {
    if (isReplay) {
      /*
       * WAL records the canonical Entity input that consensus actually
       * applied. Several individually reliable transport envelopes can merge
       * into that one input before Entity execution. Rebuild each delivery
       * frontier from its atomic lane, then replay the merged input exactly
       * once; splitting execution itself would change Entity frame contents.
       */
      for (const lane of splitRoutedOutputByDeliveryLane(input)) {
        const sourceRuntimeId = normalizeRuntimeId(lane.from);
        if (!sourceRuntimeId || !getInputReliableIdentity(lane)) continue;
        registerReliableIngress(env, sourceRuntimeId, lane, {
          allowContiguousPendingAccountAck: atomicIndexes.has(inputIndex),
        });
      }
      entityInputs.push(input);
      continue;
    }
    if (atomicPairTrailingIndexes.has(inputIndex)) continue;
    const atomicPair = atomicPairByFirstIndex.get(inputIndex);
    if (atomicPair) {
      const pendingBefore = clonePendingReliableIngress(env);
      const registrations = atomicPair.map(index =>
        registerOneReliableEntityInput(env, coalescedInputs[index]!, true));
      const complete = registrations.every(({ registration }) =>
        registration.kind === 'ordinary' || registration.kind === 'enqueue');
      if (complete) {
        entityInputs.push(...atomicPair.map(index => coalescedInputs[index]!));
      } else {
        ensureReliableIngressState(env).pendingReliableIngress = pendingBefore;
        runtimeLog.info('crossj.atomic_reliable_ingress_deferred', {
          inputIndexes: atomicPair,
          registrationKinds: registrations.map(entry => entry.registration.kind),
        });
      }
      continue;
    }
    const { sourceRuntimeId, registration } = registerOneReliableEntityInput(
      env,
      input,
      atomicIndexes.has(inputIndex),
    );
    if (registration.kind === 'ordinary' || registration.kind === 'enqueue') {
      entityInputs.push(input);
    } else if (registration.kind === 'receipt') {
      immediateReliableReceipts.push({
        runtimeId: sourceRuntimeId,
        receipt: registration.receipt,
      });
    }
  }
  return { entityInputs, immediateReliableReceipts };
};

export const validateRuntimeInputIngress = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  isReplay: boolean,
  deps: RuntimeInputAdmissionDeps,
): Omit<PreparedRuntimeIngress, 'immediateReliableReceipts'> => {
  validateRuntimeInputShapeAndLimits(env, runtimeInput, rejectRuntimeInput);
  const jOutbox = collectJOutbox(env, runtimeInput);
  const entityInputs = orderReliableEntityInputsWithinSourceLanes(
    validateEntityInputs(env, runtimeInput, isReplay, deps),
  );
  validateExternalEntityInputTargets(env, entityInputs, runtimeInput.runtimeTxs);
  return {
    runtimeTxs: [...runtimeInput.runtimeTxs],
    entityInputs,
    jOutbox,
  };
};

export const prepareRuntimeInputIngress = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  isReplay: boolean,
  deps: RuntimeInputAdmissionDeps,
): PreparedRuntimeIngress => {
  const validated = validateRuntimeInputIngress(env, runtimeInput, isReplay, deps);
  const reliable = registerReliableEntityInputs(env, validated.entityInputs, isReplay);
  return {
    ...validated,
    entityInputs: reliable.entityInputs,
    immediateReliableReceipts: reliable.immediateReliableReceipts,
  };
};

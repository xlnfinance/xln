import { createStructuredLogger, logError, shortId } from '../../infra/logger';
import { normalizeRuntimeId } from '../../network/p2p/runtime-id';
import { decodeRoutedEntityInput } from '../routing-validation';
import { validateJInputs } from '../../storage/wal/runtime-machine-schema/j';
import type { RuntimeReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import {
  getInputReliableIdentity,
  registerReliableIngress,
} from '../reliable-delivery';
import { compareReliableIdentityPosition } from '../reliable-frontier';
import {
  validateExternalEntityInputTargets,
  RuntimeEntityInputApplyError,
} from '../entity-inputs';
import { splitRoutedOutputByDeliveryLane } from '../output-routing';
import { assertScheduledWakeTxAuthorized } from '../scheduled-wake';
import { validateRuntimeInputShapeAndLimits } from '../input-validation';
import { selectPotentialAtomicCrossJInputIndexes } from './cross-j-atomic-admission';

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

const registerReliableEntityInputs = (
  env: RuntimeReplica,
  inputs: RoutedEntityInput[],
  isReplay: boolean,
): Pick<PreparedRuntimeIngress, 'entityInputs' | 'immediateReliableReceipts'> => {
  const atomicIndexes = selectPotentialAtomicCrossJInputIndexes(inputs);
  const entityInputs: RoutedEntityInput[] = [];
  const immediateReliableReceipts: PreparedRuntimeIngress['immediateReliableReceipts'] = [];

  for (const [inputIndex, input] of inputs.entries()) {
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
    const sourceRuntimeId = normalizeRuntimeId(input.from);
    if (!sourceRuntimeId || !getInputReliableIdentity(input)) {
      entityInputs.push(input);
      continue;
    }
    // Registration mutates only the isolated candidate. The live Runtime is
    // untouched until the frame's WAL commit succeeds.
    const registration = registerReliableIngress(env, sourceRuntimeId, input, {
      allowContiguousPendingAccountAck: atomicIndexes.has(inputIndex),
    });
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

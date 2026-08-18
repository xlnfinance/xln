import type { EnvSnapshot, RuntimeInput } from '../../types';
import type { RuntimeFrameTransaction } from '../transaction';
import type { EntityInfraContext } from '../../../types/entity/infra-context';

type RuntimeInputRestore = (
  error: unknown,
  options?: { discardMalformedRemoteInput?: boolean; requeue?: boolean },
) => Promise<Error>;

/**
 * Mutable orchestration facts for one Runtime frame attempt.
 *
 * Runtime State is owned and mutated in-place after ingress validation. This object
 * records whether failure can still discard input normally or must halt and
 * reload durable truth. It never represents a second speculative Runtime.
 */
export type FrameExecutionState = {
  commitDisposition: 'undurable' | 'committed' | 'conflict' | 'unknown';
  failureHandled: boolean;
  transaction: RuntimeFrameTransaction | undefined;
  pendingTraceSnapshot: EnvSnapshot | undefined;
  restoreUndurableInput: RuntimeInputRestore | undefined;
  /** True after ingress validation, when the owned Runtime State may have changed. */
  mutationStarted: boolean;
  inputDrained: boolean;
  inputForRequeue: RuntimeInput | undefined;
  /** Public Entity-frame context slices collected during this Runtime attempt. */
  entityContexts: Map<string, EntityInfraContext>;
};

export const createFrameExecutionState = (): FrameExecutionState => ({
  commitDisposition: 'undurable',
  failureHandled: false,
  transaction: undefined,
  pendingTraceSnapshot: undefined,
  restoreUndurableInput: undefined,
  mutationStarted: false,
  inputDrained: false,
  inputForRequeue: undefined,
  entityContexts: new Map(),
});

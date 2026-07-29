import type {
  EnvSnapshot,
  ReliableDeliveryReceipt,
  RuntimeInput,
} from '../../types';
import type {
  ReliableIngressCommit,
  ReliableReceiptSenderCheckpoint,
} from '../reliable-delivery';
import type { RuntimeFrameTransaction } from './transaction';

export type RuntimeReceiptDelivery = {
  runtimeId: string;
  receipt: ReliableDeliveryReceipt;
};

export type RuntimeInputRestore = (
  error: unknown,
  options?: { discardMalformedRemoteInput?: boolean; requeue?: boolean },
) => Promise<Error>;

/**
 * Mutable orchestration facts for one Runtime frame attempt.
 *
 * Runtime State is owned and mutated in-place after preflight. This object
 * records whether failure can still discard input normally or must halt and
 * reload durable truth. It never represents a second speculative Runtime.
 */
export type FrameExecutionState = {
  reliableIngressCommits: ReliableIngressCommit[];
  reliableReceiptSenderCheckpoint: ReliableReceiptSenderCheckpoint | undefined;
  reliableReceiptDeliveries: RuntimeReceiptDelivery[];
  immediateReliableReceiptDeliveries: RuntimeReceiptDelivery[];
  reliableReceiptStateDurable: boolean;
  commitDisposition: 'undurable' | 'committed' | 'conflict' | 'unknown';
  failureHandled: boolean;
  transaction: RuntimeFrameTransaction | undefined;
  pendingTraceSnapshot: EnvSnapshot | undefined;
  restoreUndurableInput: RuntimeInputRestore | undefined;
  /** True after preflight, when the owned Runtime State may have changed. */
  mutationStarted: boolean;
  inputDrained: boolean;
  inputForRequeue: RuntimeInput | undefined;
};

export const createFrameExecutionState = (): FrameExecutionState => ({
  reliableIngressCommits: [],
  reliableReceiptSenderCheckpoint: undefined,
  reliableReceiptDeliveries: [],
  immediateReliableReceiptDeliveries: [],
  reliableReceiptStateDurable: false,
  commitDisposition: 'undurable',
  failureHandled: false,
  transaction: undefined,
  pendingTraceSnapshot: undefined,
  restoreUndurableInput: undefined,
  mutationStarted: false,
  inputDrained: false,
  inputForRequeue: undefined,
});

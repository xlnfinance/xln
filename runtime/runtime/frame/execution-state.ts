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

export type RuntimeFrameRollback = (
  error: unknown,
  options?: { quarantine?: boolean; requeue?: boolean },
) => Promise<Error>;

/**
 * Mutable orchestration facts for one Runtime frame attempt.
 *
 * Consensus state stays inside the isolated Env. This object only makes the
 * commit/rollback boundary explicit so catch/finally cannot depend on a loose
 * collection of booleans with accidental combinations.
 */
export type FrameExecutionState = {
  reliableIngressCommits: ReliableIngressCommit[];
  reliableReceiptSenderCheckpoint: ReliableReceiptSenderCheckpoint | undefined;
  reliableReceiptDeliveries: RuntimeReceiptDelivery[];
  immediateReliableReceiptDeliveries: RuntimeReceiptDelivery[];
  reliableReceiptStateDurable: boolean;
  commitDisposition: 'undurable' | 'committed' | 'unknown';
  rollbackHandled: boolean;
  transaction: RuntimeFrameTransaction | undefined;
  pendingTraceSnapshot: EnvSnapshot | undefined;
  rollbackUndurable: RuntimeFrameRollback | undefined;
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
  rollbackHandled: false,
  transaction: undefined,
  pendingTraceSnapshot: undefined,
  rollbackUndurable: undefined,
  inputDrained: false,
  inputForRequeue: undefined,
});

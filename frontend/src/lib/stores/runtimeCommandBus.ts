import { get, writable } from 'svelte/store';
import type { RuntimeInput } from '@xln/runtime/xln-api';
import { registerDebugSurface } from '$lib/utils/debugSurface';
import {
  createRuntimeCommandId,
  listUnresolvedRemoteRuntimeCommandIntents,
  markRemoteRuntimeCommandIntentAccepted,
  normalizeRuntimeCommandId,
  resolveRemoteRuntimeCommandId,
  resolveRemoteRuntimeCommandIntent,
  settleRemoteRuntimeCommandIntent,
  withRemoteRuntimeCommandReplayLease,
  type RuntimeCommandIntentOptions,
} from './runtimeCommandIntent';
import { installRuntimeCommandJournalKeys } from './runtimeCommandJournalKeyring';
import { normalizeRuntimeCommandSequence } from './runtimeCommandIntentCodec';
export type { RuntimeCommandIntentOptions } from './runtimeCommandIntent';
export type RuntimeCommandExecutionOptions = RuntimeCommandIntentOptions & {
  beforeExecute?: () => void;
};
import {
  classifyRuntimeFailure,
  type RuntimeFailureKind,
} from '$lib/utils/runtimeFailure';

export type RuntimeCommandStatus = 'pending' | 'accepted' | 'observed' | 'committed' | 'error';

export type CommandReceipt = {
  receiptId: string;
  commandId: string;
  commandSequence: number | null;
  serverFingerprint: string | null;
  upstreamReceiptId: string | null;
  status: RuntimeCommandStatus;
  runtimeId: string;
  mode: 'embedded' | 'remote';
  inputSummary: {
    runtimeTxs: number;
    jInputs: number;
    entityInputs: number;
    entityTxs: number;
  };
  acceptedAtHeight: number | null;
  committedAtHeight: number | null;
  statusUrl: string | null;
  error: string | null;
  failureKind: RuntimeFailureKind | null;
  failureRetryable: boolean;
};

export type RuntimeCommandProgress = {
  accepted: (height?: number | null, upstream?: { receiptId?: string | null; statusUrl?: string | null }) => Promise<void>;
  committed: (height?: number | null) => Promise<void>;
  observed: (height?: number | null) => Promise<void>;
};

export type RuntimeIngressReceiptLike = {
  id?: string | null;
  status?: 'pending' | 'observed' | 'expired' | string;
  counts?: {
    runtimeTxs?: number;
    entityInputs?: number;
    jInputs?: number;
  } | null;
  enqueuedHeight?: number | null;
  observedHeight?: number | null;
  note?: string | null;
};

type RuntimeCommandSubmitOptions = RuntimeCommandExecutionOptions & {
  input: RuntimeInput;
  runtimeId: string;
  mode: 'embedded' | 'remote';
  serverFingerprint?: string;
  nextCommandSequence?: number | null;
  initialHeight?: number | null;
  remoteJournalMode?: 'durable' | 'one-shot';
};

const MAX_RECEIPTS = 100;
let receiptSequence = 0;

export const runtimeCommandReceipts = writable<CommandReceipt[]>([]);
export const runtimeCommandLatestReceipt = writable<CommandReceipt | null>(null);

export const runtimeCommandRetryOptions = (
  receipt: CommandReceipt,
): RuntimeCommandIntentOptions => {
  if (receipt.mode !== 'remote' || receipt.status !== 'error' || !receipt.failureRetryable) {
    throw new Error(`RUNTIME_COMMAND_RECEIPT_NOT_RETRYABLE: receiptId=${receipt.receiptId}`);
  }
  if (receipt.commandSequence === null) throw new Error('RUNTIME_COMMAND_RECEIPT_SEQUENCE_MISSING');
  return {
    commandId: normalizeRuntimeCommandId(receipt.commandId),
    commandSequence: receipt.commandSequence,
  };
};

const normalizeHeight = (height: number | null | undefined): number | null => {
  if (height === null || height === undefined) return null;
  const normalized = Math.floor(Number(height));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
};

export const summarizeRuntimeInput = (input: RuntimeInput): CommandReceipt['inputSummary'] => ({
  runtimeTxs: Array.isArray(input.runtimeTxs) ? input.runtimeTxs.length : 0,
  jInputs: Array.isArray(input.jInputs) ? input.jInputs.length : 0,
  entityInputs: Array.isArray(input.entityInputs) ? input.entityInputs.length : 0,
  entityTxs: (input.entityInputs ?? []).reduce((sum, entityInput) =>
    sum + (Array.isArray(entityInput?.entityTxs) ? entityInput.entityTxs.length : 0), 0),
});

export const createRuntimeCommandReceipt = async (options: RuntimeCommandSubmitOptions): Promise<CommandReceipt> => {
  const durableRemoteIntent = options.mode === 'remote' && options.remoteJournalMode !== 'one-shot';
  const remoteIntent = durableRemoteIntent
    ? await resolveRemoteRuntimeCommandIntent(options)
    : null;
  const oneShotSequence = options.mode === 'remote' && !durableRemoteIntent
    ? normalizeRuntimeCommandSequence(options.commandSequence ?? options.nextCommandSequence)
    : null;
  return {
  receiptId: `runtime-command-${++receiptSequence}`,
  commandId: remoteIntent?.commandId ?? normalizeRuntimeCommandId(options.commandId ?? createRuntimeCommandId()),
  commandSequence: remoteIntent?.commandSequence ?? oneShotSequence,
  serverFingerprint: options.mode === 'remote' ? options.serverFingerprint ?? null : null,
  upstreamReceiptId: null,
  status: 'pending',
  runtimeId: options.runtimeId || 'embedded',
  mode: options.mode,
  inputSummary: summarizeRuntimeInput(options.input),
  acceptedAtHeight: normalizeHeight(options.initialHeight),
  committedAtHeight: null,
  statusUrl: null,
  error: null,
  failureKind: null,
  failureRetryable: false,
  };
};

const publishReceipt = (receipt: CommandReceipt): void => {
  runtimeCommandLatestReceipt.set(receipt);
  runtimeCommandReceipts.update((receipts) => {
    const next = [receipt, ...receipts.filter((candidate) => candidate.receiptId !== receipt.receiptId)];
    return next.slice(0, MAX_RECEIPTS);
  });
};

const updateReceipt = (
  receipt: CommandReceipt,
  patch: Partial<CommandReceipt>,
): CommandReceipt => {
  const next = { ...receipt, ...patch };
  publishReceipt(next);
  return next;
};

export const submitRuntimeCommand = async <T>(
  options: RuntimeCommandSubmitOptions,
  executor: (progress: RuntimeCommandProgress, receipt: CommandReceipt) => Promise<T>,
): Promise<{ receipt: CommandReceipt; result: T }> => {
  const durableRemoteIntent = options.mode === 'remote' && options.remoteJournalMode !== 'one-shot';
  let receipt = await createRuntimeCommandReceipt(options);
  options.beforeExecute?.();
  publishReceipt(receipt);

  const progress: RuntimeCommandProgress = {
    accepted: async (height, upstream) => {
      receipt = updateReceipt(receipt, {
        status: 'accepted',
        acceptedAtHeight: normalizeHeight(height) ?? receipt.acceptedAtHeight,
        upstreamReceiptId: upstream?.receiptId ?? receipt.upstreamReceiptId,
        statusUrl: upstream?.statusUrl ?? receipt.statusUrl,
      });
      if (durableRemoteIntent) {
        await markRemoteRuntimeCommandIntentAccepted(receipt.commandId, upstream ?? {});
      }
    },
    committed: async (height) => {
      if (receipt.mode === 'remote') return;
      receipt = updateReceipt(receipt, {
        status: 'committed',
        acceptedAtHeight: receipt.acceptedAtHeight ?? normalizeHeight(height),
        committedAtHeight: normalizeHeight(height) ?? receipt.committedAtHeight ?? receipt.acceptedAtHeight,
      });
    },
    observed: async (height) => {
      receipt = updateReceipt(receipt, {
        status: receipt.mode === 'remote' ? 'observed' : 'committed',
        acceptedAtHeight: receipt.acceptedAtHeight ?? normalizeHeight(height),
        committedAtHeight: normalizeHeight(height) ?? receipt.committedAtHeight ?? receipt.acceptedAtHeight,
      });
    },
  };

  try {
    const result = await executor(progress, receipt);
    if (durableRemoteIntent && (receipt.status === 'observed' || receipt.status === 'committed')) {
      await settleRemoteRuntimeCommandIntent(receipt.commandId);
    }
    return { receipt, result };
  } catch (error) {
    const failure = classifyRuntimeFailure(error);
    receipt = updateReceipt(receipt, {
      status: 'error',
      error: failure.message,
      failureKind: failure.kind,
      failureRetryable: options.remoteJournalMode === 'one-shot' ? false : failure.retryable,
    });
    // Only an explicit terminal rejection may erase retry identity. A generic
    // E_INTERNAL can happen after the server enqueued the command but before
    // its response; deleting here would turn the next user attempt into a new ID.
    if (durableRemoteIntent && failure.kind === 'drop') {
      try {
        await settleRemoteRuntimeCommandIntent(receipt.commandId);
      } catch (journalError) {
        throw new AggregateError([error, journalError], 'RUNTIME_COMMAND_TERMINAL_SETTLEMENT_FAILED');
      }
    }
    throw error;
  }
};

export const replayRuntimeCommandIntentsInOrder = async <T>(
  intents: readonly T[],
  replay: (intent: T) => Promise<void>,
): Promise<number> => {
  let completed = 0;
  for (const intent of intents) {
    try {
      await replay(intent);
      completed += 1;
    } catch (error) {
      if (classifyRuntimeFailure(error).kind === 'drop') continue;
      throw error;
    }
  }
  return completed;
};

export const recordRuntimeIngressReceipt = (options: {
  runtimeId: string;
  mode: 'embedded' | 'remote';
  receipt: RuntimeIngressReceiptLike;
  statusUrl?: string | null;
}): CommandReceipt => {
  const counts = options.receipt.counts ?? {};
  const upstreamStatus = String(options.receipt.status || 'pending');
  const expiredFailure = upstreamStatus === 'expired'
    ? classifyRuntimeFailure(options.receipt.note || 'Runtime ingress receipt expired')
    : null;
  const status: RuntimeCommandStatus =
    upstreamStatus === 'observed' ? 'observed' :
    upstreamStatus === 'expired' ? 'error' :
    'accepted';
  const receipt: CommandReceipt = {
    receiptId: `runtime-command-${++receiptSequence}`,
    commandId: createRuntimeCommandId(),
    commandSequence: null,
    serverFingerprint: null,
    upstreamReceiptId: options.receipt.id ?? null,
    status,
    runtimeId: options.runtimeId || 'remote',
    mode: options.mode,
    inputSummary: {
      runtimeTxs: Math.max(0, Math.floor(Number(counts.runtimeTxs ?? 0))),
      jInputs: Math.max(0, Math.floor(Number(counts.jInputs ?? 0))),
      entityInputs: Math.max(0, Math.floor(Number(counts.entityInputs ?? 0))),
      entityTxs: 0,
    },
    acceptedAtHeight: normalizeHeight(options.receipt.enqueuedHeight),
    committedAtHeight: normalizeHeight(options.receipt.observedHeight),
    statusUrl: options.statusUrl ?? null,
    error: expiredFailure?.message ?? null,
    failureKind: expiredFailure?.kind ?? null,
    failureRetryable: expiredFailure?.retryable ?? false,
  };
  publishReceipt(receipt);
  return receipt;
};

export const clearRuntimeCommandReceipts = (): void => {
  runtimeCommandReceipts.set([]);
  runtimeCommandLatestReceipt.set(null);
};

const exposeRuntimeCommandDebugSurface = (): void => {
  registerDebugSurface('commands', () => ({
    latest: get(runtimeCommandLatestReceipt),
    receipts: get(runtimeCommandReceipts),
    clear: clearRuntimeCommandReceipts,
  }));
  // Localhost-only production-preview QA surface. Browser resilience tests must
  // exercise the shipped bundle, never Vite's development-only `/src` loader.
  registerDebugSurface('commandJournal', () => ({
    installKeys: installRuntimeCommandJournalKeys,
    list: listUnresolvedRemoteRuntimeCommandIntents,
    resolveId: resolveRemoteRuntimeCommandId,
    markAccepted: markRemoteRuntimeCommandIntentAccepted,
    settle: settleRemoteRuntimeCommandIntent,
    withReplayLease: withRemoteRuntimeCommandReplayLease,
  }));
};

exposeRuntimeCommandDebugSurface();

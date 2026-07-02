import { get, writable } from 'svelte/store';
import type { RuntimeInput } from '@xln/runtime/xln-api';
import { registerDebugSurface } from '$lib/utils/debugSurface';

export type RuntimeCommandStatus = 'pending' | 'accepted' | 'observed' | 'committed' | 'error';

	export type CommandReceipt = {
	  receiptId: string;
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
	};

export type RuntimeCommandProgress = {
  accepted: (height?: number | null, upstream?: { receiptId?: string | null; statusUrl?: string | null }) => void;
  committed: (height?: number | null) => void;
  observed: (height?: number | null) => void;
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

type RuntimeCommandSubmitOptions = {
  input: RuntimeInput;
  runtimeId: string;
  mode: 'embedded' | 'remote';
  initialHeight?: number | null;
};

const MAX_RECEIPTS = 100;
let receiptSequence = 0;

export const runtimeCommandReceipts = writable<CommandReceipt[]>([]);
export const runtimeCommandLatestReceipt = writable<CommandReceipt | null>(null);

const normalizeHeight = (height: number | null | undefined): number | null => {
  if (height === null || height === undefined) return null;
  const normalized = Math.floor(Number(height));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Runtime command failed');

export const summarizeRuntimeInput = (input: RuntimeInput): CommandReceipt['inputSummary'] => ({
  runtimeTxs: Array.isArray(input.runtimeTxs) ? input.runtimeTxs.length : 0,
  jInputs: Array.isArray(input.jInputs) ? input.jInputs.length : 0,
  entityInputs: Array.isArray(input.entityInputs) ? input.entityInputs.length : 0,
  entityTxs: (input.entityInputs ?? []).reduce((sum, entityInput) =>
    sum + (Array.isArray(entityInput?.entityTxs) ? entityInput.entityTxs.length : 0), 0),
});

export const createRuntimeCommandReceipt = (options: RuntimeCommandSubmitOptions): CommandReceipt => ({
	  receiptId: `runtime-command-${++receiptSequence}`,
	  upstreamReceiptId: null,
	  status: 'pending',
  runtimeId: options.runtimeId || 'embedded',
  mode: options.mode,
  inputSummary: summarizeRuntimeInput(options.input),
	  acceptedAtHeight: normalizeHeight(options.initialHeight),
	  committedAtHeight: null,
	  statusUrl: null,
	  error: null,
	});

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
  let receipt = createRuntimeCommandReceipt(options);
  publishReceipt(receipt);

  const progress: RuntimeCommandProgress = {
	    accepted: (height, upstream) => {
	      receipt = updateReceipt(receipt, {
	        status: 'accepted',
	        acceptedAtHeight: normalizeHeight(height) ?? receipt.acceptedAtHeight,
	        upstreamReceiptId: upstream?.receiptId ?? receipt.upstreamReceiptId,
	        statusUrl: upstream?.statusUrl ?? receipt.statusUrl,
	      });
    },
    committed: (height) => {
      if (receipt.mode === 'remote') return;
      receipt = updateReceipt(receipt, {
        status: 'committed',
        acceptedAtHeight: receipt.acceptedAtHeight ?? normalizeHeight(height),
        committedAtHeight: normalizeHeight(height) ?? receipt.committedAtHeight ?? receipt.acceptedAtHeight,
      });
    },
    observed: (height) => {
      receipt = updateReceipt(receipt, {
        status: receipt.mode === 'remote' ? 'observed' : 'committed',
        acceptedAtHeight: receipt.acceptedAtHeight ?? normalizeHeight(height),
        committedAtHeight: normalizeHeight(height) ?? receipt.committedAtHeight ?? receipt.acceptedAtHeight,
      });
    },
  };

  try {
    const result = await executor(progress, receipt);
    return { receipt, result };
  } catch (error) {
    receipt = updateReceipt(receipt, {
      status: 'error',
      error: errorMessage(error),
    });
    throw error;
  }
};

export const recordRuntimeIngressReceipt = (options: {
  runtimeId: string;
  mode: 'embedded' | 'remote';
  receipt: RuntimeIngressReceiptLike;
  statusUrl?: string | null;
}): CommandReceipt => {
  const counts = options.receipt.counts ?? {};
  const upstreamStatus = String(options.receipt.status || 'pending');
  const status: RuntimeCommandStatus =
    upstreamStatus === 'observed' ? 'observed' :
    upstreamStatus === 'expired' ? 'error' :
    'accepted';
  const receipt: CommandReceipt = {
    receiptId: `runtime-command-${++receiptSequence}`,
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
    error: upstreamStatus === 'expired'
      ? options.receipt.note || 'Runtime ingress receipt expired'
      : null,
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
};

exposeRuntimeCommandDebugSurface();
